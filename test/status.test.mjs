process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import { statusCommand } from '../plugin/cli/lib/commands.mjs';
import { joinWorkers, MARKERS, refreshLiveLeases } from '../plugin/cli/lib/status.mjs';
import { readWorkerRecords } from '../plugin/cli/lib/worker-state.mjs';
import { createFakeClaude } from './fakes/fake-claude.mjs';
import { github } from './helpers/fake-github.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const WS = 'C:\\work\\fleet';
const REPOS = `${WS}\\repos`;
const BASE = `${REPOS}\\acme\\app`;
const WT1 = `${BASE}\\.claude\\worktrees\\app-1`;
const WT2 = `${BASE}\\.claude\\worktrees\\app-2`;
const NOW = new Date('2026-11-04T10:00:00.000Z');
const FUTURE = '2026-11-04T12:00:00.000Z';
const PAST = '2026-11-04T08:00:00.000Z';
const SOON = '2026-11-04T10:30:00.000Z';
const EXTENDED = new Date(NOW.getTime() + 120 * 60 * 1000).toISOString();
const CONFIG = { repos: [{ repo: 'acme/app' }] };

const lease = (extra = {}) => ({
  leaseId: 'L1',
  key: 'acme/app#1',
  state: 'held',
  claimedAt: '2026-11-04T07:00:00.000Z',
  heartbeatAt: '2026-11-04T07:00:00.000Z',
  expiresAt: FUTURE,
  sessionId: 'S1',
  shortId: null,
  worktreePath: null,
  ...extra,
});
const bg = (extra = {}) => ({ id: 'abc12345', sessionId: 'S1', name: 'app-1', cwd: WT1, kind: 'background', state: 'working', startedAt: 1793700000000, ...extra });
const bg2 = (extra = {}) => bg({ id: 'def67890', sessionId: 'S2', name: 'app-2', cwd: WT2, ...extra });
const lease2 = (extra = {}) => lease({ leaseId: 'L2', key: 'acme/app#2', sessionId: 'S2', ...extra });

function writeFiles(dir, files) {
  for (const [rel, lines] of Object.entries(files)) {
    const file = path.join(dir, 'workers', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
}

// Worker records are built by writing hook-format lines into a temp state dir and calling
// readWorkerRecords, so the entries have the shape the command will pass.
function records(files) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-status-'));
  try {
    writeFiles(dir, files);
    return readWorkerRecords(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const rec = (event, sessionId, extra = {}) => ({ v: 1, recorded_at: '2026-11-04T09:00:00.000Z', event, session_id: sessionId, ...extra });

const join = (input) => joinWorkers({ leases: [], agents: [], agentsError: null, records: [], config: CONFIG, workspace: WS, reposDir: REPOS, now: NOW, ...input });
const healthy = (w) => w.markers.length === 0 && w.state === 'working';
function only(out, marker) {
  const rows = out.workers.filter((w) => w.markers.includes(marker));
  assert.equal(rows.length, 1, `one row with ${marker}`);
  assert.equal(out.workers.filter(healthy).length, 0, 'no healthy row stands in');
  return rows[0];
}

/**
 * A command context over a temp state dir: a config file, leases in claims.db, worker files, a rate-limit snapshot,
 * a fake `claude` and a recording fake `gh`. `agents` is a list, or a function for the fake's `agents` op.
 */
async function sandbox(t, { leases = [], agents = [], files = {}, rateLimits = null, json = true, cached = [] } = {}) {
  const root = makeTempDir(t, 'gvt-fleet-status-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  writeFiles(stateDir, files);
  if (rateLimits !== null) fs.writeFileSync(path.join(stateDir, 'rate-limits.json'), JSON.stringify(rateLimits), 'utf8');
  const claimsFile = path.join(stateDir, 'claims.db');
  const db = await openClaimsDb(claimsFile);
  try {
    db.immediate(() => {
      for (const l of leases) db.putLease({ labelAdded: true, assigneePreexisting: false, ...l });
    });
  } finally {
    db.close();
  }
  const cacheDb = await openCacheDb(path.join(stateDir, 'cache.db'));
  try {
    for (const row of cached) cacheDb.upsertIssue(row);
  } finally {
    cacheDb.close();
  }
  const gh = github({ issues: {} });
  const fake = createFakeClaude({ agents });
  const out = [];
  const err = [];
  const events = [];
  const ctx = {
    configFile,
    stateDir,
    json,
    repoRoot: WS,
    paths: { workspace: WS },
    gh: gh.gh,
    claude: fake,
    clock: { now: () => NOW, sleep: async () => {} },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append: (e) => events.push(e) },
  };
  const rows = async () => {
    const d = await openClaimsDb(claimsFile);
    try {
      return d.listLeases();
    } finally {
      d.close();
    }
  };
  return { root, stateDir, claimsFile, ctx, gh: gh.gh, fake, out, err, events, rows };
}

/** Run `status --json` over a sandbox. Returns the sandbox, the exit code and the parsed output. */
async function runJson(t, opts) {
  const s = await sandbox(t, opts);
  const code = await statusCommand(s.ctx, []);
  return { s, code, json: JSON.parse(s.out.join('\n')) };
}

/** The pure join and the command's `--json` output over the same input. */
async function views(t, input) {
  const pure = join({ leases: input.leases, agents: input.agents, records: records(input.files ?? {}) });
  const { s, code, json } = await runJson(t, input);
  assert.equal(code, 0, s.err.join('\n'));
  return { pure, cmd: json, s };
}

test('R64: status prints one entry per worker with issue, state, needs-you reason, lease expiry, short id and path', async (t) => {
  const s = await sandbox(t, {
    json: false,
    leases: [lease({ expiresAt: SOON }), lease2({ expiresAt: SOON })],
    agents: [bg(), bg2()],
    files: { 'acme/app/app-1.jsonl': [rec('SessionStart', 'S1'), rec('Stop', 'S1', { last_message: 'done?' })] },
  });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const lines = s.out.join('\n').split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.equal(lines[0], `acme/app#1 needs-you turn-ended lease ${EXTENDED} session abc12345 ${path.join(BASE, '.claude', 'worktrees', 'app-1')}`);
  assert.equal(lines[1], `acme/app#2 working lease ${EXTENDED} session def67890 ${path.join(BASE, '.claude', 'worktrees', 'app-2')}`);
  assert.equal(lines[2], 'workers: 2');
  assert.deepEqual(s.err, []);
});

test('R64: status --json prints the documented structure, sorted with needs-you workers first', async (t) => {
  const snapshot = { v: 1, observed_at: '2026-11-04T09:59:00.000Z', session_id: 'S1', five_hour: { used_percentage: 42, resets_at: 1793720000 } };
  // The working worker sorts before the needs-you worker by key, so only the state rank puts the needs-you worker first.
  const { json } = await runJson(t, {
    leases: [lease({ key: 'acme/app#2', leaseId: 'L2', sessionId: 'S2' }), lease({ key: 'acme/app#9', leaseId: 'L9', sessionId: 'S9' })],
    agents: [bg2(), bg({ id: '99999999', sessionId: 'S9', name: 'app-9', cwd: `${BASE}\\.claude\\worktrees\\app-9` })],
    files: { 'acme/app/app-9.jsonl': [rec('SessionStart', 'S9'), rec('Stop', 'S9', { last_message: 'q?' })] },
    rateLimits: snapshot,
  });
  assert.deepEqual(Object.keys(json).sort(), ['agents', 'ignored', 'rateLimits', 'tasks', 'workers']);
  assert.deepEqual(json.agents, { ok: true });
  assert.deepEqual(json.ignored, { records: 0, leases: 0 });
  assert.deepEqual(json.rateLimits, snapshot);
  assert.deepEqual(json.workers.map((w) => [w.key, w.state]), [['acme/app#9', 'needs-you'], ['acme/app#2', 'working']]);
  const w = json.workers[0];
  assert.deepEqual(Object.keys(w).sort(), ['detail', 'issue', 'key', 'lease', 'markers', 'path', 'questions', 'reason', 'repo', 'session', 'since', 'state', 'worktree']);
  assert.equal(w.issue, null, 'nothing is cached, so the issue is null');
  assert.deepEqual(Object.keys(w.lease).sort(), ['expiredAt', 'expiresAt', 'refreshed', 'state']);
  assert.deepEqual(Object.keys(w.session).sort(), ['agentsState', 'kind', 'sessionId', 'shortId']);
  assert.equal(w.repo, 'acme/app');
  assert.equal(w.worktree, 'app-9');
  assert.equal(w.reason, 'turn-ended');
  assert.equal(w.detail, 'q?');
  assert.deepEqual(w.markers, []);
  const none = await runJson(t, {});
  assert.equal(none.json.rateLimits, null);
});

test('R109: a worker row carries the cached issue as {title, state, closingPrs}, found by a key that differs in case', async (t) => {
  const cachedRow = {
    key: 'acme/app#1',
    repo: 'acme/app',
    number: 1,
    state: 'open',
    title: 'Fix the thing',
    managed: true,
    closingPrs: [{ number: 7, state: 'OPEN', headRefName: 'feat/thing', repo: 'acme/app' }],
  };
  const expected = { title: 'Fix the thing', state: 'open', closingPrs: [{ number: 7, state: 'OPEN', headRefName: 'feat/thing' }] };
  // The map key is lowercase; the lease key is not.
  const pure = join({ leases: [lease({ key: 'ACME/app#1' })], agents: [bg()], issues: new Map([['acme/app#1', cachedRow]]) });
  assert.equal(pure.workers.length, 1);
  assert.deepEqual(pure.workers[0].issue, expected);
  // Through the command: the rows come from cache.db.
  const { json } = await runJson(t, { leases: [lease()], agents: [bg()], cached: [cachedRow] });
  assert.deepEqual(json.workers[0].issue, expected);
});

test('R109: a worker row whose issue is not cached, or has no issue number, has issue null', async (t) => {
  const other = { key: 'acme/app#5', repo: 'acme/app', number: 5, state: 'open', title: 'Other', managed: true };
  const { json } = await runJson(t, {
    leases: [lease()],
    agents: [bg()],
    files: { 'acme/app/scratch.jsonl': [rec('SessionStart', 'S3')] },
    cached: [other],
  });
  const byWorktree = new Map(json.workers.map((w) => [w.worktree, w]));
  assert.equal(byWorktree.size, 2);
  assert.equal(byWorktree.get('app-1').issue, null);
  assert.equal(byWorktree.get('scratch').key, null);
  assert.equal(byWorktree.get('scratch').issue, null);
});

test('R65: status joins a lease, a session and a worker file whose paths differ in drive-letter case and slashes', async (t) => {
  assert.equal(MARKERS.length, 14);
  const { pure, cmd } = await views(t, {
    leases: [lease()],
    agents: [bg({ cwd: 'c:/work/fleet/repos/acme/app/.claude/worktrees/app-1' })],
    files: { 'ACME/App/APP-1.jsonl': [rec('SessionStart', 'S1'), rec('Stop', 'S1', { last_message: 'done?' })] },
  });
  for (const out of [pure, cmd]) {
    assert.equal(out.workers.length, 1);
    const w = out.workers[0];
    assert.equal(w.key, 'acme/app#1');
    assert.notEqual(w.lease, null);
    assert.equal(w.session.sessionId, 'S1');
    assert.equal(w.state, 'needs-you');
    assert.equal(w.reason, 'turn-ended');
    assert.deepEqual(w.markers, []);
    assert.equal(out.ignored.records, 0);
  }
});

test('R66: status marks a held claim with no session as no-session', async (t) => {
  const { pure, cmd } = await views(t, { leases: [lease()] });
  for (const out of [pure, cmd]) {
    const w = only(out, 'no-session');
    assert.equal(w.state, 'no-session');
    assert.equal(w.session, null);
    assert.equal(w.refresh ?? null, null);
    assert.equal(w.lease.refreshed, false);
  }
});

test('R66: status marks a session with no claim as no-claim', async (t) => {
  const { pure, cmd } = await views(t, { agents: [bg()] });
  for (const out of [pure, cmd]) {
    const w = only(out, 'no-claim');
    assert.equal(w.lease, null);
    assert.equal(w.key, 'acme/app#1');
    assert.equal(w.session.sessionId, 'S1');
  }
});

test('R66: status marks a worker file with no claim and no session as records-only', async (t) => {
  const { pure, cmd } = await views(t, { files: { 'acme/app/app-1.jsonl': [rec('SessionStart', 'S1')] } });
  for (const out of [pure, cmd]) {
    const w = only(out, 'records-only');
    assert.equal(w.lease, null);
    assert.equal(w.session, null);
  }
});

test('R66: status marks a done hook state with a live session as hook-done-session-live', async (t) => {
  const { pure, cmd } = await views(t, {
    leases: [lease()],
    agents: [bg()],
    files: { 'acme/app/app-1.jsonl': [rec('SessionStart', 'S1'), rec('SessionEnd', 'S1', { reason: 'other' })] },
  });
  for (const out of [pure, cmd]) assert.equal(only(out, 'hook-done-session-live').state, 'working');
  assert.equal(pure.workers[0].refresh, 'extend');
  assert.equal(cmd.workers[0].lease.refreshed, true);
});

test('R66: status marks an expired lease with a live session as revived', async (t) => {
  const { pure, cmd } = await views(t, { leases: [lease({ expiresAt: PAST })], agents: [bg()] });
  for (const out of [pure, cmd]) {
    const w = only(out, 'revived');
    assert.equal(w.lease.expiredAt, PAST);
    assert.equal(w.markers.includes('lease-expired'), false);
  }
  assert.equal(pure.workers[0].lease.refreshed, false);
  assert.equal(pure.workers[0].refresh, 'revive');
  assert.equal(cmd.workers[0].lease.refreshed, true);
  assert.equal(cmd.workers[0].lease.expiresAt, EXTENDED);
});

test('R66: status marks records from an earlier session id as stale-records and ignores them', async (t) => {
  const { pure, cmd } = await views(t, {
    leases: [lease()],
    agents: [bg()],
    files: { 'acme/app/app-1.jsonl': [rec('SessionStart', 'S0'), rec('Stop', 'S0', { last_message: 'old' })] },
  });
  for (const out of [pure, cmd]) {
    const w = only(out, 'stale-records');
    assert.equal(w.state, 'working');
    assert.equal(w.reason, null);
    assert.equal(out.workers.length, 1);
  }
});

test('R66: status marks a lease session id that differs from the listed one as session-id-mismatch', async (t) => {
  const { pure, cmd } = await views(t, { leases: [lease({ sessionId: 'S-old' })], agents: [bg({ sessionId: 'S-new' })] });
  for (const out of [pure, cmd]) assert.equal(only(out, 'session-id-mismatch').session.sessionId, 'S-new');
  assert.equal(pure.workers[0].refresh, 'extend');
});

test('R67: status lists no interactive session and no session outside the managed worktrees', async (t) => {
  const agents = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'claude-agents-sample.json'), 'utf8'));
  assert.ok(agents.some((a) => a.kind === 'interactive' && a.name === 'app-7'));
  const { pure, cmd } = await views(t, { agents });
  for (const out of [pure, cmd]) {
    assert.equal(out.workers.length, 1);
    const w = out.workers[0];
    assert.equal(w.key, 'acme/app#3');
    assert.equal(w.session.shortId, '5e6f7081');
    assert.deepEqual(w.markers, ['no-claim']);
    const listed = JSON.stringify(out);
    for (const sid of ['555555555551', '555555555552', '555555555553', '555555555554', '555555555556']) {
      assert.equal(listed.includes(sid), false, sid);
    }
  }
  // A second background entry in the same worktree adds a marker to the row. It does not add a row and it is not dropped.
  const twin = join({ leases: [lease()], agents: [bg(), bg({ id: 'ffff0000', sessionId: 'S9', name: 'other', cwd: WT1 })] });
  assert.equal(twin.workers.length, 1);
  assert.ok(twin.workers[0].markers.includes('duplicate-session'));
});

test('R68: status extends a held lease whose worker is live and shows the new expiry', async (t) => {
  const { s, code, json } = await runJson(t, { leases: [lease({ expiresAt: SOON })], agents: [bg()] });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(json.workers[0].lease.expiresAt, EXTENDED);
  assert.equal(json.workers[0].lease.refreshed, true);
  assert.equal(json.workers[0].lease.expiredAt, null);
  const row = (await s.rows())[0];
  assert.equal(row.expiresAt, EXTENDED);
  assert.equal(row.heartbeatAt, NOW.toISOString());
  assert.equal(row.state, 'held');
});

test('R69: status keeps the expiry of a held lease whose worker is not live', async (t) => {
  const { s, code, json } = await runJson(t, {
    leases: [lease({ expiresAt: SOON }), lease2({ expiresAt: SOON })],
    agents: [bg({ state: 'done' })],
  });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(json.workers.map((w) => [w.key, w.lease.expiresAt, w.lease.refreshed]).sort(), [['acme/app#1', SOON, false], ['acme/app#2', SOON, false]]);
  for (const row of await s.rows()) {
    assert.equal(row.expiresAt, SOON);
    assert.equal(row.heartbeatAt, '2026-11-04T07:00:00.000Z');
  }
});

test('R70: status does not change a claiming, releasing, failed or released lease', async (t) => {
  const leases = [
    lease({ leaseId: 'La', key: 'acme/app#1', state: 'claiming', sessionId: 'S1', expiresAt: null }),
    lease({ leaseId: 'Lb', key: 'acme/app#2', state: 'releasing', sessionId: 'S2' }),
    lease({ leaseId: 'Lc', key: 'acme/app#3', state: 'failed', sessionId: 'S3' }),
    lease({ leaseId: 'Ld', key: 'acme/app#4', state: 'released', sessionId: 'S4' }),
  ];
  const agents = [1, 2, 3, 4].map((n) => bg({ id: `aaaa000${n}`, sessionId: `S${n}`, name: `app-${n}`, cwd: `${BASE}\\.claude\\worktrees\\app-${n}` }));
  const s = await sandbox(t, { leases, agents });
  const before = await s.rows();
  assert.equal(before.length, 4);
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  assert.deepEqual(await s.rows(), before);
  const json = JSON.parse(s.out.join('\n'));
  assert.ok(json.workers.find((w) => w.key === 'acme/app#1').markers.includes('claiming'));
  assert.ok(json.workers.find((w) => w.key === 'acme/app#2').markers.includes('releasing'));

  // A row that still asks for a refresh, over a lease that is no longer held, changes nothing.
  const db = await openClaimsDb(s.claimsFile);
  try {
    const forged = before.map((l) => ({ key: l.key, leaseId: l.leaseId, refresh: 'extend', markers: [], lease: { state: 'held', expiresAt: l.expiresAt, refreshed: false, expiredAt: null } }));
    assert.deepEqual(refreshLiveLeases(db, forged, { now: NOW, leaseMinutes: 120 }), { refreshed: 0, revived: 0 });
    assert.deepEqual(db.listLeases(), before);
    assert.equal(forged.some((r) => r.lease.refreshed), false);
  } finally {
    db.close();
  }
});

test('R71: status revives an expired held lease whose worker is live and shows that it had expired', async (t) => {
  const { s, code, json } = await runJson(t, { leases: [lease({ expiresAt: PAST })], agents: [bg()] });
  assert.equal(code, 0, s.err.join('\n'));
  const w = json.workers[0];
  assert.ok(w.markers.includes('revived'));
  assert.equal(w.lease.refreshed, true);
  assert.equal(w.lease.expiredAt, PAST);
  assert.equal(w.lease.expiresAt, EXTENDED);
  const row = (await s.rows())[0];
  assert.equal(row.state, 'held');
  assert.equal(row.expiresAt, EXTENDED);
  assert.equal(row.heartbeatAt, NOW.toISOString());

  const text = await sandbox(t, { json: false, leases: [lease({ expiresAt: PAST })], agents: [bg()] });
  assert.equal(await statusCommand(text.ctx, []), 0);
  assert.match(text.out.join('\n'), new RegExp(`lease ${EXTENDED} \\(expired at ${PAST}\\) session abc12345 .* \\[revived\\]$`, 'm'));
});

test('R72: status reports a held lease with no live worker and releases nothing', async (t) => {
  const s = await sandbox(t, {
    leases: [lease({ expiresAt: PAST }), lease2({ expiresAt: PAST })],
    agents: [bg({ state: 'done' })],
  });
  const before = await s.rows();
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const json = JSON.parse(s.out.join('\n'));
  const one = json.workers.find((w) => w.key === 'acme/app#1');
  const two = json.workers.find((w) => w.key === 'acme/app#2');
  assert.ok(one.markers.includes('session-done'));
  assert.ok(one.markers.includes('lease-expired'));
  assert.equal(one.state, 'done');
  assert.ok(two.markers.includes('lease-expired'));
  assert.equal(two.markers.includes('session-done'), false);
  assert.deepEqual(await s.rows(), before);
  assert.deepEqual((await s.rows()).map((l) => l.state), ['held', 'held']);
  assert.equal(s.gh.calls.length, 0);
  assert.deepEqual(s.fake.calls.map((c) => c.op), ['agents']);
});

test('R73: status with an unreadable session list prints the claims and hook view, says the list is unavailable, extends no lease and exits 1', async (t) => {
  const s = await sandbox(t, {
    leases: [lease({ expiresAt: SOON })],
    agents: () => {
      throw new Error('claude agents failed (1): boom');
    },
    files: { 'acme/app/app-2.jsonl': [rec('SessionStart', 'S2')] },
  });
  const before = await s.rows();
  assert.equal(await statusCommand(s.ctx, []), 1);
  assert.deepEqual(s.err, ['claude agents unavailable: claude agents failed (1): boom']);
  const json = JSON.parse(s.out.join('\n'));
  assert.deepEqual(json.agents, { ok: false, error: 'claude agents failed (1): boom' });
  assert.deepEqual(json.workers.map((w) => w.key).sort(), ['acme/app#1', 'acme/app#2']);
  assert.ok(json.workers.every((w) => w.session === null));
  assert.equal(json.workers.find((w) => w.key === 'acme/app#1').lease.refreshed, false);
  assert.deepEqual(await s.rows(), before);

  const text = await sandbox(t, { json: false, leases: [lease()], agents: () => Promise.reject(new Error('boom')) });
  assert.equal(await statusCommand(text.ctx, []), 1);
  assert.deepEqual(text.err, ['claude agents unavailable: boom']);
  assert.match(text.out.join('\n'), /^acme\/app#1 unknown lease \S+ session - /m);
  assert.match(text.out.join('\n'), /^workers: 1$/m);
});

test('R74: status with no leases, sessions or worker files prints an empty view and exits 0', async (t) => {
  const { s, code, json } = await runJson(t, {});
  assert.equal(code, 0);
  assert.deepEqual(json.workers, []);
  assert.deepEqual(json.agents, { ok: true });
  assert.deepEqual(s.err, []);
  const text = await sandbox(t, { json: false });
  assert.equal(await statusCommand(text.ctx, []), 0);
  assert.deepEqual(text.out, ['workers: 0']);
  assert.deepEqual(text.err, []);
  assert.equal(await statusCommand(text.ctx, ['extra']), 64);
});

test('R75: status makes no GitHub write for a mix of live and dead workers', async (t) => {
  const s = await sandbox(t, {
    leases: [lease({ expiresAt: SOON }), lease2({ expiresAt: PAST }), lease({ leaseId: 'L3', key: 'acme/app#3', sessionId: 'S3', expiresAt: PAST }), lease({ leaseId: 'L4', key: 'acme/app#4', sessionId: 'S4' })],
    agents: [bg(), bg2(), bg({ id: 'aaaa0003', sessionId: 'S3', name: 'app-3', cwd: `${BASE}\\.claude\\worktrees\\app-3`, state: 'failed' })],
  });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  assert.equal(s.gh.calls.length, 0);
  assert.deepEqual((await s.rows()).map((l) => l.state), ['held', 'held', 'held', 'held']);
});

test('NF-concurrent: status does not modify a lease that changed state between its read and its write', async (t) => {
  const s = await sandbox(t, {
    leases: [lease({ expiresAt: SOON })],
    agents: async () => {
      // The lease changes after status has read it and before status writes.
      const db = await openClaimsDb(s.claimsFile);
      try {
        db.immediate(() => db.updateLease('L1', { state: 'releasing' }));
      } finally {
        db.close();
      }
      return [bg()];
    },
  });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const row = (await s.rows())[0];
  assert.equal(row.state, 'releasing');
  assert.equal(row.expiresAt, SOON);
  assert.equal(row.heartbeatAt, '2026-11-04T07:00:00.000Z');
  const json = JSON.parse(s.out.join('\n'));
  assert.equal(json.workers[0].lease.refreshed, false);
  assert.equal(s.events.at(-1).refreshed, 0);
});

// A worker whose last hook record is a turn boundary is not mid-turn when its session ends, so the
// hook-live-session-gone marker would be noise. A record that shows work or a pending question keeps it.
const FILE1 = 'acme/app/app-1.jsonl';
function gone(agents, line) {
  const out = join({ leases: [lease()], agents, records: records({ [FILE1]: [line] }) });
  assert.equal(out.workers.length, 1);
  return out.workers[0];
}

test('R103: status gives no hook-live-session-gone marker for a Stop record and a done session', () => {
  const w = gone([bg({ state: 'done' })], rec('Stop', 'S1'));
  assert.equal(w.state, 'done');
  assert.equal(w.markers.includes('hook-live-session-gone'), false);
});

test('R103: status gives no hook-live-session-gone marker for an idle_prompt record and a done session', () => {
  const w = gone([bg({ state: 'done' })], rec('Notification', 'S1', { notification_type: 'idle_prompt' }));
  assert.equal(w.state, 'done');
  assert.equal(w.markers.includes('hook-live-session-gone'), false);
});

test('R103: status gives no hook-live-session-gone marker for a StopFailure record and a failed session', () => {
  const w = gone([bg({ state: 'failed' })], rec('StopFailure', 'S1', { error: 'server_error' }));
  assert.equal(w.state, 'done');
  assert.equal(w.markers.includes('hook-live-session-gone'), false);
});

test('R103: status keeps the hook-live-session-gone marker for a SessionStart record and a done session', () => {
  const w = gone([bg({ state: 'done' })], rec('SessionStart', 'S1'));
  assert.equal(w.markers.includes('hook-live-session-gone'), true);
});

test('R103: status keeps the hook-live-session-gone marker for a permission_prompt record and a done session', () => {
  const w = gone([bg({ state: 'done' })], rec('Notification', 'S1', { notification_type: 'permission_prompt' }));
  assert.equal(w.markers.includes('hook-live-session-gone'), true);
});

test('R103: status gives no hook-live-session-gone marker for a Stop record and no matching session', () => {
  const w = gone([], rec('Stop', 'S1'));
  assert.equal(w.state, 'no-session');
  assert.equal(w.markers.includes('hook-live-session-gone'), false);
});

// An idle_prompt notification follows the Stop that ended the turn by about a minute. The row shows
// the worker's last message and the time of that Stop, when the Stop is the session's turn Stop.
const IDLE_MSG = 'Claude is waiting for your input';
const at = (s) => `2026-11-04T09:00:${String(s).padStart(2, '0')}.000Z`;
const stop = (sid, s, msg = 'q?') => rec('Stop', sid, { recorded_at: at(s), last_message: msg });
const idle = (sid, s) => rec('Notification', sid, { recorded_at: at(s), notification_type: 'idle_prompt', message: IDLE_MSG });
const liveRow = (lines) => {
  const out = join({ leases: [lease()], agents: [bg()], records: records({ [FILE1]: lines }) });
  assert.equal(out.workers.length, 1);
  return out.workers[0];
};

test('R120: status shows the last message and the time of the Stop for an idle_prompt of the same session', () => {
  const w = liveRow([rec('SessionStart', 'S1', { recorded_at: at(1) }), stop('S1', 10), idle('S1', 20)]);
  assert.equal(w.state, 'needs-you');
  assert.equal(w.reason, 'notification:idle_prompt');
  assert.equal(w.detail, 'q?');
  assert.equal(w.since, at(10));
});

test('R120: status keeps the Stop message and time across records of another session and a second idle_prompt', () => {
  const w = liveRow([stop('S1', 10), rec('SessionStart', 'S2', { recorded_at: at(12) }), idle('S1', 20), idle('S1', 30)]);
  assert.equal(w.reason, 'notification:idle_prompt');
  assert.equal(w.detail, 'q?');
  assert.equal(w.since, at(10));
});

test('R120: status keys the Stop by the session of the live row when another session is the last record', () => {
  const w = liveRow([stop('S1', 10), idle('S1', 20), rec('SessionStart', 'S2', { recorded_at: at(30) })]);
  assert.equal(w.reason, 'notification:idle_prompt');
  assert.equal(w.detail, 'q?');
  assert.equal(w.since, at(10));
});

function assertFallback(w, sinceSec) {
  assert.equal(w.state, 'needs-you');
  assert.equal(w.reason, 'notification:idle_prompt');
  assert.equal(w.detail, IDLE_MSG);
  assert.equal(w.since, at(sinceSec));
}

test('R121: an idle_prompt with no Stop in the file shows the notification message and time', () => {
  assertFallback(liveRow([rec('SessionStart', 'S1', { recorded_at: at(1) }), idle('S1', 20)]), 20);
});

test('R121: an idle_prompt after the Stop of another session only shows the notification message and time', () => {
  assertFallback(liveRow([stop('S2', 10, 'other worker'), idle('S1', 20)]), 20);
});

test('R121: a SessionStart, StopFailure or other needs-you notification between the Stop and the idle_prompt gives the notification message and time', () => {
  const between = [
    rec('SessionStart', 'S1', { recorded_at: at(15) }),
    rec('StopFailure', 'S1', { recorded_at: at(15), error: 'server_error' }),
    rec('Notification', 'S1', { recorded_at: at(15), notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
  ];
  for (const mid of between) {
    assertFallback(liveRow([stop('S1', 10), mid, idle('S1', 20)]), 20);
  }
});

test('R121: an idle_prompt whose Stop is outside the last 64 KB shows the notification message and time', () => {
  const lines = [stop('S1', 10), rec('SessionStart', 'S2', { recorded_at: at(12), pad: 'x'.repeat(70000) }), idle('S1', 20)];
  const entries = records({ [FILE1]: lines });
  assert.equal(entries.length, 1);
  assert.ok(entries[0].bytesRead <= 65536);
  assert.equal(entries[0].sessions.get('S1').event, 'Notification');
  assert.equal(entries[0].records, 1, 'the Stop is not in the tail');
  assertFallback(liveRow(lines), 20);
});

test('R121: an idle_prompt after a Stop with an empty or missing last_message shows the notification message and time', () => {
  const noMessage = rec('Stop', 'S1', { recorded_at: at(10) });
  for (const s of [stop('S1', 10, ''), noMessage]) {
    assertFallback(liveRow([s, idle('S1', 20)]), 20);
  }
});

test('R122: the other needs-you notifications after a Stop keep their own message and time', () => {
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    const note = rec('Notification', 'S1', { recorded_at: at(20), notification_type: type, message: `Claude needs your permission ${type}` });
    const w = liveRow([stop('S1', 10), note]);
    assert.equal(w.state, 'needs-you', type);
    assert.equal(w.reason, `notification:${type}`, type);
    assert.equal(w.detail, `Claude needs your permission ${type}`, type);
    assert.equal(w.since, at(20), type);
  }
});

test('R122: an idle_prompt after a Stop keeps its reason and adds no hook-live-session-gone marker for a done session', () => {
  const lines = [stop('S1', 10), idle('S1', 20)];
  assert.equal(liveRow(lines).reason, 'notification:idle_prompt');
  const out = join({ leases: [lease()], agents: [bg({ state: 'done' })], records: records({ [FILE1]: lines }) });
  assert.equal(out.workers.length, 1);
  assert.equal(out.workers[0].state, 'done');
  assert.equal(out.workers[0].since, at(10));
  assert.equal(out.workers[0].markers.includes('hook-live-session-gone'), false);
});

test('R123: with the agents list unreadable, a records-only row shows the Stop message and time for an idle_prompt', () => {
  const out = join({ agentsError: new Error('boom'), records: records({ [FILE1]: [stop('S1', 10), idle('S1', 20)] }) });
  assert.equal(out.workers.length, 1);
  const w = out.workers[0];
  assert.ok(w.markers.includes('records-only'));
  assert.equal(w.reason, 'notification:idle_prompt');
  assert.equal(w.detail, 'q?');
  assert.equal(w.since, at(10));
});

test('R154: a hook-only file gets an issue key only when its worktree is named <repoName>-N', () => {
  const out = join({
    records: records({
      'acme/app/other-3.jsonl': [rec('SessionStart', 'S3')],
      'acme/app/app-3.jsonl': [rec('SessionStart', 'S4')],
    }),
  });
  const byWorktree = new Map(out.workers.map((w) => [w.worktree, w]));
  assert.equal(byWorktree.size, 2);
  assert.equal(byWorktree.get('other-3').key, null);
  assert.equal(byWorktree.get('app-3').key, 'acme/app#3');
});

test('R150: a lease key that is not an issue key is counted in ignored.leases and does not stop the join', async (t) => {
  const bad = lease({ leaseId: 'LB', key: 'acme/app@bad', sessionId: null });
  const out = join({ leases: [lease(), bad], agents: [bg()] });
  assert.deepEqual(out.workers.map((w) => w.key), ['acme/app#1']);
  assert.deepEqual(out.ignored, { records: 0, leases: 1 });

  const s = await sandbox(t, { leases: [lease(), bad], agents: [bg()] });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const json = JSON.parse(s.out.join('\n'));
  assert.deepEqual(json.workers.map((w) => w.key), ['acme/app#1']);
  assert.deepEqual(json.ignored, { records: 0, leases: 1 });
  assert.deepEqual(s.err, ['acme/app@bad: cannot read lease key; ignored']);
});

const TASK_KEY = 'acme/app@fix-x.20261104.1';
const TASK_WT = 'app.fix-x.20261104.1';
const TASK_PATH = `${BASE}\\.claude\\worktrees\\${TASK_WT}`;
const taskLease = (extra = {}) => lease({ leaseId: 'LT', key: TASK_KEY, sessionId: 'ST', ...extra });
const taskBg = (extra = {}) => bg({ id: 'fed00001', sessionId: 'ST', name: TASK_WT, cwd: TASK_PATH, ...extra });

test('R150: a task lease is a row in tasks[] keyed by the task key, with no issue, and workers[] is unchanged', () => {
  const out = join({ leases: [lease(), taskLease()], agents: [bg(), taskBg()] });
  assert.deepEqual(out.workers.map((w) => w.key), ['acme/app#1']);
  assert.deepEqual(out.tasks.map((w) => w.key), [TASK_KEY]);
  const task = out.tasks[0];
  assert.equal(task.issue, null);
  assert.equal(task.worktree, TASK_WT);
  assert.equal(task.state, 'working');
  assert.equal(task.lease.state, 'held');
  assert.equal(task.session.shortId, 'fed00001');
  assert.equal(task.path, path.join(BASE, '.claude', 'worktrees', TASK_WT));
  assert.deepEqual(out.ignored, { records: 0, leases: 0 });
  assert.deepEqual(join({}).tasks, []);
});

test('R150: issue and task workers together make status exit 0 and the text lists both', async (t) => {
  const s = await sandbox(t, { leases: [lease(), taskLease()], agents: [bg(), taskBg()], json: false });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  assert.deepEqual(s.err, []);
  const lines = s.out.join('\n').split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.startsWith(`${TASK_KEY} working `)));
  assert.ok(lines.some((l) => l.startsWith('acme/app#1 working ')));
  assert.equal(lines.at(-1), 'workers: 2');
});

test('R150: a lease-less task session is a row in tasks[] by its task key', () => {
  const out = join({ agents: [taskBg({ cwd: `${TASK_PATH}\\sub` })] });
  assert.deepEqual(out.workers, []);
  assert.deepEqual(out.tasks.map((w) => [w.key, w.worktree, w.issue]), [[TASK_KEY, TASK_WT, null]]);
  assert.ok(out.tasks[0].markers.includes('no-claim'));
  const byName = join({ agents: [{ id: 'fed00002', sessionId: 'SN', name: TASK_WT, cwd: BASE, kind: 'background', state: 'working', startedAt: 1793700000000 }] });
  assert.deepEqual(byName.tasks.map((w) => w.key), [TASK_KEY]);
});

test('R150: a hook-only task file is a row in tasks[] by its task key', () => {
  const out = join({ records: records({ [`acme/app/${TASK_WT}.jsonl`]: [rec('SessionStart', 'S5')], 'acme/app/other-3.jsonl': [rec('SessionStart', 'S6')] }) });
  assert.deepEqual(out.tasks.map((w) => [w.key, w.worktree]), [[TASK_KEY, TASK_WT]]);
  assert.deepEqual(out.workers.map((w) => w.worktree), ['other-3']);
});

test('R150: status extends a live task lease like an issue lease', async (t) => {
  const s = await sandbox(t, { leases: [taskLease({ expiresAt: SOON })], agents: [taskBg()] });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const json = JSON.parse(s.out.join('\n'));
  assert.deepEqual(json.workers, []);
  assert.equal(json.tasks[0].key, TASK_KEY);
  assert.equal(json.tasks[0].lease.expiresAt, EXTENDED);
  assert.equal(json.tasks[0].lease.refreshed, true);
  assert.equal('refresh' in json.tasks[0], false);
  assert.equal((await s.rows())[0].expiresAt, EXTENDED);
});

// R196: status --restart prints the restart steps from the leases, the agents list and the hook files.
const FULL1 = 'abc12345-1111-4000-8000-000000000001';
const FULL2 = 'def67890-2222-4000-8000-000000000002';

async function restartRun(t, opts, { json = false } = {}) {
  const s = await sandbox(t, { ...opts, json });
  const code = await statusCommand(s.ctx, ['--restart']);
  return { s, code, text: s.out.join('\n') };
}

test('R196: status --restart lists each worker and prints a respawn and a resume line per session', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const { s, code, text } = await restartRun(t, {
    leases: [lease({ sessionId: FULL1, shortId: 'abc12345', worktreePath: wt })],
    agents: [bg({ sessionId: FULL1, cwd: wt })],
    files: { 'acme/app/app-1.jsonl': [rec('SessionStart', FULL1), rec('Stop', FULL1, { last_message: 'Ready for\nreview?' })] },
  });
  assert.equal(code, 0, s.err.join('\n'));
  const lines = text.split('\n');
  assert.equal(lines[0], '# Restart steps');
  assert.ok(lines.includes(`Generated ${NOW.toISOString()} by gvt-fleet status --restart.`), text);
  assert.ok(lines.includes('acme/app#1 abc12345 needs-you Ready for review?'), text);
  assert.ok(lines.includes('claude respawn abc12345'), text);
  assert.ok(lines.includes(`cd "${wt}" && claude --bg --resume ${FULL1}`), text);
  assert.equal(lines.filter((l) => l.startsWith('workers: ')).length, 0, 'not the status view');
  assert.equal(s.events.at(-1).restart, true);
});

test('R196: after a reboot, with no session listed, status --restart takes the session id and short id from the lease', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const { s, code, text } = await restartRun(t, { leases: [lease({ sessionId: FULL1, shortId: 'abc12345', worktreePath: wt })], agents: [] });
  assert.equal(code, 0, s.err.join('\n'));
  const lines = text.split('\n');
  assert.ok(lines.includes('acme/app#1 abc12345 no-session -'), text);
  assert.ok(lines.includes('claude respawn abc12345'), text);
  assert.ok(lines.includes(`cd "${wt}" && claude --bg --resume ${FULL1}`), text);
});

test('R196: status --restart takes the short id from the first 8 characters of the session id when the lease has none', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const { text } = await restartRun(t, { leases: [lease({ sessionId: FULL2, shortId: null, worktreePath: wt })], agents: [] });
  assert.ok(text.split('\n').includes('claude respawn def67890'), text);
});

test('R196: status --restart prints a comment, not a cd line, for a worktree folder that does not exist', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const gone = path.join(wt, 'gone');
  const { text } = await restartRun(t, { leases: [lease({ sessionId: FULL1, shortId: 'abc12345', worktreePath: gone })], agents: [] });
  const lines = text.split('\n');
  assert.ok(lines.includes(`# acme/app#1: worktree missing: ${gone}`), text);
  assert.equal(lines.filter((l) => l.startsWith('cd ')).length, 0, text);
  assert.ok(lines.includes('claude respawn abc12345'), text);
});

test('R196: status --restart names a worker with no session id and prints none in empty blocks', async (t) => {
  const { s, code, text } = await restartRun(t, { leases: [lease({ sessionId: null, shortId: null })], agents: [] });
  assert.equal(code, 0, s.err.join('\n'));
  const lines = text.split('\n');
  assert.ok(lines.includes('acme/app#1 - no-session -'), text);
  assert.equal(lines.filter((l) => l === '# none').length, 2, text);
  assert.equal(lines.at(-1), 'No session id: acme/app#1.');
});

test('R196: status --restart --json prints {generatedAt, agents, entries}', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const { s, code, text } = await restartRun(
    t,
    {
      leases: [lease({ sessionId: FULL1, shortId: 'abc12345', worktreePath: wt }), lease2({ sessionId: null, worktreePath: path.join(wt, 'x') })],
      agents: [bg({ sessionId: FULL1, cwd: wt })],
    },
    { json: true },
  );
  assert.equal(code, 0, s.err.join('\n'));
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out), ['generatedAt', 'agents', 'entries']);
  assert.equal(out.generatedAt, NOW.toISOString());
  assert.deepEqual(out.agents, { ok: true });
  assert.deepEqual(out.entries, [
    { key: 'acme/app#1', state: 'working', detail: null, shortId: 'abc12345', sessionId: FULL1, path: wt, pathExists: true },
    { key: 'acme/app#2', state: 'no-session', detail: null, shortId: null, sessionId: null, path: path.join(wt, 'x'), pathExists: false },
  ]);
});

test('R196: status --restart still prints the steps from the leases when the agents list cannot be read, and exits 1', async (t) => {
  const wt = makeTempDir(t, 'gvt-restart-wt-');
  const { s, code, text } = await restartRun(t, {
    leases: [lease({ sessionId: FULL1, shortId: 'abc12345', worktreePath: wt })],
    agents: () => {
      throw new Error('boom');
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(s.err, ['claude agents unavailable: boom']);
  assert.ok(text.split('\n').includes(`cd "${wt}" && claude --bg --resume ${FULL1}`), text);
});

test('R196: status with an argument other than --restart exits 64', async (t) => {
  const s = await sandbox(t, {});
  assert.equal(await statusCommand(s.ctx, ['--restart', 'x']), 64);
  assert.equal(await statusCommand(s.ctx, ['--restarts']), 64);
  assert.ok(s.err.includes('usage: gvt-fleet status [--restart]'), s.err.join('\n'));
});

// ---- the questions of an AskUserQuestion wait ----

const ASKED = [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'], multiSelect: false }];
const ASKED_DETAIL = 'Which colour? [Red | Blue]';
const askCall = (sessionId, time) => rec('PreToolUse', sessionId, { recorded_at: time, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', questions: ASKED });
const askPrompt = (sessionId, time) => rec('Notification', sessionId, { recorded_at: time, notification_type: 'permission_prompt', message: 'Claude needs your permission' });
const askIdle = (sessionId, time) => rec('Notification', sessionId, { recorded_at: time, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
const T_ASK = '2026-11-04T09:10:00.000Z';
const T_PROMPT = '2026-11-04T09:10:01.000Z';
const T_IDLE = '2026-11-04T09:11:01.000Z';

test('R200: status --json gives detail and questions for an AskUserQuestion wait, in workers and in tasks, and null on every other row', async (t) => {
  const { json } = await runJson(t, {
    leases: [lease(), lease2(), taskLease()],
    agents: [bg(), bg2(), taskBg()],
    files: {
      'acme/app/app-1.jsonl': [rec('SessionStart', 'S1'), askCall('S1', T_ASK), askPrompt('S1', T_PROMPT), askIdle('S1', T_IDLE)],
      'acme/app/app-2.jsonl': [rec('SessionStart', 'S2'), rec('Stop', 'S2', { last_message: 'done?' })],
      [`acme/app/${TASK_WT}.jsonl`]: [rec('SessionStart', 'ST'), askCall('ST', T_ASK), askPrompt('ST', T_PROMPT)],
    },
  });
  const asked = json.workers.find((w) => w.key === 'acme/app#1');
  assert.equal(asked.state, 'needs-you');
  assert.equal(asked.reason, 'notification:permission_prompt');
  assert.equal(asked.detail, ASKED_DETAIL);
  assert.equal(asked.since, T_PROMPT);
  assert.deepEqual(asked.questions, ASKED);
  const stopped = json.workers.find((w) => w.key === 'acme/app#2');
  assert.equal(stopped.reason, 'turn-ended');
  assert.ok(Object.hasOwn(stopped, 'questions'));
  assert.equal(stopped.questions, null);
  assert.equal(json.tasks.length, 1);
  assert.equal(json.tasks[0].detail, ASKED_DETAIL);
  assert.deepEqual(json.tasks[0].questions, ASKED);
  // A worker with no hook records at all still has the key.
  const bare = await runJson(t, { leases: [lease()], agents: [bg()] });
  assert.ok(Object.hasOwn(bare.json.workers[0], 'questions'));
  assert.equal(bare.json.workers[0].questions, null);
});

test('R200: the questions are taken from the worker file also when the lease has no session id, and when the agents list is unreadable', () => {
  const files = { 'acme/app/app-1.jsonl': [rec('SessionStart', 'S1'), askCall('S1', T_ASK), askPrompt('S1', T_PROMPT)] };
  // A live session and a lease that both have no session id: the entry-level result is used.
  const noId = join({ leases: [lease({ sessionId: null })], agents: [bg({ sessionId: null })], records: records(files) });
  assert.equal(noId.workers[0].state, 'needs-you');
  assert.equal(noId.workers[0].detail, ASKED_DETAIL);
  assert.deepEqual(noId.workers[0].questions, ASKED);
  // The agents list cannot be read and the lease has no session id: the same.
  const noIdDown = join({ leases: [lease({ sessionId: null })], agentsError: new Error('boom'), records: records(files) });
  assert.deepEqual(noIdDown.workers[0].questions, ASKED);
  // The agents list cannot be read: the hook result is shown.
  const down = join({ leases: [lease()], agentsError: new Error('boom'), records: records(files) });
  assert.equal(down.workers[0].state, 'needs-you');
  assert.deepEqual(down.workers[0].questions, ASKED);
  // The hooks say the session ended while the agents list shows it live: the row takes no hook fields.
  const done = join({ leases: [lease()], agents: [bg()], records: records({ 'acme/app/app-1.jsonl': [rec('SessionStart', 'S1'), rec('SessionEnd', 'S1', { reason: 'logout' })] }) });
  assert.equal(done.workers[0].questions, null);
});

test('R200: the question of another session in the same worktree does not show on the row of the session that has the lease', () => {
  const files = {
    'acme/app/app-1.jsonl': [
      rec('SessionStart', 'S1'),
      askCall('S9', T_ASK),
      askPrompt('S9', T_PROMPT),
      rec('Stop', 'S1', { recorded_at: '2026-11-04T09:20:00.000Z', last_message: 'mine' }),
    ],
  };
  const out = join({ leases: [lease()], agents: [bg()], records: records(files) });
  assert.equal(out.workers[0].reason, 'turn-ended');
  assert.equal(out.workers[0].detail, 'mine');
  assert.equal(out.workers[0].questions, null);
  // Asked for the session that did ask, the same file gives the question.
  const other = join({ leases: [lease({ sessionId: 'S9' })], agents: [bg({ sessionId: 'S9' })], records: records(files) });
  assert.deepEqual(other.workers[0].questions, ASKED);
  assert.equal(other.workers[0].detail, ASKED_DETAIL);
});
