// A task worker on top of the worktree sandbox: its key, worktree name and branch, a held task lease and a worktree with its session.
import path from 'node:path';
import { seedTaskLease } from './dispatch-sandbox.mjs';
import {
  addNestedWorktree,
  commitFile,
  fwd,
  g,
} from './git-sandbox.mjs';
import { OK } from './worktree-sandbox.mjs';

export const TASK_KEY = 'acme/app@docs.20261108.1';
export const TASK_NAME = 'app.docs.20261108.1';
export const TASK_BRANCH = `worktree-${TASK_NAME}`;
export const TASK_SESSION_ID = 'beef5678-0000-4000-8000-000000000000';
export const TASK_LEASE_ID = 'T-docs-20261108-1';

/** The `claude rm` that removes the task worktree and its session and leaves the branch for the branch step. */
export const taskRmKeepBranch = (s) => async () => {
  await g(s.base, 'worktree', 'remove', '--force', fwd(s.twt));
  s.fake.sessions.length = 0;
  return OK;
};

/**
 * Seed the held lease of the task and, with `worktree`, a worktree on its branch with a listed session.
 * `commit` adds one commit; `push` is 'upstream' to push the branch with an upstream. Sets `s.twt`, the worktree folder.
 */
export async function addTaskWorker(s, { worktree = true, commit = false, push = null } = {}) {
  s.twt = path.join(s.base, '.claude', 'worktrees', TASK_NAME);
  seedTaskLease(s.claims, { repo: 'acme/app', slug: 'docs', date: '20261108', n: 1 });
  if (!worktree) return s;
  await addNestedWorktree(s.base, TASK_NAME, TASK_BRANCH);
  if (commit) await commitFile(s.twt, 'work.txt', 'work\n');
  if (push === 'upstream') await g(s.twt, 'push', '-u', 'origin', TASK_BRANCH);
  s.fake.sessions.push({ id: 'beef5678', sessionId: TASK_SESSION_ID, name: TASK_NAME, cwd: s.twt, kind: 'background', state: 'working' });
  s.claims.immediate(() =>
    s.claims.updateLease(TASK_LEASE_ID, { sessionId: TASK_SESSION_ID, shortId: 'beef5678', worktreePath: s.twt, branch: TASK_BRANCH, wtState: 'created' }),
  );
  return s;
}
