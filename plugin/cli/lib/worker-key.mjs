// The key and the worktree name of a task worker (a worker that has no issue).
//
// An issue worker has the key `owner/name#N` and the worktree `<short>-<N>`. A task worker has the key
// `owner/name@<slug>.<YYYYMMDD>.<n>` and the worktree `<short>.<slug>.<YYYYMMDD>.<n>`. The task name never
// ends in `-<digits>`, so parseWorktreeCwd in ./worktree-path.mjs reads no issue from it. The name is at
// most 64 characters, the limit that `claude -w` accepted when measured.
import path from 'node:path';
import { repoShortName } from './config.mjs';

export const TASK_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 24;
export const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_LIMIT = 64;
const DATE_LENGTH = 8;

const ISSUE_KEY_RE = /^([^/#@\s]+)\/([^#@\s]+)#([1-9][0-9]*)$/;
const TASK_KEY_RE = /^([^/#@\s]+)\/([^#@\s]+)@([a-z0-9]+(?:-[a-z0-9]+)*)\.([0-9]{8})\.([1-9][0-9]*)$/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Classify a lease key. Returns an issue or task description, or null when the key is neither. Never throws. */
export function parseLeaseKey(key) {
  if (typeof key !== 'string') return null;
  const issue = ISSUE_KEY_RE.exec(key);
  if (issue) {
    return { kind: 'issue', repo: `${issue[1]}/${issue[2]}`, owner: issue[1], repoName: issue[2], number: Number(issue[3]) };
  }
  const task = TASK_KEY_RE.exec(key);
  if (task) {
    return {
      kind: 'task',
      repo: `${task[1]}/${task[2]}`,
      owner: task[1],
      repoName: task[2],
      slug: task[3],
      date: task[4],
      n: Number(task[5]),
    };
  }
  return null;
}

/** `owner/name@slug.YYYYMMDD.n` */
export function taskKey(repo, { slug, date, n }) {
  return `${repo}@${slug}.${date}.${n}`;
}

/** The worktree name, its branch and (when `base` is given) its path. `config` resolves the short name. */
export function taskNames(repo, { slug, date, n }, { base, config } = {}) {
  const name = `${repoShortName(repo, config)}.${slug}.${date}.${n}`;
  const out = { name, branch: `worktree-${name}` };
  if (base) out.path = path.join(base, '.claude', 'worktrees', name);
  return out;
}

/** The task key when `worktree` is a task worktree name of `repo` (the short name is case-insensitive), else null. */
export function parseTaskWorktreeName(config, repo, worktree) {
  if (typeof worktree !== 'string') return null;
  const short = escapeRegExp(repoShortName(repo, config));
  const m = new RegExp(`^${short}\\.([a-z0-9]+(?:-[a-z0-9]+)*)\\.([0-9]{8})\\.([1-9][0-9]*)$`, 'i').exec(worktree);
  if (!m || !TASK_SLUG_RE.test(m[1])) return null;
  return taskKey(repo, { slug: m[1], date: m[2], n: Number(m[3]) });
}

/**
 * The longest slug whose worktree name fits 64 characters for `repo`, capped at MAX_SLUG_LENGTH.
 * `nDigits` is the width of the sequence number n (1 for n below 10). The result is never below 0.
 */
export function maxSlugLength(repo, config, nDigits = 1) {
  const fixed = repoShortName(repo, config).length + 1 + 1 + DATE_LENGTH + 1 + nDigits;
  return Math.max(0, Math.min(MAX_SLUG_LENGTH, NAME_LIMIT - fixed));
}

/** Null when `slug` is usable for `repo`, else a message that names the maximum length. */
export function checkTaskSlug(repo, slug, config, nDigits = 1) {
  if (typeof slug !== 'string' || !TASK_SLUG_RE.test(slug)) {
    return `"${slug}" is not a task slug (lowercase letters, digits and single hyphens)`;
  }
  const max = maxSlugLength(repo, config, nDigits);
  if (slug.length > max) return `task slug "${slug}" is ${slug.length} characters; the maximum is ${max} for ${repo}`;
  return null;
}
