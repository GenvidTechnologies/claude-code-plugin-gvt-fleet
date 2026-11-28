process.env.GVT_FLEET_FAKE_ONLY = '1';

// wrap passes the --discard-unpushed consent of claude rm only for the tip that the merge proof covers (#142).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sequence } from './fakes/fake-claude.mjs';
import { commitFile, fwd, g } from './helpers/git-sandbox.mjs';
import { BRANCH, OK } from './helpers/worktree-sandbox.mjs';
import {
  branchExists,
  closingAtTip,
  rmCalls,
  runWrap,
  wrapSetup,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

/** The refusal text of claude rm for one unpushed commit `sha` (the shape seen live, #142). */
const refusalFor = (sha, branch = BRANCH) => ({
  code: 1,
  stdout: '',
  stderr: [
    'kept abcd1234 — its worktree is still at "somewhere"',
    `  1 unpushed commit on "${branch}": ${sha.slice(0, 7)} "add work.txt". It exists on no remote, so deleting the worktree would lose it.`,
    `  push it and run 'claude rm abcd1234' again, or discard the worktree and its commits: claude rm abcd1234 --discard-unpushed ${sha.slice(0, 7)}@wt-9`,
    '',
  ].join('\n'),
});

/** The second claude rm with the consent: it removes the worktree and the session, and keeps the branch (probe 08). */
const rmWithConsent = (x) => async () => {
  await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
  x.fake.sessions.length = 0;
  return OK;
};

/**
 * A worker whose final pull request merged at its tip, after which GitHub deleted the head branch: no remote-tracking
 * branch holds the tip. claude rm refuses with the value for `refusedSha(s)` (default: the tip), then accepts the consent.
 */
async function deletedHeadBranch(t, { refusedSha = (s) => s.tip, after = async () => {} } = {}) {
  let s;
  s = await wrapSetup(t, {
    state: 'done',
    makeScript: (x) => ({ rm: sequence(() => refusalFor(refusedSha(s)), rmWithConsent(x)) }),
  });
  closingAtTip(s);
  await g(s.base, 'push', 'origin', '--delete', BRANCH);
  await g(s.base, 'fetch', '--prune', 'origin');
  await after(s);
  return s;
}

test('R222: wrap passes the --discard-unpushed value of claude rm when it names the tip the merged pull request covers, and ends wrapped', async (t) => {
  const s = await deletedHeadBranch(t);
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D');
  const calls = rmCalls(s);
  assert.equal(calls.length, 2);
  assert.equal('discardUnpushed' in calls[0], false);
  assert.equal(calls[1].discardUnpushed, `${s.tip.slice(0, 7)}@wt-9`);
  assert.ok((r.notes ?? []).some((n) => /--discard-unpushed/.test(n) && n.includes('#12')), JSON.stringify(r.notes));
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R222: wrap passes no discard value when the value of claude rm names a commit the proof does not cover', async (t) => {
  const s = await deletedHeadBranch(t, { refusedSha: () => '1234abc0000000000000000000000000000000ff' });
  const r = await runWrap(s);
  assert.equal(r.status, 'refused', r.reason);
  assert.equal(r.steps.worktree, 'refused');
  assert.match(r.reason, /1 unpushed commit on/);
  assert.doesNotMatch(r.hint, /close them/);
  assert.equal(rmCalls(s).length, 1, 'no second claude rm');
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R222: wrap passes no discard value when the worktree has another branch checked out at the refused commit', async (t) => {
  const s = await deletedHeadBranch(t, {
    refusedSha: (x) => x.followTip,
    after: async (x) => {
      await g(x.wt, 'switch', '-c', 'follow');
      x.followTip = await commitFile(x.wt, 'follow.txt', 'follow\n');
    },
  });
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.ok(rmCalls(s).every((c) => !('discardUnpushed' in c)), 'no claude rm got a discard value');
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
});
