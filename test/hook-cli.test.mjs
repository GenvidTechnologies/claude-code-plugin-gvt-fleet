process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScript, rebase } from './helpers/run-script.mjs';
import { parseWorktreeCwd } from '../plugin/cli/lib/worktree-path.mjs';
import { workerFile } from '../plugin/cli/lib/hook-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'plugin', 'cli');
const HOOK = path.join(CLI, 'bin', 'gvt-fleet-hook.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'probe-events.jsonl');
const FIXTURE_ROOT = 'C:\\work\\fleet';

const events = fs
  .readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

function tempDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-hook-'));
}

const inScope = (e) => /\\\.claude\\worktrees\\probe/.test(e.payload.cwd);
const firstInScope = (label) => events.find((e) => e.label === label && inScope(e));

function hookArgs(workspace, stateDir) {
  return ['--workspace', workspace, '--state-dir', stateDir];
}

function runHook(payload, workspace, stateDir) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return runScript(HOOK, hookArgs(workspace, stateDir), { input });
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

// --- import closure walker -------------------------------------------------

const STATIC_RE = /\bimport\s*(?:[^'"();]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripComments(src) {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

function specifiers(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const staticSpecs = [...src.matchAll(STATIC_RE)].map((m) => m[1]);
  const dynamicSpecs = [...src.matchAll(DYNAMIC_RE)].map((m) => m[1]);
  return { staticSpecs, dynamicSpecs };
}

function closure(entry) {
  const seen = new Set();
  const found = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const { staticSpecs, dynamicSpecs } = specifiers(file);
    for (const spec of [...staticSpecs, ...dynamicSpecs]) {
      if (spec.startsWith('node:')) {
        found.add(spec);
      } else if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(fs.existsSync(target), `cannot resolve ${spec} imported by ${file}`);
        found.add(path.relative(CLI, target).split(path.sep).join('/'));
        visit(target);
      } else {
        assert.fail(`unsupported specifier ${spec} in ${file}`);
      }
    }
  };
  visit(entry);
  return found;
}

// --- tests -----------------------------------------------------------------

test('R26: the hook exits 0 and creates no state for an out-of-scope cwd', async () => {
  const tmp = tempDir();
  const stateDir = path.join(tmp, 'state');
  const line2 = events[1];
  assert.equal(line2.label, 'SessionStart');
  assert.equal(parseWorktreeCwd(line2.payload.cwd, 'C:/work/fleet'), null);
  const r = await runHook(line2.payload, 'C:/work/fleet', stateDir);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(stateDir), false);
});

test('R28: the hook import closure has no database, process or git module', () => {
  const found = closure(HOOK);
  assert.deepEqual(
    [...found].sort(),
    ['lib/hook-state.mjs', 'lib/worktree-path.mjs', 'node:fs', 'node:path', 'node:url'],
  );
});

test('R29: empty, non-JSON and cwd-less stdin exit 0 and write nothing', async () => {
  const tmp = tempDir();
  const stateDir = path.join(tmp, 'state');
  for (const input of ['', 'not json', JSON.stringify({ hook_event_name: 'Stop', session_id: 's' })]) {
    const r = await runHook(input, tmp, stateDir);
    assert.equal(r.code, 0);
  }
  assert.equal(fs.existsSync(stateDir), false);
});

test('R30: each of the five events from a fixture writes one record with the common fields', async () => {
  const tmp = tempDir();
  const stateDir = path.join(tmp, 'state');
  const payloads = ['SessionStart', 'Notification', 'Stop', 'SessionEnd'].map((label) => {
    const e = firstInScope(label);
    assert.ok(e, `fixture has an in-scope ${label}`);
    return rebase(e.payload, FIXTURE_ROOT, tmp);
  });
  payloads.push({
    session_id: payloads[0].session_id,
    cwd: payloads[0].cwd,
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    error_details: '429 Too Many Requests',
    last_assistant_message: 'API Error: Rate limit reached',
  });
  const files = new Set();
  for (const p of payloads) {
    const parsed = parseWorktreeCwd(p.cwd, tmp);
    assert.ok(parsed, `rebased cwd is in scope: ${p.cwd}`);
    files.add(workerFile(stateDir, parsed));
    const r = await runHook(p, tmp, stateDir);
    assert.equal(r.code, 0);
  }
  const records = [...files].flatMap(readLines);
  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((r) => r.event).sort(),
    ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'],
  );
  for (const rec of records) {
    assert.equal(rec.v, 1);
    assert.equal(typeof rec.recorded_at, 'string');
    assert.equal(typeof rec.session_id, 'string');
    assert.equal(typeof rec.cwd, 'string');
    assert.equal(rec.repo, 'probe/sandbox');
    assert.match(rec.worktree, /^probe/);
    assert.equal(rec.issue, null);
  }
});

test('NF-hookcost: the out-of-scope path imports only node built-ins and the path module', () => {
  const hook = specifiers(HOOK);
  // node:fs checks that a workspace worked out from the session folder holds config/repos.json (ADR 0021).
  assert.deepEqual([...hook.staticSpecs].sort(), ['../lib/worktree-path.mjs', 'node:fs', 'node:path', 'node:url']);
  const wp = specifiers(path.join(CLI, 'lib', 'worktree-path.mjs'));
  assert.ok(wp.staticSpecs.length > 0);
  assert.deepEqual(wp.dynamicSpecs, []);
  for (const s of wp.staticSpecs) assert.ok(s.startsWith('node:'), `worktree-path imports ${s}`);
  assert.deepEqual(hook.dynamicSpecs, ['../lib/hook-state.mjs']);
  assert.ok(!hook.staticSpecs.some((s) => s.includes('hook-state')));
});

test('NF-hookquiet: the hook writes nothing to stdout or stderr for in-scope, out-of-scope and broken input', async () => {
  const tmp = tempDir();
  const stateDir = path.join(tmp, 'state');
  const inScopePayload = rebase(firstInScope('Stop').payload, FIXTURE_ROOT, tmp);
  const outOfScope = events[1].payload;
  for (const input of [JSON.stringify(inScopePayload), JSON.stringify(outOfScope), 'not json']) {
    const r = await runHook(input, tmp, stateDir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr.length, 0);
  }
});

test('NF-hooksafe: the hook exits 0 when the state folder cannot be written', async () => {
  const tmp = tempDir();
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'a regular file, not a folder');
  const payload = rebase(firstInScope('Stop').payload, FIXTURE_ROOT, tmp);
  const r = await runHook(payload, tmp, blocker);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 0);
  assert.equal(r.stderr.length, 0);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['blocker']);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'a regular file, not a folder');
});

test('NF-hooksafe: the hook exits 0 when stdin never closes', async () => {
  const tmp = tempDir();
  const result = await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...hookArgs(tmp, path.join(tmp, 'state'))], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {});
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, 6000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, ms: Date.now() - started });
    });
  });
  assert.equal(result.killed, false, 'the hook was still running after 6000 ms');
  assert.equal(result.code, 0);
  assert.ok(result.ms < 6000);
  assert.equal(fs.existsSync(path.join(tmp, 'state')), false);
});
