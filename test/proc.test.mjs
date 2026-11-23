process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const PROC_URL = new URL('../lib/proc.mjs', import.meta.url).href;

// git ls-remote against a local server that accepts and never answers. git starts git-remote-https, which
// keeps the pipes open after git itself is killed, so a runner that waits for 'close' never resolves.
// Measured on Windows with Node v24.11.1 before the fix: a node child that spawns a grandchild with
// stdio 'inherit' does not reproduce this, so the test uses the real git shape.
test('NF-proc: run resolves with code 124 soon after the timeout when a grandchild holds the pipes', (t) => {
  const dir = makeTempDir(t, 'gvt-fleet-proc-');
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, [
    "import net from 'node:net';",
    `import { run } from ${JSON.stringify(PROC_URL)};`,
    'const server = net.createServer((s) => { s.on("error", () => {}); });',
    "await new Promise((r) => server.listen(0, '127.0.0.1', r));",
    'const started = Date.now();',
    "const res = await run(['git', 'ls-remote', '--heads', 'https://127.0.0.1:' + server.address().port + '/x.git'], { timeoutMs: 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });",
    'const elapsed = Date.now() - started;',
    "if (res.code !== 124) { console.error('code ' + res.code); process.exit(2); }",
    "if (!/timed out after 1000 ms$/.test(res.stderr)) { console.error('stderr ' + res.stderr); process.exit(3); }",
    "if (elapsed > 10000) { console.error('elapsed ' + elapsed); process.exit(4); }",
    'process.exit(0);',
    '',
  ].join(String.fromCharCode(10)), 'utf8');
  const res = spawnSync(process.execPath, [probe], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.error, undefined, `the probe did not finish: ${res.error?.message}`);
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});

test('NF-proc: run without a timeout still collects all stdout and stderr', async () => {
  const { run } = await import(PROC_URL);
  const res = await run([process.execPath, '-e', "process.stdout.write('o'.repeat(200000)); process.stderr.write('e'); process.exitCode = 3"]);
  assert.equal(res.code, 3);
  assert.equal(res.stdout.length, 200000);
  assert.equal(res.stderr, 'e');
});
