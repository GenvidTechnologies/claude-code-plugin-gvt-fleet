process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScript } from './helpers/run-script.mjs';
import { passthrough, run } from '../plugin/cli/lib/proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'fixtures', 'passthrough-runner.mjs');
const fake = path.join(here, 'fixtures', 'fake-statusline.mjs');

test("R38: passthrough forwards stdin, inherits the child's output and returns its exit code", async () => {
  const input = '{"cwd":"C:\\\\x"}';
  const viaRunner = await runScript(runner, ['3'], { input });
  const direct = await runScript(fake, ['3'], { input });
  assert.equal(viaRunner.code, 3);
  assert.ok(viaRunner.stdout.length > 0);
  assert.ok(viaRunner.stdout.equals(direct.stdout));
  assert.equal(viaRunner.stderr.length, 0);

  const other = await runScript(runner, ['3'], { input: '{"cwd":"D:\\\\y"}' });
  assert.ok(!other.stdout.equals(viaRunner.stdout));

  assert.equal(await passthrough(['gvt-fleet-no-such-exe-xyz']), 127);
});

const helper = path.join(here, '..', 'plugin', 'cli', 'bin', 'gvt-fleet-statusline.mjs');

function linePayload(n) {
  const lines = fs.readFileSync(path.join(here, 'fixtures', 'probe-events.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  return JSON.parse(lines[n - 1]).payload;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-sl-'));
}

test("R38: the helper output and exit code equal the chained command's", async () => {
  const payload = linePayload(3);
  assert.equal(payload.rate_limits.five_hour.used_percentage, 34);
  const input = JSON.stringify(payload);
  const tmp = tmpDir();
  const stateDir = path.join(tmp, 'state');
  const direct = await runScript(fake, ['3'], { input });
  const viaHelper = await runScript(
    helper,
    ['--workspace', tmp, '--state-dir', stateDir, '--chain', process.execPath, fake, '3'],
    { input },
  );
  assert.equal(direct.code, 3);
  assert.equal(viaHelper.code, 3);
  assert.ok(direct.stdout.length > 0);
  assert.ok(viaHelper.stdout.equals(direct.stdout));
  assert.equal(viaHelper.stderr.length, 0);
  const snap = JSON.parse(fs.readFileSync(path.join(stateDir, 'rate-limits.json'), 'utf8'));
  assert.equal(snap.five_hour.used_percentage, 34);

  const other = await runScript(
    helper,
    ['--workspace', tmp, '--state-dir', stateDir, '--chain', process.execPath, fake, '3'],
    { input: JSON.stringify({ ...payload, cwd: 'D:/elsewhere' }) },
  );
  assert.ok(!other.stdout.equals(viaHelper.stdout));
});

test('R38: a snapshot failure leaves the output unchanged', async () => {
  const input = JSON.stringify(linePayload(3));
  const tmp = tmpDir();
  const good = await runScript(
    helper,
    ['--workspace', tmp, '--state-dir', path.join(tmp, 'state'), '--chain', process.execPath, fake, '3'],
    { input },
  );
  const blocker = path.join(tmp, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const bad = await runScript(
    helper,
    ['--workspace', tmp, '--state-dir', blocker, '--chain', process.execPath, fake, '3'],
    { input },
  );
  assert.ok(good.stdout.length > 0);
  assert.ok(bad.stdout.equals(good.stdout));
  assert.equal(bad.code, 3);
  assert.equal(bad.stderr.length, 0);
  assert.ok(fs.statSync(blocker).isFile());
});

test('R38: a helper with no chained command prints nothing and exits 0', async () => {
  const tmp = tmpDir();
  const stateDir = path.join(tmp, 'state');
  const r = await runScript(helper, ['--workspace', tmp, '--state-dir', stateDir], {
    input: JSON.stringify(linePayload(3)),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 0);
  assert.equal(r.stderr.length, 0);
});

test('R38: the helper starts the chained command when stdin never closes', async () => {
  const tmp = tmpDir();
  const esc = String.fromCharCode(27);
  const child = spawn(
    process.execPath,
    [helper, '--workspace', tmp, '--state-dir', path.join(tmp, 'state'), '--chain', process.execPath, fake, '0'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const out = [];
  child.stdout.on('data', (c) => out.push(c));
  const result = await new Promise((resolve) => {
    const killer = setTimeout(() => {
      child.kill();
      resolve({ code: 'timeout' });
    }, 6000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code });
    });
  });
  assert.equal(result.code, 0);
  assert.equal(Buffer.concat(out).toString('utf8'), `${esc}[36m-${esc}[0m`);
});

function spaceBatch() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet sp-'));
  const cmd = path.join(dir, 'p.cmd');
  fs.writeFileSync(cmd, '@echo ARGS=%*\r\n');
  return { dir, cmd };
}

test('R45: passthrough runs a batch file whose folder has a space', async (t) => {
  const { dir, cmd } = spaceBatch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const procUrl = pathToFileURL(path.join(here, '..', 'plugin', 'cli', 'lib', 'proc.mjs')).href;
  const wrapper = path.join(dir, 'wrap.mjs');
  fs.writeFileSync(
    wrapper,
    `import { passthrough } from ${JSON.stringify(procUrl)};\nprocess.exit(await passthrough([process.argv[2], 'ok']));\n`,
  );
  const r = await runScript(wrapper, [cmd]);
  assert.equal(r.stderr.toString('utf8'), '');
  assert.equal(r.stdout.toString('utf8').trim(), 'ARGS=ok');
  assert.equal(r.code, 0);
});

test('R45: run runs a batch file whose folder has a space', async (t) => {
  const { dir, cmd } = spaceBatch();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await run([cmd, 'ok']);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim(), 'ARGS=ok');
  assert.equal(r.code, 0);
});

test('NF-boundary: passthrough refuses gh and claude under GVT_FLEET_FAKE_ONLY', async () => {
  assert.equal(process.env.GVT_FLEET_FAKE_ONLY, '1');
  assert.equal(await passthrough(['gh', '--version']), 127);
  assert.equal(await passthrough(['claude', '--version']), 127);
  assert.equal(await passthrough([process.execPath, '-e', 'process.exit(5)']), 5);
});
