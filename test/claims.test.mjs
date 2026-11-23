process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import { claimIssue, expireClaims, heartbeatClaim, releaseClaim } from '../plugin/cli/lib/claims.mjs';
import { createFakeClaude } from './fakes/fake-claude.mjs';
import { seedTaskLease } from './helpers/dispatch-sandbox.mjs';
import { github, LABEL } from './helpers/fake-github.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-claims-'));
const NOW = new Date('2026-11-03T12:00:00.000Z');
const minutes = (m) => new Date(NOW.getTime() + m * 60 * 1000).toISOString();
const config = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 0, fullSyncHours: 24, repos: [{ repo: 'acme/app' }] };
const clock = { now: () => NOW, sleep: async () => {} };

async function setup() {
  const dir = tmp();
  const cache = await openCacheDb(path.join(dir, 'cache.db'));
  const claims = await openClaimsDb(path.join(dir, 'claims.db'));
  return { cache, claims, close: () => (cache.close(), claims.close()) };
}

const restCalls = (gh, method) => gh.calls.filter((c) => c.kind === 'rest' && c.method === method);
const base = { labels: ['triaged'], assignees: [] };

function heldLease(key, extra = {}) {
  return { leaseId: `lease-${key}`, key, state: 'held', claimedAt: minutes(-300), heartbeatAt: minutes(-200), expiresAt: minutes(-60), assigneePreexisting: false, labelAdded: true, sessionId: 'sess-1', ...extra };
}

test('R16: claim adds label and assignee and records lease with heartbeat and expiry', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: base } });
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  const labelPost = gh.calls.find((c) => c.key === 'POST repos/acme/app/issues/1/labels');
  assert.deepEqual(labelPost.body, { labels: [LABEL] });
  const assigneePost = gh.calls.find((c) => c.key === 'POST repos/acme/app/issues/1/assignees');
  assert.deepEqual(assigneePost.body, { assignees: ['me'] });
  assert.equal(restCalls(gh, 'PUT').length, 0, 'the replacing PUT labels endpoint is never used');
  const lease = claims.getActiveLease('acme/app#1');
  assert.equal(lease.state, 'held');
  assert.equal(lease.heartbeatAt, NOW.toISOString());
  assert.equal(lease.expiresAt, minutes(120));
  assert.equal(lease.assigneePreexisting, false);
  close();
});

test('R16: claim creates the in-progress label when the repo lacks it', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: base }, labelExists: false });
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  const keys = gh.calls.filter((c) => c.kind === 'rest').map((c) => c.key);
  const create = keys.indexOf('POST repos/acme/app/labels');
  assert.ok(create >= 0, 'the label was created');
  assert.ok(keys.indexOf(`GET repos/acme/app/labels/${LABEL}`) < create, 'the GET came first');
  assert.ok(keys.lastIndexOf(`GET repos/acme/app/labels/${LABEL}`) > create, 'the label was read back after creation');
  assert.equal(gh.calls.find((c) => c.key === 'POST repos/acme/app/labels').body.name, LABEL);
  assert.equal(state.labelExists, true);
  close();
});

test('R16: claim records an assignee that was already on the issue as pre-existing', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged'], assignees: ['me'] } } });
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  assert.equal(claims.getActiveLease('acme/app#1').assigneePreexisting, true);
  close();
});

test('R16: claim on a live held lease is a no-op that makes no GitHub call', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: base } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { expiresAt: minutes(30) })));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'noop');
  assert.equal(gh.calls.length, 0);
  close();
});

test('R17: claim refuses when fresh state shows in-progress label or another assignee', async () => {
  const { cache, claims, close } = await setup();
  const labelled = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: [] } } });
  const a = await claimIssue({ gh: labelled.gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(a.status, 'refused');
  assert.ok(a.reasons.some((x) => x.code === 'in-progress-label'));
  assert.equal(labelled.gh.writes().length, 0, 'a refused claim writes nothing to GitHub');
  assert.equal(claims.getActiveLease('acme/app#1'), null);

  const assigned = github({ issues: { 1: { labels: ['triaged'], assignees: ['someone'] } } });
  const b = await claimIssue({ gh: assigned.gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(b.status, 'refused');
  assert.ok(b.reasons.some((x) => x.code === 'assigned-to-other'));
  assert.equal(assigned.gh.writes().length, 0);
  close();
});

test('R18: expired lease with no live session is released on GitHub', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const claude = createFakeClaude({ agents: [] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.deepEqual(r.released, [{ key: 'acme/app#1' }]);
  assert.deepEqual(claude.calls, [{ op: 'agents', all: true }]);
  const deletes = restCalls(gh, 'DELETE');
  assert.deepEqual(deletes.map((c) => c.path), [`repos/acme/app/issues/1/labels/${LABEL}`, 'repos/acme/app/issues/1/assignees']);
  assert.deepEqual(deletes[1].body, { assignees: ['me'] });
  assert.deepEqual(state.issues[1].labels, ['triaged']);
  assert.equal(claims.getLease('lease-acme/app#1').state, 'released');
  close();
});

test('R18: expire refreshes the lease of a session that is listed and not done', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const claude = createFakeClaude({ agents: [{ id: 'abcd1234', sessionId: 'sess-1', state: 'running' }] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.deepEqual(r.refreshed, [{ key: 'acme/app#1' }]);
  assert.equal(restCalls(gh, 'DELETE').length, 0);
  const lease = claims.getLease('lease-acme/app#1');
  assert.equal(lease.state, 'held');
  assert.equal(lease.heartbeatAt, NOW.toISOString());
  assert.equal(lease.expiresAt, minutes(120));
  close();
});

test('R18: expire releases the lease of a listed session that is done', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const claude = createFakeClaude({ agents: [{ id: 'abcd1234', sessionId: 'sess-1', state: 'done' }] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.equal(r.released.length, 1);
  close();
});

test('R77: expire refreshes an expired lease whose worker is listed by name in the base clone under another session id', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { sessionId: null })));
  const reposDir = path.join(tmp(), 'repos');
  const cwd = path.join(reposDir, 'acme', 'app', '.claude', 'worktrees', 'app-1');
  const claude = createFakeClaude({ agents: [{ id: 'zzzz9999', sessionId: 'other-sess', name: 'app-1', kind: 'background', cwd, state: 'running' }] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache, reposDir });
  assert.deepEqual(r.refreshed, [{ key: 'acme/app#1' }]);
  assert.deepEqual(r.released, []);
  assert.equal(restCalls(gh, 'DELETE').length, 0);
  assert.equal(claims.getLease('lease-acme/app#1').expiresAt, minutes(120));
  close();
});

test('R77: expire releases an expired lease whose session is failed or stopped', async () => {
  for (const state of ['failed', 'stopped']) {
    const { cache, claims, close } = await setup();
    const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
    claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
    const claude = createFakeClaude({ agents: [{ id: 'abcd1234', sessionId: 'sess-1', state }] });
    const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
    assert.equal(r.released.length, 1, `a ${state} session releases the lease`);
    assert.deepEqual(r.refreshed, []);
    assert.equal(claims.getLease('lease-acme/app#1').state, 'released');
    close();
  }
});

test('R18: label with no local lease is never removed', async () => {
  const { cache, claims, close } = await setup();
  // Issue 1 carries a hand claim. Issue 2 has an expired local lease, so expire does release something.
  const { gh, state } = github({
    issues: {
      1: { labels: ['triaged', LABEL], assignees: ['me'] },
      2: { labels: ['triaged', LABEL], assignees: ['me'] },
    },
  });
  claims.immediate(() => claims.putLease(heldLease('acme/app#2')));
  const claude = createFakeClaude({ agents: [] });
  await expireClaims({ gh, claude, clock, config }, { claims, cache });
  const deletes = restCalls(gh, 'DELETE');
  assert.ok(deletes.length > 0, 'the leased issue was released');
  assert.ok(deletes.every((c) => c.path.startsWith('repos/acme/app/issues/2/')), 'every DELETE targets the leased issue');
  assert.deepEqual(state.issues[1].labels, ['triaged', LABEL]);
  assert.deepEqual(state.issues[1].assignees, ['me']);
  close();
});

test('R18: release keeps a pre-existing assignee', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { assigneePreexisting: true })));
  const claude = createFakeClaude({ agents: [] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.equal(r.released.length, 1);
  const deletes = restCalls(gh, 'DELETE');
  assert.deepEqual(deletes.map((c) => c.path), [`repos/acme/app/issues/1/labels/${LABEL}`]);
  assert.deepEqual(state.issues[1].assignees, ['me']);
  assert.equal(claims.getLease('lease-acme/app#1').state, 'released');
  close();
});

test('R18: release on demand drops the label and the assignee the claim added', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: base } });
  await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  const r = await releaseClaim({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'released');
  assert.equal(restCalls(gh, 'DELETE').length, 2);
  assert.equal(claims.getActiveLease('acme/app#1'), null);
  close();
});

test('R18: heartbeat refreshes heartbeat and expiry of a held lease', async () => {
  const { claims, close } = await setup();
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { expiresAt: minutes(10) })));
  const r = heartbeatClaim({ clock, config }, { claims, key: 'acme/app#1' });
  assert.equal(r.status, 'refreshed');
  const lease = claims.getActiveLease('acme/app#1');
  assert.equal(lease.heartbeatAt, NOW.toISOString());
  assert.equal(lease.expiresAt, minutes(120));
  close();
});

test('R19: claim whose readback lacks the label is failed, not held', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: base }, dropLabelAdd: true });
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /label in-progress/);
  assert.equal(claims.getLease(r.leaseId).state, 'failed');
  assert.equal(claims.getActiveLease('acme/app#1'), null);
  close();
});

test('R19: claim reports contention when another assignee appeared during the claim', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: base } });
  // The intruder is added right after our assignees POST.
  const original = gh.rest.bind(gh);
  gh.rest = async (method, p, body) => {
    const out = await original(method, p, body);
    if (method === 'POST' && p.endsWith('/assignees')) state.issues[1].assignees.push('rival');
    return out;
  };
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  assert.deepEqual(r.contention, ['rival']);
  close();
});

test('R25: claim re-run after a crash between GitHub write and local commit ends held', async () => {
  const { cache, claims, close } = await setup();
  // GitHub already carries our label and assignee; the local row is still `claiming`.
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease({ leaseId: 'crashed', key: 'acme/app#1', state: 'claiming', claimedAt: minutes(-5), assigneePreexisting: false, labelAdded: true }));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  assert.equal(r.leaseId, 'crashed');
  const lease = claims.getActiveLease('acme/app#1');
  assert.equal(lease.state, 'held');
  assert.equal(lease.assigneePreexisting, false, 'the recorded flag survives the re-run');
  assert.equal(lease.expiresAt, minutes(120));
  close();
});

test('R25: a failed claim row is retried from the fresh check and ends held', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease({ leaseId: 'earlier', key: 'acme/app#1', state: 'failed', claimedAt: minutes(-5), assigneePreexisting: false, labelAdded: true }));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  assert.equal(r.leaseId, 'earlier');
  close();
});

test("R18: release after a refused claim leaves the hand claim's label on the issue", async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: [] } } });
  const a = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(a.status, 'refused');
  const r = await releaseClaim({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'released');
  assert.equal(restCalls(gh, 'DELETE').length, 0);
  assert.deepEqual(state.issues[1].labels, ['triaged', LABEL]);
  close();
});

test('R18: a label that was on the issue before the claim is not removed by release', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease({ leaseId: 'old', key: 'acme/app#1', state: 'claiming', claimedAt: minutes(-5) }));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  const lease = claims.getLease('old');
  assert.equal(lease.labelAdded, false);
  assert.equal(lease.assigneePreexisting, true);
  await releaseClaim({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(restCalls(gh, 'DELETE').length, 0);
  close();
});

test('R25: re-run after a crash before the GitHub writes records the real flags and release drops what the claim added', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: base } });
  // The row step 1 writes: both flags unknown.
  claims.immediate(() => claims.putLease({ leaseId: 'early', key: 'acme/app#1', state: 'claiming', claimedAt: minutes(-5) }));
  assert.equal(claims.getLease('early').assigneePreexisting, null);
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  const lease = claims.getLease('early');
  assert.equal(lease.assigneePreexisting, false);
  assert.equal(lease.labelAdded, true);
  await releaseClaim({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
  close();
});

test('R18: a release with unknown flags removes nothing on GitHub', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { labelAdded: null, assigneePreexisting: null })));
  const r = await expireClaims({ gh, claude: createFakeClaude({ agents: [] }), clock, config }, { claims, cache });
  assert.equal(r.released.length, 1);
  assert.equal(gh.writes().length, 0);
  close();
});

test('R18: expire retries a releasing row without asking claude agents', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { state: 'releasing', expiresAt: minutes(60) })));
  const claude = createFakeClaude({ agents: [] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.equal(r.released.length, 1);
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
  close();
});

test('R18: claim on a releasing row refuses and names the release command', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: base } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { state: 'releasing' })));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'refused');
  assert.match(r.reasons[0].detail, /gvt-fleet release acme\/app#1/);
  close();
});

test('R18: expire releases a failed claim row that left residue on GitHub', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] }, 2: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { state: 'failed' })));
  // A failed row with no flags decided wrote nothing and has no residue.
  claims.immediate(() => claims.putLease(heldLease('acme/app#2', { state: 'failed', labelAdded: null, assigneePreexisting: null })));
  const r = await expireClaims({ gh, claude: createFakeClaude({ agents: [] }), clock, config }, { claims, cache });
  assert.deepEqual(r.released, [{ key: 'acme/app#1' }]);
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
  assert.deepEqual(state.issues[2].labels, ['triaged', LABEL]);
  close();
});

test('R18: expire releases a claiming lease older than the lease length', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  // A process died after the label and assignee POSTs, before the row reached held.
  claims.immediate(() => claims.putLease({ leaseId: 'dead', key: 'acme/app#1', state: 'claiming', claimedAt: minutes(-121), assigneePreexisting: false, labelAdded: true }));
  const r = await expireClaims({ gh, claude: createFakeClaude({ agents: [] }), clock, config }, { claims, cache });
  assert.deepEqual(r.released, [{ key: 'acme/app#1' }]);
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
  assert.equal(claims.getLease('dead').state, 'released');
  close();
});

test('R18: expire leaves a fresh claiming lease alone', async () => {
  const { cache, claims, close } = await setup();
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease({ leaseId: 'live', key: 'acme/app#1', state: 'claiming', claimedAt: minutes(-119), assigneePreexisting: false, labelAdded: true }));
  const r = await expireClaims({ gh, claude: createFakeClaude({ agents: [] }), clock, config }, { claims, cache });
  assert.deepEqual(r.released, []);
  assert.equal(gh.writes().length, 0);
  assert.deepEqual(state.issues[1].labels, ['triaged', LABEL]);
  assert.equal(claims.getLease('live').state, 'claiming');
  close();
});

test('R18: expire skips a lease that was refreshed after the due list was read', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const claude = createFakeClaude({
    agents: () => {
      claims.immediate(() => claims.updateLease('lease-acme/app#1', { expiresAt: minutes(90) }));
      return [];
    },
  });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.deepEqual(r, { refreshed: [], released: [], failed: [] });
  assert.equal(gh.writes().length, 0);
  assert.equal(claims.getLease('lease-acme/app#1').state, 'held');
  close();
});

test('R18: expire with a failing claude agents releases nothing and reports the failure', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const claude = createFakeClaude({
    agents: () => {
      throw new Error('boom');
    },
  });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.equal(r.released.length, 0);
  assert.match(r.failed[0].reason, /cannot read claude agents: boom/);
  assert.equal(gh.writes().length, 0);
  assert.equal(claims.getLease('lease-acme/app#1').state, 'held');
  close();
});

test('R18: heartbeat refuses an expired lease', async () => {
  const { claims, close } = await setup();
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const r = heartbeatClaim({ clock, config }, { claims, key: 'acme/app#1' });
  assert.equal(r.status, 'expired');
  assert.equal(claims.getActiveLease('acme/app#1').expiresAt, minutes(-60));
  close();
});

test('R16: re-claiming an expired held row clears its old session id', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1', { shortId: 'ab12' })));
  const r = await claimIssue({ gh, clock, config }, { claims, cache, key: 'acme/app#1' });
  assert.equal(r.status, 'held');
  const lease = claims.getLease('lease-acme/app#1');
  assert.equal(lease.sessionId, null);
  assert.equal(lease.shortId, null);
  close();
});

test('R151: expire reports a lease key it cannot read as failed and still handles the issue lease', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  claims.immediate(() => claims.putLease(heldLease('acme/app@bad')));
  const claude = createFakeClaude({ agents: [] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache, reposDir: path.join(tmp(), 'repos') });
  assert.deepEqual(r.released, [{ key: 'acme/app#1' }]);
  assert.deepEqual(r.failed, [{ key: 'acme/app@bad', reason: 'cannot read lease key' }]);
  assert.equal(claims.getLease('lease-acme/app#1').state, 'released');
  close();
});

test('R151: release of a task lease sets it released with no GitHub call', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: {} });
  const key = seedTaskLease(claims, { repo: 'acme/app', slug: 'docs', date: '20261108', n: 1 });
  const r = await releaseClaim({ gh, clock, config }, { claims, cache, key });
  assert.equal(r.status, 'released');
  assert.equal(r.key, key);
  assert.equal(claims.getLease('T-docs-20261108-1').state, 'released');
  assert.equal(gh.calls.length, 0);
  close();
});

test('R151: heartbeat of a task lease refreshes it', async () => {
  const { claims, close } = await setup();
  const key = seedTaskLease(claims, { repo: 'acme/app', slug: 'docs', date: '20261108', n: 1, expiresAt: minutes(10) });
  const r = heartbeatClaim({ clock, config }, { claims, key });
  assert.equal(r.status, 'refreshed');
  assert.equal(r.expiresAt, minutes(120));
  assert.equal(claims.getLease('T-docs-20261108-1').expiresAt, minutes(120));
  close();
});

test('R151: expire releases a dead expired task lease with no GitHub call, refreshes a live one and still releases the issue lease', async () => {
  const { cache, claims, close } = await setup();
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  claims.immediate(() => claims.putLease(heldLease('acme/app#1')));
  const dead = seedTaskLease(claims, { repo: 'acme/app', slug: 'dead', date: '20261108', n: 1, expiresAt: minutes(-60) });
  const live = seedTaskLease(claims, { repo: 'acme/app', slug: 'live', date: '20261108', n: 2, expiresAt: minutes(-60) });
  claims.immediate(() => claims.updateLease('T-live-20261108-2', { sessionId: 'sess-live' }));
  const claude = createFakeClaude({ agents: [{ id: 'abcd1234', sessionId: 'sess-live', name: 'app.live.20261108.2', state: 'working', cwd: 'x' }] });
  const r = await expireClaims({ gh, claude, clock, config }, { claims, cache });
  assert.deepEqual(r.released.map((x) => x.key).sort(), ['acme/app#1', dead].sort());
  assert.deepEqual(r.refreshed, [{ key: live }]);
  assert.deepEqual(r.failed, []);
  assert.equal(claims.getLease('T-dead-20261108-1').state, 'released');
  assert.equal(claims.getLease('T-live-20261108-2').state, 'held');
  assert.equal(claims.getLease('T-live-20261108-2').expiresAt, minutes(120));
  assert.ok(gh.calls.every((c) => !/@/.test(JSON.stringify(c))), 'no GitHub call names a task');
  close();
});
