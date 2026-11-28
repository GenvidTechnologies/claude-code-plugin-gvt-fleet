// A worktree sandbox whose repository has one submodule, for the no-session removal of `wrap` (#143).
import path from 'node:path';
import { commitFile, fwd, g, makeOrigin } from './git-sandbox.mjs';

// Local submodule URLs need the file protocol, which git refuses by default since 2.38.1.
export const FILE_OK = ['-c', 'protocol.file.allow=always'];

/**
 * Add the submodule `sub` to the origin of `s` (pushed on main), then fetch it into the base clone and fast-forward main.
 * Sets `s.subSandbox` (the submodule's own origin and work clone). Call before the worktree is added.
 */
export async function addSubmoduleToOrigin(s) {
  s.subSandbox = await makeOrigin(path.join(s.root, 'sub'));
  await g(s.sandbox.work, ...FILE_OK, 'submodule', 'add', fwd(s.subSandbox.origin), 'sub');
  await g(s.sandbox.work, 'commit', '-m', 'add the submodule');
  await g(s.sandbox.work, 'push', 'origin', 'main');
  await g(s.base, 'pull', '--ff-only', 'origin', 'main');
}

/** Check out the submodule in the worktree folder `wt`. Returns the submodule folder. */
export async function initSubmodule(wt) {
  await g(wt, ...FILE_OK, 'submodule', 'update', '--init');
  return path.join(wt, 'sub');
}

/** Commit a file in the submodule checked out in `wt` (not pushed), and record the new pointer in the worktree. */
export async function commitInSubmodule(wt) {
  const sub = path.join(wt, 'sub');
  const sha = await commitFile(sub, 'sub-work.txt', 'sub work\n');
  await g(wt, 'add', 'sub');
  await g(wt, 'commit', '-m', 'move the submodule');
  return sha;
}
