process.env.GVT_FLEET_FAKE_ONLY = '1';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTS_TIMEOUT_MS, createClaude } from '../plugin/cli/lib/claude-cli.mjs';

const cliUrl = pathToFileURL(fileURLToPath(new URL('../plugin/cli/lib/claude-cli.mjs', import.meta.url))).href;
const procUrl = pathToFileURL(fileURLToPath(new URL('../plugin/cli/lib/proc.mjs', import.meta.url))).href;

test('R157: agents() passes the 30000 ms time limit to run', async () => {
  const calls = [];
  const run = async (argv, opts) => {
    calls.push({ argv, opts });
    return { code: 0, stdout: '[]', stderr: '' };
  };
  const claude = createClaude({ run });
  const list = await claude.agents({ all: true });
  assert.deepEqual(list, []);
  assert.equal(AGENTS_TIMEOUT_MS, 30000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['claude', 'agents', '--json', '--all']);
  assert.equal(calls[0].opts?.timeoutMs, 30000);
});

test('R157: a timed-out run result (code 124) makes agents() throw a message with "timed out"', async () => {
  const run = async () => ({ code: 124, stdout: '', stderr: 'timed out after 30000 ms' });
  const claude = createClaude({ run });
  await assert.rejects(() => claude.agents(), /timed out/);
});

test('R157: with the real run and a child that never exits, agents() rejects within its limit', () => {
  // Run in a child process: a hang must fail this test, not stall the suite.
  const script = [
    'const [cliUrl, procUrl] = process.argv.slice(1);',
    'const { createClaude } = await import(cliUrl);',
    'const { run } = await import(procUrl);',
    "const hang = [process.execPath, '-e', 'setTimeout(() => {}, 60000)'];",
    'const claude = createClaude({ run: (argv, opts) => run(hang, opts), agentsTimeoutMs: 500 });',
    'const t0 = Date.now();',
    'try {',
    '  await claude.agents();',
    "  console.log('RESOLVED');",
    '} catch (err) {',
    "  console.log('REJECTED ' + (Date.now() - t0) + ' ' + err.message);",
    '}',
    'process.exit(0);',
  ].join('\n');
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, cliUrl, procUrl],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(res.error, undefined, `child did not finish: ${res.error}`);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^REJECTED \d+ .*timed out/m, res.stdout);
  const ms = Number(/^REJECTED (\d+)/m.exec(res.stdout)[1]);
  assert.ok(ms < 15000, `rejected after ${ms} ms`);
});
