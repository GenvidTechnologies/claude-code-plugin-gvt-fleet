process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCacheDb } from '../lib/cache-db.mjs';
import { syncCommand } from '../lib/commands.mjs';
import { createGh, GhError } from '../lib/gh.mjs';
import { buildGraph } from '../lib/graph.mjs';
import { computeReady } from '../lib/ready.mjs';
import { loadRefsGrammar } from '../lib/plugin-path.mjs';
import { applyOverlays, runSync, unknownBranches } from '../lib/sync.mjs';
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
const RESET = '2026-11-03T13:00:00Z';
const config = {
  version: 1,
  claimAccount: 'me',
  leaseMinutes: 120,
  rateReserve: 1000,
  fullSyncHours: 24,
  repos: [{ repo: 'acme/app' }],
};

const fakeClock = () => ({ now: () => NOW, sleep: async () => {} });

function externalReply(_vars, query) {
  const data = {};
  const re = /(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issueOrPullRequest\(number: (\d+)\)/g;
  const nodes = fx('external.json');
  for (const m of query.matchAll(re)) data[m[1]] = { issueOrPullRequest: nodes[`${m[2]}/${m[3]}#${m[4]}`] ?? null };
  data.rateLimit = { cost: 1, remaining: 4880, resetAt: RESET };
  return { data };
}

const script = (overrides = {}) => ({
  SyncRepoMeta: fx('repo-meta.json'),
  SyncIssues: fx('issues-full.json'),
  SyncExternal: externalReply,
  ...overrides,
});

async function openAt(file, seed) {
  const first = await openCacheDb(file);
  if (seed) seed(first);
  first.close();
  return openCacheDb(file);
}

const sync = (gh, cache, extra = {}) => runSync({ gh, clock: fakeClock(), config }, { cache, extract, ...extra });
const issueCalls = (gh) => gh.calls.filter((c) => c.key === 'SyncIssues');

const NO_MORE = { hasNextPage: false, endCursor: null };
const issueNode = (number, extra = {}) => ({
  number,
  state: 'OPEN',
  title: `Issue ${number}`,
  body: '',
  updatedAt: '2026-11-01T09:00:00Z',
  labels: { nodes: [{ name: 'triaged' }], pageInfo: NO_MORE },
  assignees: { nodes: [], pageInfo: NO_MORE },
  comments: { nodes: [], pageInfo: NO_MORE },
  parent: null,
  subIssues: { nodes: [] },
  blockedBy: { nodes: [] },
  blocking: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [], pageInfo: NO_MORE },
  ...extra,
});
const ref = (number, repo) => ({ number, state: 'OPEN', repository: { nameWithOwner: repo } });
const issuesPage = (nodes, { more = false, cursor = null, remaining = 4890 } = {}) => ({
  data: {
    repository: { issues: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } } },
    rateLimit: { cost: 1, remaining, resetAt: RESET },
  },
});

// A process runner that answers `gh api graphql` calls from a script keyed by operation name. An entry
// returns a JSON body (exit 0) or {code, stdout, stderr} as the gh process would.
function ghRun(entries) {
  return async (argv) => {
    const query = argv.find((a) => a.startsWith('query=')) ?? '';
    const op = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    const entry = entries[op];
    if (entry === undefined) throw new Error(`ghRun: no script for ${op}`);
    const r = typeof entry === 'function' ? entry(query) : entry;
    if (typeof r.code === 'number') return { stdout: '', stderr: '', ...r };
    return { code: 0, stdout: JSON.stringify(r), stderr: '' };
  };
}

// The body `gh api graphql` prints for unreadable aliases: partial data with a null per alias.
const notFoundBody = (aliases, data) => ({
  data: { ...data, ...Object.fromEntries(aliases.map((a) => [a, null])) },
  errors: aliases.map((a) => ({ type: 'NOT_FOUND', path: [a], message: 'Could not resolve to an issue or pull request' })),
});

function commandCtx(dir, run) {
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const out = [];
  const err = [];
  const ctx = { configFile, stateDir: path.join(dir, 'state'), json: false, out: (s) => out.push(s), err: (s) => err.push(s), log: { append() {} }, clock: fakeClock(), run };
  return { ctx, out, err };
}

test('R6: a blocker that GitHub cannot read does not abort the sync; the others are stored and it is reported', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const run = ghRun({
    SyncRepoMeta: fx('repo-meta.json'),
    SyncIssues: fx('issues-full.json'),
    SyncExternal: (query) => {
      const data = externalReply(null, query).data;
      const alias = /(r\d+): repository\(owner: "ext", name: "lib"\) \{ issueOrPullRequest\(number: 8\)/.exec(query)[1];
      delete data[alias];
      // `gh api graphql` exits 1 on a GraphQL error and still prints the JSON with partial data.
      return { code: 1, stdout: JSON.stringify(notFoundBody([alias], data)), stderr: 'gh: Could not resolve to an issue or pull request' };
    },
  });
  const summary = await runSync({ gh: createGh({ run }), clock: fakeClock(), config }, { cache, extract });
  assert.deepEqual(summary.notFound, ['ext/lib#8']);
  assert.equal(summary.external, 1);
  assert.equal(summary.stopped, null);
  assert.deepEqual(summary.errors, []);
  const rows = new Map(cache.readIssues().map((r) => [r.key, r]));
  assert.equal(rows.get('ext/lib#7').state, 'open');
  assert.equal(rows.has('ext/lib#8'), false);
  assert.equal(rows.get('acme/app#1').title, 'Rich issue');
  cache.close();
});

test('R6: gh.graphql returns partial data on exit 1, and still throws without JSON data or on a rate limit', async () => {
  const plain = createGh({ run: async () => ({ code: 1, stdout: 'boom', stderr: 'gh: something broke' }) });
  await assert.rejects(() => plain.graphql('query X { a }'), (e) => e instanceof GhError && e.code === 1);
  const noData = createGh({ run: async () => ({ code: 1, stdout: '{"data":null,"errors":[{"type":"X"}]}', stderr: 'gh: x' }) });
  await assert.rejects(() => noData.graphql('query X { a }'), GhError);
  const limited = createGh({ run: async () => ({ code: 1, stdout: '{"data":{"a":1}}', stderr: 'gh: API rate limit exceeded for user' }) });
  await assert.rejects(() => limited.graphql('query X { a }'), (e) => e instanceof GhError && e.rate.limited === true);
  const secondary = createGh({ run: async () => ({ code: 1, stdout: '{"data":{"a":1}}', stderr: 'You have exceeded a secondary rate limit' }) });
  await assert.rejects(() => secondary.graphql('query X { a }'), (e) => e instanceof GhError && e.rate.secondary === true);
  const partial = createGh({ run: async () => ({ code: 1, stdout: '{"data":{"r0":null},"errors":[{"type":"NOT_FOUND"}]}', stderr: 'gh: nf' }) });
  const res = await partial.graphql('query X { a }');
  assert.deepEqual(res.data, { r0: null });
  assert.equal(res.errors[0].type, 'NOT_FOUND');
});

test('R6: sync command reports the not-found count and exits 0 when only external blockers are missing', async () => {
  const run = ghRun({
    SyncRepoMeta: fx('repo-meta.json'),
    SyncIssues: fx('issues-full.json'),
    SyncExternal: (query) => {
      const aliases = [...query.matchAll(/(r\d+): repository/g)].map((m) => m[1]);
      return { code: 1, stdout: JSON.stringify(notFoundBody(aliases, { rateLimit: { cost: 1, remaining: 4880, resetAt: RESET } })), stderr: 'gh: nf' };
    },
  });
  const { ctx, out, err } = commandCtx(tmp(), run);
  const code = await syncCommand(ctx, []);
  assert.equal(code, 0, err.join('\n'));
  assert.match(out.join('\n'), /\(2 not found\)/);
  assert.match(err.join('\n'), /2 external lookups not found: ext\/lib#7, ext\/lib#8/);
});

test('NF-rate: sync command exits 75 after printing the summary when the sync stopped at the rate reserve', async () => {
  const run = ghRun({
    SyncRepoMeta: fx('repo-meta.json'),
    SyncIssues: issuesPage([issueNode(1)], { more: true, cursor: 'c1', remaining: 500 }),
  });
  const { ctx, out, err } = commandCtx(tmp(), run);
  const code = await syncCommand(ctx, []);
  assert.equal(code, 75);
  assert.match(out.join('\n'), /synced 1 issues/);
  assert.match(err.join('\n'), /sync stopped \(rate-reserve\); rate limit resets at 2026-11-03T13:00:00Z/);
});

test('NF-rate: a stop by rate limit or secondary limit carries the reset time', async () => {
  const a = await openCacheDb(path.join(tmp(), 'cache.db'));
  const secondary = () => {
    throw new GhError('gh api failed', { code: 1, stderr: 'secondary rate limit', rate: { secondary: true } });
  };
  const s1 = await sync(createFakeGh(script({ SyncIssues: secondary })), a);
  assert.equal(s1.stopped.reason, 'secondary-limit');
  assert.equal(s1.stopped.resetAt, RESET);
  a.close();
  const b = await openCacheDb(path.join(tmp(), 'cache.db'));
  const limited = () => {
    throw new GhError('limited', { code: 1, rate: { limited: true } });
  };
  const s2 = await sync(createFakeGh(script({ SyncIssues: limited })), b);
  assert.equal(s2.stopped.reason, 'rate-limited');
  assert.equal(s2.stopped.resetAt, RESET);
  b.close();
});

test('R6: an external lookup keeps the labels and body of a stored row whose repo is no longer synced', async () => {
  // acme/old was managed earlier; the config no longer lists it, so its open row is refreshed by the external pass.
  const cache = await openAt(path.join(tmp(), 'cache.db'), (c) => {
    c.upsertIssue({ key: 'acme/old#50', repo: 'acme/old', number: 50, state: 'open', title: 'Old', body: 'kept', labels: ['triaged', 'bug'], managed: true });
    c.setRepoState('acme/app', { hwm: '2026-11-01T10:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' });
  });
  const gh = createFakeGh(
    script({
      SyncIssues: issuesPage([issueNode(1)]),
      SyncExternal: () => ({
        data: {
          r0: { issueOrPullRequest: { __typename: 'Issue', state: 'CLOSED', title: 'Renamed', updatedAt: '2026-11-02T00:00:00Z' } },
          rateLimit: { cost: 1, remaining: 4800, resetAt: RESET },
        },
      }),
    }),
  );
  const summary = await sync(gh, cache);
  assert.equal(summary.repos[0].mode, 'incremental');
  assert.equal(summary.external, 1);
  const row = cache.readIssues().find((r) => r.key === 'acme/old#50');
  assert.equal(row.state, 'closed');
  assert.equal(row.title, 'Renamed');
  assert.equal(row.updatedAt, '2026-11-02T00:00:00Z');
  assert.equal(row.body, 'kept');
  assert.deepEqual(row.labels, ['triaged', 'bug']);
  // A repo that left the config keeps no managed rows (#33).
  assert.equal(row.managed, false);
  cache.close();
});

test('R5: labels, assignees, closing PRs and comments past the first page are paged', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const more = { hasNextPage: true, endCursor: 'next' };
  const node = issueNode(1, {
    labels: { nodes: [{ name: 'triaged' }], pageInfo: more },
    assignees: { nodes: [{ login: 'a' }], pageInfo: more },
    closedByPullRequestsReferences: {
      nodes: [{ number: 1, state: 'CLOSED', headRefName: 'b1', repository: { nameWithOwner: 'acme/app' } }],
      pageInfo: more,
    },
    comments: { nodes: Array.from({ length: 100 }, (_, i) => ({ body: `c${i}`, createdAt: '2026-11-01T08:00:00Z' })), pageInfo: more },
  });
  const conn = (field, nodes) => ({ data: { repository: { issue: { [field]: { nodes, pageInfo: NO_MORE } } }, rateLimit: { cost: 1, remaining: 4800, resetAt: RESET } } });
  const gh = createFakeGh(
    script({
      SyncIssues: issuesPage([node]),
      SyncLabels: (vars) => {
        assert.equal(vars.cursor, 'next');
        return conn('labels', [{ name: 'p2' }]);
      },
      SyncAssignees: conn('assignees', [{ login: 'b' }]),
      SyncClosingPrs: conn('closedByPullRequestsReferences', [{ number: 2, state: 'OPEN', headRefName: 'b2', repository: { nameWithOwner: 'acme/app' } }]),
      SyncComments: conn('comments', Array.from({ length: 5 }, (_, i) => ({ body: `d${i}`, createdAt: '2026-11-01T09:00:00Z' }))),
    }),
  );
  const summary = await sync(gh, cache);
  assert.deepEqual(summary.errors, []);
  const row = cache.readIssues().find((r) => r.key === 'acme/app#1');
  assert.deepEqual(row.labels, ['triaged', 'p2']);
  assert.deepEqual(row.assignees, ['a', 'b']);
  assert.deepEqual(row.closingPrs.map((p) => p.number), [1, 2]);
  assert.equal(row.comments.length, 105);
  assert.equal(row.comments[104].body, 'd4');
  assert.match(issueCalls(gh)[0].query, /labels\(first: 100\)/);
  cache.close();
});

test('R5: a comments page that comes back empty fails the repo instead of dropping comments', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const node = issueNode(1, { comments: { nodes: [{ body: 'x', createdAt: '2026-11-01T08:00:00Z' }], pageInfo: { hasNextPage: true, endCursor: 'n' } } });
  const gh = createFakeGh(script({ SyncIssues: issuesPage([node]), SyncComments: { data: { repository: { issue: null } } } }));
  const summary = await sync(gh, cache);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].message, /comments query failed/);
  assert.equal(cache.readIssues().length, 0);
  cache.close();
});

test('R6: a MERGED pull request blocker is stored as closed and its blocked issue is cleared', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const page = fx('issues-full.json');
  page.data.repository.issues.nodes[2].blockedBy = { nodes: [ref(9, 'ext/lib')] };
  await sync(createFakeGh(script({ SyncIssues: page })), cache);
  const rows = cache.readIssues();
  assert.equal(rows.find((r) => r.key === 'ext/lib#9').state, 'closed');
  assert.equal(rows.find((r) => r.key === 'ext/lib#9').managed, false);
  const graph = buildGraph(rows, { extract, config });
  const entry = computeReady({ issues: rows, graph, claims: [], branchRecord: {}, config, now: NOW, extract }).find((e) => e.key === 'acme/app#3');
  assert.equal(entry.ready, true);
  assert.ok(!entry.reasons.some((r) => r.code === 'blocked-by'));
  cache.close();
});

test('R6: more than 50 external targets split into two aliased batches', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const refs = Array.from({ length: 60 }, (_, i) => ref(100 + i, 'ext/lib'));
  const gh = createFakeGh(
    script({
      SyncIssues: issuesPage([issueNode(1, { blockedBy: { nodes: refs } })]),
      SyncExternal: (_vars, query) => {
        const data = {};
        for (const m of query.matchAll(/(r\d+): repository\(owner: "ext", name: "lib"\) \{ issueOrPullRequest\(number: (\d+)\)/g)) {
          data[m[1]] = { issueOrPullRequest: { __typename: 'Issue', state: 'OPEN', title: `t${m[2]}`, updatedAt: '2026-10-01T00:00:00Z' } };
        }
        data.rateLimit = { cost: 1, remaining: 4000, resetAt: RESET };
        return { data };
      },
    }),
  );
  const summary = await sync(gh, cache);
  const ext = gh.calls.filter((c) => c.key === 'SyncExternal');
  assert.equal(ext.length, 2);
  assert.equal([...ext[0].query.matchAll(/ r\d+: repository/g)].length, 50);
  assert.equal([...ext[1].query.matchAll(/ r\d+: repository/g)].length, 10);
  assert.match(ext[1].query, /r0: repository\(owner: "ext", name: "lib"\) \{ issueOrPullRequest\(number: 150\)/);
  assert.equal(summary.external, 60);
  assert.equal(cache.readIssues().filter((r) => !r.managed).length, 60);
  cache.close();
});

test('R4: a multi-page full sync moves the mark and deletes vanished issues on the last page only', async () => {
  const cache = await openAt(path.join(tmp(), 'cache.db'), (c) => c.upsertIssue({ key: 'acme/app#99', repo: 'acme/app', number: 99, state: 'open', managed: true }));
  const seen = [];
  const page1 = issuesPage([issueNode(1), issueNode(2)], { more: true, cursor: 'c1' });
  const page2 = issuesPage([issueNode(3)]);
  const gh = createFakeGh(
    script({
      SyncIssues: (vars) => {
        seen.push({ cursor: vars.cursor ?? null, hwm: cache.getRepoState('acme/app')?.hwm ?? null, stale: cache.readIssues().some((r) => r.key === 'acme/app#99') });
        return vars.cursor ? page2 : page1;
      },
    }),
  );
  const summary = await sync(gh, cache);
  assert.equal(summary.repos[0].mode, 'full');
  assert.equal(summary.repos[0].pages, 2);
  // At the second request page 1 is committed, but the mark is unset and the vanished issue still exists.
  assert.deepEqual(seen, [
    { cursor: null, hwm: null, stale: true },
    { cursor: 'c1', hwm: null, stale: true },
  ]);
  const state = cache.getRepoState('acme/app');
  assert.equal(state.hwm, NOW.toISOString());
  assert.equal(state.lastFullSync, NOW.toISOString());
  assert.deepEqual(cache.readIssues({ repo: 'acme/app' }).map((r) => r.number), [1, 2, 3]);
  cache.close();
});

test('R4: a full sync interrupted after page 1 resumes as a full sync', async () => {
  const file = path.join(tmp(), 'cache.db');
  const cache = await openAt(file, (c) => c.upsertIssue({ key: 'acme/app#99', repo: 'acme/app', number: 99, state: 'open', managed: true }));
  const page1 = issuesPage([issueNode(1), issueNode(2)], { more: true, cursor: 'c1', remaining: 500 });
  const s1 = await sync(createFakeGh(script({ SyncIssues: page1 })), cache);
  assert.equal(s1.stopped.reason, 'rate-reserve');
  assert.equal(cache.getRepoState('acme/app').hwm, null);
  assert.equal(cache.getRepoState('acme/app').lastFullSync, null);
  assert.ok(cache.readIssues().some((r) => r.key === 'acme/app#99'), 'nothing is deleted before the last page');
  cache.close();
  const again = await openCacheDb(file);
  const gh = createFakeGh(script({ SyncIssues: issuesPage([issueNode(1), issueNode(2)]) }));
  const s2 = await sync(gh, again);
  assert.equal(s2.repos[0].mode, 'full');
  assert.equal(s2.repos[0].reason, 'no-high-water-mark');
  assert.equal(issueCalls(gh)[0].vars.cursor, undefined);
  assert.deepEqual(again.readIssues({ repo: 'acme/app' }).map((r) => r.number), [1, 2]);
  again.close();
});

test('R4: the incremental high-water mark never moves backwards', async () => {
  const cache = await openAt(path.join(tmp(), 'cache.db'), (c) => c.setRepoState('acme/app', { hwm: '2026-11-05T00:00:00.000Z', lastFullSync: '2026-11-03T08:00:00.000Z' }));
  const summary = await sync(createFakeGh(script({ SyncIssues: fx('issues-incremental.json') })), cache);
  assert.equal(summary.repos[0].mode, 'incremental');
  assert.equal(cache.getRepoState('acme/app').hwm, '2026-11-05T00:00:00.000Z');
  assert.equal(cache.readIssues().find((r) => r.key === 'acme/app#4').state, 'closed', 'the page itself is still stored');
  cache.close();
});

test('R4: the sync graph uses the cached overlay, as ready does', async () => {
  // The overlay renames the blocked label; an issue that carries it gets a blocker-not-named edge only
  // when the overlay is applied. The summary counts come from the same graph.
  const meta = fx('repo-meta.json');
  meta.data.repository.agentConfig = { text: '{"bugTracker": {"blockedLabel": "stuck"}}' };
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  const stuck = issueNode(1, { labels: { nodes: [{ name: 'triaged' }, { name: 'stuck' }], pageInfo: NO_MORE } });
  const gh = createFakeGh(script({ SyncRepoMeta: meta, SyncIssues: issuesPage([stuck]) }));
  await sync(gh, cache);
  const withOverlay = buildGraph(cache.readIssues(), { extract, config: applyOverlays(config, cache) });
  const without = buildGraph(cache.readIssues(), { extract, config });
  assert.equal(withOverlay.edges.some((e) => e.from === null && e.to === 'acme/app#1'), true);
  assert.equal(without.edges.some((e) => e.from === null && e.to === 'acme/app#1'), false);
  cache.close();
});

test('R4: an invalid overlay keeps the previously stored valid one and is still reported', async () => {
  const meta = (text) => {
    const m = fx('repo-meta.json');
    m.data.repository.agentConfig = text === null ? null : { text };
    return m;
  };
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  await sync(createFakeGh(script({ SyncRepoMeta: meta('{"bugTracker": {"triagedLabel": "ready"}}') })), cache);
  const s2 = await sync(createFakeGh(script({ SyncRepoMeta: meta('{"bugTracker": {"triagedLabel": 5}}') })), cache);
  assert.equal(s2.overlayErrors.length, 1);
  assert.equal(applyOverlays(config, cache).repos[0].triagedLabel, 'ready');
  const s3 = await sync(createFakeGh(script({ SyncRepoMeta: meta('not json') })), cache);
  assert.equal(s3.overlayErrors.length, 1);
  assert.equal(applyOverlays(config, cache).repos[0].triagedLabel, 'ready');
  // A repo that removed the file goes back to the defaults.
  await sync(createFakeGh(script({ SyncRepoMeta: meta(null) })), cache);
  assert.equal(applyOverlays(config, cache).repos[0].triagedLabel, undefined);
  cache.close();
});

test('R4: unknownBranches skips the default branch and recorded branches but lists one named constructor', async () => {
  const cache = await openCacheDb(path.join(tmp(), 'cache.db'));
  cache.setRepoState('acme/app', { defaultBranch: 'main' });
  const head = (name) => ({ name, headOid: 'x', lastCommitDate: null });
  cache.replaceBranchHeads('acme/app', [head('main'), head('feature-x'), head('constructor'), head('other')]);
  const record = { repos: { 'acme/app': { 'feature-x': { disposition: 'issue', issue: 'acme/app#1' } } } };
  assert.deepEqual(unknownBranches(cache, config, record).map((b) => b.name), ['constructor', 'other']);
  cache.close();
});
