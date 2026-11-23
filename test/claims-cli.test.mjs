process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import {
  claimCommand,
  classCommand,
  expireCommand,
  heartbeatCommand,
  releaseCommand,
  whyCommand,
} from '../plugin/cli/lib/commands.mjs';
import { createFakeClaude } from './fakes/fake-claude.mjs';
import { seedTaskLease } from './helpers/dispatch-sandbox.mjs';
import { github, LABEL } from './helpers/fake-github.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const NOW = new Date('2026-11-03T12:00:00.000Z');
const clock = { now: () => NOW, sleep: async () => {} };
const config = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 0, fullSyncHours: 24, repos: [{ repo: 'acme/app' }] };

function makeCtx({ gh, claude, json = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-claims-cli-'));
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(config));
  const stateDir = path.join(dir, 'state');
  const out = [];
  const err = [];
  const events = [];
  return {
    ctx: {
      repoRoot: dir,
      configFile: path.join(dir, 'repos.json'),
      stateDir,
      json,
      clock,
      gh,
      claude,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      log: { append: (e) => events.push(e) },
    },
    out,
    err,
    events,
    stateDir,
  };
}

test('R16: claim command exits 0 and prints the held lease as JSON', async () => {
  const { gh } = github({ issues: { 1: { labels: ['triaged'], assignees: [] } } });
  const t = makeCtx({ gh, json: true });
  const code = await claimCommand(t.ctx, ['acme/app#1']);
  assert.equal(code, 0, t.err.join('\n'));
  const body = JSON.parse(t.out.join('\n'));
  assert.equal(body.status, 'held');
  assert.equal(body.key, 'acme/app#1');
  assert.equal(body.expiresAt, new Date(NOW.getTime() + 120 * 60 * 1000).toISOString());
  assert.deepEqual(t.events.map((e) => e.event), ['claim']);
});

test('R17: claim command exits 1 and prints the refusal reason on stderr', async () => {
  const { gh } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: [] } } });
  const t = makeCtx({ gh });
  const code = await claimCommand(t.ctx, ['app#1']);
  assert.equal(code, 1);
  assert.ok(t.err.some((l) => /in-progress-label/.test(l)), t.err.join('\n'));
  assert.equal(gh.writes().length, 0);
});

test('R16: claim command with a bad ref exits 64 and names the problem', async () => {
  const { gh } = github({ issues: { 1: { labels: ['triaged'], assignees: [] } } });
  const t = makeCtx({ gh });
  assert.equal(await claimCommand(t.ctx, ['nonsense']), 64);
  assert.match(t.err.join('\n'), /cannot read "nonsense"/);
  assert.equal(await claimCommand(makeCtx({ gh }).ctx, ['other/repo#3']), 64);
  assert.equal(await claimCommand(makeCtx({ gh }).ctx, []), 64);
  assert.equal(gh.calls.length, 0);
});

test('R18: release and heartbeat commands act on the claim made by the claim command', async () => {
  const { gh, state } = github({ issues: { 1: { labels: ['triaged'], assignees: [] } } });
  const t = makeCtx({ gh });
  assert.equal(await claimCommand(t.ctx, ['acme/app#1']), 0);
  assert.equal(await heartbeatCommand(t.ctx, ['acme/app#1']), 0);
  assert.equal(await releaseCommand(t.ctx, ['acme/app#1']), 0);
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
  assert.equal(await releaseCommand(t.ctx, ['acme/app#1']), 1, 'a second release finds no claim');
  assert.match(t.err.join('\n'), /no claim to release/);
});

test('R18: heartbeat command on an expired lease exits 1 and says it expired', async () => {
  const { gh } = github({ issues: { 1: { labels: ['triaged'], assignees: [] } } });
  const t = makeCtx({ gh });
  const claims = await openClaimsDb(path.join(t.stateDir, 'claims.db'));
  claims.immediate(() =>
    claims.putLease({ leaseId: 'L', key: 'acme/app#1', state: 'held', expiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
  );
  claims.close();
  assert.equal(await heartbeatCommand(t.ctx, ['acme/app#1']), 1);
  assert.match(t.err.join('\n'), /expired/);
});

test('R18: expire command with a failing claude agents releases nothing and exits 1', async () => {
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  const claude = createFakeClaude({
    agents: () => {
      throw new Error('boom');
    },
  });
  const t = makeCtx({ gh, claude });
  const claims = await openClaimsDb(path.join(t.stateDir, 'claims.db'));
  claims.immediate(() =>
    claims.putLease({ leaseId: 'L', key: 'acme/app#1', state: 'held', expiresAt: new Date(NOW.getTime() - 1000).toISOString(), assigneePreexisting: false, labelAdded: true }),
  );
  claims.close();
  assert.equal(await expireCommand(t.ctx, []), 1);
  assert.match(t.err.join('\n'), /cannot read claude agents: boom/);
  assert.equal(gh.writes().length, 0);
  assert.deepEqual(state.issues[1].labels, ['triaged', LABEL]);
});

test('R18: expire command releases an expired lease with no live session and exits 0', async () => {
  const { gh, state } = github({ issues: { 1: { labels: ['triaged', LABEL], assignees: ['me'] } } });
  const t = makeCtx({ gh, claude: createFakeClaude({ agents: [] }), json: true });
  const claims = await openClaimsDb(path.join(t.stateDir, 'claims.db'));
  claims.immediate(() =>
    claims.putLease({ leaseId: 'L', key: 'acme/app#1', state: 'held', expiresAt: new Date(NOW.getTime() - 1000).toISOString(), assigneePreexisting: false, labelAdded: true }),
  );
  claims.close();
  assert.equal(await expireCommand(t.ctx, []), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).released, [{ key: 'acme/app#1' }]);
  assert.deepEqual(state.issues[1], { labels: ['triaged'], assignees: [] });
});

test('R151: release and heartbeat commands take a task id and release makes no GitHub call', async () => {
  const { gh } = github({ issues: {} });
  const t = makeCtx({ gh });
  const claims = await openClaimsDb(path.join(t.stateDir, 'claims.db'));
  const key = seedTaskLease(claims, { repo: 'acme/app', slug: 'docs', date: '20261108', n: 1, expiresAt: new Date(NOW.getTime() + 60000).toISOString() });
  claims.close();
  assert.equal(await heartbeatCommand(t.ctx, ['app@docs.20261108.1']), 0, t.err.join('\n'));
  assert.equal(await releaseCommand(t.ctx, ['acme/app@docs.20261108.1']), 0, t.err.join('\n'));
  assert.ok(t.out.join('\n').includes(`${key}: released`), t.out.join('\n'));
  assert.equal(gh.calls.length, 0);
});

test('R151: expire command releases a dead expired task lease with no GitHub call', async () => {
  const { gh } = github({ issues: {} });
  const t = makeCtx({ gh, claude: createFakeClaude({ agents: [] }), json: true });
  const claims = await openClaimsDb(path.join(t.stateDir, 'claims.db'));
  const key = seedTaskLease(claims, { repo: 'acme/app', slug: 'docs', date: '20261108', n: 1, expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
  claims.close();
  assert.equal(await expireCommand(t.ctx, []), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).released, [{ key }]);
  assert.equal(gh.calls.length, 0);
});

for (const [name, run] of [
  ['claim', (ctx) => claimCommand(ctx, ['app@docs.20261108.1'])],
  ['why', (ctx) => whyCommand(ctx, ['app@docs.20261108.1'])],
  ['class', (ctx) => classCommand(ctx, ['acme/app@docs.20261108.1', 'now'])],
]) {
  test(`R153: ${name} given a task ref exits 64 and says it is a task, not an issue reference`, async () => {
    const { gh } = github({ issues: {} });
    const t = makeCtx({ gh });
    assert.equal(await run(t.ctx), 64);
    assert.match(t.err.join('\n'), /is a task, not an issue reference/);
    assert.equal(gh.calls.length, 0);
  });
}
