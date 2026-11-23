process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCacheDb } from '../lib/cache-db.mjs';
import { GhError } from '../lib/gh.mjs';
import { buildGraph } from '../lib/graph.mjs';
import { computeReady } from '../lib/ready.mjs';
import { loadRefsGrammar } from '../lib/plugin-path.mjs';
import { run } from '../lib/proc.mjs';
import { applyOverlays, readClosingPrs, runSync } from '../lib/sync.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'graphql', name), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-sync-'));
const { extract } = await loadRefsGrammar();

const NOW = new Date('2026-11-03T12:00:00.000Z');
const config = {
  version: 1,
  claimAccount: 'me',
  leaseMinutes: 120,
  rateReserve: 1000,
  fullSyncHours: 24,
  repos: [{ repo: 'acme/app' }],
};

function fakeClock() {
  const sleeps = [];
  return { sleeps, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) };
}

// Reply to a SyncExternal query from the external.json fixture, keyed by the aliased owner/name/number.
function externalReply(_vars, query) {
  const data = {};
  const re = /(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issueOrPullRequest\(number: (\d+)\)/g;
  const nodes = fx('external.json');
  for (const m of query.matchAll(re)) {
    const node = nodes[`${m[2]}/${m[3]}#${m[4]}`];
    data[m[1]] = { issueOrPullRequest: node ?? null };
  }
  data.rateLimit = { cost: 1, remaining: 4880, resetAt: '2026-11-03T13:00:00Z' };
  return { data };
}

function script(overrides = {}) {
  return {
    SyncRepoMeta: fx('repo-meta.json'),
    SyncIssues: fx('issues-full.json'),
    SyncExternal: externalReply,
    ...overrides,
  };
}

async function openAt(file, seed) {
  const first = await openCacheDb(file);
  if (seed) seed(first);
  first.close();
  return openCacheDb(file); // not fresh: an existing file at the current version
}

const sync = (gh, cache, extra = {}, clock = fakeClock()) => runSync({ gh, clock, config }, { cache, extract, ...extra });

const issueCalls = (gh) => gh.calls.filter((c) => c.key === 'SyncIssues');

test('R4: incremental sync passes since = high-water mark minus overlap', async () => {
  const file = path.join(tmp(), 'cache.db');
  const cache = await openAt(file, (c) => c.setRepoState('acme/app', { hwm: '2026-11-01T10:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' }));
  const gh = createFakeGh(script({ SyncIssues: fx('issues-incremental.json') }));
  const summary = await sync(gh, cache);
  assert.equal(summary.repos[0].mode, 'incremental');
  assert.equal(issueCalls(gh).length, 1);
  assert.equal(issueCalls(gh)[0].vars.since, '2026-11-01T09:58:00.000Z');
  assert.match(issueCalls(gh)[0].query, /filterBy: \{since: \$since\}/);
  cache.close();
});

test('R4: missing or version-mismatched cache triggers full resync', async () => {
  const file = path.join(tmp(), 'cache.db');
  // Missing file: the first open creates it.
  const missing = await openCacheDb(file);
  assert.equal(missing.reason, 'missing');
  const gh1 = createFakeGh(script());
  const s1 = await sync(gh1, missing);
  assert.equal(s1.repos[0].mode, 'full');
  assert.equal(s1.repos[0].reason, 'missing');
  assert.equal(issueCalls(gh1)[0].vars.since, undefined);
  assert.doesNotMatch(issueCalls(gh1)[0].query, /filterBy/);
  assert.ok(missing.getRepoState('acme/app').hwm, 'the full sync set a high-water mark');
  missing.close();
  // A cache written at another schema version is recreated, and the repo is synced in full again.
  const stale = await openCacheDb(file, { version: 99 });
  assert.equal(stale.reason, 'version-mismatch');
  assert.equal(stale.readIssues().length, 0);
  const gh2 = createFakeGh(script());
  const s2 = await sync(gh2, stale);
  assert.equal(s2.repos[0].mode, 'full');
  assert.equal(s2.repos[0].reason, 'version-mismatch');
  assert.doesNotMatch(issueCalls(gh2)[0].query, /filterBy/);
  stale.close();
});

test('R5: stored issue keeps labels, assignees, comments, parent, sub-issues, blockedBy, blocking and closing PRs', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  await sync(createFakeGh(script()), cache);
  const row = cache.readIssues().find((r) => r.key === 'acme/app#1');
  assert.deepEqual(row.labels, ['triaged', 'bug']);
  assert.deepEqual(row.assignees, ['me']);
  assert.deepEqual(row.comments, [{ body: 'first comment', createdAt: '2026-11-01T08:00:00Z' }]);
  assert.equal(row.parent, 'acme/app#2');
  assert.deepEqual(row.subIssues, ['acme/app#4']);
  assert.deepEqual(row.blockedBy, ['ext/lib#7']);
  assert.deepEqual(row.blocking, ['acme/app#3']);
  assert.deepEqual(row.closingPrs, [{ number: 11, state: 'OPEN', headRefName: 'fix-1', repo: 'acme/app' }]);
  assert.equal(row.state, 'open');
  assert.equal(row.managed, true);
  assert.deepEqual(
    cache.readBranchHeads('acme/app').map((h) => h.name),
    ['feature-x', 'main'],
  );
  cache.close();
});

test('R6: blocker outside managed repos is looked up and stored', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const gh = createFakeGh(script());
  const summary = await sync(gh, cache);
  const ext = gh.calls.filter((c) => c.key === 'SyncExternal');
  assert.equal(ext.length, 1);
  assert.match(ext[0].query, /owner: "ext", name: "lib"\) \{ issueOrPullRequest\(number: 7\)/);
  assert.match(ext[0].query, /issueOrPullRequest\(number: 8\)/);
  const rows = new Map(cache.readIssues().map((r) => [r.key, r]));
  assert.equal(rows.get('ext/lib#7').state, 'open');
  assert.equal(rows.get('ext/lib#7').managed, false);
  assert.equal(rows.get('ext/lib#8').state, 'closed');
  assert.equal(summary.external, 2);
  cache.close();
});

// A row the way an earlier sync stored it, when its repo was still in the config.
const staleManaged = (key, state = 'open') => {
  const [repo, n] = key.split('#');
  return { key, repo, number: Number(n), state, title: `stale ${key}`, updatedAt: '2026-10-01T00:00:00Z', managed: true };
};

test('R113: sync leaves no managed row of a repo that is not in the config', async () => {
  const file = path.join(tmp(), 'cache.db');
  // An incremental sync of acme/app: the cleanup does not depend on a full sync.
  const cache = await openAt(file, (c) => {
    c.setRepoState('acme/app', { hwm: '2026-11-01T10:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' });
    c.upsertIssue(staleManaged('acme/old-name#5'));
    c.upsertIssue(staleManaged('acme/old-name#6', 'closed'));
  });
  const summary = await sync(createFakeGh(script({ SyncIssues: fx('issues-incremental.json') })), cache);
  assert.equal(summary.repos[0].mode, 'incremental');
  assert.deepEqual(cache.readIssues({ repo: 'acme/old-name', managedOnly: true }), []);
  // The configured repo keeps its managed rows.
  assert.ok(cache.readIssues({ repo: 'acme/app', managedOnly: true }).length > 0);
  cache.close();
});

test('R113: a referenced issue of a repo that left the config is still looked up, as not managed', async () => {
  const file = path.join(tmp(), 'cache.db');
  // ext/lib#7 blocks acme/app#1 and was stored as managed while ext/lib was in the config.
  const cache = await openAt(file, (c) => c.upsertIssue(staleManaged('ext/lib#7')));
  const gh = createFakeGh(script());
  await sync(gh, cache);
  const ext = gh.calls.filter((c) => c.key === 'SyncExternal');
  assert.equal(ext.length, 1);
  assert.match(ext[0].query, /owner: "ext", name: "lib"\) \{ issueOrPullRequest\(number: 7\)/);
  const row = cache.readIssues().find((r) => r.key === 'ext/lib#7');
  assert.ok(row, 'the referenced row is kept');
  assert.equal(row.managed, false);
  assert.equal(row.title, 'External open blocker');
  cache.close();
});

test('R7: incremental query requests OPEN and CLOSED states', async () => {
  const file = path.join(tmp(), 'cache.db');
  const cache = await openAt(file, (c) => c.setRepoState('acme/app', { hwm: '2026-11-01T10:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' }));
  const gh = createFakeGh(script({ SyncIssues: fx('issues-incremental.json') }));
  await sync(gh, cache);
  assert.match(issueCalls(gh)[0].query, /states: \[OPEN, CLOSED\]/);
  cache.close();
  // A full sync reads open issues only.
  const full = await openCacheDb(path.join(tmp(), 'cache.db'));
  const gh2 = createFakeGh(script());
  await sync(gh2, full);
  assert.match(issueCalls(gh2)[0].query, /states: \[OPEN\]/);
  assert.doesNotMatch(issueCalls(gh2)[0].query, /CLOSED/);
  full.close();
});

test('R7: issue closed upstream updates cached state to closed', async () => {
  const file = path.join(tmp(), 'cache.db');
  const first = await openCacheDb(file);
  await sync(createFakeGh(script()), first);
  assert.equal(first.readIssues().find((r) => r.key === 'acme/app#4').state, 'open');
  first.close();
  const second = await openCacheDb(file);
  assert.equal(second.fresh, false);
  const gh = createFakeGh(script({ SyncIssues: fx('issues-incremental.json') }));
  const summary = await sync(gh, second);
  assert.equal(summary.repos[0].mode, 'incremental');
  const row = second.readIssues().find((r) => r.key === 'acme/app#4');
  assert.equal(row.state, 'closed');
  assert.equal(row.updatedAt, '2026-11-03T11:00:00Z');
  second.close();
});

test('R8: deleting cache.db and re-syncing yields the same ready set', async () => {
  const dir = tmp();
  const file = path.join(dir, 'cache.db');
  const readySet = (cache) => {
    const rows = cache.readIssues();
    const graph = buildGraph(rows, { extract, config });
    const entries = computeReady({ issues: rows, graph, claims: [], branchRecord: {}, config, now: NOW, extract });
    return entries.filter((e) => rows.find((r) => r.key === e.key).managed);
  };
  const first = await openCacheDb(file);
  await sync(createFakeGh(script()), first);
  const before = readySet(first);
  first.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const second = await openCacheDb(file);
  assert.equal(second.reason, 'missing');
  await sync(createFakeGh(script()), second);
  const after = readySet(second);
  second.close();
  assert.deepEqual(after, before);
  const ready = before.filter((e) => e.ready).map((e) => e.key);
  assert.deepEqual(ready, ['acme/app#3', 'acme/app#4']);
  // #3 is ready only because its closed external blocker was looked up again.
  assert.ok(before.find((e) => e.key === 'acme/app#1').reasons.some((r) => r.code === 'blocked-by'));
});

test('NF-rate: sync stops at the rate reserve and keeps the last committed page\'s high-water mark', async () => {
  const file = path.join(tmp(), 'cache.db');
  const cache = await openAt(file, (c) => c.setRepoState('acme/app', { hwm: '2026-11-01T10:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' }));
  const page1 = fx('issues-incremental.json');
  page1.data.repository.issues.pageInfo = { hasNextPage: true, endCursor: 'cursor-1' };
  page1.data.rateLimit.remaining = 500;
  const gh = createFakeGh(
    script({
      SyncIssues: (vars) => {
        assert.equal(vars.cursor, undefined, 'the second page must not be requested');
        return page1;
      },
    }),
  );
  const summary = await sync(gh, cache);
  assert.equal(summary.stopped.reason, 'rate-reserve');
  assert.equal(summary.stopped.resetAt, '2026-11-03T13:00:00Z');
  assert.equal(issueCalls(gh).length, 1);
  assert.equal(gh.calls.filter((c) => c.key === 'SyncExternal').length, 0);
  assert.equal(cache.getRepoState('acme/app').hwm, '2026-11-03T11:00:00Z');
  assert.equal(cache.readIssues().find((r) => r.key === 'acme/app#4').state, 'closed');
  cache.close();
});

test('NF-rate: secondary rate limit backs off and retries', async () => {
  const secondary = () => new GhError('gh api failed', { code: 1, stderr: 'You have exceeded a secondary rate limit', rate: { secondary: true } });
  // Two failures, then success: the sleeps double from 60 s.
  const ok = await openCacheDb(path.join(tmp(), 'cache.db'));
  let n = 0;
  const gh = createFakeGh(
    script({
      SyncIssues: () => {
        n += 1;
        if (n <= 2) throw secondary();
        return fx('issues-full.json');
      },
    }),
  );
  const clock = fakeClock();
  const summary = await sync(gh, ok, {}, clock);
  assert.deepEqual(clock.sleeps, [60000, 120000]);
  assert.equal(summary.stopped, null);
  assert.equal(issueCalls(gh).length, 3);
  assert.equal(ok.readIssues().filter((r) => r.managed).length, 4);
  ok.close();
  // Three failures in a row: a clean stop, no fourth try.
  const bad = await openCacheDb(path.join(tmp(), 'cache.db'));
  const gh2 = createFakeGh(
    script({
      SyncIssues: () => {
        throw secondary();
      },
    }),
  );
  const clock2 = fakeClock();
  const s2 = await sync(gh2, bad, {}, clock2);
  assert.equal(s2.stopped.reason, 'secondary-limit');
  assert.equal(issueCalls(gh2).length, 3);
  assert.deepEqual(clock2.sleeps, [60000, 120000]);
  bad.close();
});

test('R4: an invalid .gvt-agent.json overlay is reported and a valid one overrides the built-in default', async () => {
  const meta = (text) => {
    const m = fx('repo-meta.json');
    m.data.repository.agentConfig = { text };
    return m;
  };
  const bad = await openCacheDb(path.join(tmp(), 'cache.db'));
  const s1 = await sync(createFakeGh(script({ SyncRepoMeta: meta('{"bugTracker": {"triagedLabel": 5}}') })), bad);
  assert.equal(s1.overlayErrors.length, 1);
  assert.match(s1.overlayErrors[0].message, /triagedLabel/);
  bad.close();
  const good = await openCacheDb(path.join(tmp(), 'cache.db'));
  await sync(createFakeGh(script({ SyncRepoMeta: meta('{"bugTracker": {"triagedLabel": "ready", "blockedLabel": "stuck"}}') })), good);
  const [entry] = applyOverlays({ ...config, repos: [{ repo: 'acme/app', blockedLabel: 'waiting' }] }, good).repos;
  assert.equal(entry.triagedLabel, 'ready');
  assert.equal(entry.blockedLabel, 'waiting', 'the config entry beats the overlay');
  good.close();
});

const closingNode = (nodes) => ({
  data: { repository: { issue: { closedByPullRequestsReferences: { nodes, pageInfo: { hasNextPage: false } } } } },
});

test('R174: readClosingPrs maps the closing pull requests of one issue', async () => {
  const gh = createFakeGh({
    ClaimIssue: closingNode([
      { number: 9, state: 'MERGED', headRefName: 'feat/x', repository: { nameWithOwner: 'acme/app' } },
      { number: 10, state: 'OPEN', headRefName: 'feat/y' },
    ]),
  });
  const r = await readClosingPrs(gh, 'acme/app', 4);
  assert.deepEqual(r, {
    prs: [
      { number: 9, state: 'MERGED', headRefName: 'feat/x', repo: 'acme/app' },
      { number: 10, state: 'OPEN', headRefName: 'feat/y', repo: null },
    ],
  });
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(gh.calls[0].vars, { owner: 'acme', name: 'app', number: 4 });
});

test('R174: readClosingPrs returns {error} when the issue node is missing', async () => {
  const gh = createFakeGh({ ClaimIssue: { data: { repository: { issue: null } }, errors: [{ message: 'Could not resolve' }] } });
  const r = await readClosingPrs(gh, 'acme/app', 4);
  assert.deepEqual(Object.keys(r), ['error']);
  assert.match(r.error.message, /acme\/app#4: cannot read the issue: Could not resolve/);
});

test('R174: readClosingPrs returns {error} when the call throws', async () => {
  const boom = new GhError('gh api failed (1): boom', { code: 1 });
  const gh = createFakeGh({
    ClaimIssue: () => {
      throw boom;
    },
  });
  const r = await readClosingPrs(gh, 'acme/app', 4);
  assert.deepEqual(Object.keys(r), ['error']);
  assert.equal(r.error, boom);
});

test('S5: ready --json on an empty state dir prints valid JSON with no sqlite ExperimentalWarning', async () => {
  const state = path.join(tmp(), 'state');
  const bin = path.join(here, '..', 'bin', 'gvt-fleet.mjs');
  const res = await run([process.execPath, bin, 'ready', '--json', '--state-dir', state]);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { ready: [], untriaged: [], now: [], next: [] });
  assert.doesNotMatch(res.stderr, /ExperimentalWarning/);
  assert.ok(fs.existsSync(path.join(state, 'cache.db')));
});
