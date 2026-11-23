import { spawn } from 'node:child_process';

/**
 * Run a node script with `process.execPath`, no shell.
 * `env` is merged over `process.env`; GVT_FLEET_FAKE_ONLY is always set to 1.
 * Resolves { code, signal, stdout, stderr, ms, timedOut }.
 */
export function runScript(scriptPath, args = [], { input, env, timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, ...env, GVT_FLEET_FAKE_ONLY: '1' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let timedOut = false;
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        ms: Date.now() - started,
        timedOut,
      });
    });
    // A child that exits before reading stdin raises EPIPE; ignore it.
    child.stdin.on('error', () => {});
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function norm(s) {
  return s.replace(/\\/g, '/').toLowerCase();
}

/**
 * Deep copy of `payload` where every string starting with `fromRoot`
 * (case-insensitive, `/` equals `\`) has that prefix replaced by `toRoot`.
 */
export function rebase(payload, fromRoot, toRoot) {
  const from = norm(fromRoot);
  const walk = (v) => {
    if (typeof v === 'string') {
      return norm(v).startsWith(from) ? toRoot + v.slice(fromRoot.length) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(payload);
}
