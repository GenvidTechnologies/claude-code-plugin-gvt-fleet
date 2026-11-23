process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimError, parseClaimRef, parseWorkerRef } from '../plugin/cli/lib/claims.mjs';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import {
  MAX_SLUG_LENGTH,
  TASK_SLUG_RE,
  WORKTREE_NAME_RE,
  checkTaskSlug,
  maxSlugLength,
  parseLeaseKey,
  parseTaskWorktreeName,
  taskKey,
  taskNames,
} from '../plugin/cli/lib/worker-key.mjs';
import { parseWorktreeCwd } from '../plugin/cli/lib/worktree-path.mjs';
import { seedTaskLease } from './helpers/dispatch-sandbox.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const CONFIG = {
  repos: [{ repo: 'acme/app' }, { repo: 'example-org/a-long-repository-name-for-the-tests' }],
};
const LONG = 'example-org/a-long-repository-name-for-the-tests';
const TASK = { slug: 'triage-pass', date: '20261108', n: 1 };

test('R148: taskNames gives <short>.<slug>.<date>.<n> that matches WORKTREE_NAME_RE', () => {
  const r = taskNames('acme/app', TASK, { base: '/b', config: CONFIG });
  assert.equal(r.name, 'app.triage-pass.20261108.1');
  assert.equal(r.branch, 'worktree-app.triage-pass.20261108.1');
  assert.equal(r.path, path.join('/b', '.claude', 'worktrees', 'app.triage-pass.20261108.1'));
  assert.match(r.name, WORKTREE_NAME_RE);
  assert.equal(taskNames('acme/app', TASK).path, undefined);
  assert.equal(taskKey('acme/app', TASK), 'acme/app@triage-pass.20261108.1');
  assert.match('triage-pass', TASK_SLUG_RE);
  assert.doesNotMatch('Triage_Pass', TASK_SLUG_RE);
});

test('R148: parseLeaseKey classifies issue, task and unreadable keys without throwing', () => {
  assert.deepEqual(parseLeaseKey('acme/app#12'), { kind: 'issue', repo: 'acme/app', owner: 'acme', repoName: 'app', number: 12 });
  assert.deepEqual(parseLeaseKey('acme/app@triage-pass.20261108.3'), {
    kind: 'task',
    repo: 'acme/app',
    owner: 'acme',
    repoName: 'app',
    slug: 'triage-pass',
    date: '20261108',
    n: 3,
  });
  for (const bad of ['', 'acme/app', 'acme/app#0', 'acme/app@Bad.20261108.1', 'acme/app@x.2026.1', null, undefined, 5, {}]) {
    assert.equal(parseLeaseKey(bad), null, String(bad));
  }
});

test('R148: parseWorktreeCwd gives issue null for a task worktree and the name does not end in -<digits>', () => {
  const name = taskNames('acme/app', TASK, { config: CONFIG }).name;
  assert.doesNotMatch(name, /-[0-9]+$/);
  const cwd = `C:/ws/repos/acme/app/.claude/worktrees/${name}`;
  const parsed = parseWorktreeCwd(cwd, 'C:/ws');
  assert.ok(parsed, 'the path is inside a managed worktree');
  assert.equal(parsed.issue, null);
  assert.equal(parsed.worktree, name);
});

test('R148: parseTaskWorktreeName round-trips taskNames and ignores other names', () => {
  const name = taskNames('acme/app', TASK, { config: CONFIG }).name;
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', name), taskKey('acme/app', TASK));
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', name.toUpperCase().replace(/^APP/, 'App')), null, 'only the short name is case-insensitive');
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', 'App.triage-pass.20261108.1'), taskKey('acme/app', TASK));
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', 'app-12'), null);
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', 'other.triage-pass.20261108.1'), null);
  assert.equal(parseTaskWorktreeName(CONFIG, 'acme/app', 'app.triage-pass.2026.1'), null);
});

test('R148: parseWorkerRef accepts short@ and owner/name@ task refs and delegates issue refs', () => {
  const want = 'acme/app@triage-pass.20261108.1';
  assert.deepEqual(parseWorkerRef('app@triage-pass.20261108.1', CONFIG), { repo: 'acme/app', key: want, kind: 'task', slug: 'triage-pass', date: '20261108', n: 1 });
  assert.equal(parseWorkerRef('acme/app@triage-pass.20261108.1', CONFIG).key, want);
  assert.deepEqual(parseWorkerRef('app#5', CONFIG), parseClaimRef('app#5', CONFIG));
});

test('R148: parseWorkerRef refuses an unknown repo with exit 64', () => {
  for (const ref of ['nope@triage-pass.20261108.1', 'x/nope@triage-pass.20261108.1']) {
    assert.throws(
      () => parseWorkerRef(ref, CONFIG),
      (err) => err instanceof ClaimError && err.exitCode === 64,
      ref,
    );
  }
});

test('R148: a 36-character short name allows a 16-character slug and a 17-character slug overflows 64', () => {
  assert.equal(maxSlugLength(LONG, CONFIG), 16);
  assert.equal(maxSlugLength('acme/app', CONFIG), MAX_SLUG_LENGTH);
  assert.equal(MAX_SLUG_LENGTH, 24);
  const fits = taskNames(LONG, { slug: 'a'.repeat(16), date: '20261108', n: 1 }, { config: CONFIG }).name;
  assert.equal(fits.length, 64);
  assert.match(fits, WORKTREE_NAME_RE);
  const over = taskNames(LONG, { slug: 'a'.repeat(17), date: '20261108', n: 1 }, { config: CONFIG }).name;
  assert.equal(over.length, 65);
  assert.doesNotMatch(over, WORKTREE_NAME_RE);
  assert.equal(checkTaskSlug(LONG, 'a'.repeat(16), CONFIG), null);
  assert.match(checkTaskSlug(LONG, 'a'.repeat(17), CONFIG), /maximum is 16/);
  assert.match(checkTaskSlug('acme/app', 'a'.repeat(25), CONFIG), /maximum is 24/);
  assert.match(checkTaskSlug('acme/app', 'Bad_Slug', CONFIG), /lowercase/);
});

test('R148: seedTaskLease stores a held task lease with a future expiry', async (t) => {
  const dir = makeTempDir(t, 'gvt-fleet-worker-key-');
  const claims = await openClaimsDb(path.join(dir, 'claims.db'));
  try {
    seedTaskLease(claims, { repo: 'acme/app', ...TASK });
    seedTaskLease(claims, { repo: 'acme/app', ...TASK, n: 2, state: 'released' });
    const key = taskKey('acme/app', TASK);
    const active = claims.getActiveLease(key);
    assert.equal(active.state, 'held');
    assert.ok(Date.parse(active.expiresAt) > Date.now());
    assert.equal(parseLeaseKey(active.key).kind, 'task');
    assert.equal(claims.listLeases().length, 2);
  } finally {
    claims.close();
  }
});

test('R148: lib/worker-key.mjs and lib/worktrees.mjs both resolve the short name through repoShortName', () => {
  for (const f of ['../plugin/cli/lib/worker-key.mjs', '../plugin/cli/lib/worktrees.mjs']) {
    const text = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(text, /\brepoShortName\(/, f);
  }
});
