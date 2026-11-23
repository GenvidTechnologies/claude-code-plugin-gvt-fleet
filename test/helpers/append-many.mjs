// Child script for the concurrency tests: node append-many.mjs <mode> <stateDir> <count> <id>
// mode is `append` (worker records) or `snapshot` (rate-limit snapshot writes).
// Writes nothing to stdout. A one-line summary of write outcomes goes to stderr.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(path.join(here, '..', '..', 'plugin', 'cli', 'lib', name)).href;

const [mode, stateDir, countArg, id] = process.argv.slice(2);
const count = Number(countArg);
if ((mode !== 'append' && mode !== 'snapshot') || !stateDir || !id || !Number.isInteger(count) || count < 0) {
  process.stderr.write(`append-many: bad arguments: ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}

if (mode === 'append') {
  const { appendRecord } = await import(lib('hook-state.mjs'));
  const { parseWorktreeCwd } = await import(lib('worktree-path.mjs'));
  const parsed = parseWorktreeCwd('C:\\tmp\\ws\\repos\\o\\n\\.claude\\worktrees\\n-1', 'C:/tmp/ws');
  const message = 'm'.repeat(1900);
  const pad = 'p'.repeat(900);
  for (let n = 0; n < count; n++) {
    appendRecord(stateDir, parsed, {
      hook_event_name: 'Stop',
      session_id: id,
      cwd: 'C:\\tmp\\ws\\repos\\o\\n\\.claude\\worktrees\\n-1',
      last_assistant_message: message,
      seq_key: `${id}:${n}`,
      pad,
    });
  }
} else {
  const { recordRateLimits } = await import(lib('rate-limits.mjs'));
  const outcomes = {};
  for (let n = 0; n < count; n++) {
    const result = recordRateLimits(stateDir, {
      session_id: id,
      rate_limits: {
        five_hour: { used_percentage: n % 100, resets_at: 1790000000 },
        seven_day: { used_percentage: 10, resets_at: 1790500000 },
      },
    });
    outcomes[result] = (outcomes[result] ?? 0) + 1;
  }
  process.stderr.write(`outcomes ${JSON.stringify(outcomes)}\n`);
}
