process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapCommand } from '../lib/commands.mjs';
import { wrapIssue } from '../lib/wrap.mjs';
import { sequence } from './fakes/fake-claude.mjs';
import { g, halfRemoveWorktree, pushCommit } from './helpers/git-sandbox.mjs';
import { BRANCH, KEY, OK } from './helpers/worktree-sandbox.mjs';
import {
  MERGED_AT,
  clock,
  prOf,
  closing,
  branchExists,
  rmCalls,
  issueLabels,
  rmKeepBranch,
  wrapSetup,
  runWrap,
  provenFollowUp,
  closingArgs,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

test('R119: wrap exits 64 for no ref, two refs or any flag', async () => {
  const calls = [];
  const spy = (name) => new Proxy({}, { get: (_, op) => (...a) => { calls.push(`${name}.${String(op)}`); throw new Error(`${name}.${String(op)} was called`); } });
  const run = async (...a) => {
    calls.push(`run ${JSON.stringify(a)}`);
    throw new Error('run was called');
  };
  for (const args of [[], [KEY, 'acme/app#2'], [KEY, '--discard'], [KEY, '--allow-self'], [KEY, '--require-merged'], ['--discard'], ['--allow-self', KEY]]) {
    const out = [];
    const err = [];
    const ctx = { configFile: path.join(os.tmpdir(), 'no-such-gvt-fleet-config.json'), stateDir: path.join(os.tmpdir(), 'no-such-gvt-fleet-state'), json: false, repoRoot: os.tmpdir(), gh: spy('gh'), claude: spy('claude'), run, out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} } };
    assert.equal(await wrapCommand(ctx, args), 64, `args ${JSON.stringify(args)}`);
    assert.match(err.join('\n'), /usage: gvt-fleet wrap <ref>/);
    assert.deepEqual(out, []);
  }
  assert.deepEqual(calls, [], 'no gh, claude or git call');
});

test('R133: wrap on a leftover folder ignores a discard consent left by an earlier remove --discard', async (t) => {
  const refusal = 'unpushed commits; run again with --discard-unpushed 1234abc@wt-9\n';
  const s = await wrapSetup(t, {
    state: 'done',
    push: 'feature-z',
    makeScript: (x) => ({
      rm: sequence(() => ({ code: 1, stdout: '', stderr: refusal }), () => {
        x.fake.sessions.length = 0;
        return OK;
      }),
    }),
  });
  s.pulls.byNumber['9'] = prOf(9, s.tip, 'feature-z');
  await g(s.base, 'push', 'origin', '--delete', 'feature-z');
  await g(s.base, 'fetch', '--prune', 'origin');
  halfRemoveWorktree(s.base, s.wt);
  // The consent that an earlier half-failed `remove --discard` left on the claim.
  s.claims.immediate(() => s.claims.updateLease('L1', { wtState: 'half-removed', discardHead: s.tip }));

  const first = await runWrap(s, closingArgs);
  assert.equal(first.status, 'refused', first.reason);
  assert.match(first.reason, /claude rm refused/);
  assert.equal(rmCalls(s).length, 1, 'no second rm with a discard value');
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');

  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'branch-kept', r.reason);
  assert.equal(r.branchFlag, '-d', 'the stale consent did not turn -d into -D');
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.ok(rmCalls(s).every((c) => !('discardUnpushed' in c)), 'no claude rm got a discard value');
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R133: wrap names the merged pull request in the branch-kept hint when no remote-tracking branch holds the tip', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  await g(s.base, 'push', 'origin', '--delete', 'feature-z');
  await g(s.base, 'fetch', '--prune', 'origin');
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'branch-kept');
  assert.match(r.hint, /Pull request #9 is merged/);
  assert.ok(r.hint.includes(`git branch -D ${BRANCH}`), r.hint);
  assert.ok(!/Push or merge/.test(r.hint), r.hint);
  assert.equal(r.noRemote, true);

  // A kept branch for another reason keeps the push-or-merge hint.
  const other = await wrapSetup(t, { commit: false, push: null, makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  await pushCommit(other.sandbox, 'next.txt', 'n\n');
  await g(other.base, 'fetch', 'origin');
  await g(other.wt, 'reset', '--hard', 'origin/main');
  other.pulls.byNumber['9'] = prOf(9, 'a'.repeat(40), 'feature-z');
  const o = await runWrap(other, closingArgs);
  assert.equal(o.status, 'branch-kept');
  assert.match(o.hint, new RegExp(`Push or merge ${BRANCH}`));
  assert.ok(!/Pull request #9 is merged/.test(o.hint), o.hint);
  assert.notEqual(o.noRemote, true, 'the flag is not set for the other-branch case');
  assert.match(o.reason, /only a pull request of another branch proved the merge/);
  assert.ok(!/no remote-tracking branch contains/.test(o.reason), o.reason);
});

test('R133: wrap after full success on a claim that never had a worktree reports wrapped with nothing true and makes no GitHub call', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const first = await runWrap(s, closingArgs);
  assert.equal(first.status, 'wrapped', first.reason);
  const again = s.newHub();
  s.deps.gh = again.gh;
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.nothing, true);
  assert.equal(r.steps.proof, 'earlier');
  assert.deepEqual(again.gh.calls, [], 'no GitHub call');
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R133: wrap after full success on a reopened issue reads the wrapped marker of the latest claim', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  // An earlier claim of the same issue: it had a worktree and was released without a wrap.
  s.claims.immediate(() => {
    s.claims.putLease({ leaseId: 'L0', key: KEY, state: 'released', claimedAt: '2026-01-01T00:00:00.000Z' });
    s.claims.updateLease('L0', { worktreePath: s.wt, branch: BRANCH, wtState: 'removed' });
  });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const first = await runWrap(s, closingArgs);
  assert.equal(first.status, 'wrapped', first.reason);
  assert.equal(s.claims.getLease('L1').state, 'released');
  assert.equal(s.claims.getLease('L1').wtState, 'wrapped', 'the marker is on the latest claim');
  assert.notEqual(s.claims.getLease('L0').wtState, 'wrapped');
  const again = s.newHub();
  s.deps.gh = again.gh;
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.nothing, true);
  assert.equal(r.steps.proof, 'earlier');
  assert.deepEqual(again.gh.calls, [], 'no GitHub call');
});

test('R128: wrap with nothing left and no wrap marker needs a merged closing pull request before it releases', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  const none = await runWrap(s);
  assert.equal(none.status, 'refused');
  assert.deepEqual(none.problems, [`${BRANCH} has no commits of its own and no closing pull request of ${KEY} is merged; run gvt-fleet sync`]);
  assert.deepEqual(none.steps, { proof: 'refused', worktree: 'not-run', branch: 'not-run', claim: 'not-run' });

  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z', { state: 'open', merged_at: null });
  const open = await runWrap(s, closingArgs);
  assert.equal(open.status, 'refused');
  assert.ok(open.problems.includes('closing pull request #9 from feature-z is open'), open.problems.join('; '));
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);

  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(r.proofs[0].pr.number, 9);
  assert.equal(s.claims.getLease('L1').state, 'released');
  assert.deepEqual(issueLabels(s), []);

  // A ref with no claim row and nothing on disk is a wrong ref, not a success.
  const other = s.newHub();
  s.deps.gh = other.gh;
  const wrong = await runWrap(s, { key: 'acme/app#2' });
  assert.equal(wrong.status, 'refused');
  assert.match(wrong.reason, /no claim and nothing left to wrap for acme\/app#2/);
  assert.deepEqual(other.gh.calls, []);
});

test('R181: wrap refuses a pull request at the tip that merged into a branch other than the default branch, and changes nothing', async (t) => {
  const s = await wrapSetup(t);
  s.pulls.byHead[BRANCH] = [prOf(12, s.tip, BRANCH, { base: { ref: 'release' } })];
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes(`pull request #12 from ${BRANCH} is merged into release, not into the default branch main`), r.problems.join('; '));
  assert.deepEqual(r.steps, { proof: 'refused', worktree: 'not-run', branch: 'not-run', claim: 'not-run' });
  assert.equal(fs.existsSync(s.wt), true);
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(rmCalls(s), []);
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R181: wrap with nothing left refuses a closing pull request that merged into a branch other than the default branch', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z', { base: { ref: 'release' } });
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['closing pull request #9 from feature-z is merged into release, not into the default branch main']);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R182: wrap of a claim with nothing left refuses a closing pull request merged before the claim', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  // The issue was closed by #9, reopened and claimed again after #9 merged.
  const claimedAt = '2026-11-02T06:00:00.000Z';
  s.claims.immediate(() => s.claims.updateLease('L1', { claimedAt }));
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const old = await runWrap(s, closingArgs);
  assert.equal(old.status, 'refused');
  assert.deepEqual(old.problems, [`closing pull request #9 from feature-z was merged at ${MERGED_AT}, before the claim at ${claimedAt}`]);
  assert.deepEqual(old.steps, { proof: 'refused', worktree: 'not-run', branch: 'not-run', claim: 'not-run' });
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.notEqual(s.claims.getLease('L1').wtState, 'wrapped');
  assert.deepEqual(s.hub.gh.writes(), []);

  // A closing pull request merged after the claim proves it.
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z', { merged_at: '2026-11-02T08:00:00Z' });
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.steps.proof, 'proven');
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R182: wrap with only a failed claim row and nothing left refuses a closing pull request merged before that claim', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  // The row that a refused claim leaves: no active claim and no released one.
  s.claims.immediate(() => s.claims.updateLease('L1', { state: 'failed', claimedAt: '2026-11-02T06:00:00.000Z', labelAdded: null, assigneePreexisting: null }));
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'refused');
  assert.match(r.problems.join('; '), /was merged at .*, before the claim at 2026-11-02T06:00:00\.000Z/);
  assert.equal(s.claims.getLease('L1').state, 'failed');
});

/** A branch record holding the coordinator's own worktree-app-1 entry for the issue, in the shape wrapIssue takes. */
function recordSetup(s) {
  const recordFile = path.join(s.root, 'config', 'branches.json');
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  const own = { disposition: 'issue', issue: KEY, decided: '2026-11-03', by: 'coordinator' };
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, repos: { 'acme/app': { [BRANCH]: own } } }), 'utf8');
  s.recordFile = recordFile;
  return { recordFile, lockFile: path.join(s.stateDir, 'branches.lock'), config: { repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }, cache: {}, clock };
}
const recordOf = (s) => JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos['acme/app'] ?? {};

test('R183: wrap drops the coordinator worktree-<name> entry when only a leftover folder is left', async (t) => {
  const s = await wrapSetup(t, {
    state: 'done',
    push: 'feature-z',
    makeScript: (x) => ({
      rm: () => {
        x.fake.sessions.length = 0;
        return OK;
      },
    }),
  });
  s.pulls.byNumber['9'] = prOf(9, s.tip, 'feature-z');
  halfRemoveWorktree(s.base, s.wt);
  const r = await runWrap(s, { ...closingArgs, branchRecord: recordSetup(s) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.steps.worktree, 'removed');
  assert.equal(r.branchRecord.dropped, BRANCH);
  assert.equal(recordOf(s)[BRANCH], undefined);
});

test('R183: wrap drops the coordinator worktree-<name> entry when only the branch is left', async (t) => {
  const s = await wrapSetup(t, { push: 'feature-z', makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  s.pulls.byNumber['9'] = prOf(9, s.tip, 'feature-z');
  await rmKeepBranch(s)();
  assert.equal(await branchExists(s), true);
  const r = await runWrap(s, { ...closingArgs, branchRecord: recordSetup(s) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'deleted', claim: 'released' });
  assert.deepEqual(r.branchRecord, { recorded: 'feature-z', dropped: BRANCH });
  assert.equal(recordOf(s)[BRANCH], undefined);
  assert.equal(recordOf(s)['feature-z']?.issue, KEY);
});

test('R183: wrap drops the coordinator worktree-<name> entry when nothing is left on disk', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const r = await runWrap(s, { ...closingArgs, branchRecord: recordSetup(s) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: BRANCH });
  assert.deepEqual(recordOf(s), {});

  // A refused wrap leaves the record as it was.
  const refused = await wrapSetup(t, { worktree: false });
  const br = recordSetup(refused);
  const before = fs.readFileSync(refused.recordFile, 'utf8');
  const no = await runWrap(refused, { branchRecord: br });
  assert.equal(no.status, 'refused');
  assert.equal(no.branchRecord, undefined);
  assert.equal(fs.readFileSync(refused.recordFile, 'utf8'), before);
});

test('R184: wrap keeps the wrapped marker through a failed re-claim, so a later wrap with no closing pull request still ends wrapped', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const first = await runWrap(s, closingArgs);
  assert.equal(first.status, 'wrapped', first.reason);
  assert.equal(s.claims.getLease('L1').wtState, 'wrapped');

  // A later claim is refused: claimIssue leaves a new failed row, since it reuses only an active or failed row.
  s.claims.immediate(() => s.claims.putLease({ leaseId: 'L2', key: KEY, state: 'failed', claimedAt: '2026-11-03T13:00:00.000Z' }));

  const second = await runWrap(s);
  assert.equal(second.status, 'wrapped', second.reason);
  assert.deepEqual(second.steps, { proof: 'earlier', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(s.claims.getLease('L2').state, 'released');
  assert.equal(s.claims.getLease('L2').wtState, 'wrapped', 'the marker moved to the row the release released');

  const again = s.newHub();
  s.deps.gh = again.gh;
  const third = await runWrap(s);
  assert.equal(third.status, 'wrapped', third.reason);
  assert.equal(third.nothing, true);
  assert.deepEqual(third.steps, { proof: 'earlier', worktree: 'gone', branch: 'gone', claim: 'released-earlier' });
  assert.deepEqual(again.gh.calls, [], 'no GitHub call');
});
