process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classOfRow, groupByClass, issuesOfClass } from '../plugin/cli/lib/classes.mjs';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { classCommand, readyCommand, whyCommand } from '../plugin/cli/lib/commands.mjs';
import { loadRefsGrammar } from '../plugin/cli/lib/plugin-path.mjs';
import { runSync } from '../plugin/cli/lib/sync.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { fakeProject } from './fakes/fake-project.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const TODAY = '2026-11-12';
const NOW = new Date(`${TODAY}T12:00:00.000Z`);
const OLD = { id: 'i_old', title: 'Iteration 1', startDate: '2026-11-01', duration: 5 };
const CUR = { id: 'i_now', title: 'Goal A', startDate: '2026-11-06', duration: 365 };
const NXT = { id: 'i_next', title: 'Goal B', startDate: '2027-11-06', duration: 365 };
const P1 = { id: 'i_p1', title: 'Goal C', startDate: '2028-11-05', duration: 365 };
const ITERATIONS = [OLD, CUR, NXT, P1];
const PROJECT = 'acme/7';

// ---- pure classification ----

function fixture() {
  const config = { repos: [{ repo: 'o/a', project: PROJECT }, { repo: 'o/b', project: PROJECT }, { repo: 'o/c' }] };
  const row = (repo, number, extra = {}) => ({ key: `${repo}#${number}`, repo, number, title: `t${number}`, state: 'open', managed: true, labels: [], ...extra });
  const rows = [
    row('o/a', 1),
    row('o/a', 2),
    row('o/a', 3, { labels: ['class:now'] }),
    row('o/a', 4),
    row('o/a', 5, { state: 'closed' }),
    row('o/a', 6, { managed: false }),
    row('o/b', 1),
    row('o/b', 2),
    row('o/c', 1, { labels: ['class:now'] }),
  ];
  const items = new Map(
    Object.entries({ 'o/a#1': 'i_now', 'o/a#2': 'i_next', 'o/a#4': 'i_p1', 'o/a#5': 'i_now', 'o/a#6': 'i_now', 'o/b#1': 'i_now', 'o/b#2': 'i_next', 'o/c#1': 'i_now' }),
  );
  const projects = new Map([[PROJECT, { iterations: ITERATIONS, items }]]);
  const entries = rows.map((r) => ({ key: r.key, ready: r.number % 2 === 1, reasons: [] }));
  return { rows, entries, config, projects, today: TODAY };
}

test('R189: the class comes from the iteration of the item: current is now, next is next, any other or none is later', () => {
  const f = fixture();
  const cls = (key) => classOfRow(f.rows.find((r) => r.key === key), f);
  assert.deepEqual(cls('o/a#1'), { class: 'now', conflict: false, iteration: { id: 'i_now', title: 'Goal A' } });
  assert.equal(cls('o/a#2').class, 'next');
  assert.deepEqual(cls('o/a#3'), { class: 'later', conflict: false, iteration: null }, 'a class:now label is not read');
  assert.equal(cls('o/a#4').class, 'later', 'a planned iteration is later');
  assert.equal(cls('o/c#1').class, 'later', 'a repo with no project is later');
  assert.equal(classOfRow(f.rows[0], { ...f, today: '2027-11-06' }).class, 'later', 'on the start day of Next, Now has moved on');
  assert.equal(classOfRow(f.rows[1], { ...f, today: '2027-11-06' }).class, 'now');
});

test('R189: groupByClass lists the open managed Now rows and counts Next per repo', () => {
  const g = groupByClass(fixture());
  assert.deepEqual(g.now.map((x) => [x.key, x.conflict, x.title, x.ready]), [
    ['o/a#1', false, 't1', true],
    ['o/b#1', false, 't1', true],
  ]);
  assert.deepEqual(g.next, [{ repo: 'o/a', count: 1 }, { repo: 'o/b', count: 1 }]);
  assert.deepEqual(issuesOfClass(fixture(), 'later').map((x) => x.key), ['o/a#3', 'o/a#4', 'o/c#1']);
});

// ---- the class command ----

const REPO = 'acme/app';
const KEY = `${REPO}#1`;

async function classSandbox(t, { items = [], issues = { [KEY]: {} }, iterations = ITERATIONS, entry = { project: PROJECT }, field = true, cached = true, tamper = null, crossOrg = false, pageSize = 100 } = {}) {
  const dir = makeTempDir(t, 'gvt-fleet-class-');
  const configFile = path.join(dir, 'repos.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO, ...entry }] }));
  const fake = fakeProject({ today: TODAY, iterations, items, issues, field, tamper, crossOrg, pageSize });
  if (cached) {
    const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
    cache.replaceProject(PROJECT, { projectId: fake.state.projectId, fieldId: fake.state.fieldId, iterations: [], items: [] });
    cache.close();
  }
  const out = [];
  const err = [];
  const events = [];
  const ctx = { json: true, configFile, stateDir, gh: fake.gh, clock: { now: () => NOW, sleep: async () => {} }, log: { append: (e) => events.push(e) }, out: (x) => out.push(x), err: (x) => err.push(x) };
  const cachedProject = async () => {
    const c = await openCacheDb(path.join(stateDir, 'cache.db'));
    try {
      return c.readProjects().get(PROJECT);
    } finally {
      c.close();
    }
  };
  return { ctx, out, err, events, fake, cachedProject };
}

const body = (s) => JSON.parse(s.out.at(-1));
const writes = (s) => s.fake.gh.writes().map((c) => c.key);

test('R190: class now puts the item in the current iteration, reads it back and writes it to the cache', async (t) => {
  const s = await classSandbox(t, { items: [{ key: KEY, iterationId: 'i_p1' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['SetItemIteration']);
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_now');
  const b = body(s);
  assert.equal(b.status, 'changed');
  assert.equal(b.previous, 'later');
  assert.deepEqual(b.iteration, { id: 'i_now', title: 'Goal A' });
  assert.equal(b.cached, true);
  const c = await s.cachedProject();
  assert.equal(c.items.get(KEY.toLowerCase()), 'i_now');
  assert.equal(c.iterations.length, ITERATIONS.length, 'the live iterations are cached with the item');
  assert.deepEqual(s.events.map((e) => [e.event, e.status, e.iteration]), [['class', 'changed', 'i_now']]);
});

test('R190: class next on an issue outside the project adds it to the project first', async (t) => {
  const s = await classSandbox(t);
  assert.equal(await classCommand(s.ctx, [KEY, 'next']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['AddProjectItem', 'SetItemIteration']);
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_next');
  assert.equal(body(s).addedToProject, true);
});

test('R190: class later clears the value of a Now item, and is a noop for a planned item or an issue outside the project', async (t) => {
  const s = await classSandbox(t, { items: [{ key: KEY, iterationId: 'i_now' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'later']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['ClearItemIteration']);
  assert.equal(s.fake.itemOf(KEY).iterationId, null);
  assert.equal(body(s).previous, 'now');
  const planned = await classSandbox(t, { items: [{ key: KEY, iterationId: 'i_p1' }] });
  assert.equal(await classCommand(planned.ctx, [KEY, 'later']), 0);
  assert.equal(body(planned).status, 'noop');
  assert.deepEqual(writes(planned), []);
  const outside = await classSandbox(t);
  assert.equal(await classCommand(outside.ctx, [KEY, 'later']), 0);
  assert.equal(body(outside).status, 'noop');
  assert.deepEqual(writes(outside), []);
});

test('R190: class to the class the issue has makes no write and prints noop', async (t) => {
  const s = await classSandbox(t, { items: [{ key: KEY, iterationId: 'i_now' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 0);
  assert.equal(body(s).status, 'noop');
  assert.deepEqual(writes(s), []);
});

test('R190: a readback that disagrees reports failed, exits 1 and leaves the cache unchanged', async (t) => {
  const s = await classSandbox(t, {
    items: [{ key: KEY, iterationId: null }],
    tamper: (op, state) => {
      if (op === 'SetItemIteration') state.items[0].iterationId = 'i_p1';
    },
  });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 1);
  assert.equal(body(s).status, 'failed');
  assert.match(body(s).reason, /readback/);
  assert.equal((await s.cachedProject()).items.size, 0);
});

test('R190: class refuses a closed issue, a project with no Iteration field, and now or next with no such iteration', async (t) => {
  const closed = await classSandbox(t, { issues: { [KEY]: { state: 'CLOSED' } } });
  assert.equal(await classCommand(closed.ctx, [KEY, 'now']), 1);
  assert.match(body(closed).reason, /closed/);
  const nofield = await classSandbox(t, { field: false, iterations: [] });
  assert.equal(await classCommand(nofield.ctx, [KEY, 'now']), 1);
  assert.match(body(nofield).reason, /no Iteration field/);
  const nonext = await classSandbox(t, { iterations: [OLD, CUR] });
  assert.equal(await classCommand(nonext.ctx, [KEY, 'next']), 1);
  assert.match(body(nonext).reason, /no next iteration/);
  for (const s of [closed, nofield, nonext]) assert.deepEqual(writes(s), []);
});

test('R190: class exits 2 for a repo with no project and 64 for an unknown class or a wrong argument count', async (t) => {
  const s = await classSandbox(t, { entry: {} });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 2);
  assert.match(s.err.join('\n'), /no project in the config/);
  assert.equal(await classCommand(s.ctx, [KEY, 'soon']), 64);
  assert.equal(await classCommand(s.ctx, [KEY]), 64);
  assert.deepEqual(s.fake.gh.calls, []);
});

// ---- a project of another owner (#143): the issue side lists no item ----

test('R202: class now on a cross-org item in a planned iteration finds it on the project side, changes it and reads it back', async (t) => {
  const s = await classSandbox(t, { crossOrg: true, items: [{ key: KEY, iterationId: 'i_p1' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['SetItemIteration'], 'the item is not added again');
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_now');
  const b = body(s);
  assert.equal(b.status, 'changed');
  assert.equal(b.previous, 'later');
  assert.equal(b.addedToProject, false);
  assert.equal(b.cached, true);
  assert.equal((await s.cachedProject()).items.get(KEY.toLowerCase()), 'i_now');
});

test('R202: class now on a cross-org item already in Now is a noop with previous now', async (t) => {
  const s = await classSandbox(t, { crossOrg: true, items: [{ key: KEY, iterationId: 'i_now' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 0, s.err.join('\n'));
  const b = body(s);
  assert.equal(b.status, 'noop');
  assert.equal(b.previous, 'now');
  assert.equal(b.addedToProject, false);
  assert.deepEqual(writes(s), []);
});

test('R202: class later on a cross-org item in Now clears its value', async (t) => {
  const s = await classSandbox(t, { crossOrg: true, items: [{ key: KEY, iterationId: 'i_now' }] });
  assert.equal(await classCommand(s.ctx, [KEY, 'later']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['ClearItemIteration']);
  assert.equal(s.fake.itemOf(KEY).iterationId, null);
  assert.equal(body(s).status, 'changed');
  assert.equal(body(s).previous, 'now');
});

test('R202: class next on a cross-org issue outside the project adds it and reads the value back by item id', async (t) => {
  const s = await classSandbox(t, { crossOrg: true });
  assert.equal(await classCommand(s.ctx, [KEY, 'next']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['AddProjectItem', 'SetItemIteration']);
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_next');
  assert.equal(body(s).status, 'changed');
  assert.equal(body(s).addedToProject, true);
});

test('R202: class later on a cross-org issue outside the project is a noop and writes nothing', async (t) => {
  const s = await classSandbox(t, { crossOrg: true });
  assert.equal(await classCommand(s.ctx, [KEY, 'later']), 0, s.err.join('\n'));
  assert.equal(body(s).status, 'noop');
  assert.deepEqual(writes(s), []);
});

test('R202: the project-side lookup pages through the repo items and matches the issue by number', async (t) => {
  const items = [
    { key: `${REPO}#7`, iterationId: 'i_now' },
    { key: 'other/repo#1', iterationId: null },
    { key: `${REPO}#8`, iterationId: null },
    { key: KEY, iterationId: 'i_now' },
  ];
  const s = await classSandbox(t, { crossOrg: true, pageSize: 2, items });
  assert.equal(await classCommand(s.ctx, [KEY, 'later']), 0, s.err.join('\n'));
  assert.equal(body(s).previous, 'now');
  assert.equal(s.fake.itemOf(KEY).iterationId, null);
  assert.equal(s.fake.itemOf(`${REPO}#7`).iterationId, 'i_now', 'another issue of the repo is untouched');
  const pages = s.fake.gh.calls.filter((c) => c.key === 'RepoItems');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((c) => c.vars.q), [`repo:${REPO}`, `repo:${REPO}`]);
});

// ---- ready: now[], next[] and --class ----

const issueIn = (repo, number, extra = {}) => ({
  key: `${repo}#${number}`, repo, number, state: 'open', title: `Issue ${number} of ${repo}`, body: '', updatedAt: '2026-11-03T09:00:00Z',
  labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], closingPrs: [], managed: true, ...extra,
});

/** A config whose repos are in PROJECT, a cache seeded with `rows` and the item iterations, and no GitHub. */
async function readySandbox(t, rows, itemIterations, repos = ['acme/app']) {
  const dir = makeTempDir(t, 'gvt-fleet-class-ready-');
  const configFile = path.join(dir, 'repos.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: repos.map((repo) => ({ repo, project: PROJECT })) }));
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  cache.transaction(() => {
    for (const row of rows) cache.upsertIssue(row);
    const items = Object.entries(itemIterations).map(([key, iterationId]) => ({ key, itemId: `item-${key}`, iterationId }));
    cache.replaceProject(PROJECT, { projectId: 'P', fieldId: 'F', iterations: ITERATIONS, items });
  });
  cache.close();
  const out = [];
  const err = [];
  const ctx = { json: true, configFile, stateDir, clock: { now: () => NOW, sleep: async () => {} }, log: { append() {} }, out: (x) => out.push(x), err: (x) => err.push(x) };
  return { ctx, out, err, dir };
}

const readyBody = async (s, args = []) => {
  s.out.length = 0;
  assert.equal(await readyCommand(s.ctx, args), 0, s.err.join('\n'));
  return JSON.parse(s.out.join('\n'));
};

test('R191: ready --json lists the Now issues from the cached iterations, ready or not, and counts Next per repo', async (t) => {
  const s = await readySandbox(
    t,
    [issueIn('acme/app', 1), issueIn('acme/app', 2, { labels: [] }), issueIn('acme/app', 3), issueIn('acme/app', 4, { labels: ['triaged', 'class:now'] }), issueIn('acme/web', 1)],
    { 'acme/app#1': 'i_now', 'acme/app#2': 'i_now', 'acme/app#3': 'i_next', 'acme/web#1': 'i_next' },
    ['acme/app', 'acme/web'],
  );
  const b = await readyBody(s);
  assert.deepEqual(b.now.map((x) => [x.key, x.ready, x.conflict]), [
    ['acme/app#1', true, false],
    ['acme/app#2', false, false],
  ]);
  assert.ok(b.now[1].reasons.length > 0, 'the untriaged Now issue carries its reasons');
  assert.deepEqual(b.next, [{ repo: 'acme/app', count: 1 }, { repo: 'acme/web', count: 1 }]);
  const later = await readyBody(s, ['--class', 'later']);
  assert.deepEqual(later.issues.map((x) => x.key), ['acme/app#4'], 'a class:now label alone is Later');
});

test('R191: why prints the class with the iteration title, and --json carries iteration', async (t) => {
  const s = await readySandbox(t, [issueIn('acme/app', 1)], { 'acme/app#1': 'i_now' });
  assert.equal(await whyCommand(s.ctx, ['acme/app#1']), 0, s.err.join('\n'));
  const b = JSON.parse(s.out.join('\n'));
  assert.equal(b.class, 'now');
  assert.deepEqual(b.iteration, { id: 'i_now', title: 'Goal A' });
  s.ctx.json = false;
  s.out.length = 0;
  assert.equal(await whyCommand(s.ctx, ['acme/app#1']), 0);
  assert.equal(s.out[1], '  class: now (iteration Goal A)');
});

test('R191: a sync reads the project items and iterations, and ready then derives Now and Next from them', async (t) => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'graphql');
  const fx = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  const project = fakeProject({
    today: TODAY,
    iterations: ITERATIONS,
    items: [
      { key: 'acme/app#2', iterationId: 'i_now' },
      { key: 'acme/app#3', iterationId: 'i_next' },
      { key: 'other/repo#9', iterationId: 'i_now' },
    ],
    pageSize: 2,
    extra: {
      SyncRepoMeta: fx('repo-meta.json'),
      SyncIssues: fx('issues-full.json'),
      SyncExternal: () => ({ data: { rateLimit: { cost: 1, remaining: 4880, resetAt: '2026-11-12T13:00:00Z' } } }),
    },
  });
  const s = await readySandbox(t, [], {});
  const { extract } = await loadRefsGrammar();
  const config = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 1000, fullSyncHours: 24, repos: [{ repo: 'acme/app', project: PROJECT }] };
  const cache = await openCacheDb(path.join(s.ctx.stateDir, 'cache.db'));
  const summary = await runSync({ gh: project.gh, clock: { now: () => NOW, sleep: async () => {} }, config }, { cache, extract });
  cache.close();
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.projects, [{ project: PROJECT, pages: 2, items: 3, iterations: 4, field: true }]);
  assert.equal(project.gh.calls.filter((c) => c.key === 'SyncProject').length, 2, 'the items are paged');
  const b = await readyBody(s);
  assert.deepEqual(b.now.map((x) => x.key), ['acme/app#2']);
  assert.deepEqual(b.next, [{ repo: 'acme/app', count: 1 }]);
});

test('R191: a project with no Iteration field syncs without an error, and every issue of it is Later', async (t) => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'graphql');
  const fx = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  const project = fakeProject({
    today: TODAY,
    field: false,
    items: [{ key: 'acme/app#2' }],
    extra: {
      SyncRepoMeta: fx('repo-meta.json'),
      SyncIssues: fx('issues-full.json'),
      SyncExternal: () => ({ data: { rateLimit: { cost: 1, remaining: 4880, resetAt: '2026-11-12T13:00:00Z' } } }),
    },
  });
  const s = await readySandbox(t, [], {});
  const { extract } = await loadRefsGrammar();
  const config = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 1000, fullSyncHours: 24, repos: [{ repo: 'acme/app', project: PROJECT }] };
  const cache = await openCacheDb(path.join(s.ctx.stateDir, 'cache.db'));
  const summary = await runSync({ gh: project.gh, clock: { now: () => NOW, sleep: async () => {} }, config }, { cache, extract });
  cache.close();
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.projects, [{ project: PROJECT, pages: 1, items: 1, iterations: 0, field: false }]);
  const b = await readyBody(s);
  assert.deepEqual(b.now, []);
  assert.deepEqual(b.next, []);
});

test('R191: a project that cannot be read is a sync error and keeps the cached items', async (t) => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'graphql');
  const fx = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  const gh = createFakeGh({
    SyncRepoMeta: fx('repo-meta.json'),
    SyncIssues: fx('issues-full.json'),
    SyncExternal: () => ({ data: { rateLimit: { cost: 1, remaining: 4880, resetAt: '2026-11-12T13:00:00Z' } } }),
    SyncProject: () => ({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2' }] }),
  });
  const s = await readySandbox(t, [], { 'acme/app#2': 'i_now' });
  const { extract } = await loadRefsGrammar();
  const config = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 1000, fullSyncHours: 24, repos: [{ repo: 'acme/app', project: PROJECT }] };
  const cache = await openCacheDb(path.join(s.ctx.stateDir, 'cache.db'));
  const summary = await runSync({ gh, clock: { now: () => NOW, sleep: async () => {} }, config }, { cache, extract });
  cache.close();
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].repo, PROJECT);
  const b = await readyBody(s);
  assert.deepEqual(b.now.map((x) => x.key), ['acme/app#2']);
});

// ---- the recorded Now pointer (ADR 0022) ----

/** Record `nowId` as the Now of PROJECT, as iteration promote does. */
function recordNow(stateDir, nowId) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'now-pointers.json'), JSON.stringify({ version: 1, projects: { [PROJECT]: { now: nowId, setAt: NOW.toISOString() } } }));
}

test('R215: classOfRow follows the recorded Now of the project, and the dates with no record', () => {
  const f = fixture();
  const row = (key) => f.rows.find((r) => r.key === key);
  assert.equal(classOfRow(row('o/a#2'), f).class, 'next');
  f.projects.get(PROJECT).nowId = 'i_next';
  assert.equal(classOfRow(row('o/a#2'), f).class, 'now', 'Next was promoted: its issues are Now, though the iteration starts next year');
  assert.equal(classOfRow(row('o/a#4'), f).class, 'next');
  assert.equal(classOfRow(row('o/a#1'), f).class, 'later', 'the old Now still holds today and is Later');
});

test('R215: on a project whose recorded Now does not hold today, ready --json and why give now for its issues', async (t) => {
  const s = await readySandbox(t, [issueIn('acme/app', 1), issueIn('acme/app', 2), issueIn('acme/app', 3)], {
    'acme/app#1': 'i_now',
    'acme/app#2': 'i_next',
    'acme/app#3': 'i_p1',
  });
  assert.deepEqual((await readyBody(s)).now.map((x) => x.key), ['acme/app#1'], 'with no record, the dates decide');
  recordNow(s.ctx.stateDir, 'i_next');
  const b = await readyBody(s);
  assert.deepEqual(b.now.map((x) => x.key), ['acme/app#2']);
  assert.deepEqual(b.next, [{ repo: 'acme/app', count: 1 }]);
  s.out.length = 0;
  assert.equal(await whyCommand(s.ctx, ['acme/app#2']), 0, s.err.join('\n'));
  const w = JSON.parse(s.out.join('\n'));
  assert.equal(w.class, 'now');
  assert.deepEqual(w.iteration, { id: 'i_next', title: 'Goal B' });
  s.out.length = 0;
  assert.equal(await whyCommand(s.ctx, ['acme/app#1']), 0);
  assert.equal(JSON.parse(s.out.join('\n')).class, 'later');
});

test('R215: class now and next write the iterations that the recorded Now names', async (t) => {
  const s = await classSandbox(t, { items: [{ key: KEY, iterationId: 'i_now' }] });
  recordNow(s.ctx.stateDir, 'i_next');
  assert.equal(await classCommand(s.ctx, [KEY, 'now']), 0, s.err.join('\n'));
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_next');
  assert.equal(body(s).previous, 'later', 'the old Now is Later once Next is recorded as Now');
  assert.equal(await classCommand(s.ctx, [KEY, 'next']), 0, s.err.join('\n'));
  assert.equal(s.fake.itemOf(KEY).iterationId, 'i_p1');
});

test('R215: a pointer file that cannot be read stops ready and class with exit 1', async (t) => {
  const s = await readySandbox(t, [issueIn('acme/app', 1)], { 'acme/app#1': 'i_now' });
  fs.mkdirSync(s.ctx.stateDir, { recursive: true });
  fs.writeFileSync(path.join(s.ctx.stateDir, 'now-pointers.json'), 'not json');
  assert.equal(await readyCommand(s.ctx, []), 1);
  assert.match(s.err.at(-1), /now-pointers\.json: not valid JSON/);
  const c = await classSandbox(t);
  fs.mkdirSync(c.ctx.stateDir, { recursive: true });
  fs.writeFileSync(path.join(c.ctx.stateDir, 'now-pointers.json'), 'not json');
  assert.equal(await classCommand(c.ctx, [KEY, 'now']), 1);
  assert.deepEqual(writes(c), []);
});
