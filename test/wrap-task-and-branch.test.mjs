process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCacheDb } from '../lib/cache-db.mjs';
import { wrapCommand, worktreeRemoveCommand } from '../lib/commands.mjs';
import { readClosingPrs } from '../lib/sync.mjs';
import { wrapTask } from '../lib/wrap.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { commitFile, fwd, g } from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  OK,
  REPOS,
} from './helpers/worktree-sandbox.mjs';
import {
  TASK_BRANCH,
  TASK_KEY,
  TASK_LEASE_ID,
  addTaskWorker,
  taskRmKeepBranch,
} from './helpers/task-worktree.mjs';
import {
  CONFIG,
  clock,
  prOf,
  closing,
  claudeWrites,
  rmCalls,
  rmKeepBranch,
  wrapSetup,
  runWrap,
  commandCtx,
  provenFollowUp,
  closingArgs,
  closingAtTip,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// ---- a task worker: no merge proof, a task that wrote nothing is removed ----

/** wrapSetup with no issue worktree, plus the task worker: its lease and, with `worktree`, its worktree and session. */
async function taskSetup(t, opts = {}) {
  const s = await wrapSetup(t, { worktree: false, makeScript: (x) => ({ rm: taskRmKeepBranch(x) }) });
  await addTaskWorker(s, opts);
  return s;
}

const runTask = (s, extra = {}) =>
  wrapTask(s.deps, { claims: s.claims, cache: s.cache, config: CONFIG, clock, closingPrs: [], key: TASK_KEY, reposDir: REPOS(s), defaultBranch: 'main', stateDir: s.stateDir, ...extra });
const taskBranchExists = async (s) => (await s.deps.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}`], { cwd: s.base })).code === 0;
const taskLease = (s) => s.claims.getLease(TASK_LEASE_ID);

test('R152: wrap of a task that wrote nothing removes the worktree and the branch, releases the lease and makes no GitHub call', async (t) => {
  const s = await taskSetup(t);
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D');
  assert.equal(fs.existsSync(s.twt), false);
  assert.equal(await taskBranchExists(s), false);
  assert.equal(taskLease(s).state, 'released');
  assert.deepEqual(s.hub.gh.writes(), []);
  assert.deepEqual(s.hub.gh.calls, [], 'no GitHub call at all');
  assert.equal(s.claims.getLease('L1').state, 'held', 'the lease of the issue is not touched');
});

test('R152: the wrap command for a task that wrote nothing exits 0 and leaves config/branches.json as it was', async (t) => {
  const s = await taskSetup(t);
  const cmdDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-wrap-task-'));
  t.after(() => fs.rmSync(cmdDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configFile = path.join(cmdDir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...CONFIG, repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const recordFile = path.join(cmdDir, 'branches.json');
  const seeded = { version: 1, repos: { 'acme/app': { 'feature-q': { disposition: 'keep', decided: '2026-11-03', by: 'coach' } } } };
  fs.writeFileSync(recordFile, JSON.stringify(seeded), 'utf8');
  const out = [];
  const err = [];
  const ctx = commandCtx(s, { configFile, out, err });
  ctx.gh = s.newHub().gh;
  assert.equal(await wrapCommand(ctx, [TASK_KEY]), 0, err.join('\n'));
  assert.match(out.join('\n'), /wrapped/);
  assert.match(out.join('\n'), /proof not-required/);
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')), seeded);
  assert.deepEqual(err.filter((l) => /branches\.json/.test(l)), []);
  assert.deepEqual(ctx.gh.calls, []);
  assert.equal(taskLease(s).state, 'released');
  assert.equal(await taskBranchExists(s), false);

  // The command refuses a flag, as it does for an issue.
  const bad = await wrapCommand(commandCtx(s, { configFile, out: [], err: [] }), [TASK_KEY, '--require-merged']);
  assert.equal(bad, 64);
});

test('R152: an early exit of wrap for a task reports the proof as not-required', async (t) => {
  const s = await taskSetup(t);
  const r = await runTask(s, { key: 'acme/app@nothing.20261108.1' });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /no claim and nothing left to wrap/);
  assert.equal(r.steps.proof, 'not-required');
});

test('R152: wrap of a task with a commit on no remote branch is refused, names the branch and keeps the lease and the worktree', async (t) => {
  const s = await taskSetup(t, { commit: true });
  const tip = await g(s.twt, 'rev-parse', 'HEAD');
  const r = await runTask(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'refused', branch: 'not-run', claim: 'not-run' });
  assert.ok(r.problems.some((p) => p.includes(TASK_BRANCH)), r.problems.join('; '));
  const discardAt = r.hint.indexOf(`gvt-fleet worktree remove ${TASK_KEY} --discard`);
  assert.ok(discardAt >= 0, r.hint);
  assert.ok(r.hint.indexOf(`gvt-fleet release ${TASK_KEY}`) > discardAt, r.hint);
  assert.ok(!/merge the pull request/i.test(r.hint), r.hint);
  assert.equal(taskLease(s).state, 'held');
  assert.equal(fs.existsSync(s.twt), true);
  assert.equal(await g(s.base, 'rev-parse', `refs/heads/${TASK_BRANCH}`), tip);
  assert.deepEqual(claudeWrites(s), []);
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R152: wrap of a task whose branch is pushed with no pull request is wrapped and keeps the remote branch', async (t) => {
  const s = await taskSetup(t, { commit: true, push: 'upstream' });
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D', 'the tip is on a remote-tracking branch, so the remote consent applies');
  assert.notEqual(await g(s.base, 'ls-remote', '--heads', 'origin', TASK_BRANCH), '', 'the remote branch is kept');
  assert.equal(await taskBranchExists(s), false);
  assert.equal(taskLease(s).state, 'released');
  assert.deepEqual(s.hub.gh.calls, []);
});

test('R152: wrap of a task with uncommitted changes is refused even when its branch has no commits of its own', async (t) => {
  const s = await taskSetup(t);
  fs.writeFileSync(path.join(s.twt, 'dirty.txt'), 'x\n', 'utf8');
  const r = await runTask(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes('the working tree has uncommitted changes'), r.problems.join('; '));
  assert.equal(r.steps.worktree, 'refused');
  assert.equal(taskLease(s).state, 'held');
  assert.equal(fs.existsSync(path.join(s.twt, 'dirty.txt')), true);
  assert.equal(await taskBranchExists(s), true);
});

test('R152: a rerun of wrap for a task after success reports wrapped with nothing true and makes no GitHub call', async (t) => {
  const s = await taskSetup(t);
  const first = await runTask(s);
  assert.equal(first.status, 'wrapped', first.reason);
  assert.equal(first.nothing, undefined);
  const claudeBefore = claudeWrites(s).length;
  const again = s.newHub();
  s.deps.gh = again.gh;
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped');
  assert.equal(r.nothing, true);
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'gone', branch: 'gone', claim: 'released-earlier' });
  assert.deepEqual(again.gh.calls, []);
  assert.equal(claudeWrites(s).length, claudeBefore);
});

test('R152: wrap of a task whose worktree is gone and whose branch has no commits of its own deletes the branch and releases the lease', async (t) => {
  const s = await taskSetup(t);
  await g(s.base, 'worktree', 'remove', '--force', fwd(s.twt));
  s.fake.sessions.length = 0;
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'gone', branch: 'deleted', claim: 'released' });
  assert.equal(await taskBranchExists(s), false);
  assert.equal(taskLease(s).state, 'released');

  // A branch that holds a commit on no remote branch is refused in the same state.
  const kept = await taskSetup(t, { commit: true });
  await g(kept.base, 'worktree', 'remove', '--force', fwd(kept.twt));
  kept.fake.sessions.length = 0;
  const k = await runTask(kept);
  assert.equal(k.status, 'refused');
  assert.deepEqual(k.steps, { proof: 'not-required', worktree: 'refused', branch: 'not-run', claim: 'not-run' });
  assert.ok(k.problems.some((p) => p.includes(TASK_BRANCH)), k.problems.join('; '));
  assert.equal(await taskBranchExists(kept), true);
  assert.equal(taskLease(kept).state, 'held');
});

// ---- the checked-out branch and a detached HEAD: every commit on a remote-tracking ref, else a merged pull request found by commit ----

/** A worktree whose issue branch is pushed and proven by its own merged pull request, so that only the checked-out HEAD is in question. */
async function provenIssueBranch(t) {
  const s = await wrapSetup(t, { makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  closingAtTip(s);
  return s;
}

/** Leave worktree-app-1 for `name`, cut from origin/main (so its upstream is origin/main) with one commit. Returns the tip. */
async function trackingMain(s, name) {
  await g(s.wt, 'switch', '-c', name, '--track', 'origin/main');
  return commitFile(s.wt, `${name}.txt`, `${name}\n`);
}

test('R175: wrap ends wrapped when the checked-out branch tracks origin/main and is pushed under its own name', async (t) => {
  const s = await provenIssueBranch(t);
  await trackingMain(s, 'retro');
  await g(s.wt, 'push', 'origin', 'retro');
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R175: wrap ends wrapped on a detached HEAD at origin/main when the issue branch has its own merged pull request', async (t) => {
  const s = await provenIssueBranch(t);
  await g(s.wt, 'checkout', '--detach', 'origin/main');
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.ok(s.hub.gh.calls.some((c) => /pulls\?head=/.test(c.key)), 'the issue branch was looked up by its remote name');
  assert.equal(r.proofs[0].pr.number, 12);
});

test('R175: wrap ends wrapped when the remote branch of the checked-out branch was deleted and a merged pull request has its tip as head', async (t) => {
  const s = await provenIssueBranch(t);
  const tip = await trackingMain(s, 'retro');
  await g(s.wt, 'push', 'origin', 'retro');
  await g(s.wt, 'push', 'origin', '--delete', 'retro');
  await g(s.base, 'fetch', '--prune', 'origin');
  s.pulls.byCommit = { [tip]: [prOf(14, tip, 'retro')] };
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.ok(s.hub.gh.calls.some((c) => c.key === `GET repos/acme/app/commits/${tip}/pulls?per_page=100`), 'the checked-out tip was looked up by commit');
});

test('R175: wrap of a task whose branch is pushed under another name with no upstream passes the safety check, removes the worktree and deletes the branch with -D, with no GitHub call', async (t) => {
  const s = await taskSetup(t, { commit: true });
  await g(s.twt, 'push', 'origin', `${TASK_BRANCH}:other-name`);
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.problems, undefined);
  assert.equal(r.steps.worktree, 'removed');
  assert.equal(r.steps.branch, 'deleted');
  assert.equal(r.branchFlag, '-D');
  assert.equal(await taskBranchExists(s), false);
  assert.deepEqual(s.hub.gh.calls, []);
});

test('R179: wrap of a task deletes with -D a branch with no upstream whose tip a remote-tracking branch of another name contains', async (t) => {
  const s = await taskSetup(t, { commit: true });
  await g(s.twt, 'push', 'origin', `${TASK_BRANCH}:other-name`);
  const r = await runTask(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.branchFlag, '-D');
  assert.equal(taskLease(s).state, 'released');
  assert.equal(await taskBranchExists(s), false);
});

test('R179: wrap of a task keeps the branch with -d and names why -D was not used when no remote-tracking branch contains the tip at the branch step', async (t) => {
  // The remote-tracking ref is deleted after the safety check, as the worktree is removed.
  const s = await wrapSetup(t, {
    worktree: false,
    makeScript: (x) => ({
      rm: async () => {
        await taskRmKeepBranch(x)();
        await g(x.base, 'update-ref', '-d', 'refs/remotes/origin/other-name');
        return OK;
      },
    }),
  });
  await addTaskWorker(s, { commit: true });
  await g(s.twt, 'push', 'origin', `${TASK_BRANCH}:other-name`);
  const r = await runTask(s);
  assert.equal(r.status, 'branch-kept', r.reason);
  assert.equal(r.steps.worktree, 'removed');
  assert.equal(r.branchFlag, '-d');
  assert.match(r.reason, /-D was not used: no remote-tracking branch contains [0-9a-f]{7}/);
  assert.equal(await taskBranchExists(s), true);
  assert.equal(taskLease(s).state, 'held');
});

// ---- the closing pull requests read live from GitHub when the cache lists none ----

/** What the `ClaimIssue` query returns for a merged closing pull request. */
const liveClosing = (number = 9, ref = 'feature-z') => ({ number, state: 'MERGED', headRefName: ref, repository: { nameWithOwner: 'acme/app' } });
const claimIssueCalls = (gh) => gh.calls.filter((c) => c.key === 'ClaimIssue');

/** Swap in a fake GitHub whose `ClaimIssue` query lists `closing`, with the sandbox pull request answers. */
function useHub(s, opts = {}) {
  s.hub = s.newHub(opts);
  s.deps.gh = s.hub.gh;
}

/** Run a command over the sandbox with a fresh config file. Returns {code, out, err}. */
async function runCommand(t, s, command, args) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-live-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...CONFIG, repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const code = await command(commandCtx(s, { configFile, out, err }), args);
  return { code, out, err };
}

test('R176: wrap with no cache row reads the closing pull requests live and ends wrapped', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  useHub(s, { closing: [liveClosing()] });
  const r = await runCommand(t, s, wrapCommand, [KEY]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out.join('\n'), /wrapped/);
  assert.equal(claimIssueCalls(s.hub.gh).length >= 1, true, 'the closing pull requests were read live');
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R176: wrap of an issue that the cache holds as a closed external row reads the closing pull requests live', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  const cache = await openCacheDb(path.join(s.stateDir, 'cache.db'));
  cache.upsertExternal({ key: KEY, repo: 'acme/app', number: 1, state: 'closed', title: 'T', updatedAt: '2026-11-01T00:00:00Z', managed: false });
  cache.close();
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  useHub(s, { closing: [liveClosing()] });
  const r = await runCommand(t, s, wrapCommand, [KEY]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(claimIssueCalls(s.hub.gh).length >= 1, true, 'a row with no closing pull requests triggers the live read');
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R176: wrap names the issue and leaves the work unproven when the live read fails, with no sync suggestion', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.deps.gh = createFakeGh({ ClaimIssue: () => { throw new Error('HTTP 502'); } });
  const r = await runCommand(t, s, wrapCommand, [KEY]);
  assert.equal(r.code, 1);
  const text = r.err.join('\n');
  assert.ok(text.includes(`cannot read the closing pull requests of ${KEY}: HTTP 502`), text);
  assert.doesNotMatch(text, /run gvt-fleet sync/);
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R176: wrap refuses without the sync suggestion when the live read finds no closing pull request', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  useHub(s, { closing: [] });
  const r = await runCommand(t, s, wrapCommand, [KEY]);
  assert.equal(r.code, 1);
  const text = r.err.join('\n');
  assert.ok(text.includes(`${BRANCH} has no commits of its own and no closing pull request of ${KEY} is merged`), text);
  assert.doesNotMatch(text, /run gvt-fleet sync/);
  assert.equal(claimIssueCalls(s.hub.gh).length, 1);
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R176: a pull request of the issue branch that the cache does not list proves the work once the live read lists it as closing', async (t) => {
  // Since #128 a merged pull request at the tip proves the work only as a closing pull request, so the live read runs once.
  const s = await wrapSetup(t, { makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  closingAtTip(s);
  s.closingPrs = [];
  let reads = 0;
  const r = await runWrap(s, { readClosingPrs: async () => { reads += 1; return { prs: [{ number: 12, repo: 'acme/app' }] }; } });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(reads, 1);
  assert.equal(r.proofs[0].pr.number, 12);
});

test('R176: no live read when the cache lists a closing pull request', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  let reads = 0;
  const r = await runWrap(s, { ...closingArgs, readClosingPrs: async () => { reads += 1; return { prs: [] }; } });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(reads, 0);
});

test('R176: worktree remove with --require-merged reads the closing pull requests live', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  useHub(s, { closing: [liveClosing()] });
  const r = await runCommand(t, s, worktreeRemoveCommand, [KEY, '--require-merged']);
  // The live proof passes and `claude rm` runs. Without a deletion proof the branch step keeps the squash-merged branch (`branch -d`).
  const text = r.err.join('\n');
  assert.match(text, /branch-kept/);
  assert.doesNotMatch(text, /refused|cannot read the closing|no closing pull request/);
  assert.equal(claimIssueCalls(s.hub.gh).length, 1, 'one live read');
  assert.equal(rmCalls(s).length, 1);
});

test('R176: wrap of an issue with nothing on disk and no wrap marker reads the closing pull requests live', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  useHub(s, { closing: [liveClosing()] });
  const r = await runWrap(s, { readClosingPrs: () => readClosingPrs(s.deps.gh, 'acme/app', 1) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(r.proofs[0].pr.number, 9);
  assert.equal(claimIssueCalls(s.hub.gh).length, 1);
});
