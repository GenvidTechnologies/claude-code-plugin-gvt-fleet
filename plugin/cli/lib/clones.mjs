// Base clones: one per managed repo under repos/<owner>/<name>.
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write.mjs';

const EXCLUDE_LINE = '/.claude/worktrees/';

function fwd(p) {
  return p.split(path.sep).join('/');
}

export function cloneUrl(repo) {
  return `https://github.com/${repo}.git`;
}

/** Git env that never blocks on a credential prompt. */
function gitEnv(env = process.env) {
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

function addExclude(dir) {
  const file = path.join(dir, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  // Normalise to LF: the file may hold CRLF, and appending LF would leave mixed endings.
  const lf = text.replace(/\r\n?/g, '\n');
  const sep = lf === '' || lf.endsWith('\n') ? '' : '\n';
  writeTextAtomic(file, `${lf}${sep}${EXCLUDE_LINE}\n`);
}

/** True when `pid` is a live process. ESRCH means dead; EPERM means alive but not ours. */
export function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Delete coordinator-owned `.<name>.tmp-*` folders left by an interrupted clone. A folder whose pid is alive is kept. */
function removeLeftovers(parent, name, isAlive = pidAlive) {
  // Only the shape this module creates: `.<name>.tmp-<pid>`.
  const shape = new RegExp(`^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-\\d+$`);
  const removed = [];
  if (!fs.existsSync(parent)) return removed;
  for (const entry of fs.readdirSync(parent)) {
    if (!shape.test(entry)) continue;
    if (isAlive(Number(entry.slice(entry.lastIndexOf('-') + 1)))) continue;
    fs.rmSync(path.join(parent, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed.push(entry);
  }
  return removed;
}

/** True when `p` exists, including as a dangling symbolic link. Only ENOENT means missing. */
function pathPresent(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Read-only check of repos/<owner>/<name>. Makes no fetch, merge, checkout, clone or file write.
 * Returns {status: 'absent'}, {status: 'skipped', reason} or {status: 'ok'}.
 * 'ok' means the folder is a clean clone on the default branch.
 */
export async function inspectClone({ git, reposDir, repo, defaultBranch, env }) {
  const [owner, name] = repo.split('/');
  const dir = path.join(reposDir, owner, name);
  if (!pathPresent(dir)) return { status: 'absent' };
  const cwd = dir;
  const genv = gitEnv(env);
  const inside = await git.run(['rev-parse', '--git-dir'], { cwd, env: genv });
  if (inside.code !== 0 || !pathPresent(path.join(dir, '.git'))) {
    return { status: 'skipped', reason: 'not a git repository' };
  }
  const porcelain = await git.run(['status', '--porcelain'], { cwd, env: genv });
  if (porcelain.code !== 0) {
    return { status: 'skipped', reason: `git status failed: ${porcelain.stderr.trim()}` };
  }
  if (porcelain.stdout.trim() !== '') {
    return { status: 'skipped', reason: 'working tree is dirty' };
  }
  const head = await git.run(['symbolic-ref', '--short', 'HEAD'], { cwd, env: genv });
  const branch = head.code === 0 ? head.stdout.trim() : '(detached)';
  if (branch !== defaultBranch) {
    return { status: 'skipped', reason: `on branch ${branch}, not ${defaultBranch}` };
  }
  return { status: 'ok' };
}

/**
 * Make sure repos/<owner>/<name> is a clone on the default branch, current with origin.
 * Returns {status, dir, ...}. status is one of
 * 'cloned', 'updated', 'up-to-date', 'skipped' (with reason) or 'failed' (with reason).
 * ctx: {git, reposDir, repo: 'owner/name', defaultBranch, url?, env?, pid?, isPidAlive?}
 */
export async function ensureClone(ctx) {
  const { git, reposDir, repo, defaultBranch } = ctx;
  const [owner, name] = repo.split('/');
  const parent = path.join(reposDir, owner);
  const dir = path.join(parent, name);
  const env = gitEnv(ctx.env);
  const url = ctx.url ?? cloneUrl(repo);
  const cleaned = removeLeftovers(parent, name, ctx.isPidAlive);
  const extra = cleaned.length > 0 ? { cleaned } : {};

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(parent, { recursive: true });
    const tmp = path.join(parent, `.${name}.tmp-${ctx.pid ?? process.pid}`);
    const res = await git.run(['clone', '--branch', defaultBranch, url, fwd(tmp)], { env });
    if (res.code !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { status: 'failed', dir, reason: `clone failed: ${res.stderr.trim()}`, ...extra };
    }
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return { status: 'failed', dir, reason: `could not move the clone into place: ${e.message}`, ...extra };
    }
    addExclude(dir);
    return { status: 'cloned', dir, ...extra };
  }

  const cwd = dir;
  const inspected = await inspectClone({ git, reposDir, repo, defaultBranch, env: ctx.env });
  if (inspected.status === 'skipped') {
    return { status: 'skipped', dir, reason: inspected.reason, ...extra };
  }
  addExclude(dir);
  const before = (await git.out(['rev-parse', 'HEAD'], { cwd, env }));
  const fetch = await git.run(['fetch', 'origin'], { cwd, env });
  if (fetch.code !== 0) {
    return { status: 'failed', dir, reason: `fetch failed: ${fetch.stderr.trim()}`, ...extra };
  }
  const merge = await git.run(['merge', '--ff-only', `origin/${defaultBranch}`], { cwd, env });
  if (merge.code !== 0) {
    return { status: 'failed', dir, reason: `not a fast-forward: ${(merge.stderr || merge.stdout).trim()}`, ...extra };
  }
  const after = await git.out(['rev-parse', 'HEAD'], { cwd, env });
  return { status: after === before ? 'up-to-date' : 'updated', dir, before, after, ...extra };
}
