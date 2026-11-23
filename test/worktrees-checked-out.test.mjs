process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { names } from '../plugin/cli/lib/worktrees.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { noCommitFound, serverError } from './helpers/fake-github.mjs';
import {
  commitFile,
  fwd,
  g,
  git,
} from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  COMMITS_KEY,
  OK,
  PULLS_KEY,
  addWorktree,
  setup,
} from './helpers/worktree-sandbox.mjs';
import { TASK_BRANCH } from './helpers/task-worktree.mjs';
import {
  branchExists,
  rmCalls,
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

// ---- the checked-out branch and a detached HEAD: every commit on a remote-tracking ref, else a merged pull request found by commit ----

/** Leave worktree-app-1 for `name`, cut from origin/main (so its upstream is origin/main) with one commit; `push` names the remote branch it is pushed to, with no -u. */
async function trackingMain(s, name, { push = null } = {}) {
  await g(s.wt, 'switch', '-c', name, '--track', 'origin/main');
  const tip = await commitFile(s.wt, `${name}.txt`, `${name}\n`);
  if (push) await g(s.wt, 'push', 'origin', `${name}:${push}`);
  return tip;
}

/** Replace the fake GitHub of the sandbox; the issue branch lookup answers no pull request unless `script` says otherwise. */
function useGh(s, script) {
  s.gh = createFakeGh({ [PULLS_KEY]: () => ({ data: [] }), ...script });
  s.deps.gh = s.gh;
}

test('R175: plain remove of a checked-out branch that tracks origin/main and is pushed under its own name is removed with no GitHub call', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  await trackingMain(s, 'retro', { push: 'retro' });
  useGh(s, {});
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(s.gh.calls, []);
  assert.equal(rmCalls(s).length, 1);
});

test('R175: remove of a checked-out branch whose commits are on no remote and for which GitHub knows no commit is refused with the not-pushed message', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const tip = await followUp(s, 'follow');
  useGh(s, {
    [COMMITS_KEY(tip)]: () => {
      throw noCommitFound(tip);
    },
  });
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['follow has 1 commit(s) not pushed to any remote branch and no merged pull request']);
  assert.deepEqual(s.gh.calls.map((c) => c.key), [COMMITS_KEY(tip)]);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R175: remove of a checked-out branch is refused with the lookup error when the pull request lookup by commit fails', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const tip = await followUp(s, 'follow');
  const failure = serverError();
  useGh(s, {
    [COMMITS_KEY(tip)]: () => {
      throw failure;
    },
  });
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [
    `follow has 1 commit(s) not pushed to any remote branch and no merged pull request, and the pull request lookup by commit ${tip.slice(0, 7)} failed: ${failure.message}`,
  ]);
  assert.equal(rmCalls(s).length, 0);
});

test('R175: remove --require-merged on a detached HEAD with a commit on no remote is refused for that commit, although the issue branch is proven', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  await g(s.wt, 'checkout', '--detach');
  const tip = await commitFile(s.wt, 'loose.txt', 'loose\n');
  useGh(s, {
    [PULLS_KEY]: () => ({ data: [prOf(12, s.box.tip, BRANCH)] }),
    [COMMITS_KEY(tip)]: () => {
      throw noCommitFound(tip);
    },
  });
  const r = await removeProving(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, ['HEAD is detached with 1 commit(s) not on any remote branch and no merged pull request']);
  assert.equal(rmCalls(s).length, 0);
});

test('R175: a merged pull request found by commit waives the checked-out branch but not the issue branch, which still needs its own', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const tip = await trackingMain(s, 'retro');
  useGh(s, { [COMMITS_KEY(tip)]: () => ({ data: [prOf(13, tip, 'retro')] }) });
  const r = await removeProving(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`no pull request from ${BRANCH}`]);
  assert.equal(rmCalls(s).length, 0);
});

test('R175: remove refuses a worked branch whose commit is a cherry-pick on no remote, and makes no lookup by commit for it', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  await g(s.wt, 'switch', '-c', 'picked', 'main');
  // A new message keeps the copy from getting the same hash as the original when both commits fall in one second.
  await g(s.wt, 'cherry-pick', '-n', s.box.tip);
  await g(s.wt, 'commit', '-m', 'picked');
  await g(s.wt, 'switch', BRANCH);
  useGh(s, {});
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.equal(r.problems.length, 1, r.problems.join('; '));
  assert.match(r.problems[0], /^picked has 1 commit\(s\) on no remote branch/);
  assert.deepEqual(s.gh.calls, []);
  assert.equal(rmCalls(s).length, 0);
});

test('R180: plain remove is refused when a merged pull request found by commit belongs to the checked-out branch, not to the unpushed issue branch', async (t) => {
  const s = await issueSetup(t, { push: null });
  await g(s.wt, 'switch', '-c', 'follow');
  const tip = s.box.tip;
  useGh(s, { [COMMITS_KEY(tip)]: () => ({ data: [prOf(13, tip, 'follow')] }) });
  const r = await removePlain(s);
  assert.equal(r.status, 'refused', r.reason);
  assert.deepEqual(r.problems, [`${BRANCH} has 1 commit(s) on no remote branch`]);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R180: a closing pull request found only by the live read waives the unpushed commits of the issue branch', async (t) => {
  const s = await issueSetup(t, { push: null, script: (b) => ({ [closingKey(9)]: () => ({ data: prOf(9, b.tip, 'feature-z') }) }) });
  await followUp(s, 'follow', { push: true });
  const r = await removeProving(s, { readClosingPrs: async () => ({ prs: [closing(9)] }) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.problems, undefined);
});

// ---- checkedOutBranch: the branch checked out in the worktree when it is not the issue branch ----

const localBranchExists = async (s, name) => (await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: s.base })).code === 0;

test('R177: remove of a worktree on a pushed follow-up branch reports checkedOutBranch {branch, tip, kept: true}', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const tip = await followUp(s, 'follow', { push: true });
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.checkedOutBranch, { branch: 'follow', tip, kept: true });
  assert.equal(await localBranchExists(s, 'follow'), true);
});

test('R177: remove reports kept: false when claude rm deletes the checked-out branch', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: async () => {
        await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
        await g(x.base, 'branch', '-D', BRANCH);
        await g(x.base, 'branch', '-D', 'follow');
        x.fake.sessions.length = 0;
        return OK;
      },
    }),
    ghScript: { [PULLS_KEY]: () => ({ data: [] }) },
  });
  await addWorktree(s, { commit: true });
  await g(s.wt, 'push', '-u', 'origin', BRANCH);
  const tip = await followUp(s, 'follow', { push: true });
  const r = await removePlain(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.checkedOutBranch, { branch: 'follow', tip, kept: false });
});

test('R177: remove reports checkedOutBranch null on the issue branch and on a detached HEAD', async (t) => {
  const onBranch = await issueSetup(t, { push: 'upstream' });
  const a = await removePlain(onBranch);
  assert.equal(a.status, 'removed', a.reason);
  assert.equal(Object.hasOwn(a, 'checkedOutBranch'), true);
  assert.equal(a.checkedOutBranch, null);

  const detached = await issueSetup(t, { push: 'upstream' });
  await g(detached.wt, 'checkout', '--detach');
  const b = await removePlain(detached);
  assert.equal(b.status, 'removed', b.reason);
  assert.equal(Object.hasOwn(b, 'checkedOutBranch'), true);
  assert.equal(b.checkedOutBranch, null);
});

test('R177: a refused remove reports checkedOutBranch with kept: null, because the worktree step did not run', async (t) => {
  const s = await issueSetup(t, { push: 'upstream' });
  const tip = await followUp(s, 'follow');
  useGh(s, {
    [COMMITS_KEY(tip)]: () => {
      throw noCommitFound(tip);
    },
  });
  const r = await removePlain(s);
  assert.equal(r.status, 'refused');
  assert.equal(Object.hasOwn(r.checkedOutBranch, 'kept'), true);
  assert.deepEqual(r.checkedOutBranch, { branch: 'follow', tip, kept: null });
  assert.equal(rmCalls(s).length, 0);
});

test('R179: worktree remove of a task pushed under another name with no upstream keeps the branch with -d, as it has no remote consent', async (t) => {
  const s = await taskSetup(t, { commit: true });
  await g(s.twt, 'push', 'origin', `${TASK_BRANCH}:other-name`);
  const r = await removeTask(s);
  assert.equal(r.status, 'branch-kept', r.reason);
  assert.equal(r.branchStep, undefined);
  assert.match(r.reason, /git branch -d /);
  assert.doesNotMatch(r.reason, /-D was not used/);
  assert.equal(await taskBranchExists(s), true);
});
