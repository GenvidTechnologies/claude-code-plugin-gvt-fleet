process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openCacheDb, CACHE_SCHEMA, CACHE_SCHEMA_VERSION } from '../lib/cache-db.mjs';
import { openClaimsDb, ClaimsVersionError, CLAIMS_SCHEMA, CLAIMS_SCHEMA_VERSION } from '../lib/claims-db.mjs';
import { buildGraph } from '../lib/graph.mjs';
import { computeReady } from '../lib/ready.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

// Imported after the filter above so the sqlite ExperimentalWarning stays swallowed.
const { DatabaseSync } = await import('node:sqlite');

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-db-'));

test('R8: cache.db with a different user_version is deleted and recreated empty', async () => {
  const file = path.join(tmp(), 'state', 'cache.db');
  const first = await openCacheDb(file);
  assert.equal(first.fresh, true);
  assert.equal(first.reason, 'missing');
  first.upsertIssue({ key: 'o/r#1', repo: 'o/r', number: 1, state: 'open' });
  first.close();

  const same = await openCacheDb(file);
  assert.equal(same.fresh, false);
  assert.equal(same.readIssues().length, 1);
  same.close();

  const other = await openCacheDb(file, { version: CACHE_SCHEMA_VERSION + 1 });
  assert.equal(other.fresh, true);
  assert.equal(other.reason, 'version-mismatch');
  assert.deepEqual(other.readIssues(), []);
  other.close();
});

test('R8: claims.db with a different user_version stops with an error and is kept', async () => {
  const file = path.join(tmp(), 'claims.db');
  const c = await openClaimsDb(file);
  c.immediate(() => c.putLease({ leaseId: 'L1', key: 'o/r#1', state: 'held' }));
  c.close();
  const before = fs.readFileSync(file);

  await assert.rejects(
    () => openClaimsDb(file, { version: 7 }),
    (err) => err instanceof ClaimsVersionError && err.found === CLAIMS_SCHEMA_VERSION && err.expected === 7 && err.message.includes(file),
  );
  assert.ok(fs.readFileSync(file).equals(before), 'file is byte-identical');
  const again = await openClaimsDb(file);
  assert.equal(again.getLease('L1').key, 'o/r#1');
  again.close();
});

test('R8: claims.db that has a foreign user_version and tables is not initialised over', async () => {
  const file = path.join(tmp(), 'claims.db');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE other (x); PRAGMA user_version = 41');
  raw.close();
  await assert.rejects(() => openClaimsDb(file), (err) => err instanceof ClaimsVersionError && err.found === 41);
});

test('R8: a version-1 claims.db with the pre-rename leases shape stops with ClaimsVersionError and is kept', async () => {
  const file = path.join(tmp(), 'claims.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claiming','held','failed','releasing','released')),
  claimed_at TEXT,
  heartbeat_at TEXT,
  expires_at TEXT,
  assignee_preexisting INTEGER,
  label_added INTEGER,
  session_id TEXT,
  short_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  wt_state TEXT,
  discard_consent INTEGER
);
CREATE INDEX leases_key ON leases (key);
CREATE UNIQUE INDEX leases_one_active ON leases (key) WHERE state IN ('claiming','held','releasing');
PRAGMA user_version = 1;
`);
  raw.close();
  const before = fs.readFileSync(file);

  await assert.rejects(
    () => openClaimsDb(file),
    (err) => err instanceof ClaimsVersionError && err.found === 1 && err.expected === 2,
  );
  assert.ok(fs.readFileSync(file).equals(before), 'file is byte-identical');
});

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const DIGEST_MESSAGE =
  'the schema changed or the version was bumped; bump the version and record the new digest in this table';

// Keyed by schema version. A version with no entry fails the assertion.
const CLAIMS_SCHEMA_DIGESTS = {
  2: '418d4cdabdaac824a0d549886044b4883082db4683b53df690356ab473e9a22f',
};
const CACHE_SCHEMA_DIGESTS = {
  2: '4a03fd6579de54b60903cef77bff2b773fa2d8015bf2e638716f48c55305065a',
};

test('R8: claims.db SCHEMA digest matches the one recorded for CLAIMS_SCHEMA_VERSION', () => {
  assert.equal(sha256(CLAIMS_SCHEMA), CLAIMS_SCHEMA_DIGESTS[CLAIMS_SCHEMA_VERSION], DIGEST_MESSAGE);
});

test('R8: cache.db SCHEMA digest matches the one recorded for CACHE_SCHEMA_VERSION', () => {
  assert.equal(sha256(CACHE_SCHEMA), CACHE_SCHEMA_DIGESTS[CACHE_SCHEMA_VERSION], DIGEST_MESSAGE);
});

test('R16: claims.db round-trips a lease row under BEGIN IMMEDIATE', async () => {
  const c = await openClaimsDb(path.join(tmp(), 'claims.db'));
  const lease = {
    leaseId: 'L1',
    key: 'o/r#1',
    state: 'held',
    claimedAt: '2026-11-03T10:00:00Z',
    heartbeatAt: '2026-11-03T10:05:00Z',
    expiresAt: '2026-11-03T11:00:00Z',
    assigneePreexisting: true,
    labelAdded: false,
    sessionId: 's-1',
    shortId: 'ab12',
    worktreePath: 'C:/work/fleet/repos/o/r/wt',
    branch: 'issue-1',
    wtState: 'created',
    discardHead: 'abc1234def',
  };
  c.immediate(() => c.putLease(lease));
  assert.deepEqual(c.getLease('L1'), lease);
  assert.deepEqual(c.getActiveLease('o/r#1'), lease);

  c.immediate(() => c.updateLease('L1', { state: 'released', wtState: null }));
  assert.equal(c.getActiveLease('o/r#1'), null);
  assert.equal(c.getLease('L1').state, 'released');
  assert.equal(c.getLease('L1').wtState, null);

  // A second active lease for the same key is refused; the failed write rolls back.
  c.immediate(() => c.putLease({ leaseId: 'L2', key: 'o/r#1', state: 'held' }));
  assert.equal(c.getLease('L2').assigneePreexisting, null, 'an undecided flag stays null, not false');
  assert.equal(c.getLease('L2').labelAdded, null);
  assert.equal(c.getLease('L2').discardHead, null);
  assert.throws(() =>
    c.immediate(() => {
      c.putLease({ leaseId: 'L3', key: 'o/r#9', state: 'held' });
      c.putLease({ leaseId: 'L4', key: 'o/r#1', state: 'claiming' });
    }),
  );
  assert.equal(c.getLease('L3'), null);
  assert.deepEqual(c.listLeases({ states: ['held'] }).map((l) => l.leaseId), ['L2']);
  c.close();
});

test('R5: cache.db round-trips an issue row in the shape ready.mjs reads', async () => {
  const db = await openCacheDb(path.join(tmp(), 'cache.db'));
  const row = {
    key: 'o/r#2',
    repo: 'o/r',
    number: 2,
    state: 'open',
    title: 'Do the thing',
    body: 'text',
    updatedAt: '2026-11-03T09:00:00Z',
    labels: ['triaged'],
    assignees: ['someone'],
    comments: [{ body: 'hi', createdAt: '2026-11-03T09:00:00Z' }],
    parent: 'o/r#1',
    subIssues: ['o/r#5'],
    blockedBy: ['o/r#3'],
    blocking: ['o/r#4'],
    closingPrs: [{ number: 9, state: 'OPEN' }],
    managed: true,
  };
  db.transaction(() => {
    db.upsertIssue(row);
    db.setRepoState('o/r', { hwm: '2026-11-03T09:00:00Z', defaultBranch: 'main' });
  });
  assert.deepEqual(db.readIssues(), [row]);
  assert.deepEqual(db.readIssues({ repo: 'x/y' }), []);

  const issues = db.readIssues();
  const graph = buildGraph(issues, { extract: () => ({ refs: [] }), config: { repos: [{ repo: 'o/r' }] } });
  const [entry] = computeReady({ issues, graph, config: { claimAccount: 'me', repos: [{ repo: 'o/r' }] }, now: '2026-11-03T12:00:00Z' });
  const codes = entry.reasons.map((r) => r.code);
  assert.ok(codes.includes('assigned-to-other'));
  assert.ok(codes.includes('closing-pr'));
  assert.ok(codes.includes('blocked-by'));
  db.close();
});

test('R5: cache.db upserts replace by key and a failed transaction rolls back with the high-water mark', async () => {
  const db = await openCacheDb(path.join(tmp(), 'cache.db'));
  db.upsertIssue({ key: 'o/r#1', repo: 'o/r', number: 1, state: 'open', title: 'old' });
  assert.throws(() =>
    db.transaction(() => {
      db.upsertIssue({ key: 'o/r#1', repo: 'o/r', number: 1, state: 'closed', title: 'new' });
      db.setRepoState('o/r', { hwm: 'T1' });
      throw new Error('page failed');
    }),
  );
  assert.equal(db.readIssues()[0].title, 'old');
  assert.equal(db.getRepoState('o/r'), null);

  db.transaction(() => {
    db.upsertIssue({ key: 'o/r#1', repo: 'o/r', number: 1, state: 'closed', title: 'new' });
    db.setRepoState('o/r', { hwm: 'T1', bugTracker: 'text' });
    db.setRepoState('o/r', { lastFullSync: 'T2' });
  });
  assert.equal(db.readIssues()[0].title, 'new');
  assert.deepEqual(db.getRepoState('o/r'), {
    repo: 'o/r',
    hwm: 'T1',
    lastFullSync: 'T2',
    bugTracker: 'text',
    overlay: null,
    defaultBranch: null,
  });
  assert.equal(db.deleteIssuesNotIn('o/r', []), 1);
  db.close();
});

test('R5: cache.db stores remote branch heads per repo and yields the remoteHeads map', async () => {
  const db = await openCacheDb(path.join(tmp(), 'cache.db'));
  db.replaceBranchHeads('o/r', [
    { name: 'main', headOid: 'aaa', lastCommitDate: '2026-11-01T00:00:00Z' },
    { name: 'issue-1', headOid: 'bbb', lastCommitDate: '2026-11-02T00:00:00Z' },
  ]);
  db.replaceBranchHeads('o/r', [{ name: 'main', headOid: 'ccc', lastCommitDate: '2026-11-03T00:00:00Z' }]);
  assert.deepEqual(db.readBranchHeads('o/r'), [{ name: 'main', headOid: 'ccc', lastCommitDate: '2026-11-03T00:00:00Z' }]);
  assert.deepEqual(db.remoteHeads(), { 'o/r': ['main'] });
  db.close();
});

test('R16: claims.db immediate() holds the write lock, so a second BEGIN IMMEDIATE fails with SQLITE_BUSY', async () => {
  const file = path.join(tmp(), 'claims.db');
  const c = await openClaimsDb(file);
  const other = new DatabaseSync(file);
  other.exec('PRAGMA busy_timeout = 0');
  let busy = null;
  c.immediate(() => {
    try {
      other.exec('BEGIN IMMEDIATE');
      other.exec('ROLLBACK');
    } catch (e) {
      busy = e;
    }
  });
  assert.ok(busy, 'the second connection could not take the write lock while immediate() ran');
  assert.equal(busy.errcode, 5, busy.message);
  other.exec('BEGIN IMMEDIATE'); // free again after the commit
  other.exec('ROLLBACK');
  other.close();
  c.close();
});

test('R8: a freshly initialised claims.db and cache.db open a second time without error', async () => {
  const dir = tmp();
  const c1 = await openClaimsDb(path.join(dir, 'claims.db'));
  const c2 = await openClaimsDb(path.join(dir, 'claims.db'));
  assert.deepEqual(c2.listLeases(), []);
  c1.close();
  c2.close();
  const k1 = await openCacheDb(path.join(dir, 'cache.db'));
  assert.equal(k1.fresh, true);
  k1.close();
  const k2 = await openCacheDb(path.join(dir, 'cache.db'));
  assert.equal(k2.fresh, false);
  k2.close();
  const raw = new DatabaseSync(path.join(dir, 'claims.db'));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, CLAIMS_SCHEMA_VERSION);
  raw.close();
});

test('R5: cache.db upsertExternal updates state, title and updatedAt and keeps the other columns of an existing row', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  cache.upsertIssue({
    key: 'o/r#1',
    repo: 'o/r',
    number: 1,
    state: 'open',
    title: 'old',
    body: 'kept body',
    updatedAt: '2026-11-01T00:00:00Z',
    labels: ['triaged'],
    comments: [{ body: 'c', createdAt: '2026-11-01T00:00:00Z' }],
    blockedBy: ['x/y#2'],
    managed: true,
  });
  cache.upsertExternal({ key: 'o/r#1', repo: 'o/r', number: 1, state: 'closed', title: 'new', updatedAt: '2026-11-02T00:00:00Z', managed: false });
  cache.upsertExternal({ key: 'x/y#2', repo: 'x/y', number: 2, state: 'open', title: 'ext', updatedAt: '2026-11-02T00:00:00Z', managed: false });
  const rows = new Map(cache.readIssues().map((r) => [r.key, r]));
  const one = rows.get('o/r#1');
  assert.equal(one.state, 'closed');
  assert.equal(one.title, 'new');
  assert.equal(one.updatedAt, '2026-11-02T00:00:00Z');
  assert.equal(one.body, 'kept body');
  assert.deepEqual(one.labels, ['triaged']);
  assert.deepEqual(one.blockedBy, ['x/y#2']);
  assert.equal(one.managed, true);
  assert.equal(rows.get('x/y#2').managed, false);
  assert.deepEqual(rows.get('x/y#2').labels, []);
  cache.close();
});

test('R145: setIssueLabels replaces the labels of a cached row, keeps its other columns, and returns 0 for a key not in the cache', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const row = {
    key: 'o/r#7',
    repo: 'o/r',
    number: 7,
    state: 'open',
    title: 'seven',
    body: 'seven body',
    updatedAt: '2026-01-02T00:00:00Z',
    labels: ['old'],
    assignees: ['alice'],
    comments: ['c1'],
    parent: 'o/r#1',
    subIssues: ['o/r#8'],
    blockedBy: ['x/y#2'],
    blocking: ['o/r#9'],
    closingPrs: ['o/r#10'],
    managed: true,
  };
  cache.upsertIssue(row);
  const before = cache.readIssues()[0];
  assert.deepEqual(before.labels, ['old']);

  let changed;
  try {
    changed = cache.setIssueLabels('o/r#7', ['triaged', 'p1']);
  } catch (err) {
    assert.fail(`setIssueLabels threw: ${err.message}`);
  }
  assert.equal(changed, 1);
  const after = cache.readIssues();
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].labels, ['triaged', 'p1']);
  assert.deepEqual({ ...after[0], labels: null }, { ...before, labels: null });
  assert.equal(after[0].managed, true);

  assert.equal(cache.setIssueLabels('o/r#999', ['x']), 0);
  assert.equal(cache.readIssues().length, 1);
  cache.close();
});
