process.env.GVT_FLEET_FAKE_ONLY = '1';

// The JSON keys a coach skill reads from each command line it runs (design section 6). The skill lives in a
// separate repository, so a renamed or dropped key breaks it without any test of this repository failing.
// A key counts as part of the contract when the skill reads it in some outcome, so each test drives the
// outcomes in which the listed keys are present and asserts the key and the type the code produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import {
  claimCommand,
  classCommand,
  dispatchCommand,
  readyCommand,
  releaseCommand,
  statusCommand,
  syncCommand,
  whyCommand,
  worktreeFinishCommand,
  watchCommand,
  worktreeRemoveCommand,
  wrapCommand,
} from '../plugin/cli/lib/commands.mjs';
import { COACH_CONTRACT } from '../plugin/cli/lib/dispatch.mjs';
import { createFakeClaude } from './fakes/fake-claude.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { fakeProject } from './fakes/fake-project.mjs';
import { github, LABEL } from './helpers/fake-github.mjs';
import { dispatchSandbox, NOW, seedTaskLease } from './helpers/dispatch-sandbox.mjs';
import { addNestedWorktree, commitFile, fwd, g, halfRemoveWorktree, makeTempDir } from './helpers/git-sandbox.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN_ROOT = path.resolve(here, '..', 'plugin', 'cli');
const REPO = 'acme/app';
const KEY = 'acme/app#1';
const RESET = '2026-11-03T13:00:00Z';
const TYPE_OF = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Assert that `obj` has each key of `spec` (own property) with the named type. A type may be 'a|b'. */
function assertKeys(obj, spec, label) {
  assert.ok(obj !== null && typeof obj === 'object', `${label}: not an object`);
  for (const [k, type] of Object.entries(spec)) {
    assert.ok(Object.hasOwn(obj, k), `${label}: missing key ${k}`);
    assert.ok(type.split('|').includes(TYPE_OF(obj[k])), `${label}: key ${k} is ${TYPE_OF(obj[k])}, expected ${type}`);
  }
}

const parse = (out, label) => {
  assert.equal(out.length, 1, `${label}: exactly one stdout write, got ${out.length}`);
  return JSON.parse(out[0]);
};

// ---- check-config ----

test('R111: check-config --json carries coach.contract (the number the skill is written for) and coach.workspaceRepo', () => {
  const ws = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-coach-ws-'));
  try {
    fs.cpSync(path.join(BIN_ROOT, 'bin'), path.join(ws, 'bin'), { recursive: true });
    fs.cpSync(path.join(BIN_ROOT, 'lib'), path.join(ws, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'config'));
    fs.writeFileSync(path.join(ws, 'config', 'repos.json'), JSON.stringify({ version: 1, repos: [{ repo: REPO }] }));
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/acme/ws.git']]) {
      const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
    const r = spawnSync(process.execPath, [path.join(ws, 'bin', 'gvt-fleet.mjs'), 'check-config', '--json'], {
      cwd: ws, encoding: 'utf8', env: { ...process.env, GVT_FLEET_FAKE_ONLY: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assertKeys(body, { coach: 'object' }, 'check-config');
    assertKeys(body.coach, { contract: 'number', workspaceRepo: 'string' }, 'check-config coach');
    assert.equal(body.coach.contract, COACH_CONTRACT);
    assert.equal(body.coach.contract, 2, 'the contract number the skill is written for');
    assert.equal(body.coach.workspaceRepo, 'acme/ws');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---- sync ----

const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'graphql', name), 'utf8'));
const NO_MORE = { hasNextPage: false, endCursor: null };
const issueNode = (number) => ({
  number, state: 'OPEN', title: `Issue ${number}`, body: '', updatedAt: '2026-11-01T09:00:00Z',
  labels: { nodes: [{ name: 'triaged' }], pageInfo: NO_MORE }, assignees: { nodes: [], pageInfo: NO_MORE }, comments: { nodes: [], pageInfo: NO_MORE },
  parent: null, subIssues: { nodes: [] }, blockedBy: { nodes: [] }, blocking: { nodes: [] }, closedByPullRequestsReferences: { nodes: [], pageInfo: NO_MORE },
});
const issuesPage = (nodes, { more = false, cursor = null, remaining = 4890 } = {}) => ({
  data: { repository: { issues: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } } }, rateLimit: { cost: 1, remaining, resetAt: RESET } },
});
/** A process runner that answers `gh api graphql` calls by operation name. An entry returns a JSON body or {code, stdout, stderr}. */
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
function syncCtx(run) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-coach-sync-'));
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 1000, fullSyncHours: 24, repos: [{ repo: REPO }] }));
  const out = [];
  const err = [];
  const ctx = { configFile, stateDir: path.join(dir, 'state'), json: true, out: (s) => out.push(s), err: (s) => err.push(s), log: { append() {} }, clock: { now: () => NOW, sleep: async () => {} }, run };
  return { ctx, out, err, dir };
}

test('R111: sync --json carries errors, and stopped.reason and stopped.resetAt when the sync stopped', async (t) => {
  // A sync stopped at the rate reserve: exit 75 with stopped set.
  const stopped = syncCtx(ghRun({ SyncRepoMeta: fx('repo-meta.json'), SyncIssues: issuesPage([issueNode(1)], { more: true, cursor: 'c1', remaining: 500 }) }));
  t.after(() => fs.rmSync(stopped.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(await syncCommand(stopped.ctx, []), 75, stopped.err.join('\n'));
  const a = parse(stopped.out, 'sync stopped');
  assertKeys(a, { errors: 'array', stopped: 'object' }, 'sync stopped');
  assertKeys(a.stopped, { reason: 'string', resetAt: 'string' }, 'sync stopped.stopped');
  assert.equal(a.stopped.reason, 'rate-reserve');
  assert.equal(a.stopped.resetAt, RESET);

  // A sync that finished: stopped is null, errors is an empty array.
  const ok = syncCtx(ghRun({ SyncRepoMeta: fx('repo-meta.json'), SyncIssues: issuesPage([issueNode(1)]) }));
  t.after(() => fs.rmSync(ok.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(await syncCommand(ok.ctx, []), 0, ok.err.join('\n'));
  const b = parse(ok.out, 'sync ok');
  assertKeys(b, { errors: 'array', stopped: 'null' }, 'sync ok');
  assert.deepEqual(b.errors, []);

  // A repo that failed: errors lists it and the exit code is 1.
  const failed = syncCtx(ghRun({ SyncRepoMeta: fx('repo-meta.json'), SyncIssues: { code: 1, stdout: '', stderr: 'gh: boom' } }));
  t.after(() => fs.rmSync(failed.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(await syncCommand(failed.ctx, []), 1, failed.err.join('\n'));
  const c = parse(failed.out, 'sync failed');
  assertKeys(c, { errors: 'array' }, 'sync failed');
  assert.ok(c.errors.length > 0, 'a failed repo is listed in errors');
  assertKeys(c.errors[0], { repo: 'string', message: 'string' }, 'sync failed.errors[0]');
});

// ---- status ----

const WS = 'C:\\work\\fleet';
const BASE = `${WS}\\repos\\acme\\app`;
const WT1 = `${BASE}\\.claude\\worktrees\\app-1`;
const FUTURE = '2026-11-03T14:00:00.000Z';

const TASK_KEY = 'acme/app@fix-x.20261103.1';
const TASK_WT = 'app.fix-x.20261103.1';

// The questions a hook record holds for an AskUserQuestion call.
const ASKED = [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'], multiSelect: false }];
// The records of a session that waits on an AskUserQuestion call.
const askLines = (sessionId) =>
  [
    { event: 'SessionStart' },
    { event: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', questions: ASKED },
    { event: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' },
  ]
    .map((r) => `${JSON.stringify({ v: 1, recorded_at: '2026-11-03T11:00:00.000Z', session_id: sessionId, ...r })}\n`)
    .join('');

async function statusSandbox(t, { agents, task = false, ask = false }) {
  const root = makeTempDir(t, 'gvt-fleet-coach-status-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: REPO, defaultBranch: 'main' }] }), 'utf8');
  // A hook worker file: the session ended its turn, so the row is needs-you with a reason and a detail.
  const rec = (event, extra = {}) => `${JSON.stringify({ v: 1, recorded_at: '2026-11-03T11:00:00.000Z', event, session_id: 'S1', ...extra })}\n`;
  const workerFile = path.join(stateDir, 'workers', 'acme', 'app', 'app-1.jsonl');
  fs.mkdirSync(path.dirname(workerFile), { recursive: true });
  fs.writeFileSync(workerFile, ask ? askLines('S1') : rec('SessionStart') + rec('Stop', { last_message: 'done?' }));
  const claims = await openClaimsDb(path.join(stateDir, 'claims.db'));
  try {
    claims.immediate(() =>
      claims.putLease({ leaseId: 'L1', key: KEY, state: 'held', claimedAt: '2026-11-03T10:00:00.000Z', heartbeatAt: '2026-11-03T10:00:00.000Z', expiresAt: FUTURE, sessionId: 'S1', shortId: null, worktreePath: null, labelAdded: true, assigneePreexisting: false }),
    );
    if (task) {
      const taskFile = path.join(stateDir, 'workers', 'acme', 'app', `${TASK_WT}.jsonl`);
      fs.writeFileSync(
        taskFile,
        ask
          ? askLines('ST')
          : `${JSON.stringify({ v: 1, recorded_at: '2026-11-03T11:00:00.000Z', event: 'SessionStart', session_id: 'ST' })}\n${JSON.stringify({ v: 1, recorded_at: '2026-11-03T11:00:00.000Z', event: 'Stop', session_id: 'ST', last_message: 'which?' })}\n`,
      );
      claims.immediate(() =>
        claims.putLease({ leaseId: 'LT', key: TASK_KEY, state: 'held', claimedAt: '2026-11-03T10:00:00.000Z', heartbeatAt: '2026-11-03T10:00:00.000Z', expiresAt: FUTURE, sessionId: 'ST', shortId: null, worktreePath: null, labelAdded: true, assigneePreexisting: false }),
      );
    }
  } finally {
    claims.close();
  }
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  try {
    cache.upsertIssue({
      key: KEY, repo: REPO, number: 1, state: 'open', title: 'Issue 1', body: '', updatedAt: '2026-11-03T09:00:00Z',
      labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [],
      closingPrs: [{ number: 5, state: 'OPEN', headRefName: 'worktree-app-1' }], managed: true,
    });
  } finally {
    cache.close();
  }
  const out = [];
  const err = [];
  const ctx = {
    configFile, stateDir, json: true, repoRoot: WS, paths: { workspace: WS }, gh: github({ issues: {} }).gh, claude: createFakeClaude({ agents }),
    clock: { now: () => NOW, sleep: async () => {} }, out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} },
  };
  return { ctx, out, err };
}

test('R111: status --json carries agents.ok, agents.error and the keys of each worker row', async (t) => {
  const session = { id: 'abc12345', sessionId: 'S1', name: 'app-1', cwd: WT1, kind: 'background', state: 'working', startedAt: 1793700000000 };
  const s = await statusSandbox(t, { agents: [session] });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const body = parse(s.out, 'status');
  assertKeys(body, { agents: 'object', workers: 'array' }, 'status');
  assertKeys(body.agents, { ok: 'boolean' }, 'status.agents');
  assert.equal(body.agents.ok, true);
  assert.equal(body.workers.length, 1);
  const w = body.workers[0];
  assertKeys(w, { key: 'string', state: 'string', reason: 'string', detail: 'string', questions: 'null', lease: 'object', session: 'object', issue: 'object' }, 'status worker');
  assert.equal(w.key, KEY);
  assert.equal(w.state, 'needs-you');
  assertKeys(w.lease, { state: 'string' }, 'status worker.lease');
  assertKeys(w.session, { agentsState: 'string', shortId: 'string' }, 'status worker.session');
  assertKeys(w.issue, { title: 'string', state: 'string', closingPrs: 'array' }, 'status worker.issue');
  assert.equal(w.issue.closingPrs.length, 1);

  // The session list cannot be read: agents.ok is false, agents.error says why, and the worker has no session.
  const down = await statusSandbox(t, {
    agents: () => {
      throw new Error('claude agents failed (1): boom');
    },
  });
  assert.equal(await statusCommand(down.ctx, []), 1);
  const bad = parse(down.out, 'status agents down');
  assertKeys(bad.agents, { ok: 'boolean', error: 'string' }, 'status agents down.agents');
  assert.equal(bad.agents.ok, false);
  assertKeys(bad.workers[0], { key: 'string', state: 'string', session: 'null' }, 'status agents down worker');
});

test('R156: status --json carries tasks[] with key, state, reason, detail, lease.state, session.agentsState, session.shortId and a null issue', async (t) => {
  const issueSession = { id: 'abc12345', sessionId: 'S1', name: 'app-1', cwd: WT1, kind: 'background', state: 'working', startedAt: 1793700000000 };
  const taskSession = { id: 'fed00001', sessionId: 'ST', name: TASK_WT, cwd: `${BASE}\\.claude\\worktrees\\${TASK_WT}`, kind: 'background', state: 'working', startedAt: 1793700000000 };
  const s = await statusSandbox(t, { agents: [issueSession, taskSession], task: true });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const body = parse(s.out, 'status tasks');
  assertKeys(body, { agents: 'object', workers: 'array', tasks: 'array', ignored: 'object' }, 'status tasks');
  assert.equal(body.workers.length, 1);
  assert.equal(body.tasks.length, 1);
  const w = body.tasks[0];
  assertKeys(w, { key: 'string', state: 'string', reason: 'string', detail: 'string', questions: 'null', lease: 'object', session: 'object', issue: 'null' }, 'status task');
  assert.equal(w.key, TASK_KEY);
  assert.equal(w.state, 'needs-you');
  assertKeys(w.lease, { state: 'string' }, 'status task.lease');
  assertKeys(w.session, { agentsState: 'string', shortId: 'string' }, 'status task.session');

  // With no task worker, tasks is an empty array and not absent.
  const none = await statusSandbox(t, { agents: [issueSession] });
  assert.equal(await statusCommand(none.ctx, []), 0, none.err.join('\n'));
  assertKeys(parse(none.out, 'status no tasks'), { tasks: 'array' }, 'status no tasks');
  assert.deepEqual(JSON.parse(none.out[0]).tasks, []);
});

// ---- ready and why ----

const issueRow = (number, over = {}) => ({
  key: `${REPO}#${number}`, repo: REPO, number, state: 'open', title: `Issue ${number}`, body: '', updatedAt: '2026-11-03T09:00:00Z',
  labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], closingPrs: [], managed: true, ...over,
});

async function cacheSandbox(t, issues) {
  const dir = makeTempDir(t, 'gvt-fleet-coach-cache-');
  const configFile = path.join(dir, 'repos.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO }] }));
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  cache.transaction(() => {
    for (const row of issues) cache.upsertIssue(row);
  });
  cache.close();
  const out = [];
  const err = [];
  const ctx = { json: true, configFile, stateDir, log: { append() {} }, out: (x) => out.push(x), err: (x) => err.push(x), clock: { now: () => NOW, sleep: async () => {} } };
  return { ctx, out, err };
}

const blockedPair = () => [issueRow(1, { labels: [], blockedBy: [`${REPO}#2`] }), issueRow(2, { blocking: [`${REPO}#1`] })];

test('R111: ready --json carries ready[].key, ready[].title and untriaged[]', async (t) => {
  const s = await cacheSandbox(t, blockedPair());
  assert.equal(await readyCommand(s.ctx, []), 0, s.err.join('\n'));
  const body = parse(s.out, 'ready');
  assertKeys(body, { ready: 'array', untriaged: 'array' }, 'ready');
  assert.equal(body.untriaged.length, 1, 'issue 1 has no triaged label');
  assertKeys(body.untriaged[0], { repo: 'string', count: 'number', keys: 'array', onlyReason: 'number' }, 'untriaged[0]');
  assert.equal(body.untriaged[0].repo, REPO);
  assert.equal(body.ready.length, 1, 'only the unblocked issue is ready');
  assertKeys(body.ready[0], { key: 'string', title: 'string' }, 'ready[0]');
  assert.equal(body.ready[0].key, 'acme/app#2');
});

test('R111: ready --json carries now and next with their keys, and ready --class carries issues with key, title and ready', async (t) => {
  const s = await cacheSandbox(t, [issueRow(1), issueRow(2, { labels: [] }), issueRow(3)]);
  fs.writeFileSync(s.ctx.configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO, project: 'acme/7' }] }));
  const cache = await openCacheDb(path.join(s.ctx.stateDir, 'cache.db'));
  cache.replaceProject('acme/7', {
    projectId: 'P',
    fieldId: 'F',
    iterations: [
      { id: 'i_now', title: 'Goal A', startDate: '2026-11-01', duration: 365 },
      { id: 'i_next', title: 'Goal B', startDate: '2027-11-01', duration: 365 },
    ],
    items: [
      { key: `${REPO}#1`, itemId: 'I1', iterationId: 'i_now' },
      { key: `${REPO}#2`, itemId: 'I2', iterationId: 'i_now' },
      { key: `${REPO}#3`, itemId: 'I3', iterationId: 'i_next' },
    ],
  });
  cache.close();
  assert.equal(await readyCommand(s.ctx, []), 0, s.err.join('\n'));
  const body = parse(s.out, 'ready');
  assertKeys(body, { ready: 'array', untriaged: 'array', now: 'array', next: 'array' }, 'ready');
  assert.equal(body.now.length, 2);
  assertKeys(body.now[0], { key: 'string', title: 'string', ready: 'boolean', reasons: 'array', conflict: 'boolean' }, 'now[0]');
  assert.equal(body.now[0].ready, true);
  assert.equal(body.now[1].ready, false);
  assertKeys(body.now[1].reasons[0], { code: 'string', detail: 'string' }, 'now[1].reasons[0]');
  assert.equal(body.next.length, 1);
  assertKeys(body.next[0], { repo: 'string', count: 'number' }, 'next[0]');
  assert.equal(body.next[0].repo, REPO);
  s.out.length = 0;
  assert.equal(await readyCommand(s.ctx, ['--class', 'next']), 0, s.err.join('\n'));
  const listed = parse(s.out, 'ready --class');
  assertKeys(listed, { ready: 'array', untriaged: 'array', now: 'array', next: 'array', issues: 'array' }, 'ready --class');
  assert.equal(listed.issues.length, 1);
  assertKeys(listed.issues[0], { key: 'string', title: 'string', ready: 'boolean', reasons: 'array' }, 'issues[0]');
  assert.equal(listed.issues[0].key, 'acme/app#3');
});

test('R111: why --json carries ready and reasons, for a ready and for a not-ready issue', async (t) => {
  const s = await cacheSandbox(t, blockedPair());
  assert.equal(await whyCommand(s.ctx, [`${REPO}#2`]), 0, s.err.join('\n'));
  const ready = parse(s.out, 'why ready');
  assertKeys(ready, { ready: 'boolean', reasons: 'array' }, 'why ready');
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.reasons, []);

  s.out.length = 0;
  assert.equal(await whyCommand(s.ctx, [`${REPO}#1`]), 0, s.err.join('\n'));
  const blocked = parse(s.out, 'why blocked');
  assertKeys(blocked, { ready: 'boolean', reasons: 'array' }, 'why blocked');
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.length > 0);
  assertKeys(blocked.reasons[0], { code: 'string', detail: 'string' }, 'why blocked.reasons[0]');
});

// ---- class ----

test('R111: class --json carries status, class, previous and reason', async (t) => {
  const mk = async (state) => {
    const s = await cacheSandbox(t, [issueRow(1, { labels: [] })]);
    fs.writeFileSync(s.ctx.configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO, project: 'acme/7' }] }));
    const fake = fakeProject({
      today: '2026-11-03',
      iterations: [{ id: 'i_now', title: 'Goal A', startDate: '2026-11-01', duration: 365 }],
      issues: { [KEY]: { state: state.toUpperCase() } },
    });
    s.ctx.gh = fake.gh;
    return s;
  };
  const ok = await mk('open');
  assert.equal(await classCommand(ok.ctx, [KEY, 'now']), 0, ok.err.join('\n'));
  const changed = parse(ok.out, 'class changed');
  assertKeys(changed, { key: 'string', status: 'string', class: 'string', previous: 'string', project: 'string', iteration: 'object', addedToProject: 'boolean', cached: 'boolean' }, 'class changed');
  assert.equal(changed.status, 'changed');
  assert.equal(changed.class, 'now');
  assert.equal(changed.previous, 'later');

  const closed = await mk('closed');
  assert.equal(await classCommand(closed.ctx, [KEY, 'now']), 1);
  const refused = parse(closed.out, 'class refused');
  assertKeys(refused, { status: 'string', class: 'string', previous: 'string', reason: 'string' }, 'class refused');
  assert.equal(refused.status, 'refused');
});

// ---- dispatch ----

test('R111: dispatch --allow-self --json carries status, step, claim, rollback, reasons, reason, shortId and path', async (t) => {
  // Created: the session started. The skill reads status, shortId and path.
  const ok = await dispatchSandbox({ t });
  ok.ctx.json = true;
  assert.equal(await dispatchCommand(ok.ctx, ['--allow-self', KEY]), 0, ok.err.join('\n'));
  const created = parse(ok.out, 'dispatch created');
  assertKeys(created, { status: 'string', shortId: 'string', path: 'string' }, 'dispatch created');
  assert.equal(created.status, 'created');

  // A step failed after the claim: step, claim, rollback and reason say where and what.
  const rolled = await dispatchSandbox({ t });
  rolled.ctx.json = true;
  fs.rmSync(rolled.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rolled.ctx.cloneUrlOf = () => fwd(path.join(rolled.root, 'no-such-origin.git'));
  assert.equal(await dispatchCommand(rolled.ctx, ['--allow-self', KEY]), 1);
  const failed = parse(rolled.out, 'dispatch rolled back');
  assertKeys(failed, { status: 'string', step: 'string', claim: 'string', rollback: 'string', reason: 'string' }, 'dispatch rolled back');
  assert.equal(failed.step, 'clone');
  assert.equal(failed.rollback, 'released');

  // A refused claim: reasons lists the codes.
  const refused = await dispatchSandbox({ t, issues: { 1: { labels: ['triaged', LABEL], assignees: [] } } });
  refused.ctx.json = true;
  assert.equal(await dispatchCommand(refused.ctx, ['--allow-self', KEY]), 1);
  const no = parse(refused.out, 'dispatch refused');
  assertKeys(no, { status: 'string', claim: 'string', reasons: 'array' }, 'dispatch refused');
  assert.equal(no.claim, 'refused');
  assert.ok(no.reasons.length > 0);
  assertKeys(no.reasons[0], { code: 'string', detail: 'string' }, 'dispatch refused.reasons[0]');
});

test('R156: dispatch --task --json carries status, key, shortId and path on success, and step, claim, rollback and reason on a refusal', async (t) => {
  const ok = await dispatchSandbox({ t });
  ok.ctx.json = true;
  assert.equal(await dispatchCommand(ok.ctx, ['--task', REPO, 'fix-x']), 0, ok.err.join('\n'));
  const created = parse(ok.out, 'dispatch --task created');
  assertKeys(created, { status: 'string', key: 'string', shortId: 'string', path: 'string', claim: 'string' }, 'dispatch --task created');
  assert.equal(created.status, 'created');
  assert.equal(created.claim, 'held');
  assert.match(created.key, /^acme\/app@fix-x\.[0-9]{8}\.1$/);

  // The refusal comes before any lease: step, claim, rollback and reason are present, claim and rollback are null.
  const active = await dispatchSandbox({ t });
  active.ctx.json = true;
  assert.equal(await dispatchCommand(active.ctx, ['--task', REPO, 'fix-x']), 0, active.err.join('\n'));
  active.out.length = 0;
  assert.equal(await dispatchCommand(active.ctx, ['--task', REPO, 'fix-x']), 1);
  const again = parse(active.out, 'dispatch --task task-active');
  assertKeys(again, { status: 'string', key: 'string', step: 'string', claim: 'null', rollback: 'null', reason: 'string' }, 'dispatch --task task-active');
  assert.equal(again.step, 'task-active');

  const self = await dispatchSandbox({ t });
  self.ctx.json = true;
  assert.equal(await dispatchCommand(self.ctx, ['--task', 'example-org/fleet-home', 'fix-x']), 1);
  const refused = parse(self.out, 'dispatch --task self-repo');
  assertKeys(refused, { status: 'string', key: 'string', step: 'string', claim: 'null', rollback: 'null', reason: 'string' }, 'dispatch --task self-repo');
  assert.equal(refused.step, 'self-repo');

  // A start that failed and was rolled back carries rollback as a string.
  const rolled = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  rolled.ctx.json = true;
  assert.equal(await dispatchCommand(rolled.ctx, ['--task', REPO, 'fix-x']), 1);
  const failed = parse(rolled.out, 'dispatch --task rolled back');
  assertKeys(failed, { status: 'string', key: 'string', step: 'string', claim: 'string', rollback: 'string', reason: 'string' }, 'dispatch --task rolled back');
  assert.equal(failed.rollback, 'released');
});

// ---- worktree remove, worktree finish and release ----

const BRANCH = 'worktree-app-1';
const SESSION_ID = 'abcd1234-0000-4000-8000-000000000000';
const MERGED_AT = '2026-11-02T00:00:00Z';
const PULLS_KEY = `GET repos/acme/app/pulls?head=acme%3A${BRANCH}&state=all&per_page=100`;
const OK = { code: 0, stdout: '', stderr: '' };

/**
 * A dispatch sandbox with one held lease for acme/app#1, as `worktree create` leaves it. With `worktree`, a real linked worktree
 * on branch worktree-app-1 (committed and pushed) and its session. `pr` answers the pull request lookup.
 */
// `closing` lists pull request #12 (the first one `pr` returns) as closing the issue, which `wrap` needs (#128).
async function worktreeSandbox(t, { worktree = true, pr = () => ({ data: [] }), state = 'working', rm = null, closing = false } = {}) {
  let s;
  const rmFully = async () => {
    await g(s.base, 'worktree', 'remove', '--force', fwd(s.wt));
    await g(s.base, 'branch', '-D', BRANCH);
    s.fake.sessions.length = 0;
    return OK;
  };
  s = await dispatchSandbox({ t, claudeScript: { track: true, rm: async () => (rm ? rm(s) : rmFully()) } });
  s.ctx.json = true;
  s.wt = path.join(s.base, '.claude', 'worktrees', 'app-1');
  s.head = '';
  const closingScript = closing
    ? {
        ClaimIssue: () => ({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 12, state: 'MERGED', headRefName: BRANCH, repository: { nameWithOwner: 'acme/app' } }] } } } } }),
        'GET repos/acme/app/pulls/12': () => ({ data: pr(s.head).data[0] }),
      }
    : {};
  s.ctx.gh = createFakeGh({ [PULLS_KEY]: () => pr(s.head), ...closingScript });
  const claims = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
  try {
    claims.immediate(() => claims.putLease({ leaseId: 'L1', key: KEY, state: 'held', claimedAt: NOW.toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }));
    if (worktree) {
      await addNestedWorktree(s.base, 'app-1', BRANCH);
      await commitFile(s.wt, 'work.txt', 'work\n');
      await g(s.wt, 'push', '-u', 'origin', BRANCH);
      s.head = await g(s.wt, 'rev-parse', 'HEAD');
      s.fake.sessions.push({ id: 'abcd1234', sessionId: SESSION_ID, name: 'app-1', cwd: s.wt, kind: 'background', state });
      claims.immediate(() => claims.updateLease('L1', { sessionId: SESSION_ID, shortId: 'abcd1234', worktreePath: s.wt, branch: BRANCH, wtState: 'created' }));
    }
  } finally {
    claims.close();
  }
  return s;
}

test('R111: worktree remove --require-merged --json carries status, problems, reason, holders, hint, pushedBranch, pr, branchRecord and nothing', async (t) => {
  // Removed: the pull request is merged at HEAD.
  const merged = await worktreeSandbox(t, { pr: (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }) });
  assert.equal(await worktreeRemoveCommand(merged.ctx, ['app#1', '--require-merged']), 0, merged.err.join('\n'));
  const removed = parse(merged.out, 'remove removed');
  assertKeys(removed, { status: 'string', pushedBranch: 'string', pr: 'object', branchRecord: 'object' }, 'remove removed');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.pushedBranch, BRANCH);
  assertKeys(removed.pr, { number: 'number', state: 'string', mergedAt: 'string', headSha: 'string' }, 'remove removed.pr');
  assertKeys(removed.branchRecord, { recorded: 'string|null', dropped: 'string|null' }, 'remove removed.branchRecord');

  // Refused: the pull request is open. problems and reason say why.
  const open = await worktreeSandbox(t, { pr: (head) => ({ data: [{ number: 12, state: 'open', merged_at: null, head: { sha: head } }] }) });
  assert.equal(await worktreeRemoveCommand(open.ctx, ['app#1', '--require-merged']), 1);
  const refused = parse(open.out, 'remove refused');
  assertKeys(refused, { status: 'string', problems: 'array', reason: 'string', pushedBranch: 'string', pr: 'object' }, 'remove refused');
  assert.equal(refused.status, 'refused');
  assert.ok(refused.problems.length > 0 && refused.problems.every((p) => typeof p === 'string'));

  // Refused with no pull request: pr is null.
  const none = await worktreeSandbox(t);
  assert.equal(await worktreeRemoveCommand(none.ctx, ['app#1', '--require-merged']), 1);
  assertKeys(parse(none.out, 'remove no pr'), { status: 'string', pr: 'null' }, 'remove no pr');

  // Half-removed: the folder is held. holders and hint say what to close and what to run next.
  const half = await worktreeSandbox(t, {
    rm: (x) => {
      halfRemoveWorktree(x.base, x.wt);
      return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
    },
  });
  half.ctx.findHolders = async () => ({ source: 'stub', holders: [{ process: 'Code.exe', pid: 42 }] });
  assert.equal(await worktreeRemoveCommand(half.ctx, ['app#1']), 1);
  const held = parse(half.out, 'remove half-removed');
  assertKeys(held, { status: 'string', holders: 'array', hint: 'string' }, 'remove half-removed');
  assert.equal(held.status, 'half-removed');
  assertKeys(held.holders[0], { process: 'string', pid: 'number' }, 'remove half-removed.holders[0]');

  // Nothing left to remove: nothing is true and pr is null.
  const empty = await worktreeSandbox(t, { worktree: false });
  assert.equal(await worktreeRemoveCommand(empty.ctx, ['app#1']), 0, empty.err.join('\n'));
  const nothing = parse(empty.out, 'remove nothing');
  assertKeys(nothing, { status: 'string', nothing: 'boolean', pr: 'null', branchRecord: 'object' }, 'remove nothing');
  assert.equal(nothing.status, 'removed');
  assert.equal(nothing.nothing, true);
});

test('R111: worktree remove --require-merged --json carries proofs', async (t) => {
  // Removed: one proof, the merged pull request that covers the tip of the issue branch.
  const merged = await worktreeSandbox(t, { pr: (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }) });
  assert.equal(await worktreeRemoveCommand(merged.ctx, ['app#1', '--require-merged']), 0, merged.err.join('\n'));
  const removed = parse(merged.out, 'remove proofs');
  assertKeys(removed, { proofs: 'array' }, 'remove proofs');
  assert.equal(removed.proofs.length, 1);
  assertKeys(removed.proofs[0], { branch: 'string', pr: 'object' }, 'remove proofs[0]');
  assertKeys(removed.proofs[0].pr, { number: 'number', state: 'string', mergedAt: 'string', headSha: 'string' }, 'remove proofs[0].pr');

  // Refused: nothing is proven, so proofs is an empty array and not absent.
  const none = await worktreeSandbox(t);
  assert.equal(await worktreeRemoveCommand(none.ctx, ['app#1', '--require-merged']), 1);
  const refused = parse(none.out, 'remove proofs refused');
  assertKeys(refused, { proofs: 'array' }, 'remove proofs refused');
  assert.equal(refused.proofs.length, 0);
});

test('R111: wrap --json carries status, steps, problems, reason, holders, hint, pushedBranch, pr, proofs, otherBranches and nothing', async (t) => {
  const STEPS = { proof: 'string', worktree: 'string', branch: 'string', claim: 'string' };

  // Wrapped: the pull request is merged at HEAD and closes the issue.
  const merged = await worktreeSandbox(t, { closing: true, pr: (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }) });
  assert.equal(await wrapCommand(merged.ctx, ['app#1']), 0, merged.err.join('\n'));
  const wrapped = parse(merged.out, 'wrap wrapped');
  assertKeys(wrapped, { status: 'string', steps: 'object', pushedBranch: 'string', pr: 'object', proofs: 'array', otherBranches: 'array', checkedOutBranch: 'null|object' }, 'wrap wrapped');
  assert.equal(wrapped.status, 'wrapped');
  assertKeys(wrapped.steps, STEPS, 'wrap wrapped.steps');
  assertKeys(wrapped.pr, { number: 'number', state: 'string', mergedAt: 'string', headSha: 'string' }, 'wrap wrapped.pr');
  assert.equal(wrapped.proofs.length, 1);
  assertKeys(wrapped.proofs[0], { branch: 'string', pr: 'object' }, 'wrap wrapped.proofs[0]');
  assertKeys(wrapped.proofs[0].pr, { number: 'number', state: 'string', mergedAt: 'string', headSha: 'string' }, 'wrap wrapped.proofs[0].pr');

  // Refused: the pull request is open. problems, reason and hint say why and what to do.
  const open = await worktreeSandbox(t, { pr: (head) => ({ data: [{ number: 12, state: 'open', merged_at: null, head: { sha: head } }] }) });
  assert.equal(await wrapCommand(open.ctx, ['app#1']), 1);
  const refused = parse(open.out, 'wrap refused');
  assertKeys(refused, { status: 'string', steps: 'object', problems: 'array', reason: 'string', hint: 'string', pushedBranch: 'string', pr: 'object', proofs: 'array', otherBranches: 'array', checkedOutBranch: 'null|object' }, 'wrap refused');
  assert.equal(refused.status, 'refused');
  assert.ok(refused.problems.length > 0 && refused.problems.every((p) => typeof p === 'string'));
  assertKeys(refused.steps, STEPS, 'wrap refused.steps');
  assert.equal(refused.proofs.length, 0);

  // Refused with no pull request: pr is null.
  const none = await worktreeSandbox(t);
  assert.equal(await wrapCommand(none.ctx, ['app#1']), 1);
  assertKeys(parse(none.out, 'wrap no pr'), { status: 'string', pr: 'null', proofs: 'array' }, 'wrap no pr');

  // Half-removed: the folder is held. holders and hint say what to close and what to run next.
  const half = await worktreeSandbox(t, {
    closing: true,
    pr: (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }),
    rm: (x) => {
      halfRemoveWorktree(x.base, x.wt);
      return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
    },
  });
  half.ctx.findHolders = async () => ({ source: 'stub', holders: [{ process: 'Code.exe', pid: 42 }] });
  assert.equal(await wrapCommand(half.ctx, ['app#1']), 1);
  const held = parse(half.out, 'wrap half-removed');
  assertKeys(held, { status: 'string', steps: 'object', holders: 'array', hint: 'string' }, 'wrap half-removed');
  assert.equal(held.status, 'half-removed');
  assertKeys(held.holders[0], { process: 'string', pid: 'number' }, 'wrap half-removed.holders[0]');

  // A second wrap of the wrapped issue: nothing is true and the exit code is 0.
  const again = await wrapCommand(merged.ctx, ['app#1']);
  assert.equal(again, 0, merged.err.join('\n'));
  const nothing = JSON.parse(merged.out[1]);
  assertKeys(nothing, { status: 'string', nothing: 'boolean', steps: 'object' }, 'wrap nothing');
  assert.equal(nothing.status, 'wrapped');
  assert.equal(nothing.nothing, true);
});

test('R156: wrap --json for a task carries status and steps with proof not-required, whether wrapped or refused', async (t) => {
  const STEPS = { proof: 'string', worktree: 'string', branch: 'string', claim: 'string' };
  const TASK = 'acme/app@docs.20261108.1';
  const seed = async (s) => {
    const claims = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
    try {
      seedTaskLease(claims, { repo: REPO, slug: 'docs', date: '20261108', n: 1 });
    } finally {
      claims.close();
    }
  };

  // Wrapped: the lease is held and nothing is on disk.
  const done = await dispatchSandbox({ t });
  done.ctx.json = true;
  await seed(done);
  assert.equal(await wrapCommand(done.ctx, [TASK]), 0, done.err.join('\n'));
  const wrapped = parse(done.out, 'wrap task wrapped');
  assertKeys(wrapped, { status: 'string', key: 'string', steps: 'object' }, 'wrap task wrapped');
  assert.equal(wrapped.status, 'wrapped');
  assert.equal(wrapped.key, TASK);
  assertKeys(wrapped.steps, STEPS, 'wrap task wrapped.steps');
  assert.equal(wrapped.steps.proof, 'not-required');
  assert.equal(wrapped.steps.claim, 'released');

  // Refused: a commit on no remote branch. problems, reason and hint say why and what to do.
  const open = await dispatchSandbox({ t });
  open.ctx.json = true;
  open.ctx.gh = github({ issues: { 1: { labels: [], assignees: [] } }, pulls: { byHead: {}, byNumber: {} } }).gh;
  await seed(open);
  const name = 'app.docs.20261108.1';
  const wt = await addNestedWorktree(open.base, name, `worktree-${name}`);
  await commitFile(wt, 'work.txt', 'work\n');
  assert.equal(await wrapCommand(open.ctx, [TASK]), 1);
  const refused = parse(open.out, 'wrap task refused');
  assertKeys(refused, { status: 'string', steps: 'object', problems: 'array', reason: 'string', hint: 'string' }, 'wrap task refused');
  assert.equal(refused.status, 'refused');
  assertKeys(refused.steps, STEPS, 'wrap task refused.steps');
  assert.equal(refused.steps.proof, 'not-required');
  assert.ok(refused.problems.length > 0 && refused.problems.every((p) => typeof p === 'string'));
});

test('R111: worktree finish --json carries status, reason, holders and hint', async (t) => {
  // Refused: the session is still running.
  const running = await worktreeSandbox(t, { state: 'working' });
  halfRemoveWorktree(running.base, running.wt);
  assert.equal(await worktreeFinishCommand(running.ctx, ['app#1']), 1);
  const refused = parse(running.out, 'finish refused');
  assertKeys(refused, { status: 'string', reason: 'string' }, 'finish refused');
  assert.equal(refused.status, 'refused');

  // Removed: the session is done and the folder holds only .git.
  const done = await worktreeSandbox(t, { state: 'done' });
  halfRemoveWorktree(done.base, done.wt);
  assert.equal(await worktreeFinishCommand(done.ctx, ['app#1']), 0, done.err.join('\n'));
  assertKeys(parse(done.out, 'finish removed'), { status: 'string' }, 'finish removed');

  // Held: a process has the folder as its working directory, so deleting it fails with a hold code.
  const holdSandbox = await worktreeSandbox(t, { state: 'done' });
  holdSandbox.ctx.findHolders = async () => ({ source: 'stub', holders: [{ process: 'Code.exe', pid: 42 }] });
  halfRemoveWorktree(holdSandbox.base, holdSandbox.wt);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: holdSandbox.wt, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  let heldCode;
  try {
    heldCode = await worktreeFinishCommand(holdSandbox.ctx, ['app#1']);
  } finally {
    // The folder must be free before the sandbox removes it.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  assert.equal(heldCode, 1);
  const held = parse(holdSandbox.out, 'finish held');
  assertKeys(held, { status: 'string', reason: 'string', holders: 'array', hint: 'string' }, 'finish held');
  assert.equal(held.status, 'held');
});

test('R111: release --json carries status and, when it fails, reason', async (t) => {
  const makeCtx = ({ gh }) => {
    const dir = makeTempDir(t, 'gvt-fleet-coach-release-');
    const configFile = path.join(dir, 'repos.json');
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 0, fullSyncHours: 24, repos: [{ repo: REPO }] }));
    const out = [];
    const err = [];
    const ctx = { repoRoot: dir, configFile, stateDir: path.join(dir, 'state'), json: true, clock: { now: () => NOW, sleep: async () => {} }, gh, out: (x) => out.push(x), err: (x) => err.push(x), log: { append() {} } };
    return { ctx, out, err };
  };
  const ok = github({ issues: { 1: { labels: ['triaged'], assignees: [] } } });
  const a = makeCtx(ok);
  assert.equal(await claimCommand(a.ctx, [KEY]), 0, a.err.join('\n'));
  a.out.length = 0;
  assert.equal(await releaseCommand(a.ctx, [KEY]), 0, a.err.join('\n'));
  const released = parse(a.out, 'release released');
  assertKeys(released, { status: 'string' }, 'release released');
  assert.equal(released.status, 'released');

  // No claim to release: status says so.
  a.out.length = 0;
  assert.equal(await releaseCommand(a.ctx, [KEY]), 1);
  assert.equal(parse(a.out, 'release none').status, 'none');

  // GitHub refuses to take the marks off: the release fails and says why.
  const bad = github({ issues: { 1: { labels: ['triaged'], assignees: [] } }, failDelete: true });
  const b = makeCtx(bad);
  assert.equal(await claimCommand(b.ctx, [KEY]), 0, b.err.join('\n'));
  b.out.length = 0;
  assert.equal(await releaseCommand(b.ctx, [KEY]), 1);
  const failed = parse(b.out, 'release failed');
  assertKeys(failed, { status: 'string', reason: 'string' }, 'release failed');
  assert.equal(failed.status, 'failed');
});

test('R111: watch --json carries event, key, reason, detail, since and cursor', async (t) => {
  const dir = makeTempDir(t, 'gvt-fleet-coach-watch-');
  const stateDir = path.join(dir, 'state');
  const ws = 'C:\\work\\fleet';
  const wt = `${ws}\\repos\\acme\\app\\.claude\\worktrees\\app-1`;
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: REPO }] }), 'utf8');
  const start = Date.parse('2026-11-06T10:00:00.000Z');
  let nowMs = start;
  const file = path.join(stateDir, 'workers', 'acme', 'app', 'app-1.jsonl');
  const session = { id: 'abc00001', sessionId: 'S1', name: 'app-1', cwd: wt, kind: 'background', state: 'working', startedAt: start - 3600000 };
  const out = [];
  const err = [];
  const ctx = {
    configFile,
    stateDir,
    json: true,
    repoRoot: ws,
    paths: { workspace: ws },
    gh: {},
    claude: createFakeClaude({ agents: () => [session] }),
    clock: {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const rec = { v: 1, recorded_at: new Date(start + 20000).toISOString(), event: 'Stop', session_id: 'S1', last_message: 'Which one?' };
        fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      },
    },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append() {} },
  };
  assert.equal(await watchCommand(ctx, ['--minutes', '1', '--interval', '15']), 0, err.join('\n'));
  const lines = out.map((x) => JSON.parse(x));
  const waits = lines.filter((l) => l.event === 'needs-you');
  assert.equal(waits.length, 1, 'exactly one needs-you line');
  assertKeys(waits[0], { event: 'string', key: 'string', reason: 'string', detail: 'string', questions: 'null', since: 'string' }, 'watch needs-you');
  assert.equal(waits[0].event, 'needs-you');
  const end = lines.at(-1);
  assertKeys(end, { event: 'string', cursor: 'string', polls: 'number', agentsErrors: 'number' }, 'watch end');
  assert.equal(end.event, 'watch-end');
});

test('R156: the watch line for a waiting task worker carries key, the task key', async (t) => {
  const dir = makeTempDir(t, 'gvt-fleet-coach-watch-task-');
  const stateDir = path.join(dir, 'state');
  const ws = 'C:\\work\\fleet';
  const name = 'app.fix-x.20261106.1';
  const wt = `${ws}\\repos\\acme\\app\\.claude\\worktrees\\${name}`;
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: REPO }] }), 'utf8');
  const start = Date.parse('2026-11-06T10:00:00.000Z');
  let nowMs = start;
  const file = path.join(stateDir, 'workers', 'acme', 'app', `${name}.jsonl`);
  const session = { id: 'abc00002', sessionId: 'S2', name, cwd: wt, kind: 'background', state: 'working', startedAt: start - 3600000 };
  const out = [];
  const err = [];
  const ctx = {
    configFile,
    stateDir,
    json: true,
    repoRoot: ws,
    paths: { workspace: ws },
    gh: {},
    claude: createFakeClaude({ agents: () => [session] }),
    clock: {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const rec = { v: 1, recorded_at: new Date(start + 20000).toISOString(), event: 'Stop', session_id: 'S2', last_message: 'Which one?' };
        fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      },
    },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append() {} },
  };
  assert.equal(await watchCommand(ctx, ['--minutes', '1', '--interval', '15']), 0, err.join('\n'));
  const waits = out.map((x) => JSON.parse(x)).filter((l) => l.event === 'needs-you');
  assert.equal(waits.length, 1, 'exactly one needs-you line');
  assertKeys(waits[0], { event: 'string', key: 'string', reason: 'string', since: 'string' }, 'watch task needs-you');
  assert.equal(waits[0].key, 'acme/app@fix-x.20261106.1');
});

test('R201: questions is an array on the status workers[] and tasks[] rows and on the watch needs-you line for an AskUserQuestion wait, and the contract number stays 2', async (t) => {
  const issueSession = { id: 'abc12345', sessionId: 'S1', name: 'app-1', cwd: WT1, kind: 'background', state: 'working', startedAt: 1793700000000 };
  const taskSession = { id: 'fed00001', sessionId: 'ST', name: TASK_WT, cwd: `${BASE}\\.claude\\worktrees\\${TASK_WT}`, kind: 'background', state: 'working', startedAt: 1793700000000 };
  const s = await statusSandbox(t, { agents: [issueSession, taskSession], task: true, ask: true });
  assert.equal(await statusCommand(s.ctx, []), 0, s.err.join('\n'));
  const body = parse(s.out, 'status ask');
  const rowKeys = { key: 'string', state: 'string', reason: 'string', detail: 'string', questions: 'array', lease: 'object', session: 'object' };
  assertKeys(body.workers[0], rowKeys, 'status ask worker');
  assertKeys(body.tasks[0], rowKeys, 'status ask task');
  for (const w of [body.workers[0], body.tasks[0]]) {
    assert.equal(w.reason, 'notification:permission_prompt');
    assert.equal(w.detail, 'Which colour? [Red | Blue]');
    assert.deepEqual(w.questions, ASKED);
    assertKeys(w.questions[0], { question: 'string', header: 'string', options: 'array', multiSelect: 'boolean' }, 'status ask questions[0]');
    assertKeys({ label: w.questions[0].options[0] }, { label: 'string' }, 'status ask questions[0].options[0]');
  }

  const dir = makeTempDir(t, 'gvt-fleet-coach-watch-ask-');
  const stateDir = path.join(dir, 'state');
  const ws = 'C:\\work\\fleet';
  const wt = `${ws}\\repos\\acme\\app\\.claude\\worktrees\\app-1`;
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: REPO }] }), 'utf8');
  const start = Date.parse('2026-11-06T10:00:00.000Z');
  let nowMs = start;
  const file = path.join(stateDir, 'workers', 'acme', 'app', 'app-1.jsonl');
  const session = { id: 'abc00001', sessionId: 'S1', name: 'app-1', cwd: wt, kind: 'background', state: 'working', startedAt: start - 3600000 };
  const out = [];
  const err = [];
  const ctx = {
    configFile,
    stateDir,
    json: true,
    repoRoot: ws,
    paths: { workspace: ws },
    gh: {},
    claude: createFakeClaude({ agents: () => [session] }),
    clock: {
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const at = (sec) => new Date(start + sec * 1000).toISOString();
        const recs = [
          { v: 1, recorded_at: at(20), event: 'PreToolUse', session_id: 'S1', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', questions: ASKED },
          { v: 1, recorded_at: at(21), event: 'Notification', session_id: 'S1', notification_type: 'permission_prompt', message: 'Claude needs your permission' },
        ];
        if (!fs.existsSync(file)) fs.appendFileSync(file, recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
      },
    },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append() {} },
  };
  assert.equal(await watchCommand(ctx, ['--minutes', '1', '--interval', '15']), 0, err.join('\n'));
  const waits = out.map((x) => JSON.parse(x)).filter((l) => l.event === 'needs-you');
  assert.equal(waits.length, 1, 'exactly one needs-you line');
  assertKeys(waits[0], { event: 'string', key: 'string', reason: 'string', detail: 'string', questions: 'array', since: 'string' }, 'watch ask needs-you');
  assert.equal(waits[0].reason, 'notification:permission_prompt');
  assert.deepEqual(waits[0].questions, ASKED);

  // Adding a key the skill reads keeps the contract number (ADR 0008).
  assert.equal(COACH_CONTRACT, 2);
  assert.match(fs.readFileSync(path.join(BIN_ROOT, 'lib', 'dispatch.mjs'), 'utf8'), /^export const COACH_CONTRACT = 2;$/m);
});
