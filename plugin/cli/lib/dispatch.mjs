// Dispatch: claim an issue and start its worktree session in one command.
// It composes `claimIssue` and `createWorktree` and adds the read-only pre-checks before the claim and
// the rollback after it. Every write stays in those two functions; this module decides on their results.
// Nothing here prints: the command in lib/commands.mjs reports the result.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseLeaseKey,
  taskKey,
  taskNames,
  WORKTREE_NAME_RE,
} from './worker-key.mjs';
import { claimIssue, releaseClaim } from './claims.mjs';
import { inspectClone } from './clones.mjs';
import { isLive, matchSessions, pickSession } from './sessions.mjs';
import { createWorktree, names, splitKey } from './worktrees.mjs';

const SSH_SCP_RE = /^git@github\.com:([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const URL_RE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

const sameDir = (a, b) => path.resolve(a).split(path.sep).join('/').toLowerCase() === path.resolve(b).split(path.sep).join('/').toLowerCase();

/** `owner/name` of a GitHub remote URL (scp-style SSH, ssh:// or https://, with or without `.git`), or null. */
export function repoFromRemoteUrl(url) {
  const text = String(url ?? '').trim();
  const m = SSH_SCP_RE.exec(text) ?? URL_RE.exec(text);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Version of the `coach` block in `check-config --json`. A coach skill refuses any number it does not know. */
export const COACH_CONTRACT = 2;

/**
 * The GitHub repository of the workspace, from its `origin` remote, or null when it cannot be read.
 * The workspace must be the top level of its own git repository: a folder inside another repository does not count.
 */
export async function workspaceRepo(git, workspace) {
  try {
    const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: workspace });
    if (top.code !== 0 || !sameDir(top.stdout.trim(), workspace)) return null;
    const url = await git.run(['config', '--get', 'remote.origin.url'], { cwd: workspace });
    if (url.code !== 0) return null;
    return repoFromRemoteUrl(url.stdout);
  } catch {
    return null;
  }
}

export const defaultPrompt = (key) =>
  `Work on GitHub issue ${key}. When you open a pull request for this issue, put a closing keyword for it in the body (Fixes ${key}), so that gvt-fleet wrap can prove the merge.`;

/** What the failed start left behind: the session listed under the worktree name, and the worktree folder. */
async function startTraces(deps, t) {
  const found = [];
  try {
    const session = pickSession(matchSessions(await deps.claude.agents({ all: true }), { name: t.name, base: t.base }));
    if (session) found.push(`a session named ${t.name} (${session.state ?? 'state unknown'})`);
  } catch (e) {
    return { unknown: true, found: [`claude agents could not be read again: ${e.message}`] };
  }
  try {
    fs.lstatSync(t.path);
    found.push(`the folder ${t.path}`);
  } catch (e) {
    if (e.code !== 'ENOENT') found.push(`${t.path} (${e.code ?? e.message})`);
  }
  return { unknown: false, found };
}

/**
 * Claim `a.key` and create its worktree. Returns {status, key, step?, claim, rollback, ...}.
 * status: 'created' | 'noop' | 'adopted' | 'refused' | 'failed'.
 * claim: the status of the claim step ('held', 'noop', 'refused', 'failed'), or null when a pre-check stopped dispatch first.
 * rollback: 'released' | 'failed' (the lease is left `releasing`) | 'kept' (the claim stays on purpose) | 'not-needed' (the claim was not ours) | null.
 * deps: what createWorktree takes ({git, claude, gh, sleep, now, findHolders}).
 * a: {claims, cache, config, clock, key, reposDir, workspace, defaultBranch, cloneUrl?, trust, prompt?, allowSelf?, extract?, branchRecord?}
 */
export async function dispatchIssue(deps, a) {
  const { key } = a;
  const { repo, owner, repoName, number } = splitKey(key);
  const t = names(repo, number, { base: path.join(a.reposDir, owner, repoName) });
  const stop = (step, reason) => ({ status: 'refused', key, step, claim: null, rollback: null, reason });

  // Pre-checks: no writes and no GitHub call.
  if (!a.allowSelf) {
    const own = await workspaceRepo(deps.git, a.workspace);
    if (own === null) return stop('self-repo', 'cannot read the workspace repository (the origin remote of the workspace); pass --allow-self to dispatch anyway');
    if (own.toLowerCase() === repo.toLowerCase()) return stop('self-repo', `${repo} is the workspace repository; pass --allow-self to dispatch it`);
  }
  if (!a.defaultBranch) return stop('default-branch', 'default branch unknown; run gvt-fleet sync first');
  const pre = await inspectClone({ git: deps.git, reposDir: a.reposDir, repo, defaultBranch: a.defaultBranch });
  if (pre.status === 'skipped') return stop('base-clone', `base clone not usable: ${pre.reason}`);

  // A `held` or `claiming` row that exists now is reused by claimIssue, so its result alone cannot say whose claim it is.
  const prior = a.claims.getActiveLease(key);
  const heldBefore = prior?.state === 'held' || prior?.state === 'claiming';

  const claim = await claimIssue(
    { gh: deps.gh, clock: a.clock, config: a.config },
    { claims: a.claims, cache: a.cache, key, extract: a.extract, branchRecord: a.branchRecord },
  );
  if (claim.status === 'refused' || claim.status === 'failed') {
    return { status: claim.status, key, step: 'claim', claim: claim.status, rollback: null, reasons: claim.reasons, reason: claim.reason };
  }
  const ours = claim.status === 'held' && !heldBefore;
  const base = { key, claim: claim.status, expiresAt: claim.expiresAt, name: t.name };

  // Undo this dispatch's own claim. Only a claim taken by this run is ever released.
  const rollBack = async () => {
    const r = await releaseClaim({ gh: deps.gh, clock: a.clock, config: a.config }, { claims: a.claims, cache: a.cache, key });
    if (r.status === 'released') return { rollback: 'released' };
    return { rollback: 'failed', rollbackReason: r.reason ?? `release ${r.status}`, leaseState: a.claims.getActiveLease(key)?.state ?? null };
  };

  if (claim.contention) {
    const refusal = { ...base, status: 'refused', step: 'contention', reason: `another assignee appeared: ${claim.contention.join(', ')}`, contention: claim.contention };
    return ours ? { ...refusal, ...(await rollBack()) } : { ...refusal, rollback: 'not-needed' };
  }

  return startWorker(deps, a, { key, t, ours, base, release: rollBack });
}

/** Appended to every task prompt: a task worker has no issue, so it must not write to the tracker on its own. */
export const TASK_RULE =
  'There is no GitHub issue for this task. Do not write to the issue tracker (no new issues, comments, labels, assignees or closing) unless the coach approves that one write: ask, then wait for the answer. You may commit, push your branch and open a pull request.';

export const defaultTaskPrompt = (slug, repo, key) => `Task ${slug} in ${repo} (${key}).`;

const MAX_ID_TRIES = 50;
const ACTIVE_STATES = ['claiming', 'held', 'releasing'];

/** True when the worktree folder or the branch `worktree-<name>` of `t` already exists in the base clone. */
async function idTaken(deps, t) {
  try {
    fs.lstatSync(t.path);
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') return true;
  }
  if (!fs.existsSync(t.base)) return false;
  const r = await deps.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: t.base });
  return r.code === 0;
}

/**
 * Start a task worker: a lease with no GitHub issue behind it, then the shared start. It makes no GitHub call.
 * Returns the same result object as dispatchIssue. `key` is the task key once the id is allocated, in every result
 * from then on (including a refusal such as "another run took <key>"); a refusal before that carries `owner/name@slug`.
 * a: {claims, cache, config, clock, repo, slug, reposDir, workspace, defaultBranch, cloneUrl?, trust, prompt?, allowSelf?}
 */
export async function dispatchTask(deps, a) {
  const { repo, slug } = a;
  const [owner, repoName] = repo.split('/');
  const baseDir = path.join(a.reposDir, owner, repoName);
  const prefix = `${repo}@${slug}`;
  let key = null; // set once the id is allocated; a refusal carries it from then on
  const stop = (step, reason) => ({ status: 'refused', key: key ?? prefix, step, claim: null, rollback: null, reason });

  // Pre-checks: no writes and no GitHub call.
  if (!a.allowSelf) {
    const own = await workspaceRepo(deps.git, a.workspace);
    if (own === null) return stop('self-repo', 'cannot read the workspace repository (the origin remote of the workspace); pass --allow-self to dispatch anyway');
    if (own.toLowerCase() === repo.toLowerCase()) return stop('self-repo', `${repo} is the workspace repository; pass --allow-self to dispatch it`);
  }
  if (!a.defaultBranch) return stop('default-branch', 'default branch unknown; run gvt-fleet sync first');
  const pre = await inspectClone({ git: deps.git, reposDir: a.reposDir, repo, defaultBranch: a.defaultBranch });
  if (pre.status === 'skipped') return stop('base-clone', `base clone not usable: ${pre.reason}`);
  const active = a.claims.listLeases({ states: ACTIVE_STATES }).find((l) => {
    const k = parseLeaseKey(l.key);
    return k?.kind === 'task' && k.repo.toLowerCase() === repo.toLowerCase() && k.slug === slug;
  });
  if (active) return stop('task-active', `task ${slug} in ${repo} already has an active lease: ${active.key} (${active.state})`);

  // Allocate the id: one more than the highest n of any row (history included) for this slug and date.
  const date = a.clock.now().toISOString().slice(0, 10).replace(/-/g, '');
  const idPrefix = `${prefix}.${date}.`.toLowerCase();
  let n =
    1 +
    Math.max(
      0,
      ...a.claims
        .listLeases()
        .filter((l) => l.key.toLowerCase().startsWith(idPrefix))
        .map((l) => parseLeaseKey(l.key)?.n ?? 0),
    );
  let t;
  let tries = 0;
  for (; tries < MAX_ID_TRIES; tries++, n++) {
    t = { ...taskNames(repo, { slug, date, n }, { base: baseDir, config: a.config }), repo, base: baseDir };
    if (!WORKTREE_NAME_RE.test(t.name)) return stop('task-id', `the worktree name ${t.name} is longer than 64 characters; use a shorter slug`);
    if (!(await idTaken(deps, t))) break;
  }
  if (tries === MAX_ID_TRIES) return stop('task-id', `no free id for ${prefix}.${date} after ${MAX_ID_TRIES} tries`);
  key = taskKey(repo, { slug, date, n });

  const now = a.clock.now();
  const expiresAt = new Date(now.getTime() + (a.config.leaseMinutes ?? 120) * 60 * 1000).toISOString();
  const taken = a.claims.immediate(() => {
    if (a.claims.listLeases().some((l) => l.key === key)) return true;
    a.claims.putLease({
      leaseId: randomUUID(),
      key,
      state: 'held',
      claimedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt,
      assigneePreexisting: null,
      labelAdded: null,
      sessionId: null,
    });
    return false;
  });
  if (taken) return stop('task-id', `another run took ${key}; run the command again`);

  const base = { key, claim: 'held', expiresAt, name: t.name };
  const release = async () => {
    const r = await releaseClaim({ gh: deps.gh, clock: a.clock, config: a.config }, { claims: a.claims, cache: a.cache, key });
    if (r.status === 'released') return { rollback: 'released' };
    return { rollback: 'failed', rollbackReason: r.reason ?? `release ${r.status}`, leaseState: a.claims.getActiveLease(key)?.state ?? null };
  };
  const body = a.prompt || defaultTaskPrompt(slug, repo, key);
  return startWorker(deps, { ...a, prompt: `${body} ${TASK_RULE}` }, { key, t, ours: true, base, release });
}

/**
 * Create the worktree of a held claim and decide what the result means for the claim. Returns the same result
 * object as dispatchIssue after the claim step.
 * a: {claims, reposDir, defaultBranch, cloneUrl?, trust, prompt?}
 * t: the names of the worker ({name, base, path, ...}). ours: this run took the claim.
 * base: the fields every result carries ({key, claim, expiresAt, name}).
 * release: async () => {rollback: 'released'} | {rollback: 'failed', ...}; it undoes the claim, so a worker
 * without a GitHub claim passes its own.
 */
export async function startWorker(deps, a, { key, t, ours, base, release }) {
  const prompt = a.prompt || defaultPrompt(key);
  const wt = await createWorktree(deps, {
    claims: a.claims,
    key,
    reposDir: a.reposDir,
    defaultBranch: a.defaultBranch,
    cloneUrl: a.cloneUrl,
    trust: a.trust,
    prompt,
  });

  if (wt.status === 'created') return { ...base, ...wt, rollback: null };
  if (wt.status === 'noop') {
    const live = isLive({ state: wt.sessionState });
    return { ...base, ...wt, status: live && !ours ? 'noop' : 'adopted', live, rollback: live ? null : 'kept' };
  }

  const failure = { ...base, status: wt.status, step: wt.step, reason: wt.reason };
  if (wt.step === 'confirm') {
    // The session may still appear: keep the claim so that a later dispatch can adopt it.
    return { ...failure, printedId: wt.printedId ?? null, rollback: 'kept' };
  }
  if (wt.step === 'start') {
    const traces = await startTraces(deps, t);
    if (traces.found.length > 0) return { ...failure, found: traces.found, rollback: 'kept' };
  }
  if (!ours) return { ...failure, rollback: 'not-needed' };
  return { ...failure, ...(await release()) };
}
