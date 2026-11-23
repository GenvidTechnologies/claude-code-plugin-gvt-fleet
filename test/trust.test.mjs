process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TMP_INFIX } from '../lib/atomic-write.mjs';
import { ensureTrusted, normalizeKey, trustKey } from '../lib/trust.mjs';
import { makeTempDir, fwd } from './helpers/git-sandbox.mjs';

const NO_SLEEP = async () => {};

function setup(t, initial) {
  const root = makeTempDir(t, 'gvt-fleet-trust-');
  const workspace = `${fwd(root)}/ws/`;
  const folder = path.join(root, 'ws', 'repos', 'o', 'n');
  fs.mkdirSync(folder, { recursive: true });
  const claudeJson = path.join(root, 'claude.json');
  const text = JSON.stringify(initial, null, 2) + '\n';
  fs.writeFileSync(claudeJson, text, 'utf8');
  const stateDir = path.join(root, 'state');
  return { root, workspace, folder, claudeJson, stateDir, text };
}

test('R21: writes forward-slash uppercase-drive key and keeps existing entry keys', async (t) => {
  const s = setup(t, {
    zeta: 1,
    projects: {
      'c:/other/lowercase': { hasTrustDialogAccepted: false, keep: 'me' },
    },
    alpha: { nested: true },
  });
  const key = trustKey(s.folder);
  // Seed an existing entry for the same key with an unrelated field.
  const seeded = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  seeded.projects[key] = { allowedTools: ['x'], hasTrustDialogAccepted: false };
  fs.writeFileSync(s.claudeJson, JSON.stringify(seeded, null, 2) + '\n', 'utf8');

  const res = await ensureTrusted(s.folder, { ...s, sleep: NO_SLEEP });
  assert.equal(res.status, 'written');
  assert.equal(res.key, key);
  assert.match(key, /^[A-Z]:\//, 'uppercase drive, forward slash');
  assert.ok(!key.includes('\\'), 'no backslash');
  assert.ok(!key.endsWith('/'), 'no trailing slash');

  const after = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(after.projects[key], { allowedTools: ['x'], hasTrustDialogAccepted: true });
  assert.deepEqual(after.projects['c:/other/lowercase'], { hasTrustDialogAccepted: false, keep: 'me' });
  assert.deepEqual(after.alpha, { nested: true });
  assert.deepEqual(Object.keys(after), ['zeta', 'projects', 'alpha'], 'top-level key order kept');
  assert.ok(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), 'backup taken');
  assert.deepEqual(
    fs.readdirSync(path.dirname(s.claudeJson)).filter((n) => n.includes(TMP_INFIX)),
    [],
    'no temp file left',
  );
});

test('R21: refuses a path outside the workspace', async (t) => {
  const s = setup(t, { projects: {} });
  const outside = path.join(s.root, 'elsewhere');
  fs.mkdirSync(outside);
  const res = await ensureTrusted(outside, { ...s, sleep: NO_SLEEP });
  assert.equal(res.status, 'refused');
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), s.text, 'file unchanged');
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false, 'no backup');

  // A sibling whose name only shares the workspace prefix text is also outside.
  const sibling = path.join(s.root, 'ws-evil');
  fs.mkdirSync(sibling);
  const res2 = await ensureTrusted(sibling, { ...s, sleep: NO_SLEEP });
  assert.equal(res2.status, 'refused');
});

test('R21: retries when the entry is missing on re-read', async (t) => {
  const s = setup(t, { projects: {} });
  const key = trustKey(s.folder);
  let sleeps = 0;
  const sleep = async (ms) => {
    sleeps += 1;
    assert.equal(ms, 3000, 'default wait is 3 s');
    if (sleeps === 1) {
      // A second writer rewrites the file from its stale copy and drops the entry.
      fs.writeFileSync(s.claudeJson, JSON.stringify({ projects: {} }, null, 2) + '\n', 'utf8');
    }
  };
  const res = await ensureTrusted(s.folder, { ...s, sleep });
  assert.equal(res.status, 'written');
  assert.equal(res.attempts, 2);
  assert.equal(sleeps, 2);
  assert.equal(JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects[key].hasTrustDialogAccepted, true);

  // A writer that always drops the entry ends in failure after 1 write + 3 retries.
  const s2 = setup(t, { projects: {} });
  let n = 0;
  const res2 = await ensureTrusted(s2.folder, {
    ...s2,
    sleep: async () => {
      n += 1;
      fs.writeFileSync(s2.claudeJson, JSON.stringify({ projects: {} }) + '\n', 'utf8');
    },
  });
  assert.equal(res2.status, 'failed');
  assert.equal(res2.attempts, 4);
  assert.equal(n, 4);
});

test('R21: no write when already trusted', async (t) => {
  const s = setup(t, { projects: {} });
  const key = trustKey(s.folder);
  const text = JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }, null, 4);
  fs.writeFileSync(s.claudeJson, text, 'utf8');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(s.claudeJson, old, old);
  const mtime = fs.statSync(s.claudeJson).mtimeMs;

  let slept = false;
  const res = await ensureTrusted(s.folder, { ...s, sleep: async () => { slept = true; } });
  assert.equal(res.status, 'already-trusted');
  assert.equal(slept, false);
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), text);
  assert.equal(fs.statSync(s.claudeJson).mtimeMs, mtime);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false, 'no backup');
});

test('R21: refuses the workspace root itself', async (t) => {
  const s = setup(t, { projects: {} });
  const res = await ensureTrusted(path.join(s.root, 'ws'), { ...s, sleep: NO_SLEEP });
  assert.equal(res.status, 'refused');
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), s.text);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false);
});

test('R21: a missing .claude.json is not created and no backup is made', async (t) => {
  const s = setup(t, { projects: {} });
  fs.rmSync(s.claudeJson);
  const res = await ensureTrusted(s.folder, { ...s, sleep: NO_SLEEP });
  assert.equal(res.status, 'failed');
  assert.equal(fs.existsSync(s.claudeJson), false);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false);
});

test('R21: an unparsable .claude.json is left unchanged and no backup is made', async (t) => {
  const s = setup(t, { projects: {} });
  const broken = '{ "projects": ';
  fs.writeFileSync(s.claudeJson, broken, 'utf8');
  const res = await ensureTrusted(s.folder, { ...s, sleep: NO_SLEEP });
  assert.equal(res.status, 'failed');
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), broken);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false);
});

test('R21: normalizeKey turns backslashes, a lowercase drive and a trailing slash into the key form', () => {
  const bs = String.fromCharCode(92);
  const input = ['c:', 'work', 'fleet', 'repos', 'o', 'n', ''].join(bs);
  assert.ok(input.endsWith(bs) && input.startsWith('c:'));
  assert.equal(normalizeKey(input), 'C:/work/fleet/repos/o/n');
  assert.equal(normalizeKey('C:/already/fine'), 'C:/already/fine');
});
