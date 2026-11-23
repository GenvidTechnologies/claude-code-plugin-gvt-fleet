// Hook script: records one worker-state line per Claude Code hook event.
//
// It runs on every hook event in every session on the machine, so the out-of-scope path stays cheap
// and silent: it loads only node built-ins and the path module, and loads the state writer only
// after a cwd matches. It must never print: SessionStart stdout becomes session context. It must
// always exit 0: a non-zero exit on Stop can change the session's flow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorktreeCwd, resolveWorkspace, workspaceCandidates } from '../lib/worktree-path.mjs';

process.exitCode = 0;
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const READ_LIMIT_MS = 2000;

/** Reads all of stdin, or gives up after READ_LIMIT_MS and returns what was read (usually ''). */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      try {
        process.stdin.destroy();
      } catch {
        // Ignored: the input is treated as empty.
      }
      finish('');
    }, READ_LIMIT_MS);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

/** True when `dir` holds config/repos.json as a file: a fleet workspace. */
function isWorkspace(dir) {
  try {
    return fs.statSync(path.join(dir, 'config', 'repos.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * The worktree and state folder for a session folder. With --workspace (a user-settings entry), that
 * workspace. Without it (the plugin's hooks.json), the workspace is worked out from the session
 * folder: the innermost <W> above repos/<owner>/<repo>/.claude/worktrees/<name> that holds
 * config/repos.json (ADR 0021). A folder of no such shape reads no file.
 */
function locate(argv, cwd) {
  const at = argv.indexOf('--workspace');
  if (at >= 0 && typeof argv[at + 1] === 'string') {
    const { workspace, stateDir } = resolveWorkspace({ argv, scriptPath: path.resolve(fileURLToPath(import.meta.url)) });
    const parsed = parseWorktreeCwd(cwd, workspace);
    return parsed === null ? null : { parsed, stateDir };
  }
  const s = argv.indexOf('--state-dir');
  const stateGiven = s >= 0 && typeof argv[s + 1] === 'string' ? path.resolve(argv[s + 1]) : null;
  for (const w of workspaceCandidates(cwd)) {
    const parsed = parseWorktreeCwd(cwd, w);
    if (parsed === null || !isWorkspace(w)) continue;
    return { parsed, stateDir: stateGiven ?? path.join(w, 'state') };
  }
  return null;
}

async function main() {
  const text = await readStdin();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (typeof payload.cwd !== 'string') return;
  const found = locate(process.argv.slice(2), payload.cwd);
  if (found === null) return;
  const { parsed, stateDir } = found;
  const hs = await import('../lib/hook-state.mjs');
  try {
    hs.appendRecord(stateDir, parsed, payload);
  } catch (err) {
    hs.appendHookError(stateDir, err, { event: payload.hook_event_name, session_id: payload.session_id });
  }
}

try {
  await main();
} catch {
  // Swallowed on purpose: the hook never fails a session.
}
process.exit(0);
