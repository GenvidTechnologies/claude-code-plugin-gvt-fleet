// The only module that imports node:child_process.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const SAFE_CMD_ARG = /^[\w./:@#=-]+$/;
const FAKE_ONLY_BLOCKED = new Set(['gh', 'claude']);
const KILL_FLUSH_MS = 250; // after a timed-out child exits: time for buffered output to arrive
const KILL_GRACE_MS = 3000; // after the kill: the result is returned by then, even if the child has not exited

/**
 * Kill a timed-out child and its descendants. On Windows, taskkill /T ends the whole tree, so a grandchild
 * (for example git-remote-https) does not keep running against a remote. Elsewhere only the child is killed.
 */
function killTree(child) {
  // A child that has already exited has a pid that the system may have given to another process.
  // taskkill /T on it could end an unrelated tree, so nothing is killed then.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
      const res = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      if (res.status === 0) return;
    } catch {
      // fall through to the plain kill
    }
  }
  child.kill();
}

/** True when an argument may be passed to a .cmd/.bat target. */
export function isSafeCmdArg(a) {
  return SAFE_CMD_ARG.test(a);
}

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a command name to an absolute path that includes its extension. */
export function resolveExe(name, env = process.env) {
  const isWin = process.platform === 'win32';
  const pathext = isWin
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasPath = /[\\/]/.test(name);
  const dirs = hasPath ? [''] : (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const hasExt = isWin && path.extname(name) !== '' && pathext.some((e) => e.toLowerCase() === path.extname(name).toLowerCase());
  const exts = hasExt ? [''] : pathext;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = hasPath ? path.resolve(name + ext) : path.join(dir, name + ext);
      if (isFile(candidate)) return path.resolve(candidate);
    }
  }
  throw new Error(`executable not found: ${name}`);
}

/**
 * Spawn form for a .cmd/.bat target. With /s, cmd.exe strips the first and last
 * quote of the line, so the whole line is wrapped in one more pair of quotes and
 * passed verbatim; node's own quoting would break a path that contains a space.
 * Arguments must already have passed SAFE_CMD_ARG. Throws on an exe path that
 * contains a quote or a percent sign (cmd.exe expands %VAR% even inside quotes).
 */
function cmdShimSpawn(exe, args) {
  if (/["%]/.test(exe)) throw new Error(`batch file path not allowed: ${JSON.stringify(exe)}`);
  const line = `""${exe}"${args.length ? ` ${args.join(' ')}` : ''}"`;
  return { file: resolveExe('cmd.exe'), args: ['/d', '/s', '/c', line] };
}

function baseName(file) {
  return path.basename(file, path.extname(file)).toLowerCase();
}

/**
 * Run argv[0] with argv.slice(1). No shell. Returns {code, stdout, stderr}.
 * Under GVT_FLEET_FAKE_ONLY=1, refuses gh and claude.
 */
export async function run(argv, { cwd, env, input, timeoutMs } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('run: argv must be a non-empty array');
  const fakeOnly = process.env.GVT_FLEET_FAKE_ONLY === '1';
  if (fakeOnly && FAKE_ONLY_BLOCKED.has(baseName(argv[0]))) {
    throw new Error(`GVT_FLEET_FAKE_ONLY=1: refusing to spawn ${baseName(argv[0])}`);
  }
  const exe = resolveExe(argv[0], env ?? process.env);
  if (fakeOnly && FAKE_ONLY_BLOCKED.has(baseName(exe))) {
    throw new Error(`GVT_FLEET_FAKE_ONLY=1: refusing to spawn ${baseName(exe)}`);
  }
  const args = argv.slice(1);
  let file = exe;
  let spawnArgs = args;
  let verbatim = false;
  if (/\.(cmd|bat)$/i.test(exe)) {
    for (const a of args) {
      if (!SAFE_CMD_ARG.test(a)) throw new Error(`run: argument not allowed for a .cmd/.bat target: ${JSON.stringify(a)}`);
    }
    ({ file, args: spawnArgs } = cmdShimSpawn(exe, args));
    verbatim = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, spawnArgs, {
      windowsVerbatimArguments: verbatim,
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let timer;
    let graceTimer;
    let timedOut = false;
    let settled = false;
    // Resolves once. After a timeout, 'close' can never come while a grandchild holds the pipes, so the
    // streams are destroyed and the result is built from what arrived.
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (timedOut) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        code: timedOut ? 124 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: timedOut ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}timed out after ${timeoutMs} ms` : stderr,
      });
    };
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      // After a timeout, an error from the kill does not replace the timeout result.
      if (timedOut) return finish(null);
      clearTimeout(timer);
      clearTimeout(graceTimer);
      settled = true;
      reject(e);
    });
    // A run that did not time out resolves on 'close' only, so no buffered output is lost. If a helper
    // process outlives the child and holds the pipes, such a run ends at the timeout with code 124
    // instead of its own exit code.
    child.on('exit', (code) => {
      if (timedOut) setTimeout(() => finish(code), KILL_FLUSH_MS);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/**
 * Run argv[0] with argv.slice(1) with stdout and stderr inherited from this
 * process. `input` (Buffer or string) is written to the child's stdin. No shell.
 * Resolves with the child's exit code: 1 if a signal killed it, 127 if argv[0]
 * cannot be resolved or the spawn fails. Never rejects.
 * Under GVT_FLEET_FAKE_ONLY=1, refuses gh and claude (resolves 127).
 */
export function passthrough(argv, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    let exe;
    try {
      if (!Array.isArray(argv) || argv.length === 0) return resolve(127);
      const fakeOnly = process.env.GVT_FLEET_FAKE_ONLY === '1';
      if (fakeOnly && FAKE_ONLY_BLOCKED.has(baseName(argv[0]))) return resolve(127);
      exe = resolveExe(argv[0], env ?? process.env);
      if (fakeOnly && FAKE_ONLY_BLOCKED.has(baseName(exe))) return resolve(127);
    } catch {
      return resolve(127);
    }
    const args = argv.slice(1);
    let file = exe;
    let spawnArgs = args;
    let verbatim = false;
    try {
      if (/\.(cmd|bat)$/i.test(exe)) {
        if (!args.every((a) => SAFE_CMD_ARG.test(a))) return resolve(127);
        ({ file, args: spawnArgs } = cmdShimSpawn(exe, args));
        verbatim = true;
      }
      const child = spawn(file, spawnArgs, {
        windowsVerbatimArguments: verbatim,
        cwd,
        env: env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      child.on('error', () => resolve(127));
      child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? undefined);
    } catch {
      resolve(127);
    }
  });
}
