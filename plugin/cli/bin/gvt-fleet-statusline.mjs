// Status-line helper: runs the user's original status-line command and records the account-wide
// rate limits from the same payload.
//
// The bytes Claude Code shows are the chained command's own output, untouched. Recording the limits
// is a side effect whose failure must never change the display. This script never writes to stdout
// or stderr itself, and it exits with the chained command's exit code.
//
// Order: stdin is read first, bounded to 2000 ms (what was read is kept). Then the chained command
// starts with that input, and the snapshot is written while it runs. The snapshot is skipped when
// the input does not parse.
//
// Usage: node gvt-fleet-statusline.mjs [--workspace W] [--state-dir S] --chain <command> [args...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from '../lib/worktree-path.mjs';
import { passthrough } from '../lib/proc.mjs';
import { recordRateLimits } from '../lib/rate-limits.mjs';

let childCode = null;
const bail = () => process.exit(childCode ?? 0);
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

const READ_LIMIT_MS = 2000;

/**
 * Reads all of stdin as a Buffer. After READ_LIMIT_MS it stops reading and returns what was read.
 * An error counts as empty input.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(buf);
    };
    const timer = setTimeout(() => {
      try {
        process.stdin.destroy();
      } catch {
        // Ignored: the input is whatever was read so far.
      }
      finish(Buffer.concat(chunks));
    }, READ_LIMIT_MS);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => finish(Buffer.concat(chunks)));
    process.stdin.on('error', () => finish(Buffer.alloc(0)));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--chain');
  const own = at >= 0 ? argv.slice(0, at) : argv;
  const chain = at >= 0 ? argv.slice(at + 1) : [];
  const { stateDir } = resolveWorkspace({
    argv: own,
    scriptPath: path.resolve(fileURLToPath(import.meta.url)),
  });
  const input = await readStdin();
  const running = chain.length > 0 ? passthrough(chain, { input }) : null;
  try {
    recordRateLimits(stateDir, JSON.parse(input.toString('utf8')));
  } catch {
    // Swallowed on purpose: the display never depends on the snapshot.
  }
  if (running !== null) childCode = await running;
}

try {
  await main();
} catch {
  // Swallowed on purpose.
}
process.exit(childCode ?? 0);
