process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { worktreeFinishCommand, worktreeRemoveCommand } from '../lib/commands.mjs';
import { names } from '../lib/worktrees.mjs';
import { fwd, g } from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  PULLS_KEY,
} from './helpers/worktree-sandbox.mjs';
import { TASK_BRANCH, TASK_KEY, TASK_LEASE_ID } from './helpers/task-worktree.mjs';
import {
  branchExists,
  rmCalls,
  MERGED_AT,
  REMOTE_NAME,
  recordSetup,
  readRecord,
  OWN_ENTRY,
  removeRecording,
  pushedUnderOtherName,
  closingKey,
  prOf,
  closing,
  removeProving,
  removePlain,
  issueSetup,
  followUp,
  taskSetup,
  removeTask,
  taskBranchExists,
} from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// ---- the issue branch is proven whatever branch is checked out ----

/** Visit a branch cut from main with one commit, then come back to worktree-app-1. */
async function visit(s, name, { push = false } = {}) {
  const tip = await followUp(s, name, { push });
  await g(s.wt, 'switch', BRANCH);
  return tip;
}

test('R114: remove --require-merged proves worktree-app-1 by its own merged pull request', async (t) => {
  const s = await issueSetup(t, { push: 'upstream', script: (b) => ({ [PULLS_KEY]: () => ({ data: [prOf(12, b.tip, BRANCH)] }) }) });
  await followUp(s, 'follow', { push: true });
  const r = await removeProving(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.pushedBranch, BRANCH);
  assert.deepEqual(r.proofs, [{ branch: BRANCH, pr: { number: 12, state: 'merged', mergedAt: MERGED_AT, headSha: s.box.tip } }]);
  assert.equal(await branchExists(s), false);
});

test('R114: remove --require-merged refuses when only the checked-out branch has a merged pull request', async (t) => {
  const followKey = 'GET repos/acme/app/pulls?head=acme%3Afollow&state=all&per_page=100';
  const s = await issueSetup(t, { push: 'upstream', script: (b) => ({ [followKey]: () => ({ data: [prOf(13, b.follow, 'follow')] }) }) });
  s.box.follow = await followUp(s, 'follow', { push: true });
  const r = await removeProving(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`no pull request from ${BRANCH}`]);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R114: a cached closing pull request whose head is the tip proves an issue branch that has no upstream', async (t) => {
  const s = await issueSetup(t, { push: 'feature-z', script: (b) => ({ [closingKey(9)]: () => ({ data: prOf(9, b.tip, 'feature-z') }) }) });
  const r = await removeProving(s, { closingPrs: [closing(9)] });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.pushedBranch, 'feature-z');
  assert.deepEqual(r.proofs, [{ branch: 'feature-z', pr: { number: 9, state: 'merged', mergedAt: MERGED_AT, headSha: s.box.tip } }]);
});

test('R114: a failed closing pull request lookup leaves the work unproven', async (t) => {
  const s = await issueSetup(t, {
    push: 'upstream',
    script: (b) => ({
      [PULLS_KEY]: () => ({ data: [prOf(12, b.tip, BRANCH)] }),
      [closingKey(9)]: () => {
        throw new Error('gh: HTTP 502');
      },
    }),
  });
  const r = await removeProving(s, { closingPrs: [closing(9)] });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['cannot look up closing pull request #9: gh: HTTP 502']);
  assert.equal(rmCalls(s).length, 0);
});

test('R115: remove --require-merged refuses while a closing pull request is open', async (t) => {
  const s = await issueSetup(t, {
    push: 'upstream',
    script: (b) => ({
      [PULLS_KEY]: () => ({ data: [prOf(12, b.tip, BRANCH)] }),
      [closingKey(9)]: () => ({ data: prOf(9, 'f'.repeat(40), 'feature-z', { state: 'open', merged_at: null }) }),
    }),
  });
  const r = await removeProving(s, { closingPrs: [closing(9)] });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['closing pull request #9 from feature-z is open']);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R115: an issue branch with no commits of its own is proven by a merged closing pull request', async (t) => {
  const s = await issueSetup(t, { commit: false, script: () => ({ [closingKey(9)]: () => ({ data: prOf(9, 'a'.repeat(40), 'feature-z') }) }) });
  const r = await removeProving(s, { closingPrs: [closing(9)] });
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.proofs, [{ branch: 'feature-z', pr: { number: 9, state: 'merged', mergedAt: MERGED_AT, headSha: 'a'.repeat(40) } }]);
  assert.equal(await branchExists(s), false);
});

test('R115: an issue branch with no commits of its own and no merged closing pull request is refused', async (t) => {
  const s = await issueSetup(t, { commit: false });
  const r = await removeProving(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`${BRANCH} has no commits of its own and no closing pull request of ${KEY} is merged; run gvt-fleet sync`]);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R116: plain remove refuses unpushed commits on worktree-app-1 while another branch is checked out', async (t) => {
  const s = await issueSetup(t);
  await followUp(s, 'follow', { push: true });
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /^worktree-app-1 has 1 commit\(s\)/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R116: remove refuses a branch this worktree checked out that has commits on no remote', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  await visit(s, 'extra');
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /^extra has 1 commit\(s\)/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
});

test('R116: remove reports a pushed branch this worktree checked out in otherBranches', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const extraTip = await visit(s, 'extra', { push: true });
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.otherBranches, [{ branch: 'extra', tip: extraTip }]);
});

test('R116: remove refuses a stash made on a branch this worktree checked out', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  // The branch is pushed, so only its stash can be a problem; the worktree is back on worktree-app-1 when remove runs.
  await followUp(s, 'stashy', { push: true });
  fs.writeFileSync(path.join(s.wt, 'stashy.txt'), 'changed\n');
  await g(s.wt, 'stash');
  await g(s.wt, 'switch', BRANCH);
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /^1 stash entry made on .*\bstashy\b/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
});

test('R116: a branch checked out only in another worktree is not counted', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  await visit(s, 'shared');
  // The branch is free once this worktree has left it, so a second worktree takes it over.
  await g(s.base, 'worktree', 'add', fwd(path.join(s.root, 'other-wt')), 'shared');
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.otherBranches, []);
});

test('R117: remove records the issue branch remote name, not the checked-out follow-up branch', async (t) => {
  const s = await pushedUnderOtherName(t);
  await followUp(s, 'follow', { push: true });
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.branchRecord.recorded, REMOTE_NAME);
  assert.deepEqual(readRecord(s), { [REMOTE_NAME]: OWN_ENTRY });
});

test('R117: remove records the head of the proving pull request when the issue branch has no upstream', async (t) => {
  const s = await issueSetup(t, { push: 'feature-z', script: (b) => ({ [closingKey(9)]: () => ({ data: prOf(9, b.tip, 'feature-z') }) }) });
  recordSetup(s);
  const r = await removeProving(s, { closingPrs: [closing(9)], branchRecord: s.branchRecord });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.branchRecord.recorded, 'feature-z');
  assert.deepEqual(readRecord(s), { 'feature-z': OWN_ENTRY });
});

// ---- a task worker: plain remove and finish take a task id ----

/** A command context over the task sandbox, with a repos.json in its own folder. */
function taskCtx(s, out, err) {
  const configFile = path.join(s.root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  return {
    configFile, stateDir: s.stateDir, json: false, repoRoot: s.ws, paths: { workspace: s.ws, claudeJson: s.claudeJson },
    clock: { now: () => NOW, sleep: async () => {} }, claude: s.fake, gh: s.gh, findHolders: s.deps.findHolders,
    out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} },
  };
}

test('R152: plain remove of a task that wrote nothing removes the worktree and the branch without --discard and makes no GitHub call', async (t) => {
  const s = await taskSetup(t);
  const r = await removeTask(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(s.twt), false);
  assert.equal(await taskBranchExists(s), false);
  assert.equal(rmCalls(s).length, 1);
  assert.equal(s.claims.getLease(TASK_LEASE_ID).wtState, 'removed');
  assert.deepEqual(s.gh.calls, []);
});

test('R152: plain remove of a task with a commit on no remote branch is refused and names the branch', async (t) => {
  const s = await taskSetup(t, { commit: true });
  const r = await removeTask(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => p.includes(TASK_BRANCH)), r.problems.join('; '));
  assert.match(r.reason, /--discard/);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await taskBranchExists(s), true);
  assert.equal(fs.existsSync(s.twt), true);
});

test('R152: plain remove of an issue worktree with no commits of its own and no upstream is removed with no GitHub call, because its tip is on a remote branch', async (t) => {
  const s = await issueSetup(t, { commit: false, push: null });
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(s.gh.calls, []);
  assert.equal(rmCalls(s).length, 1);
});

test('R152: remove of a task with uncommitted changes is refused although its branch has no commits of its own', async (t) => {
  const s = await taskSetup(t);
  fs.writeFileSync(path.join(s.twt, 'dirty.txt'), 'x\n', 'utf8');
  const r = await removeTask(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['the working tree has uncommitted changes']);
  assert.equal(rmCalls(s).length, 0);
});

test('R152: worktree remove takes a task id, refuses --require-merged for it with exit 64, and writes no branch record', async (t) => {
  const s = await taskSetup(t);
  const out = [];
  const err = [];
  const ctx = taskCtx(s, out, err);
  assert.equal(await worktreeRemoveCommand(ctx, [TASK_KEY, '--require-merged']), 64);
  assert.match(err.join('\n'), /--require-merged does not apply to a task/);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(fs.existsSync(s.twt), true);

  assert.equal(await worktreeRemoveCommand(ctx, [TASK_KEY]), 0, err.join(' | '));
  assert.equal(fs.existsSync(s.twt), false);
  assert.equal(await taskBranchExists(s), false);
  assert.equal(fs.existsSync(path.join(path.dirname(ctx.configFile), 'branches.json')), false, 'no branch record file was written');
});

test('R152: worktree finish takes a task id and deletes the branch left after a removal', async (t) => {
  const s = await taskSetup(t);
  await g(s.base, 'worktree', 'remove', '--force', fwd(s.twt));
  s.fake.sessions.length = 0;
  const out = [];
  const err = [];
  assert.equal(await worktreeFinishCommand(taskCtx(s, out, err), [TASK_KEY]), 0, err.join(' | '));
  assert.equal(await taskBranchExists(s), false);
});
