// Helpers shared by the test/wrap*.test.mjs files, split from one file for CI time (#76).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCacheDb } from '../../plugin/cli/lib/cache-db.mjs';
import { wrapIssue } from '../../plugin/cli/lib/wrap.mjs';
import { commitFile, fwd, g } from './git-sandbox.mjs';
import { github, LABEL } from './fake-github.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  OK,
  REPOS,
  addWorktree,
  rmFully,
  setup,
} from './worktree-sandbox.mjs';

export const MERGED_AT = '2026-11-02T00:00:00Z';

// The claim is older than the merge, so a closing pull request merged at MERGED_AT proves this claim's work.
export const CLAIMED_AT = '2026-11-01T00:00:00.000Z';

export const CONFIG = { version: 1, claimAccount: 'me', leaseMinutes: 120, rateReserve: 0, fullSyncHours: 24, repos: [{ repo: 'acme/app' }] };
export const clock = { now: () => NOW, sleep: async () => {} };
export const prOf = (number, sha, ref, over = {}) => ({ number, state: 'closed', merged_at: MERGED_AT, head: { sha, ref, repo: { full_name: 'acme/app' } }, base: { ref: 'main' }, ...over });
export const closing = (number, ref = 'feature-z') => ({ number, state: 'MERGED', headRefName: ref, repo: 'acme/app' });
export const branchExists = async (s) => (await s.deps.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`], { cwd: s.base })).code === 0;
export const claudeWrites = (s) => s.fake.calls.filter((c) => c.op === 'stop' || c.op === 'rm' || c.op === 'startBg');
export const rmCalls = (s) => s.fake.calls.filter((c) => c.op === 'rm');
export const issueLabels = (s) => s.hub.state.issues[1].labels;

/** The `claude rm` that removes the worktree and leaves every branch for the branch step. */
export const rmKeepBranch = (x) => async () => {
  await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
  x.fake.sessions.length = 0;
  return OK;
};

/**
 * Real git, a held claim that added the label and the assignee, a fake GitHub that answers the pull request
 * lookups (`s.pulls`) and the release calls, and a cache database. `worktree: false` leaves nothing on disk.
 * `push` is 'upstream' (pushed with an upstream), null (not pushed) or a remote branch name (pushed with no upstream).
 */
export async function wrapSetup(t, { commit = true, push = 'upstream', worktree = true, state = 'working', makeScript = (x) => ({ rm: rmFully(x) }), failDelete = false } = {}) {
  const s = await setup(t, { makeScript, lease: { labelAdded: true, assigneePreexisting: false, claimedAt: CLAIMED_AT } });
  s.pulls = { byHead: {}, byNumber: {} };
  s.newHub = (opts = {}) => github({ issues: { 1: { labels: [LABEL], assignees: ['me'] } }, pulls: s.pulls, ...opts });
  s.hub = s.newHub({ failDelete });
  s.deps.gh = s.hub.gh;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-wrap-cache-'));
  s.cache = await openCacheDb(path.join(dir, 'cache.db'));
  t.after(() => {
    s.cache.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  if (worktree) {
    await addWorktree(s, { commit, state });
    if (push === 'upstream') await g(s.wt, 'push', '-u', 'origin', BRANCH);
    else if (push) await g(s.wt, 'push', 'origin', `${BRANCH}:${push}`);
    s.tip = await g(s.wt, 'rev-parse', 'HEAD');
  }
  return s;
}

export const runWrap = (s, extra = {}) =>
  wrapIssue(s.deps, { claims: s.claims, cache: s.cache, config: CONFIG, clock, closingPrs: s.closingPrs ?? [], key: KEY, reposDir: REPOS(s), defaultBranch: 'main', stateDir: s.stateDir, ...extra });

/**
 * The merged pull request `number` from the issue branch at its tip, found by its head branch and listed in the cache as a
 * closing pull request of the issue. `wrap` counts a pull request at the tip only when it closes the issue (#128).
 */
export function closingAtTip(s, number = 12, over = {}) {
  const pr = prOf(number, s.tip, BRANCH, over);
  s.pulls.byHead[BRANCH] = [pr];
  s.pulls.byNumber[String(number)] = pr;
  s.closingPrs = [closing(number, BRANCH)];
  return pr;
}

/** A command context over the sandbox: its workspace, its state folder (claims.db) and its fake claude. */
export const commandCtx = (s, { configFile, out, err }) => ({
  configFile,
  stateDir: s.stateDir,
  json: false,
  repoRoot: s.ws,
  paths: { workspace: s.ws, claudeJson: s.claudeJson },
  gh: s.deps.gh,
  claude: s.fake,
  clock,
  findHolders: s.deps.findHolders,
  out: (x) => out.push(x),
  err: (x) => err.push(x),
  log: { append: () => {} },
});

/** Leave worktree-app-1 for a pushed branch cut from main, so that the issue branch is not the checked-out one. */
export async function switchToFollowUp(s) {
  await g(s.wt, 'switch', '-c', 'follow', 'main');
  await commitFile(s.wt, 'follow.txt', 'follow\n');
  await g(s.wt, 'push', '-u', 'origin', 'follow');
}

/** A worktree whose issue branch was pushed as feature-z and is proven by the merged closing pull request #9, with a follow-up branch checked out. */
export async function provenFollowUp(t, makeScript) {
  const s = await wrapSetup(t, { push: 'feature-z', makeScript });
  s.pulls.byNumber['9'] = prOf(9, s.tip, 'feature-z');
  await switchToFollowUp(s);
  return s;
}

export const closingArgs = { closingPrs: [closing(9)] };
