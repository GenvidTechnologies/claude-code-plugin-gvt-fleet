// Composable helpers that build real git repositories in a temp dir. Never inside a real checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../lib/proc.mjs';
import { createGit } from '../../lib/git.mjs';

export const git = createGit({ run });

const IDENTITY = ['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.invalid', '-c', 'commit.gpgsign=false'];

export function fwd(p) {
  return p.split(path.sep).join('/');
}

/** Make a temp dir and register its removal on the test context. */
export function makeTempDir(t, prefix = 'gvt-fleet-sandbox-') {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** Run git and throw with stderr on failure. Returns trimmed stdout. */
export function g(cwd, ...args) {
  return git.out([...IDENTITY, ...args], { cwd });
}

/** Commit a file in a work clone. Returns the new HEAD sha. */
export async function commitFile(workDir, name, content, message = `add ${name}`) {
  fs.mkdirSync(path.dirname(path.join(workDir, name)), { recursive: true });
  fs.writeFileSync(path.join(workDir, name), content, 'utf8');
  await g(workDir, 'add', '--', name);
  await g(workDir, 'commit', '-m', message);
  return g(workDir, 'rev-parse', 'HEAD');
}

/**
 * Build <root>/origin.git (bare, default branch with one commit) and <root>/work (a clone of it,
 * used to push more commits). Returns {root, origin, work, branch}.
 */
export async function makeOrigin(root, { branch = 'main' } = {}) {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin, { recursive: true });
  await g(origin, 'init', '--bare', `--initial-branch=${branch}`);
  fs.mkdirSync(work, { recursive: true });
  await g(work, 'init', `--initial-branch=${branch}`);
  await g(work, 'remote', 'add', 'origin', fwd(origin));
  await commitFile(work, 'README.md', 'first\n', 'first commit');
  await g(work, 'push', 'origin', branch);
  return { root, origin, work, branch };
}

/** Commit a file in `work` and push it to origin. Returns the new sha. */
export async function pushCommit(sandbox, name, content) {
  const sha = await commitFile(sandbox.work, name, content);
  await g(sandbox.work, 'push', 'origin', sandbox.branch);
  return sha;
}

/** Clone origin into `dir` on its default branch. */
export async function cloneOrigin(sandbox, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await g(path.dirname(dir), 'clone', '--branch', sandbox.branch, fwd(sandbox.origin), fwd(dir));
  return dir;
}

/** Add a linked worktree under <base>/.claude/worktrees/<name> on a new branch. */
export async function addNestedWorktree(base, name, branch = name) {
  const wt = path.join(base, '.claude', 'worktrees', name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await g(base, 'worktree', 'add', '-b', branch, fwd(wt));
  return wt;
}

/**
 * Push the checked-out branch of a worktree to origin under `remote` and set it as the upstream, so
 * `branch.<local>.merge` is `refs/heads/<remote>`. `remote` defaults to the local name.
 */
export async function pushWithUpstream(wt, local, remote = local) {
  await g(wt, 'push', '-u', 'origin', `${local}:${remote}`);
  return remote;
}

/**
 * Build the half-removed worktree state: rename the admin dir to <name>.claude-dropped-x and
 * delete everything in the worktree folder except the `.git` file.
 */
export function halfRemoveWorktree(base, wt) {
  const adminDir = path.join(base, '.git', 'worktrees', path.basename(wt));
  const dropped = `${adminDir}.claude-dropped-x`;
  fs.renameSync(adminDir, dropped);
  for (const entry of fs.readdirSync(wt)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(wt, entry), { recursive: true, force: true });
  }
  return { adminDir, dropped };
}
