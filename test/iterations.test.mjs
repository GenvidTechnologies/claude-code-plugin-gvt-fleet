process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LONG_DAYS,
  addDays,
  assertKeepsEveryId,
  assertValidLayout,
  classOfIteration,
  compareLayout,
  endDay,
  planAppend,
  planPromote,
  pointers,
  roleOf,
} from '../plugin/cli/lib/iterations.mjs';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import {
  iterationListCommand,
  iterationPlanCommand,
  iterationPromoteCommand,
} from '../plugin/cli/lib/commands.mjs';
import { fakeProject } from './fakes/fake-project.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const TODAY = '2026-11-12';
const NOW = new Date(`${TODAY}T12:00:00.000Z`);

const OLD = { id: 'i_old', title: 'Iteration 1', startDate: '2026-11-01', duration: 5 };
const CUR = { id: 'i_now', title: 'Goal A', startDate: '2026-11-06', duration: 365 };
const NXT = { id: 'i_next', title: 'Goal B', startDate: '2027-11-06', duration: 365 };
const P1 = { id: 'i_p1', title: 'Goal C', startDate: '2028-11-05', duration: 365 };
const P2 = { id: 'i_p2', title: 'Goal D', startDate: '2029-11-05', duration: 365 };
const ALL = [OLD, CUR, NXT, P1, P2];

const ids = (list) => list.map((it) => it.id).sort();

// ---- pure layout ----

test('R185: pointers give the iteration that holds today as Now and the first one after today as Next', () => {
  const p = pointers(ALL, TODAY);
  assert.equal(p.now.id, 'i_now');
  assert.equal(p.next.id, 'i_next');
  assert.equal(pointers(ALL, '2026-11-06').now.id, 'i_now', 'the start day is in the iteration');
  assert.equal(pointers(ALL, '2026-11-05').now.id, 'i_old');
  assert.equal(pointers([OLD], TODAY).now, null);
  assert.equal(pointers([OLD], TODAY).next, null);
  assert.deepEqual(pointers([NXT], TODAY), { now: null, next: NXT, source: 'dates' });
});

test('R185: classOfIteration gives now, next, or later for another iteration and for none', () => {
  const p = pointers(ALL, TODAY);
  assert.equal(classOfIteration('i_now', p), 'now');
  assert.equal(classOfIteration('i_next', p), 'next');
  assert.equal(classOfIteration('i_p1', p), 'later');
  assert.equal(classOfIteration('i_old', p), 'later');
  assert.equal(classOfIteration(null, p), 'later');
  assert.equal(classOfIteration('x', { now: null, next: null }), 'later');
});

test('R186: promote ends Now today, starts Next today for 365 days, and lays the planned ones back to back', () => {
  const r = planPromote(ALL, TODAY);
  const by = Object.fromEntries(r.iterations.map((it) => [it.id, it]));
  assert.deepEqual(by.i_old, OLD, 'a completed iteration is kept as it is');
  assert.deepEqual(by.i_now, { ...CUR, duration: 6 });
  assert.equal(endDay(by.i_now), TODAY);
  assert.deepEqual(by.i_next, { ...NXT, startDate: TODAY, duration: LONG_DAYS });
  assert.equal(by.i_p1.startDate, endDay(by.i_next));
  assert.equal(by.i_p2.startDate, endDay(by.i_p1));
  assert.equal(r.from.now.id, 'i_now');
  assert.equal(r.to.now.id, 'i_next');
  assert.equal(r.to.next.id, 'i_p1');
  assert.deepEqual(ids(r.iterations), ids(ALL), 'every existing id is in the new layout, completed ones included');
});

test('R186: promote with a chosen planned iteration puts it right after the new Now', () => {
  const r = planPromote(ALL, TODAY, 'Goal D');
  assert.equal(r.to.next.id, 'i_p2');
  const by = Object.fromEntries(r.iterations.map((it) => [it.id, it]));
  assert.equal(by.i_p2.startDate, endDay(by.i_next));
  assert.equal(by.i_p1.startDate, endDay(by.i_p2));
  assert.deepEqual(planPromote(ALL, TODAY, 'i_p2').to.next.id, 'i_p2', 'by id too');
});

test('R186: promote with no Now starts Next today and keeps everything else', () => {
  const r = planPromote([OLD, NXT, P1], TODAY);
  assert.equal(r.from.now, null);
  assert.equal(r.to.now.id, 'i_next');
  assert.deepEqual(ids(r.iterations), ids([OLD, NXT, P1]));
});

test('R186: promote refuses with no Next, and for a chosen iteration that is not planned', () => {
  assert.throws(() => planPromote([OLD, CUR], TODAY), /no Next iteration/);
  assert.throws(() => planPromote(ALL, TODAY, 'Goal B'), /no planned iteration after Next is "Goal B"/);
  assert.throws(() => planPromote(ALL, TODAY, 'Iteration 1'), /no planned iteration/);
  assert.throws(() => planPromote([OLD, CUR, NXT, P1, { ...P2, title: 'Goal C' }], TODAY, 'Goal C'), /2 iterations are titled/);
});

test('R186: assertKeepsEveryId throws when a layout leaves out an iteration, a completed one included', () => {
  assert.doesNotThrow(() => assertKeepsEveryId(ALL, [...ALL, { title: 'new' }]));
  assert.throws(() => assertKeepsEveryId(ALL, [CUR, NXT, P1, P2]), /leaves out iteration i_old/);
  assert.throws(() => assertKeepsEveryId(ALL, [OLD, CUR, NXT, P1]), /i_p2/);
});

test('R187: plan appends after the last iteration, or starts today when none ends after today', () => {
  const a = planAppend(ALL, TODAY, 'Goal E');
  assert.deepEqual(a.added, { title: 'Goal E', startDate: endDay(P2), duration: LONG_DAYS });
  assert.deepEqual(ids(a.iterations.filter((it) => it.id)), ids(ALL));
  const b = planAppend([OLD], TODAY, 'First');
  assert.equal(b.added.startDate, TODAY);
  assert.equal(pointers(b.iterations.map((it) => ({ id: 'x', ...it })), TODAY).now.title, 'First');
  assert.equal(planAppend([], TODAY, 'First').added.startDate, TODAY);
  assert.throws(() => planAppend(ALL, TODAY, '  '), /title is empty/);
});

test('R187: compareLayout reports a missing iteration and a moved one, and matches a new one by title', () => {
  assert.deepEqual(compareLayout([CUR, { title: 'New', startDate: TODAY, duration: 1 }], [CUR, { id: 'z', title: 'New', startDate: TODAY, duration: 1 }]), []);
  assert.deepEqual(compareLayout([CUR, NXT], [CUR]), ['iteration i_next is missing']);
  assert.match(compareLayout([CUR], [{ ...CUR, duration: 3 }])[0], /reads 2026-11-06\+3/);
});

test('R187: plan starts after the iteration that ends last, not the one that starts last', () => {
  const long = { id: 'a', title: 'long', startDate: '2026-09-01', duration: 400 };
  const short = { id: 'b', title: 'short', startDate: '2026-09-10', duration: 5 };
  assert.equal(planAppend([long, short], TODAY, 'x').added.startDate, endDay(long));
});

// ---- the recorded Now pointer (ADR 0022) ----

// A Now that started today: the layout of the second goal on a day with two promotes.
const SAME = { id: 'i_now', title: 'Goal A', startDate: TODAY, duration: LONG_DAYS };
const SAME_NXT = { id: 'i_next', title: 'Goal B', startDate: addDays(TODAY, LONG_DAYS), duration: LONG_DAYS };
const SAME_P1 = { id: 'i_p1', title: 'Goal C', startDate: addDays(TODAY, 2 * LONG_DAYS), duration: LONG_DAYS };
const SAME_ALL = [OLD, { ...CUR, id: 'i_prev', duration: daysFrom(CUR.startDate, TODAY) }, SAME, SAME_NXT, SAME_P1];

function daysFrom(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

test('R213: a recorded Now is Now whatever the date, and Next is the first iteration after it', () => {
  const p = pointers(ALL, TODAY, 'i_old');
  assert.equal(p.source, 'recorded');
  assert.equal(p.now.id, 'i_old', 'a Now that does not hold today');
  assert.equal(p.next.id, 'i_now', 'Next follows Now in order, not after today');
  const q = pointers(ALL, TODAY, 'i_next');
  assert.deepEqual([q.now.id, q.next.id], ['i_next', 'i_p1'], 'a Now that starts after today');
  assert.equal(pointers(ALL, TODAY, 'i_p2').next, null);
  const stale = pointers(ALL, TODAY, 'gone');
  assert.deepEqual([stale.source, stale.now.id, stale.next.id], ['dates', 'i_now', 'i_next'], 'an id not in the field falls back to the dates');
});

test('R213: with a recorded Now, an iteration before it is completed and one after Next is planned, whatever the date', () => {
  const p = pointers(ALL, TODAY, 'i_next');
  assert.deepEqual(ALL.map((it) => roleOf(it, p, TODAY)), ['completed', 'completed', 'now', 'next', 'planned']);
  const q = pointers(ALL, TODAY, 'i_old');
  assert.deepEqual(ALL.map((it) => roleOf(it, q, TODAY)), ['now', 'next', 'planned', 'planned', 'planned']);
});

test('R213: promote when Now started today keeps it one day, starts Next the day after, and records Next as Now', () => {
  const r = planPromote(SAME_ALL, TODAY, null, 'i_now');
  const by = Object.fromEntries(r.iterations.map((it) => [it.id, it]));
  assert.deepEqual(by.i_now, { ...SAME, duration: 1 }, 'an iteration cannot have zero days');
  assert.deepEqual(by.i_next, { ...SAME_NXT, startDate: addDays(TODAY, 1), duration: LONG_DAYS });
  assert.equal(by.i_p1.startDate, endDay(by.i_next));
  assert.deepEqual(by.i_old, OLD);
  assert.deepEqual(by.i_prev, SAME_ALL[1], 'completed iterations are kept as they are');
  assert.equal(r.nowId, 'i_next');
  assert.deepEqual([r.from.now.id, r.to.now.id, r.to.next.id], ['i_now', 'i_next', 'i_p1']);
  assert.deepEqual(ids(r.iterations), ids(SAME_ALL));
  assert.doesNotThrow(() => assertValidLayout(r.iterations));
  const d = planPromote(SAME_ALL, TODAY);
  assert.equal(d.nowId, 'i_next', 'with no record, the dates find the Now that started today, and the promote is not refused');
});

test('R213: two promotes in a row on one day each move Now, and every layout is one GitHub keeps whole', () => {
  const first = planPromote(ALL, TODAY, null, null);
  assert.equal(first.nowId, 'i_next');
  const second = planPromote(first.iterations, TODAY, null, first.nowId);
  assert.equal(second.nowId, 'i_p1');
  assert.deepEqual([second.from.now.id, second.to.now.id, second.to.next.id], ['i_next', 'i_p1', 'i_p2']);
  const by = Object.fromEntries(second.iterations.map((it) => [it.id, it]));
  assert.deepEqual([by.i_next.startDate, by.i_next.duration], [TODAY, 1]);
  assert.equal(by.i_p1.startDate, addDays(TODAY, 1));
  const third = planPromote(second.iterations, TODAY, null, second.nowId);
  assert.equal(third.nowId, 'i_p2', 'a third promote starts after the second, which already starts tomorrow');
  assert.equal(Object.fromEntries(third.iterations.map((it) => [it.id, it])).i_p2.startDate, addDays(TODAY, 2));
  for (const r of [first, second, third]) {
    assert.doesNotThrow(() => assertValidLayout(r.iterations));
    assert.deepEqual(ids(r.iterations), ids(ALL));
  }
  assert.throws(() => planPromote(third.iterations, TODAY, null, third.nowId), /no Next iteration/);
});

test('R213: assertValidLayout refuses an iteration under one day and an overlap, the same start date included', () => {
  assert.doesNotThrow(() => assertValidLayout(ALL));
  assert.throws(() => assertValidLayout([OLD, { ...CUR, duration: 0 }]), /lasts 0 days/);
  assert.throws(() => assertValidLayout([CUR, { ...NXT, startDate: CUR.startDate }]), /i_next overlaps i_now/);
  assert.throws(() => assertValidLayout([CUR, { title: 'New', startDate: TODAY, duration: 1 }]), /"New" overlaps i_now/);
});

test('R193: the iterations literal escapes quotes, backslashes and control characters in a title', async () => {
  const { iterationsLiteral } = await import('../plugin/cli/lib/projects.mjs');
  const { parseIterationsLiteral } = await import('./fakes/fake-project.mjs');
  const title = 'a "quoted" \\ back\nslash\ttab';
  const lit = iterationsLiteral([{ id: 'i1', title, startDate: TODAY, duration: 3 }, { title: 'new', startDate: '2026-11-15', duration: 365 }]);
  assert.equal(lit, `[{id: "i1", title: ${JSON.stringify(title)}, startDate: "${TODAY}", duration: 3}, {title: "new", startDate: "2026-11-15", duration: 365}]`);
  assert.deepEqual(parseIterationsLiteral(`iterations: ${lit}}})`), [
    { id: 'i1', title, startDate: TODAY, duration: 3 },
    { title: 'new', startDate: '2026-11-15', duration: 365 },
  ]);
});

test('R193: only a NOT_FOUND error on the projectV2 field path counts as a missing Iteration field', async () => {
  const { isMissingFieldError } = await import('../plugin/cli/lib/projects.mjs');
  const path = ['repositoryOwner', 'projectV2', 'field'];
  assert.equal(isMissingFieldError({ type: 'NOT_FOUND', path, message: 'any wording' }), true);
  assert.equal(isMissingFieldError({ type: 'FORBIDDEN', path, message: 'x' }), false);
  assert.equal(isMissingFieldError({ type: 'NOT_FOUND', path: ['repositoryOwner', 'projectV2'], message: 'x' }), false);
  assert.equal(isMissingFieldError({ type: 'NOT_FOUND' }), false);
});

// ---- commands ----

const PROJECT = 'acme/7';
const REPO = 'acme/app';

async function sandbox(t, fakeOpts = {}, { entry = { project: PROJECT }, seedCache = true } = {}) {
  const dir = makeTempDir(t, 'gvt-fleet-iter-');
  const configFile = path.join(dir, 'repos.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO, ...entry }] }));
  const fake = fakeProject({ today: TODAY, iterations: ALL, ...fakeOpts });
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  if (seedCache) cache.replaceProject(PROJECT, { projectId: fake.state.projectId, fieldId: fake.state.fieldId, iterations: [], items: [] });
  cache.close();
  const out = [];
  const err = [];
  const events = [];
  const ctx = { json: true, configFile, stateDir, gh: fake.gh, clock: { now: () => NOW, sleep: async () => {} }, log: { append: (e) => events.push(e) }, out: (x) => out.push(x), err: (x) => err.push(x) };
  const cached = async () => {
    const c = await openCacheDb(path.join(stateDir, 'cache.db'));
    try {
      return c.readProjects().get(PROJECT);
    } finally {
      c.close();
    }
  };
  return { ctx, out, err, events, fake, cached };
}

const json = (s) => JSON.parse(s.out.at(-1));
const writes = (s) => s.fake.gh.writes().map((c) => c.key);

test('R188: iteration promote writes one field update with every iteration id and no item, and the items keep their iteration', async (t) => {
  const items = [
    { key: `${REPO}#1`, iterationId: 'i_now' },
    { key: `${REPO}#2`, iterationId: 'i_next' },
    { key: `${REPO}#3`, iterationId: 'i_old' },
    { key: `${REPO}#4`, iterationId: 'i_p1' },
  ];
  const s = await sandbox(t, { items });
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['UpdateIterations'], 'one write, and it is the field update: no item is written');
  const sent = s.fake.state.updates[0];
  assert.deepEqual(sent.map((it) => it.id).sort(), ids(ALL), 'every existing id is passed, the completed one included');
  assert.deepEqual(s.fake.state.items.map((it) => it.iterationId), ['i_now', 'i_next', 'i_old', 'i_p1']);
  const b = json(s);
  assert.equal(b.status, 'changed');
  assert.equal(b.from.now.id, 'i_now');
  assert.equal(b.to.now.id, 'i_next');
  assert.equal(b.to.next.id, 'i_p1');
  assert.deepEqual(b.iterations.map((it) => [it.id, it.role]), [
    ['i_old', 'completed'],
    ['i_now', 'completed'],
    ['i_next', 'now'],
    ['i_p1', 'next'],
    ['i_p2', 'planned'],
  ]);
  const c = await s.cached();
  assert.equal(pointers(c.iterations, TODAY).now.id, 'i_next', 'the cache holds the new layout');
  assert.deepEqual(s.events.map((e) => [e.event, e.status]), [['iteration promote', 'changed']]);
});

test('R188: iteration promote with a chosen iteration makes it Next', async (t) => {
  const s = await sandbox(t);
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT, 'Goal D']), 0, s.err.join('\n'));
  assert.equal(json(s).to.next.id, 'i_p2');
});

test('R188: iteration promote refuses with exit 1 and no write when there is no Next', async (t) => {
  const s = await sandbox(t, { iterations: [OLD, CUR] });
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 1);
  assert.deepEqual(writes(s), []);
  assert.equal(json(s).status, 'refused');
  assert.match(json(s).reason, /no Next iteration/);
});

test('R188: a readback that disagrees reports failed and exits 1', async (t) => {
  const s = await sandbox(t, {
    tamper: (op, state) => {
      if (op === 'UpdateIterations') state.iterations = state.iterations.filter((it) => it.id !== 'i_p2');
    },
  });
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 1);
  const b = json(s);
  assert.equal(b.status, 'failed');
  assert.match(b.reason, /iteration i_p2 is missing/);
});

test('R188: iteration plan appends an iteration with every id passed and reads it back', async (t) => {
  const s = await sandbox(t);
  assert.equal(await iterationPlanCommand(s.ctx, [PROJECT, 'Goal E']), 0, s.err.join('\n'));
  assert.deepEqual(writes(s), ['UpdateIterations']);
  const sent = s.fake.state.updates[0];
  assert.deepEqual(sent.filter((it) => it.id).map((it) => it.id).sort(), ids(ALL));
  assert.deepEqual(sent.find((it) => !it.id), { title: 'Goal E', startDate: endDay(P2), duration: LONG_DAYS });
  const b = json(s);
  assert.equal(b.status, 'changed');
  assert.equal(b.added.title, 'Goal E');
  assert.match(b.added.id, /^it_new_/);
});

test('R188: plan and promote refuse a project with no Iteration field', async (t) => {
  const s = await sandbox(t, { field: false, iterations: [] });
  assert.equal(await iterationPlanCommand(s.ctx, [PROJECT, 'x']), 1);
  assert.match(json(s).reason, /no Iteration field/);
  assert.deepEqual(writes(s), []);
});

test('R188: iteration commands exit 64 for a project that no enabled repo names, and for wrong arguments', async (t) => {
  const s = await sandbox(t);
  assert.equal(await iterationPromoteCommand(s.ctx, ['acme/8']), 64);
  assert.equal(await iterationPlanCommand(s.ctx, ['acme/app', 'x']), 64);
  assert.equal(await iterationPlanCommand(s.ctx, [PROJECT]), 64);
  assert.equal(await iterationPromoteCommand(s.ctx, []), 64);
  assert.equal(await iterationListCommand(s.ctx, [PROJECT, 'x']), 64);
  assert.deepEqual(s.fake.gh.calls, []);
});

test('R188: iteration list prints each iteration with its role and writes nothing', async (t) => {
  const s = await sandbox(t);
  assert.equal(await iterationListCommand(s.ctx, []), 0, s.err.join('\n'));
  const b = json(s);
  assert.equal(b.today, TODAY);
  assert.deepEqual(b.projects[0].iterations.map((it) => [it.title, it.role]), [
    ['Iteration 1', 'completed'],
    ['Goal A', 'now'],
    ['Goal B', 'next'],
    ['Goal C', 'planned'],
    ['Goal D', 'planned'],
  ]);
  assert.deepEqual(writes(s), []);
  s.ctx.json = false;
  s.out.length = 0;
  assert.equal(await iterationListCommand(s.ctx, [PROJECT]), 0);
  assert.equal(s.out[0], `${PROJECT}:`);
  assert.equal(s.out[2], '  now       2026-11-06 to 2027-11-06 i_now Goal A');
});

// ---- the recorded Now pointer, through the commands (ADR 0022) ----

const pointerFile = (s) => path.join(s.ctx.stateDir, 'now-pointers.json');
const recorded = (s) => JSON.parse(fs.readFileSync(pointerFile(s), 'utf8'));
const roles = (b) => b.iterations.map((it) => [it.id, it.role]);

test('R214: iteration promote run twice on one UTC day gives changed both times, and iteration list shows the new Now and Next after each', async (t) => {
  const s = await sandbox(t);
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 0, s.err.join('\n'));
  assert.equal(json(s).status, 'changed');
  assert.equal(await iterationListCommand(s.ctx, [PROJECT]), 0, s.err.join('\n'));
  assert.deepEqual(roles(json(s).projects[0]), [
    ['i_old', 'completed'],
    ['i_now', 'completed'],
    ['i_next', 'now'],
    ['i_p1', 'next'],
    ['i_p2', 'planned'],
  ]);

  const second = await iterationPromoteCommand(s.ctx, [PROJECT]);
  const b = json(s);
  assert.equal(b.status, 'changed', `the second promote of the day is not refused: ${b.reason ?? ''}`);
  assert.equal(second, 0);
  assert.deepEqual([b.from.now.id, b.to.now.id, b.to.next.id], ['i_next', 'i_p1', 'i_p2']);
  assert.deepEqual(recorded(s).projects[PROJECT].now, 'i_p1');
  assert.equal(recorded(s).projects[PROJECT].setAt, NOW.toISOString());
  assert.equal(await iterationListCommand(s.ctx, [PROJECT]), 0, s.err.join('\n'));
  assert.equal(json(s).projects[0].pointer, 'recorded');
  assert.deepEqual(roles(json(s).projects[0]), [
    ['i_old', 'completed'],
    ['i_now', 'completed'],
    ['i_next', 'completed'],
    ['i_p1', 'now'],
    ['i_p2', 'next'],
  ]);
  const by = Object.fromEntries(s.fake.state.iterations.map((it) => [it.id, it]));
  assert.deepEqual([by.i_next.startDate, by.i_next.duration], [TODAY, 1], 'the first goal of the day keeps one day');
  assert.equal(by.i_p1.startDate, addDays(TODAY, 1), 'the second starts the day after, and is Now at once');
  assert.deepEqual(ids(s.fake.state.iterations), ids(ALL), 'GitHub kept every iteration');
  assert.deepEqual(s.fake.state.updates.map((u) => u.map((it) => it.id).sort()), [ids(ALL), ids(ALL)], 'each write passes every id');
  assert.deepEqual(s.events.map((e) => [e.event, e.status]), [['iteration promote', 'changed'], ['iteration promote', 'changed']]);
});

test('R214: a promote whose readback fails after GitHub took the update still records the new Now and says so', async (t) => {
  const s = await sandbox(t, {
    tamper: (op, state) => {
      if (op === 'UpdateIterations') state.iterations = state.iterations.map((it) => (it.id === 'i_p2' ? { ...it, title: 'renamed' } : it));
    },
  });
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 1);
  const b = json(s);
  assert.equal(b.status, 'failed');
  assert.match(b.reason, /Now is recorded as i_next: run iteration list before another promote/);
  assert.equal(recorded(s).projects[PROJECT].now, 'i_next');
});

test('R214: a promote that GitHub refuses records nothing', async (t) => {
  const s = await sandbox(t);
  const real = s.ctx.gh;
  s.ctx.gh = {
    ...real,
    graphql: async (query, vars) =>
      /mutation UpdateIterations/.test(query) ? { data: { updateProjectV2Field: null }, errors: [{ type: 'UNPROCESSABLE', message: 'nope' }] } : real.graphql(query, vars),
  };
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 1);
  assert.equal(json(s).status, 'failed');
  assert.equal(fs.existsSync(pointerFile(s)), false);
});

test('R214: a pointer file that cannot be read stops promote with exit 1 and no write', async (t) => {
  const s = await sandbox(t);
  fs.mkdirSync(s.ctx.stateDir, { recursive: true });
  fs.writeFileSync(pointerFile(s), '{"version": 9}');
  assert.equal(await iterationPromoteCommand(s.ctx, [PROJECT]), 1);
  assert.match(json(s).reason, /expected version 1/);
  assert.deepEqual(writes(s), []);
  assert.equal(await iterationListCommand(s.ctx, [PROJECT]), 1);
  assert.match(s.err.at(-1), /expected version 1/);
});

test('R214: iteration list warns about a recorded Now that is not in the field, and follows the dates', async (t) => {
  const s = await sandbox(t);
  fs.mkdirSync(s.ctx.stateDir, { recursive: true });
  fs.writeFileSync(pointerFile(s), JSON.stringify({ version: 1, projects: { [PROJECT]: { now: 'gone', setAt: NOW.toISOString() } } }));
  assert.equal(await iterationListCommand(s.ctx, [PROJECT]), 0);
  assert.equal(json(s).projects[0].pointer, 'dates');
  assert.match(s.err.join('\n'), /recorded Now gone is not in the Iteration field/);
  assert.deepEqual(roles(json(s).projects[0]).find(([, r]) => r === 'now'), ['i_now', 'now']);
});
