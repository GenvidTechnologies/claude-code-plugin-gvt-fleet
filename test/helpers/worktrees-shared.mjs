// Helpers shared by the test/worktrees*.test.mjs files, split from one file for CI time (#76).
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { removeWorktree } from '../../lib/worktrees.mjs';
import {
  commitFile,
  fwd,
  g,
  git,
  pushWithUpstream,
} from './git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  PULLS_KEY,
  REPOS,
  addWorktree,
  rmFully,
  setup,
} from './worktree-sandbox.mjs';
import {
  TASK_BRANCH,
  TASK_KEY,
  addTaskWorker,
  taskRmKeepBranch,
} from './task-worktree.mjs';

export const branchExists = async (s) => (await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`], { cwd: s.base })).code === 0;

// git removes .git/worktrees itself once the last admin dir is pruned.
export const droppedDirs = (s) => {
  const dir = path.join(s.base, '.git', 'worktrees');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => e.includes('.claude-dropped-')) : [];
};

export const rmCalls = (s) => s.fake.calls.filter((c) => c.op === 'rm');
export const createArgs = (s) => ({ claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos'), defaultBranch: 'main', cloneUrl: fwd(s.sandbox.origin), trust: s.trust });
export const MERGED_AT = '2026-11-02T00:00:00Z';

/** A pushed worktree with one commit, and `reply(head)` answering the pulls lookup. Returns the setup. */
export async function requireMergedSetup(t, reply) {
  let head = '';
  const s = await setup(t, {
    makeScript: (x) => ({ rm: rmFully(x) }),
    ghScript: { [PULLS_KEY]: () => reply(head) },
  });
  await addWorktree(s, { commit: true, push: true });
  head = await g(s.wt, 'rev-parse', 'HEAD');
  s.head = head;
  return s;
}

export const removeMerged = (s) => removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), requireMerged: true, defaultBranch: 'main' });
export const REMOTE_NAME = 'feature-y';

/** A branch record in a temp folder, optionally pre-filled, in the shape removeWorktree takes. */
export function recordSetup(s, repos = {}) {
  const recordFile = path.join(s.root, 'config', 'branches.json');
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, repos }), 'utf8');
  s.recordFile = recordFile;
  s.branchRecord = {
    recordFile,
    lockFile: path.join(s.stateDir, 'branches.lock'),
    config: { repos: [{ repo: 'acme/app', defaultBranch: 'main' }] },
    cache: {},
    clock: { now: () => NOW },
  };
  return s.branchRecord;
}

export const readRecord = (s) => JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos['acme/app'] ?? {};
export const OWN_ENTRY = { disposition: 'issue', issue: KEY, decided: '2026-11-03', by: 'coordinator' };
export const removeRecording = (s) => removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), branchRecord: s.branchRecord });

/** A pushed worktree whose upstream branch is named REMOTE_NAME; `claude rm` notes what the record held when it ran. */
export async function pushedUnderOtherName(t, repos) {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: async () => {
        x.recordAtRm = readRecord(x);
        return rmFully(x)();
      },
    }),
  });
  await addWorktree(s, { commit: true });
  await pushWithUpstream(s.wt, BRANCH, REMOTE_NAME);
  recordSetup(s, repos);
  return s;
}

export const closingKey = (n) => `GET repos/acme/app/pulls/${n}`;
export const prOf = (number, sha, ref, over = {}) => ({ number, state: 'closed', merged_at: MERGED_AT, head: { sha, ref, repo: { full_name: 'acme/app' } }, base: { ref: 'main' }, ...over });
export const closing = (number, ref = 'feature-z') => ({ number, state: 'MERGED', headRefName: ref, repo: 'acme/app' });

export const removeProving = (s, extra = {}) =>
  removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), requireMerged: true, defaultBranch: 'main', ...extra });

export const removePlain = (s) => removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), defaultBranch: 'main' });

/**
 * A worktree on worktree-app-1. `push` is null (not pushed), 'upstream' (pushed with an upstream of the same name) or a
 * remote branch name (pushed under that name, with no upstream). `script(box)` returns more gh replies; `box.tip` is the
 * tip of worktree-app-1.
 */
export async function issueSetup(t, { commit = true, push = null, script = () => ({}) } = {}) {
  const box = { tip: '' };
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }), ghScript: { [PULLS_KEY]: () => ({ data: [] }), ...script(box) } });
  await addWorktree(s, { commit });
  if (push === 'upstream') await g(s.wt, 'push', '-u', 'origin', BRANCH);
  else if (push) await g(s.wt, 'push', 'origin', `${BRANCH}:${push}`);
  box.tip = await g(s.wt, 'rev-parse', 'HEAD');
  s.box = box;
  return s;
}

/** Leave worktree-app-1 for a new branch cut from main, with one commit of its own; optionally push it with an upstream. */
export async function followUp(s, name, { push = false } = {}) {
  await g(s.wt, 'switch', '-c', name, 'main');
  const tip = await commitFile(s.wt, `${name}.txt`, `${name}\n`);
  if (push) await g(s.wt, 'push', '-u', 'origin', name);
  return tip;
}

export const TASK_PULLS_KEY = `GET repos/acme/app/pulls?head=acme%3A${TASK_BRANCH}&state=all&per_page=100`;

/** The sandbox with the task worker: its held lease and, with `worktree`, its worktree and session. */
export async function taskSetup(t, opts = {}) {
  const s = await setup(t, {
    makeScript: (x) => ({ rm: taskRmKeepBranch(x) }),
    ghScript: { [PULLS_KEY]: { data: [] }, [TASK_PULLS_KEY]: { data: [] } },
  });
  await addTaskWorker(s, opts);
  return s;
}

export const removeTask = (s, extra = {}) => removeWorktree(s.deps, { claims: s.claims, key: TASK_KEY, reposDir: REPOS(s), defaultBranch: 'main', ...extra });
export const taskBranchExists = async (s) => (await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}`], { cwd: s.base })).code === 0;
