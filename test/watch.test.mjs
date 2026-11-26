process.env.GVT_FLEET_FAKE_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import { watchCommand } from '../plugin/cli/lib/commands.mjs';
import { nextWaits, oneLine, formatWait } from '../plugin/cli/lib/watch.mjs';
import { createFakeClaude } from './fakes/fake-claude.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const KEY = 'o/r#7';
const T0 = '2026-11-06T10:00:00.000Z';
const T1 = '2026-11-06T10:05:00.000Z';
const cursor = Date.parse('2026-11-06T09:00:00.000Z');

const row = (over = {}) => ({
  key: KEY,
  state: 'needs-you',
  reason: 'turn-ended',
  detail: 'Which one?',
  since: T0,
  ...over,
});

test('R131: a hook wait is identified by key and since, not by reason', () => {
  const a = nextWaits(null, [row()], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 1);
  assert.deepEqual(a.lines[0], { event: 'needs-you', key: KEY, reason: 'turn-ended', detail: 'Which one?', questions: null, since: T0 });
  // Same key and since, reason changes (Stop then idle_prompt): no second line.
  const b = nextWaits(a.memo, [row({ reason: 'notification:idle_prompt' })], { cursorMs: cursor, agentsOk: true });
  assert.equal(b.lines.length, 0);
  // Same again: still nothing.
  const c = nextWaits(b.memo, [row()], { cursorMs: cursor, agentsOk: true });
  assert.equal(c.lines.length, 0);
  // A new since is a new wait.
  const d = nextWaits(c.memo, [row({ since: T1 })], { cursorMs: cursor, agentsOk: true });
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].since, T1);
});

test('R131: an idle prompt after a turn-ended wait is the same wait, even with its own since', () => {
  const idle = row({ reason: 'notification:idle_prompt', since: T1 });
  const a = nextWaits(null, [row()], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 1);
  const b = nextWaits(a.memo, [idle], { cursorMs: cursor, agentsOk: true });
  assert.equal(b.lines.length, 0);
  // Its identity is recorded as seen: the same row again prints nothing.
  assert.equal(nextWaits(b.memo, [idle], { cursorMs: cursor, agentsOk: true }).lines.length, 0);
  // A permission prompt in between clears the rule: a later idle prompt is a new wait.
  const perm = row({ reason: 'notification:permission_prompt', since: '2026-11-06T10:02:00.000Z' });
  const c = nextWaits(a.memo, [perm], { cursorMs: cursor, agentsOk: true });
  assert.equal(c.lines.length, 1);
  const d = nextWaits(c.memo, [idle], { cursorMs: cursor, agentsOk: true });
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].reason, 'notification:idle_prompt');
  // An idle prompt with no earlier turn-ended wait for the key is a new wait.
  assert.equal(nextWaits(null, [idle], { cursorMs: cursor, agentsOk: true }).lines.length, 1);
  // The input memo is not mutated.
  const snapshot = JSON.stringify(a.memo);
  nextWaits(a.memo, [idle, perm], { cursorMs: cursor, agentsOk: true });
  assert.equal(JSON.stringify(a.memo), snapshot);
});

test('R131: a poll that is not needs-you ends the turn-ended rule', () => {
  const idle = row({ reason: 'notification:idle_prompt', since: '2026-11-06T10:20:00.000Z' });
  const a = nextWaits(null, [row()], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 1);
  for (const state of ['working', 'rate-limited', 'no-session']) {
    const between = nextWaits(a.memo, [row({ state, reason: null, since: T1 })], { cursorMs: cursor, agentsOk: true });
    assert.equal(between.lines.length, 0);
    const later = nextWaits(between.memo, [idle], { cursorMs: cursor, agentsOk: true });
    assert.equal(later.lines.length, 1, state);
    assert.equal(later.lines[0].reason, 'notification:idle_prompt');
  }
});

test('R131: an agents:blocked line carries the poll time as since', () => {
  const blocked = row({ reason: 'agents:blocked', since: '2026-11-06T08:00:00.000Z', detail: null });
  const working = { key: KEY, state: 'working', reason: 'agents:working', detail: null, since: null };
  const a = nextWaits(null, [working], { cursorMs: cursor, agentsOk: true, nowMs: Date.parse(T0) });
  const b = nextWaits(a.memo, [blocked], { cursorMs: cursor, agentsOk: true, nowMs: Date.parse(T1) });
  assert.equal(b.lines.length, 1);
  assert.equal(b.lines[0].since, T1);
});

test('R131: a hook wait with since before the cursor is dropped', () => {
  const late = Date.parse('2026-11-06T10:02:00.000Z');
  const a = nextWaits(null, [row({ since: T0 })], { cursorMs: late, agentsOk: true });
  assert.equal(a.lines.length, 0);
  const b = nextWaits(a.memo, [row({ since: T1 })], { cursorMs: late, agentsOk: true });
  assert.equal(b.lines.length, 1);
  // A since equal to the cursor counts.
  const c = nextWaits(null, [row({ since: T0 })], { cursorMs: Date.parse(T0), agentsOk: true });
  assert.equal(c.lines.length, 1);
});

test('R131: agents:blocked emits only on an observed transition', () => {
  const blocked = row({ reason: 'agents:blocked', since: null, detail: null });
  const working = { key: KEY, state: 'working', reason: 'agents:working', detail: null, since: null };
  // The first readable poll sets the baseline and emits nothing.
  const a = nextWaits(null, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 0);
  // Still blocked: nothing.
  const b = nextWaits(a.memo, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(b.lines.length, 0);
  // Working, then blocked: one line.
  const c = nextWaits(b.memo, [working], { cursorMs: cursor, agentsOk: true });
  assert.equal(c.lines.length, 0);
  const d = nextWaits(c.memo, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].key, KEY);
  assert.equal(d.lines[0].reason, 'agents:blocked');
  assert.equal(d.lines[0].detail, '');
  // A row not seen before, then seen blocked: one line.
  const e = nextWaits(d.memo, [], { cursorMs: cursor, agentsOk: true });
  const f = nextWaits(e.memo, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(f.lines.length, 1);
});

test('R131: an agents-error poll is ignored for the agents:blocked rule', () => {
  const blocked = row({ reason: 'agents:blocked', since: null });
  const working = { key: KEY, state: 'working', reason: 'agents:working', detail: null, since: null };
  const a = nextWaits(null, [working], { cursorMs: cursor, agentsOk: true });
  // An unreadable poll shows the row as blocked: no line, and no memo update.
  const b = nextWaits(a.memo, [blocked], { cursorMs: cursor, agentsOk: false });
  assert.equal(b.lines.length, 0);
  // Unreadable poll with no row at all must not wipe the baseline either.
  const c = nextWaits(b.memo, [], { cursorMs: cursor, agentsOk: false });
  assert.equal(c.lines.length, 0);
  // The next readable poll still compares with the working baseline.
  const d = nextWaits(c.memo, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(d.lines.length, 1);
  // The input memo is not mutated.
  const snapshot = JSON.stringify(a.memo);
  nextWaits(a.memo, [blocked], { cursorMs: cursor, agentsOk: true });
  assert.equal(JSON.stringify(a.memo), snapshot);
});

// A background session that ends its turn can show `done` in the agents list while it waits for the coach.
const doneRow = (over = {}) => row({ state: 'done', reason: 'agents:done', detail: 'Ready for review: #12', lease: 'held', ...over });

test('R217: a held worker that goes from working to done prints one line, and none at the next poll', () => {
  const working = { key: KEY, state: 'working', reason: null, detail: null, since: null, lease: 'held' };
  const a = nextWaits(null, [working], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 0);
  const b = nextWaits(a.memo, [doneRow()], { cursorMs: cursor, agentsOk: true });
  assert.deepEqual(b.lines, [{ event: 'needs-you', key: KEY, reason: 'agents:done', detail: 'Ready for review: #12', since: T0, questions: null }]);
  const c = nextWaits(b.memo, [doneRow()], { cursorMs: cursor, agentsOk: true });
  assert.equal(c.lines.length, 0);
  // A new turn that ends with a new since is a new wait.
  const d = nextWaits(c.memo, [working], { cursorMs: cursor, agentsOk: true });
  const e = nextWaits(d.memo, [doneRow({ since: T1 })], { cursorMs: cursor, agentsOk: true });
  assert.deepEqual(e.lines.map((l) => [l.reason, l.since]), [['agents:done', T1]]);
});

test('R217: a done row prints no line without a held lease, or for a failed or stopped session', () => {
  for (const over of [{ lease: null }, { lease: undefined }, { lease: 'claiming' }, { lease: 'releasing' }, { reason: 'agents:failed' }, { reason: 'agents:stopped' }]) {
    assert.equal(nextWaits(null, [doneRow(over)], { cursorMs: cursor, agentsOk: true }).lines.length, 0, JSON.stringify(over));
  }
});

test('R217: a turn end already printed prints no second line when the session then shows done', () => {
  const a = nextWaits(null, [row({ lease: 'held' })], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 1);
  const b = nextWaits(a.memo, [doneRow()], { cursorMs: cursor, agentsOk: true });
  assert.equal(b.lines.length, 0);
  // Its idle prompt after the session is live again is still the same wait.
  const c = nextWaits(b.memo, [row({ reason: 'notification:idle_prompt', since: T1, lease: 'held' })], { cursorMs: cursor, agentsOk: true });
  assert.equal(c.lines.length, 0);
});

test('R217: a done wait with since before the cursor prints no line', () => {
  assert.equal(nextWaits(null, [doneRow()], { cursorMs: Date.parse(T1), agentsOk: true }).lines.length, 0);
  assert.equal(nextWaits(null, [doneRow({ since: T1 })], { cursorMs: Date.parse(T1), agentsOk: true }).lines.length, 1);
});

test('R132: oneLine collapses whitespace and trims', () => {
  assert.equal(oneLine('  a \n\n b\t\tc  '), 'a b c');
});

test('R132: oneLine keeps the last 160 characters behind ...', () => {
  const long = 'x'.repeat(100) + 'START' + 'y'.repeat(155) + 'END';
  const out = oneLine(long);
  assert.equal(out, '...' + long.slice(-160));
  assert.ok(out.endsWith('END'));
  assert.ok(!out.includes('START'));
  assert.equal(oneLine('z'.repeat(160)), 'z'.repeat(160));
  assert.equal(oneLine('abcdefghij', 4), '...ghij');
});

test('R132: oneLine gives an empty string for null, undefined or empty', () => {
  assert.equal(oneLine(null), '');
  assert.equal(oneLine(undefined), '');
  assert.equal(oneLine(''), '');
  assert.equal(oneLine('   \n '), '');
});

test('R132: formatWait prints text and JSON lines', () => {
  const line = { event: 'needs-you', key: KEY, reason: 'turn-ended', detail: 'Which one?', since: T0 };
  assert.equal(formatWait(line, { json: false }), `${KEY} needs-you turn-ended since ${T0}: Which one?`);
  assert.equal(formatWait({ ...line, detail: '' }, { json: false }), `${KEY} needs-you turn-ended since ${T0}`);
  assert.equal(formatWait(line, { json: true }), JSON.stringify(line));
  const end = { event: 'watch-end', cursor: T1, polls: 3, agentsErrors: 0 };
  assert.equal(formatWait(end, { json: false }), `watch-end ${T1}`);
  assert.equal(formatWait(end, { json: true }), JSON.stringify(end));
});

// ---- the command ----

const WS = 'C:\\work\\fleet';
const BASE = `${WS}\\repos\\acme\\app`;
const wtPath = (name) => `${BASE}\\.claude\\worktrees\\${name}`;
const START = Date.parse('2026-11-06T10:00:00.000Z');
const at = (sec) => new Date(START + sec * 1000).toISOString();
const agent = (n, extra = {}) => ({ id: `abc0000${n}`, sessionId: `S${n}`, name: `app-${n}`, cwd: wtPath(`app-${n}`), kind: 'background', state: 'working', startedAt: START - 3600000, ...extra });
const hook = (event, sessionId, sec, extra = {}) => ({ v: 1, recorded_at: at(sec), event, session_id: sessionId, ...extra });
const stop = (sessionId, sec, msg = 'Which one?') => hook('Stop', sessionId, sec, { last_message: msg });
const FILE1 = 'acme/app/app-1.jsonl';
const FILE2 = 'acme/app/app-2.jsonl';
const DEFAULT_ARGS = ['--minutes', '1', '--interval', '15'];

function addRecords(stateDir, rel, ...records) {
  const file = path.join(stateDir, 'workers', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/**
 * A command context over a temp state dir with a fake clock. The n-th sleep moves the clock on and then runs `steps[n]`,
 * which appends worker records through `add(file, ...records)`. `agents` is a list, or a function of the poll index
 * (it may throw). `gh` is a stand-in that counts any property access.
 */
async function setup(t, { files = {}, agents = [], steps = [], json = true, leases = [] } = {}) {
  const root = makeTempDir(t, 'gvt-fleet-watch-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const add = (rel, ...records) => addRecords(stateDir, rel, ...records);
  for (const [rel, records] of Object.entries(files)) add(rel, ...records);
  const claimsFile = path.join(stateDir, 'claims.db');
  const db = await openClaimsDb(claimsFile);
  try {
    db.immediate(() => {
      for (const l of leases) db.putLease({ labelAdded: true, assigneePreexisting: false, ...l });
    });
  } finally {
    db.close();
  }
  const rows = async () => {
    const d = await openClaimsDb(claimsFile);
    try {
      return d.listLeases();
    } finally {
      d.close();
    }
  };
  const fake = createFakeClaude({ agents: (arg, n) => (typeof agents === 'function' ? agents(n) : agents) });
  const ghAccess = [];
  const gh = new Proxy({}, { get: (_, prop) => { ghAccess.push(String(prop)); return () => { throw new Error(`gh.${String(prop)} called`); }; } });
  const out = [];
  const err = [];
  const events = [];
  let nowMs = START;
  let sleeps = 0;
  const ctx = {
    configFile,
    stateDir,
    json,
    repoRoot: WS,
    paths: { workspace: WS },
    gh,
    claude: fake,
    clock: {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        const step = steps[sleeps];
        sleeps += 1;
        if (step) step(add);
      },
    },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append: (e) => events.push(e) },
  };
  return { ctx, out, err, events, fake, rows, ghAccess, elapsedMs: () => nowMs - START, sleeps: () => sleeps };
}

async function runWatch(t, opts = {}, args = DEFAULT_ARGS) {
  const s = await setup(t, opts);
  const code = await watchCommand(s.ctx, args);
  const lines = s.out.filter((x) => s.ctx.json && x.startsWith('{')).map((x) => JSON.parse(x));
  const waits = lines.filter((l) => l.event === 'needs-you');
  return { s, code, lines, waits };
}

test('R130: a Stop after the start prints one line', async (t) => {
  const { s, code, waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, stop('S1', 20))] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0], { event: 'needs-you', key: 'acme/app#1', reason: 'turn-ended', detail: 'Which one?', questions: null, since: at(20) });
});

test('R130: a Stop and then its idle_prompt print one line', async (t) => {
  const idle = hook('Notification', 'S1', 35, { notification_type: 'idle_prompt', message: 'waiting' });
  const { waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, stop('S1', 20)), (add) => add(FILE1, idle)] });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].reason, 'turn-ended');
});

test('R130: a Stop with an empty last message and then its idle_prompt print one line', async (t) => {
  const idle = hook('Notification', 'S1', 35, { notification_type: 'idle_prompt', message: 'waiting' });
  const { waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, stop('S1', 20, '')), (add) => add(FILE1, idle)] });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].reason, 'turn-ended');
  assert.equal(waits[0].since, at(20));
});

test('R130: a Stop, a new turn and a second Stop print two lines', async (t) => {
  const { waits } = await runWatch(t, {
    agents: [agent(1)],
    steps: [(add) => add(FILE1, stop('S1', 20, 'first')), (add) => add(FILE1, hook('SessionStart', 'S1', 35)), (add) => add(FILE1, stop('S1', 50, 'second'))],
  });
  assert.deepEqual(waits.map((w) => [w.since, w.detail]), [[at(20), 'first'], [at(50), 'second']]);
});

test('R130: two permission_prompt records print two lines', async (t) => {
  const prompt = (sec, message) => hook('Notification', 'S1', sec, { notification_type: 'permission_prompt', message });
  const { waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, prompt(20, 'a')), (add) => add(FILE1, prompt(35, 'b'))] });
  assert.deepEqual(waits.map((w) => [w.reason, w.detail, w.since]), [
    ['notification:permission_prompt', 'a', at(20)],
    ['notification:permission_prompt', 'b', at(35)],
  ]);
});

test('R130: the Stop of a resumed session with a new id prints a line', async (t) => {
  const { waits } = await runWatch(t, {
    agents: (n) => [agent(1, { sessionId: n < 2 ? 'S1' : 'S2' })],
    steps: [(add) => add(FILE1, stop('S1', 20, 'before resume')), (add) => add(FILE1, hook('SessionStart', 'S2', 35)), (add) => add(FILE1, stop('S2', 50, 'after resume'))],
  });
  assert.deepEqual(waits.map((w) => [w.detail, w.since]), [['before resume', at(20)], ['after resume', at(50)]]);
  assert.deepEqual(waits.map((w) => w.key), ['acme/app#1', 'acme/app#1']);
});

test('R130: no line for a record before --since or before the start', async (t) => {
  const files = { [FILE1]: [stop('S1', -3600)], [FILE2]: [stop('S2', 5)], 'acme/app/app-3.jsonl': [stop('S3', 12)] };
  const three = [agent(1), agent(2), agent(3)];
  // With --since: only the record at or after it prints.
  const a = await runWatch(t, { files, agents: three }, [...DEFAULT_ARGS, '--since', at(10)]);
  assert.equal(a.code, 0, a.s.err.join('\n'));
  assert.deepEqual(a.waits.map((w) => w.key), ['acme/app#3']);
  // Without it the cursor is the start: the record an hour earlier stays silent, the other two print.
  const b = await runWatch(t, { files, agents: three });
  assert.deepEqual(b.waits.map((w) => w.key).sort(), ['acme/app#2', 'acme/app#3']);
});

test('R130: a StopFailure that is not a rate limit prints a line and rate_limit prints none', async (t) => {
  const { waits } = await runWatch(t, {
    agents: [agent(1), agent(2)],
    steps: [(add) => { add(FILE1, hook('StopFailure', 'S1', 20, { error: 'server_error' })); add(FILE2, hook('StopFailure', 'S2', 20, { error: 'rate_limit' })); }],
  });
  assert.deepEqual(waits.map((w) => [w.key, w.reason]), [['acme/app#1', 'error:server_error']]);
});

test('R130: a session that turns blocked with no hook record prints a line, none when blocked at the first poll', async (t) => {
  const { waits } = await runWatch(t, {
    agents: (n) => [agent(1, { state: n < 2 ? 'working' : 'blocked' }), agent(2, { state: 'blocked' })],
  });
  assert.deepEqual(waits.map((w) => [w.key, w.reason]), [['acme/app#1', 'agents:blocked']]);
});

test('R130: it ends after --minutes with a watch-end line naming the cursor', async (t) => {
  const a = await runWatch(t, { agents: [agent(1)], json: false });
  assert.equal(a.code, 0, a.s.err.join('\n'));
  assert.equal(a.s.out.at(-1), `watch-end ${at(55)}`);
  assert.equal(a.s.elapsedMs(), 60000);
  assert.equal(a.s.sleeps(), 4);
  assert.equal(a.s.fake.calls.filter((c) => c.op === 'agents').length, 5);
  const end = a.s.events.filter((e) => e.event === 'watch-end');
  assert.equal(end.length, 1);
  assert.deepEqual([end[0].polls, end[0].emitted, end[0].agentsErrors], [5, 0, 0]);
  // --minutes 0 is exactly one poll and never sleeps.
  const b = await runWatch(t, { agents: [agent(1)], json: false }, ['--minutes', '0']);
  assert.equal(b.code, 0);
  assert.equal(b.s.sleeps(), 0);
  assert.equal(b.s.fake.calls.filter((c) => c.op === 'agents').length, 1);
  assert.equal(b.s.out.at(-1), `watch-end ${at(-5)}`);
});

test('R130: --json prints one object per line', async (t) => {
  const { s, code, lines, waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, stop('S1', 20))] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(lines.length, s.out.length, 'every output line is a JSON object');
  assert.equal(waits.length, 1);
  assert.deepEqual(lines.at(-1), { event: 'watch-end', cursor: at(55), polls: 5, agentsErrors: 0 });
  assert.deepEqual(s.events.filter((e) => e.event === 'watch-wait'), [{ event: 'watch-wait', key: 'acme/app#1', reason: 'turn-ended' }]);
  assert.equal(s.events.filter((e) => e.event === 'watch-start').length, 1);
});

test('R130: it writes no lease and makes no GitHub call', async (t) => {
  const lease = { leaseId: 'L1', key: 'acme/app#1', state: 'held', claimedAt: at(-7200), heartbeatAt: at(-7200), expiresAt: at(3600), sessionId: 'S1', shortId: null, worktreePath: null };
  const s = await setup(t, { leases: [lease], agents: [agent(1)], steps: [(add) => add(FILE1, stop('S1', 20))] });
  const before = await s.rows();
  assert.equal(before.length, 1);
  assert.equal(await watchCommand(s.ctx, DEFAULT_ARGS), 0, s.err.join('\n'));
  assert.deepEqual(await s.rows(), before);
  assert.deepEqual(s.ghAccess, []);
  assert.equal(s.out.filter((x) => JSON.parse(x).event === 'needs-you').length, 1);
});

test('R130: it exits 64 for an unknown argument or a bad --minutes, --interval or --since', async (t) => {
  const bad = [['--bogus'], ['stray'], ['--minutes'], ['--minutes', 'x'], ['--minutes', '-1'], ['--minutes', '1.5'], ['--interval'], ['--interval', 'x'], ['--interval', '4'], ['--minutes', '1441'], ['--interval', '3601'], ['--since'], ['--since', 'not-a-date']];
  for (const args of bad) {
    const s = await setup(t, { agents: [agent(1)] });
    assert.equal(await watchCommand(s.ctx, args), 64, args.join(' '));
    assert.deepEqual(s.out, [], args.join(' '));
    assert.equal(s.fake.calls.length, 0, args.join(' '));
  }
  const ok = await setup(t, { agents: [agent(1)] });
  assert.equal(await watchCommand(ok.ctx, ['--minutes', '0', '--interval', '5', '--since', at(0)]), 0, ok.err.join('\n'));
});

test('R130: an unreadable agents poll prints hook waits and no agents:blocked line', async (t) => {
  const { s, code, lines, waits } = await runWatch(t, {
    files: { [FILE1]: [stop('S1', 1)] },
    agents: (n) => {
      if (n === 2) return [agent(1)];
      throw new Error('boom');
    },
  });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(waits.map((w) => [w.key, w.reason]), [['acme/app#1', 'turn-ended']]);
  assert.ok(!lines.some((l) => l.reason === 'agents:blocked'));
  // The message appears on the first failed poll and again after a recovery.
  assert.deepEqual(s.err, ['claude agents unavailable: boom', 'claude agents unavailable: boom']);
  assert.equal(lines.at(-1).agentsErrors, 4);
});

test('R150: a task worker that needs you is reported with its task key', async (t) => {
  const name = 'app.fix-x.20261106.1';
  const task = { id: 'abc00008', sessionId: 'S8', name, cwd: wtPath(name), kind: 'background', state: 'working', startedAt: START - 3600000 };
  const { s, code, waits } = await runWatch(t, { agents: [task], steps: [(add) => add(`acme/app/${name}.jsonl`, stop('S8', 20, 'which?'))] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(waits.map((w) => w.key), ['acme/app@fix-x.20261106.1']);
});

// ---- the questions of an AskUserQuestion wait ----

const ASKED = [
  { question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'], multiSelect: false },
  { question: 'Why?', header: null, options: [], multiSelect: false },
];
const ASKED_DETAIL = 'Which colour? [Red | Blue]\nWhy?';
const askCall = (sessionId, sec) => hook('PreToolUse', sessionId, sec, { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', questions: ASKED });
const askPrompt = (sessionId, sec) => hook('Notification', sessionId, sec, { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
const askIdle = (sessionId, sec) => hook('Notification', sessionId, sec, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });

test('R200: a wait line carries the questions of its row, null when the row has none, and a later idle_prompt row adds no line', () => {
  const asked = row({ reason: 'notification:permission_prompt', detail: ASKED_DETAIL, questions: ASKED });
  const a = nextWaits(null, [asked], { cursorMs: cursor, agentsOk: true });
  assert.equal(a.lines.length, 1);
  assert.deepEqual(a.lines[0], {
    event: 'needs-you',
    key: KEY,
    reason: 'notification:permission_prompt',
    detail: ASKED_DETAIL.replace('\n', ' '),
    questions: ASKED,
    since: T0,
  });
  // The idle_prompt on top of the wait keeps the same since: the same wait.
  const idleOnTop = nextWaits(a.memo, [asked], { cursorMs: cursor, agentsOk: true });
  assert.equal(idleOnTop.lines.length, 0);
  // A row from before the questions existed has no key: the line says null.
  const old = nextWaits(null, [row({ questions: undefined })], { cursorMs: cursor, agentsOk: true });
  assert.equal(old.lines[0].questions, null);
  // The text line is unchanged: the detail is one line.
  assert.equal(
    formatWait(a.lines[0], { json: false }),
    `${KEY} needs-you notification:permission_prompt since ${T0}: Which colour? [Red | Blue] Why?`,
  );
});

test('R200: watch --json prints detail and questions for an AskUserQuestion wait', async (t) => {
  const { s, code, waits } = await runWatch(t, { agents: [agent(1)], steps: [(add) => add(FILE1, askCall('S1', 10), askPrompt('S1', 11))] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0], {
    event: 'needs-you',
    key: 'acme/app#1',
    reason: 'notification:permission_prompt',
    detail: ASKED_DETAIL.replace('\n', ' '),
    questions: ASKED,
    since: at(11),
  });
});

test('R200: an idle_prompt that lands on the wait in a later poll prints no second line, and other waits say questions null', async (t) => {
  const { s, code, waits } = await runWatch(t, {
    agents: [agent(1), agent(2)],
    steps: [(add) => add(FILE1, askCall('S1', 10), askPrompt('S1', 11)), (add) => add(FILE1, askIdle('S1', 40)), (add) => add(FILE2, stop('S2', 50))],
  });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(waits.map((w) => [w.key, w.reason]), [['acme/app#1', 'notification:permission_prompt'], ['acme/app#2', 'turn-ended']]);
  assert.deepEqual(waits[0].questions, ASKED);
  assert.equal(waits[1].questions, null);
  assert.ok(Object.hasOwn(waits[1], 'questions'));
});

test('R130: a worker with no issue number is keyed owner/name:<worktree>', async (t) => {
  const scratch = { id: 'abc00009', sessionId: 'S9', name: 'scratch', cwd: wtPath('scratch'), kind: 'background', state: 'working', startedAt: START - 3600000 };
  const { s, code, waits } = await runWatch(t, { agents: [scratch], steps: [(add) => add('acme/app/scratch.jsonl', stop('S9', 20, 'done?'))] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(waits.map((w) => w.key), ['acme/app:scratch']);
});

test('R217: watch prints one line with the last message for a held worker or task whose session shows done after its turn', async (t) => {
  const task = 'app.fix-x.20261106.1';
  const held = (leaseId, key, sessionId) => ({ leaseId, key, state: 'held', claimedAt: at(-7200), heartbeatAt: at(-7200), expiresAt: at(3600), sessionId, shortId: null, worktreePath: null });
  const taskAgent = (state) => ({ id: 'abc00008', sessionId: 'S8', name: task, cwd: wtPath(task), kind: 'background', state, startedAt: START - 3600000 });
  // From the second poll on, the agents list shows each session done. Worker 2 has no lease.
  const { s, code, waits } = await runWatch(t, {
    leases: [held('L1', 'acme/app#1', 'S1'), held('L8', 'acme/app@fix-x.20261106.1', 'S8')],
    agents: (n) => {
      const state = n < 1 ? 'working' : 'done';
      return [agent(1, { state }), agent(2, { state }), taskAgent(state)];
    },
    steps: [
      (add) => {
        add(FILE1, stop('S1', 20, 'Side pull request opened.\n\nReady for review: #12'));
        add(FILE2, stop('S2', 20, 'Ready for review: #13'));
        add(`acme/app/${task}.jsonl`, stop('S8', 20, 'Ready for review: #14'));
      },
    ],
  });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(waits, [
    { event: 'needs-you', key: 'acme/app#1', reason: 'agents:done', detail: 'Side pull request opened. Ready for review: #12', since: at(20), questions: null },
    { event: 'needs-you', key: 'acme/app@fix-x.20261106.1', reason: 'agents:done', detail: 'Ready for review: #14', since: at(20), questions: null },
  ]);
  assert.ok(s.events.filter((e) => e.event === 'watch-start').length === 1);
  assert.deepEqual(s.events.filter((e) => e.event === 'watch-wait').map((e) => e.reason), ['agents:done', 'agents:done']);
});
