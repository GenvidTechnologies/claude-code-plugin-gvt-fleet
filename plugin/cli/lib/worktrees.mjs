// Worktree lifecycle (R22-R25): create, remove, finish. Every step observes the real state first
// (claude agents, the folder, git worktree list, the admin dirs, the branch) and then acts.
// `wt_state` on the claim row records intent only.
//
// deps: {git, claude, gh, sleep, findHolders, now?}. All of them are injected; tests fake claude, gh and the
// process listing, and use real git.

import fs from 'node:fs';
import path from 'node:path';
import { dropBranch, setBranch } from './branches.mjs';
import { repoShortName } from './config.mjs';
import { ensureClone } from './clones.mjs';
import { ensureTrusted } from './trust.mjs';
import { resolveExe } from './proc.mjs';
import { workerFile } from './hook-state.mjs';
import { isLive, matchSessions, pickSession } from './sessions.mjs';
import { decideProof } from './merge-proof.mjs';
import { decideNothingToLose } from './nothing-to-lose.mjs';
import { parseLeaseKey, taskNames } from './worker-key.mjs';

export const RM_ATTEMPTS = 5;
export const RM_RETRY_MS = 2000;
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_WAIT_MS = 1000;
const LOCK_ERROR = (text) => /lock/i.test(text) && /still running/i.test(text);
const HALF_FAILED_TEXT = /\bkept\b|EBUSY/i;
// The refusal of `claude rm` for unpushed work also starts with "kept <id>", but nothing holds the folder: it is a refusal (#142).
const UNPUSHED_REFUSAL = /--discard-unpushed|\bunpushed commit/i;
const halfFailedText = (text) => HALF_FAILED_TEXT.test(text) && !UNPUSHED_REFUSAL.test(text);

/** The next step after a held folder: close the likely holders when some were found, else wait and run `next` again (#126). */
export function holdersHint(holders, next) {
  return holders?.length > 0 ? `close them, then ${next}` : `no program was found that holds the folder; wait a moment, then ${next}`;
}
// A removal that fails with EBUSY or EPERM and has no holder is tried again: BUSY_ATTEMPTS attempts in all,
// with BUSY_WAITS_MS[i] ms of waiting after attempt i + 1.
export const BUSY_ATTEMPTS = 3;
export const BUSY_WAITS_MS = [2000, 5000];
const BUSY_TEXT = /EBUSY|EPERM/i;
/** The wait after attempt `n` (1-based); the last value repeats when BUSY_ATTEMPTS outgrows the list. */
const busyWait = (n) => BUSY_WAITS_MS[Math.min(n, BUSY_WAITS_MS.length) - 1];
const BUSY_CODES = new Set(['EBUSY', 'EPERM']);
const OK_RM = { code: 0, stdout: '', stderr: '' };
const HOLDER_PROCESSES = ['code.exe', 'gitextensions.exe'];

const fwd = (p) => p.split(path.sep).join('/');
const sameDir = (a, b) => fwd(path.resolve(a)).toLowerCase() === fwd(path.resolve(b)).toLowerCase();
const short7 = (sha) => String(sha ?? '').slice(0, 7);

/**
 * The only builder of a worktree name, path and branch. `repo` is `owner/name` or the short name;
 * the short name (the part after the slash) is used. `base` is the base clone folder.
 */
export function names(repo, issue, { base } = {}) {
  const short = repo.includes('/') ? repoShortName(repo, undefined) : repo;
  const name = `${short}-${issue}`;
  const out = { name, branch: `worktree-${name}` };
  if (base) out.path = path.join(base, '.claude', 'worktrees', name);
  return out;
}

export function splitKey(key) {
  const m = /^([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(key);
  if (!m) throw new Error(`cannot read "${key}" as owner/repo#N`);
  return { repo: `${m[1]}/${m[2]}`, owner: m[1], repoName: m[2], number: Number(m[3]) };
}

/**
 * The claim row the worktree primitives keep their state on (`wtState`, `discardHead`): the active claim, else the newest
 * row that has a worktree path, the claim the folder was made under. `wrap` reads its `wrapped` marker from another row on
 * purpose: the active claim, else the latest released one, also when that claim never had a worktree path. The marker
 * belongs to the claim being wrapped, and on a reopened issue the row with a worktree path can be an older claim whose marker
 * must not prove the new one. The two differ only when no claim is active.
 */
export function leaseFor(claims, key) {
  return claims.getActiveLease(key) ?? claims.listLeases().filter((l) => l.key === key && l.worktreePath).at(-1) ?? null;
}

export function setWtState(claims, lease, wtState, extra = {}) {
  if (!lease) return;
  claims.immediate(() => claims.updateLease(lease.leaseId, { wtState, ...extra }));
}

/**
 * What is at `dir`. `unsafe` is set (with a reason) when it is not a real folder that can be read:
 * a link or junction, a file, or something unreadable. Nothing is read through a link.
 */
function folderState(dir) {
  const gone = { exists: false, entries: [], gitIsFile: false, unsafe: null };
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return gone;
    return { exists: true, entries: [], gitIsFile: false, unsafe: `cannot look at ${dir}: ${e.code ?? e.message}` };
  }
  if (st.isSymbolicLink()) return { exists: true, entries: [], gitIsFile: false, unsafe: `${dir} is a link or junction, not a folder` };
  if (!st.isDirectory()) return { exists: true, entries: [], gitIsFile: false, unsafe: `${dir} is a file, not a folder` };
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return { exists: true, entries: [], gitIsFile: false, unsafe: `cannot read ${dir}: ${e.code ?? e.message}` };
  }
  let gitIsFile = false;
  if (entries.includes('.git')) {
    try {
      gitIsFile = fs.lstatSync(path.join(dir, '.git')).isFile();
    } catch {
      gitIsFile = false;
    }
  }
  return { exists: true, entries, gitIsFile, unsafe: null };
}

export async function observe(deps, t) {
  const o = { agents: [], agentsError: null, listed: false, locked: null, dropped: [], branchExists: false };
  try {
    o.agents = await deps.claude.agents({ all: true });
  } catch (e) {
    o.agentsError = e.message;
  }
  o.session = pickSession(matchSessions(o.agents, { name: t.name, base: t.base }));
  o.running = isLive(o.session);
  o.folder = folderState(t.path);
  if (fs.existsSync(t.base)) {
    const list = await deps.git.run(['worktree', 'list', '--porcelain'], { cwd: t.base });
    const block = list.code === 0
      ? list.stdout.split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/)).find((ls) => ls[0]?.startsWith('worktree ') && sameDir(ls[0].slice(9), t.path))
      : undefined;
    o.listed = Boolean(block);
    // `locked` or `locked <reason>`: the reason, '' for none, null when the entry is not locked (or not listed).
    const lockLine = block?.find((l) => l === 'locked' || l.startsWith('locked '));
    o.locked = lockLine === undefined ? null : lockLine.slice('locked'.length).trim();
    // A delete that failed half-way can take the `.git` file and leave the folder. git then marks the entry
    // prunable (its gitdir points at the missing file). Such a folder is not a working worktree either.
    if (o.listed && o.folder.exists && !o.folder.entries.includes('.git') && block.some((l) => l.startsWith('prunable'))) o.listed = false;
    // After a failed `claude rm` the admin dir is renamed to `<name>.claude-dropped-*`, which git still
    // lists, but the folder's `.git` file points at the old name. Such a worktree is not registered.
    if (o.listed && o.folder.gitIsFile) {
      let pointer;
      try {
        pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(t.path, '.git'), 'utf8'))?.[1];
      } catch {
        pointer = undefined;
      }
      if (!pointer || !fs.existsSync(path.resolve(t.path, pointer))) o.listed = false;
    }
    const adminRoot = path.join(t.base, '.git', 'worktrees');
    if (fs.existsSync(adminRoot)) o.dropped = fs.readdirSync(adminRoot).filter((e) => e.startsWith(`${t.name}.claude-dropped-`));
    o.branchExists = (await deps.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: t.base })).code === 0;
  }
  return o;
}

/** The id `claude rm` and `claude stop` take: the listed id, else the recorded short id. */
const sessionIdOf = (o, lease) => o.session?.id ?? lease?.shortId ?? lease?.sessionId?.slice(0, 8) ?? null;

/** parseLeaseKey, but a key that is neither an issue nor a task key throws. */
function readLeaseKey(key) {
  const k = parseLeaseKey(key);
  if (!k) throw new Error(`cannot read "${key}" as owner/repo#N or a task id`);
  return k;
}

export function target(reposDir, key) {
  const k = readLeaseKey(key);
  const base = path.join(reposDir, k.owner, k.repoName);
  const n = k.kind === 'task' ? taskNames(k.repo, k, { base }) : names(k.repo, k.number, { base });
  return { repo: k.repo, number: k.number ?? null, kind: k.kind, base, ...n };
}

const now = (deps) => (deps.now ? deps.now() : new Date());

// ---- create ----

/**
 * Create the worktree of a held claim. Returns {status: 'created'|'noop'|'refused'|'failed', key, ...}.
 * args: {claims, key, reposDir, defaultBranch, cloneUrl?, trust, prompt?}
 * `trust` is the ensureTrusted context: {claudeJson, workspace, stateDir, sleep, run?}. `run` is the
 * once-per-command object that keeps the backup to one per run; it defaults to a fresh one.
 */
export async function createWorktree(deps, { claims, key, reposDir, defaultBranch, cloneUrl, trust, prompt }) {
  const lease = claims.getActiveLease(key);
  if (lease?.state !== 'held') return { status: 'refused', step: 'claim', key, reason: `no held claim for ${key}; run gvt-fleet claim first` };
  if (lease.expiresAt && Date.parse(lease.expiresAt) <= now(deps).getTime()) {
    return { status: 'refused', step: 'claim', key, reason: `the claim on ${key} expired at ${lease.expiresAt}; run gvt-fleet expire, then claim again` };
  }
  const t = target(reposDir, key);
  const o = await observe(deps, t);
  if (o.agentsError) return { status: 'failed', step: 'agents', key, reason: `cannot read claude agents: ${o.agentsError}` };
  if (o.session) {
    // A live session is a no-op; a row that lost its session id is filled in again.
    if (!lease.sessionId) {
      setWtState(claims, lease, 'created', { sessionId: o.session.sessionId ?? o.session.id, shortId: o.session.id ?? o.session.sessionId?.slice(0, 8), worktreePath: t.path, branch: t.branch });
    }
    const shortId = lease.shortId ?? o.session.id ?? o.session.sessionId?.slice(0, 8) ?? null;
    return { status: 'noop', key, name: t.name, path: t.path, branch: t.branch, shortId, sessionState: o.session.state ?? null };
  }
  if (o.folder.exists) {
    return { status: 'refused', step: 'folder', key, path: t.path, reason: `${t.path} exists but no session is listed for ${t.name}; it was not overwritten` };
  }

  const clone = await ensureClone({ git: deps.git, reposDir, repo: t.repo, defaultBranch, url: cloneUrl });
  if (clone.status === 'skipped' || clone.status === 'failed') {
    return { status: clone.status === 'failed' ? 'failed' : 'refused', step: 'clone', key, reason: `base clone ${clone.status}: ${clone.reason}` };
  }
  const trusted = await ensureTrusted(t.base, { ...trust, run: trust.run ?? {} });
  if (trusted.status === 'refused' || trusted.status === 'failed') {
    return { status: trusted.status === 'failed' ? 'failed' : 'refused', step: 'trust', key, reason: `trust ${trusted.status}: ${trusted.reason}` };
  }

  let started;
  try {
    started = await deps.claude.startBg({ cwd: t.base, name: t.name, prompt });
  } catch (e) {
    return { status: 'failed', step: 'start', key, reason: e.message };
  }

  // Confirm by name. The printed id is only a hint: its format is not pinned.
  let session = null;
  for (let i = 0; i < CONFIRM_ATTEMPTS && !session; i++) {
    if (i > 0) await deps.sleep(CONFIRM_WAIT_MS);
    try {
      session = pickSession(matchSessions(await deps.claude.agents({ all: true }), { name: t.name, base: t.base }));
    } catch (e) {
      return { status: 'failed', step: 'confirm', key, printedId: started.id ?? null, reason: `claude agents failed after claude --bg: ${e.message}` };
    }
  }
  if (!session) {
    return { status: 'failed', step: 'confirm', key, printedId: started.id ?? null, reason: `claude --bg printed ${JSON.stringify(started.stdout?.trim() ?? '')} but no session named ${t.name} is listed` };
  }
  const sessionId = session.sessionId ?? session.id;
  const shortId = sessionId.slice(0, 8);
  setWtState(claims, lease, 'created', { sessionId, shortId, worktreePath: t.path, branch: t.branch });
  return { status: 'created', key, name: t.name, sessionId, shortId, path: t.path, branch: t.branch };
}

// ---- remove ----

const lines = (text) => String(text ?? '').split(/\r?\n/).filter(Boolean);

/** The remote branch name from `branch.<b>.merge` without `refs/heads/`, or the local name. */
export async function remoteBranchOf(git, cwd, local) {
  const res = await git(['config', '--get', `branch.${local}.merge`], cwd);
  const merge = res.code === 0 ? res.stdout.trim() : '';
  return merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : local;
}

/** The pull requests whose head is `<owner>:<branch>`: `{ prs }`, or `{ error }` when the lookup fails. */
export async function findPullRequests(deps, repo, owner, branch) {
  try {
    const { data } = await deps.gh.rest('GET', `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`);
    return { prs: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { error };
  }
}

/**
 * The pull requests that contain `sha`: `{ prs }`. GitHub answers HTTP 422 "No commit found for SHA" for a commit it does not know,
 * which gives `{ prs: [], noCommit: true }`. Any other failure, a 422 with other text included, gives `{ error }`.
 * `GhError` has no status field, so the 422 is recognised by its text.
 */
export async function findPullRequestsByCommit(deps, repo, sha) {
  try {
    const { data } = await deps.gh.rest('GET', `repos/${repo}/commits/${sha}/pulls?per_page=100`);
    if (!Array.isArray(data)) return { error: new Error(`the pull request list for commit ${sha} is not an array`) };
    return { prs: data };
  } catch (error) {
    const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
    if (/HTTP 422/.test(text) && /No commit found/i.test(text)) return { prs: [], noCommit: true };
    return { error };
  }
}

/** One pull request by number: `{ pr }`, or `{ error }` when the lookup fails. */
export async function findPullRequest(deps, repo, number) {
  try {
    const { data } = await deps.gh.rest('GET', `repos/${repo}/pulls/${number}`);
    return { pr: data };
  } catch (error) {
    return { error };
  }
}

/** The branches the worktree HEAD reflog says were checked out in that worktree, in no particular order. */
async function reflogBranches(git, wt) {
  const log = await git(['reflog', 'show', '--format=%gs', 'HEAD'], wt);
  if (log.code !== 0) return [];
  const names = new Set();
  for (const l of lines(log.stdout)) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(l);
    if (m) {
      names.add(m[1]);
      names.add(m[2]);
    }
  }
  return [...names];
}

/** The branches checked out in worktrees other than `wt` (the base clone included). */
async function checkedOutElsewhere(git, base, wt) {
  const list = await git(['worktree', 'list', '--porcelain'], base);
  const out = new Set();
  if (list.code !== 0) return out;
  let here = false;
  for (const l of lines(list.stdout)) {
    if (l.startsWith('worktree ')) here = sameDir(l.slice(9), wt);
    else if (l.startsWith('branch refs/heads/') && !here) out.add(l.slice('branch refs/heads/'.length));
  }
  return out;
}

/**
 * The other local branches this worktree checked out: names in its HEAD reflog that still resolve to `refs/heads/*`,
 * except `skip` (the issue branch, the checked-out branch, the default branch) and any branch checked out in another worktree.
 * Returns [{branch, tip}].
 */
async function workedBranches(git, t, skip) {
  const elsewhere = await checkedOutElsewhere(git, t.base, t.path);
  const out = [];
  for (const name of await reflogBranches(git, t.path)) {
    if (skip.has(name) || elsewhere.has(name)) continue;
    const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], t.base);
    if (r.code === 0) out.push({ branch: name, tip: r.stdout.trim() });
  }
  return out;
}

/** False when `tip` is on the default branch of origin (no work of its own). True when it is not, or when that cannot be told. */
async function hasOwnCommits(git, base, tip, defaultBranch) {
  if (!tip) return false;
  const refs = [defaultBranch ? `refs/remotes/origin/${defaultBranch}` : null, 'refs/remotes/origin/HEAD'].filter(Boolean);
  for (const ref of refs) {
    if ((await git(['rev-parse', '--verify', '--quiet', ref], base)).code !== 0) continue;
    return (await git(['merge-base', '--is-ancestor', tip, ref], base)).code !== 0;
  }
  return true;
}

/**
 * Gather the facts of the nothing-to-lose proof and decide it (decideNothingToLose in nothing-to-lose.mjs).
 * `readIssueRefs` (async) returns the issue state and the pull requests that refer to it; nothing else is read when the
 * issue is open or cannot be read. `held` is [{branch, tip, ownCommits?}], the branches the worker holds; `ownCommits` is
 * read when it is absent. A branch with commits of its own is matched against the `known` pull requests first, then looked
 * up by its tip (`GET repos/{repo}/commits/{sha}/pulls`). Returns {problems, proofs, proven}.
 */
export async function nothingToLose(deps, t, { readIssueRefs, held = [], defaultBranch, known = [] }) {
  const git = (args, cwd) => deps.git.run(args, { cwd });
  const refs = await readIssueRefs();
  if (refs?.error || refs?.state !== 'closed') return decideNothingToLose({ key: t.key, refs, branches: [] });
  const branches = [];
  for (const h of held) {
    const ownCommits = h.ownCommits ?? (await hasOwnCommits(git, t.base, h.tip, defaultBranch));
    let lookup = null;
    if (ownCommits) {
      const hit = known.filter((p) => p.merged_at && p.head?.sha === h.tip);
      lookup = hit.length > 0 ? { prs: hit } : await findPullRequestsByCommit(deps, t.repo, h.tip);
    }
    branches.push({ ...h, ownCommits, lookup });
  }
  return decideNothingToLose({ key: t.key, refs, branches });
}

/** `{ error }` or `{ count }`: how many commits of `tip` are on no remote branch. */
async function unpushedOf(git, cwd, tip) {
  const ahead = await git(['rev-list', tip, '--not', '--remotes'], cwd);
  if (ahead.code !== 0) return { error: `git rev-list failed: ${ahead.stderr.trim()}` };
  return { count: lines(ahead.stdout).length };
}

/**
 * The submodules checked out in the worktree `wt` (`git submodule status --recursive`, skipping the `-` lines of those
 * not checked out): `{subs: [{path, dir}]}`, or `{error}`. A worktree with no `.gitmodules` file has none, and runs no git.
 */
async function checkedOutSubmodules(git, wt) {
  if (!fs.existsSync(path.join(wt, '.gitmodules'))) return { subs: [] };
  const r = await git(['submodule', 'status', '--recursive'], wt);
  if (r.code !== 0) return { error: `git submodule status failed: ${r.stderr.trim()}` };
  const subs = [];
  for (const l of lines(r.stdout)) {
    const m = /^([ +U-])[0-9a-f]+ (.+?)(?: \([^)]*\))?$/.exec(l);
    if (!m || m[1] === '-') continue;
    subs.push({ path: m[2], dir: path.join(wt, m[2]) });
  }
  return { subs };
}

/**
 * The work left in the submodules checked out in `wt` (#143): uncommitted changes, commits of HEAD on no remote branch of the
 * submodule, and stash entries (a submodule has its own stash list). Returns {problems, count}; `count` is the number of
 * submodules checked out.
 */
async function submoduleProblems(git, wt) {
  const found = await checkedOutSubmodules(git, wt);
  if (found.error) return { problems: [found.error], count: 0 };
  const problems = [];
  for (const sm of found.subs) {
    const st = await git(['status', '--porcelain'], sm.dir);
    if (st.code !== 0) problems.push(`submodule ${sm.path}: git status failed: ${st.stderr.trim()}`);
    else if (st.stdout.trim() !== '') problems.push(`submodule ${sm.path} has uncommitted changes`);
    const u = await unpushedOf(git, sm.dir, 'HEAD');
    if (u.error) problems.push(`submodule ${sm.path}: ${u.error}`);
    else if (u.count > 0) problems.push(`submodule ${sm.path} has ${u.count} commit(s) on no remote branch of the submodule`);
    const stash = await git(['stash', 'list', '--format=%gs'], sm.dir);
    if (stash.code !== 0) {
      problems.push(`submodule ${sm.path}: git stash list failed: ${stash.stderr.trim()}`);
    } else {
      const n = lines(stash.stdout).length;
      if (n > 0) problems.push(`submodule ${sm.path} has ${n} stash entr${n === 1 ? 'y' : 'ies'}`);
    }
  }
  return { problems, count: found.subs.length };
}

/**
 * The first symbolic link or junction under `dir`, without following any: `{reason}`, or null when there is none.
 * An entry that cannot be read also gives a reason. A junction can read as a folder in the listing, so folders are lstat'ed.
 */
export function firstLinkIn(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return { reason: `cannot read ${d}: ${e.code ?? e.message}` };
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) return { reason: `${p} is a link or junction` };
      if (!e.isDirectory()) continue;
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (err) {
        return { reason: `cannot look at ${p}: ${err.code ?? err.message}` };
      }
      if (st.isSymbolicLink()) return { reason: `${p} is a link or junction` };
      stack.push(p);
    }
  }
  return null;
}

/** `git worktree unlock` of a listed, locked entry. Returns {note} or {error}. */
async function unlockStale(deps, t, reason) {
  const r = await deps.git.run(['worktree', 'unlock', t.path], { cwd: t.base });
  if (r.code !== 0) return { error: `git worktree unlock failed: ${r.stderr.trim()}` };
  return { note: `the git entry of ${t.name} was locked (${reason || 'no reason'}) with no live session of this worktree; the lock was removed as stale` };
}

/**
 * Read-only safety check. Returns {safe, problems[], via, head, tip, remoteBranch, pr, proofs, provenTip, otherBranches, current, cwd}.
 * `head` is the commit the worktree is at (its own HEAD when the folder is a registered worktree, else the branch tip), or null.
 * `tip` is the tip of the issue branch `worktree-<name>`, or null when it is absent.
 * Three sets of branches are checked, plain `remove` included:
 *   - the checked-out branch or a detached HEAD: its commits must be on a remote-tracking branch, or its tip must be the head of
 *     a merged pull request (found by the branch name when it is the issue branch, else by the HEAD commit);
 *   - the issue branch, when it is not the checked-out one: its commits must be on a remote branch, or at the head of a merged pull request;
 *   - the worked branches (other branches in the HEAD reflog of the worktree, not checked out in another worktree): their commits
 *     must be on a remote branch. A pushed one is returned in `otherBranches` ({branch, tip}) and is not deleted.
 * `remoteBranch` is the remote name of the issue branch (null when the branch is absent or HEAD cannot be read). `pr` is the
 * pull request that satisfied the check or else the most relevant one found ({number, state, mergedAt, headSha}), or null.
 * `proofs` ([{branch, pr}]) lists the merged pull requests that proved the work under `requireMerged`, `provenTip` the issue
 * branch tip they cover (null when only another branch's pull request proved a branch with no commits of its own).
 * With `requireMerged` the check needs a merged pull request whose head is the tip of the issue branch, even when it is pushed
 * (see decideProof in merge-proof.mjs; with `requireClosing`, only a closing pull request counts). `closingPrs` ([{number, repo?}]) are the pull requests the cache says close the issue,
 * looked up one by one. `readClosingPrs` (optional, async, returns `{prs}` or `{error}`) is called once under `requireMerged`
 * when `closingPrs` is empty and nothing else proved the work; its pull requests are looked up like the cached ones, and an
 * `{error}` leaves the work unproven. `defaultBranch` is the repository default branch.
 * `readIssueRefs` (optional, async, see readIssueRefs in nothing-to-lose.mjs) turns on the nothing-to-lose proof (#103) under
 * `requireMerged`: when the check found problems, none of them in the folder or a stash, it is asked once, and when the issue
 * is closed, every pull request that refers to it is merged and every branch held has no commits of its own or its tip at the
 * head of a merged pull request, the check passes with `via: 'nothing-to-lose'`. Its `proofs` are then those pull requests,
 * `provenTip` is the issue branch tip when that branch passed, and `otherBranches` lists every worked branch. Otherwise its
 * reasons are added to the problems, each starting with `no nothing-to-lose proof:`.
 * Plain mode looks up pull requests only when something is unpushed. A step that cannot be read counts as unsafe.
 * With `waiveEmpty` (a task worker), a branch with no commits of its own, checked out and not pushed, counts as pushed, and
 * `provenTip` is its tip. No merge proof is asked for; a branch that has commits must have them on a remote branch.
 * With `leftoverFolder`, the folder is not looked at (`inFolder` is false) and the base clone view is used: the issue branch
 * is the checked-out one.
 */
export async function safetyCheck(deps, t, o, { requireMerged = false, requireClosing = false, closingPrs = [], readClosingPrs, readIssueRefs, defaultBranch, leftoverFolder = false, waiveEmpty = false } = {}) {
  const problems = [];
  const git = (args, cwd) => deps.git.run(args, { cwd });
  const inFolder = !leftoverFolder && o.folder.exists && !o.folder.unsafe;
  const bare = { head: null, tip: null, remoteBranch: null, pr: null, proofs: [], provenTip: null, otherBranches: [] };
  if (!o.branchExists && !inFolder) return { safe: true, problems, via: 'nothing to protect', ...bare };
  const cwd = inFolder ? t.path : t.base;

  if (inFolder) {
    // Whatever git lists, a folder that exists is looked at.
    const st = await git(['status', '--porcelain'], cwd);
    if (st.code !== 0) problems.push(`git status failed: ${st.stderr.trim()}`);
    else if (st.stdout.trim() !== '') problems.push('the working tree has uncommitted changes');
    if (!o.listed) {
      const extra = o.folder.entries.filter((e) => !(e === '.git' && o.folder.gitIsFile));
      if (extra.length > 0) problems.push(`${t.path} is not a registered worktree and holds ${extra.join(', ')}`);
    }
  }
  // The submodules checked out in a registered worktree keep work of their own (#143). It counts as work in the folder.
  let submodules = 0;
  if (inFolder && o.listed) {
    const sm = await submoduleProblems(git, t.path);
    problems.push(...sm.problems);
    submodules = sm.count;
  }

  let head = null;
  let current = null; // the branch HEAD is on
  let detached = false;
  if (inFolder && o.listed) {
    const h = await git(['rev-parse', 'HEAD'], t.path);
    if (h.code === 0) head = h.stdout.trim();
    const sym = await git(['symbolic-ref', '--short', '-q', 'HEAD'], t.path);
    if (sym.code === 0) current = sym.stdout.trim();
    else detached = true;
  } else if (o.branchExists) {
    const h = await git(['rev-parse', `refs/heads/${t.branch}`], t.base);
    if (h.code === 0) head = h.stdout.trim();
    current = t.branch;
  }
  if (head === null) {
    if (o.branchExists || (inFolder && o.listed)) problems.push('cannot read HEAD of the worktree');
    return { safe: problems.length === 0, problems, via: null, ...bare };
  }

  const tip = o.branchExists ? ((r) => (r.code === 0 ? r.stdout.trim() : null))(await git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], t.base)) : null;
  // The default branch is never a worked branch, whatever the reflog says.
  const skip = new Set([t.branch, current, defaultBranch].filter(Boolean));
  const worked = inFolder && o.listed ? await workedBranches(git, t, skip) : [];

  // Stashes are shared by the whole repository, so only those made on these branches (or on a detached HEAD) count.
  const stash = await git(['stash', 'list', '--format=%gs'], cwd);
  if (stash.code === 0) {
    const wanted = new Set([t.branch, current, ...worked.map((w) => w.branch), detached ? '(no branch)' : null].filter(Boolean));
    const mine = lines(stash.stdout).filter((l) => [...wanted].some((b) => l.startsWith(`WIP on ${b}:`) || l.startsWith(`On ${b}:`)));
    if (mine.length > 0) problems.push(`${mine.length} stash entr${mine.length === 1 ? 'y' : 'ies'} made on ${[...wanted].join(' or ')}`);
  } else {
    problems.push(`git stash list failed: ${stash.stderr.trim()}`);
  }
  // Work in the folder or in a stash: the nothing-to-lose proof cannot waive it, so that proof is not tried while any is found.
  const workLeft = problems.length;

  // The checked-out branch and a detached HEAD share one rule: every commit is on some remote-tracking ref, else a merged
  // pull request has HEAD as its head. The problem is held back: a merged pull request at HEAD waives it.
  const unpushed = []; // problems that need no pull request lookup text (a failed git read)
  let unpushedCount = 0; // commits of HEAD on no remote-tracking ref
  let pushed = false;
  {
    const ahead = await unpushedOf(git, cwd, head);
    if (ahead.error) unpushed.push(ahead.error);
    else if (ahead.count === 0) pushed = true;
    else unpushedCount = ahead.count;
  }

  // The issue branch is the unit of work, whatever is checked out. Its remote name is a local config read.
  const issueRemote = tip ? await remoteBranchOf(git, t.base, t.branch) : null;
  const hasUpstream = tip ? (await git(['config', '--get', `branch.${t.branch}.merge`], t.base)).code === 0 : false;
  const readsOwnCommits = requireMerged || waiveEmpty;
  const ownCommits = readsOwnCommits ? await hasOwnCommits(git, t.base, tip, defaultBranch) : true;
  // A branch with no commits of its own has nothing to push. Under requireMerged a merged closing pull request is the proof;
  // under waiveEmpty (a task) the branch is the proof of nothing written, and `provenTip` lets the branch step delete it.
  if (readsOwnCommits && !ownCommits && current === t.branch && !pushed) {
    unpushed.length = 0;
    unpushedCount = 0;
    pushed = true;
  }
  const issueUnpushed = [];
  if (tip && current !== t.branch) {
    const u = await unpushedOf(git, t.base, tip);
    if (u.error) issueUnpushed.push(u.error);
    else if (u.count > 0) issueUnpushed.push(`${t.branch} has ${u.count} commit(s) on no remote branch`);
  }
  // A worked branch has no waiver: its commits are on a remote branch, or it is a problem.
  const workedUnpushed = [];
  const otherBranches = [];
  for (const w of worked) {
    const u = await unpushedOf(git, t.base, w.tip);
    if (u.error) workedUnpushed.push(`${w.branch}: ${u.error}`);
    else if (u.count > 0) workedUnpushed.push(`${w.branch} has ${u.count} commit(s) on no remote branch`);
    else otherBranches.push({ branch: w.branch, tip: w.tip });
  }

  // Pull request lookups. A squash merge leaves the local commits looking unpushed: a merged pull request whose head is
  // that commit waives the unpushed problem. The pull request is looked up under the remote name of the branch, which can
  // differ from the local name. Plain mode looks up only when something is unpushed. A checked-out branch other than the
  // issue branch, and a detached HEAD, are looked up by their HEAD commit: a merged pull request that has HEAD as its head
  // waives the problem. HTTP 422 "No commit found" is an answer (no pull request), not a failure.
  // When gh is unavailable the lookup returns an error and the work stays unproven.
  const owner = readLeaseKey(t.key).owner;
  const needsCurrent = !pushed && (unpushed.length > 0 || unpushedCount > 0);
  let l1 = null;
  const l2 = [];
  if (requireMerged) {
    if (tip) l1 = await findPullRequests(deps, t.repo, owner, issueRemote);
    for (const c of closingPrs) l2.push({ number: c.number, ...(await findPullRequest(deps, c.repo ?? t.repo, c.number)) });
  } else if (tip && (issueUnpushed.length > 0 || (needsCurrent && current === t.branch))) {
    l1 = await findPullRequests(deps, t.repo, owner, issueRemote ?? t.branch);
  }
  const factsOf = (closingRead) => ({
    requireMerged, requireClosing, tip, headIsTip: current === t.branch, ownCommits, branch: t.branch, key: t.key, repo: t.repo, issueRemote, hasUpstream, l1, l2, closingPrs, closingRead, defaultBranch,
  });
  let proof = decideProof(factsOf(null));
  // Lazy live read: only when the cache lists no closing pull request and nothing else proved the work. It runs before the
  // unpushed waivers below, so a closing pull request found only by the live read waives them like a cached one.
  if (requireMerged && closingPrs.length === 0 && typeof readClosingPrs === 'function' && proof.proofs.length === 0) {
    const closingRead = await readClosingPrs();
    if (closingRead?.prs) {
      closingPrs = closingRead.prs;
      for (const c of closingPrs) l2.push({ number: c.number, ...(await findPullRequest(deps, c.repo ?? t.repo, c.number)) });
    }
    proof = decideProof(factsOf(closingRead ?? null));
  }

  // `found` holds the pull requests of the issue branch (by its name) and the closing pull requests. A pull request found by
  // the HEAD commit may belong to another branch, so it only waives the problem of the checked-out branch or detached HEAD.
  // These waivers ask only whether the commits are kept on GitHub, so a pull request merged into any base counts. Under
  // requireMerged the merge proof (decideProof, rule 7) still needs one merged into the default branch.
  const found = [l1].flatMap((x) => x?.prs ?? []).concat(l2.filter((e) => e.pr).map((e) => e.pr));
  const mergedIn = (prs, sha) => Boolean(sha) && prs.some((p) => p.merged_at && p.head?.sha === sha);
  const mergedAt = (sha) => mergedIn(found, sha);
  let byCommit = null;
  if (unpushedCount > 0 && current !== t.branch && !mergedAt(head)) {
    byCommit = await findPullRequestsByCommit(deps, t.repo, head);
  }

  let via = pushed ? 'pushed' : null;
  if (needsCurrent) {
    if (mergedAt(head) || mergedIn(byCommit?.prs ?? [], head)) via = 'merged-pr';
    else {
      problems.push(...unpushed);
      if (unpushedCount > 0) {
        const subject = current
          ? `${current} has ${unpushedCount} commit(s) not pushed to any remote branch and no merged pull request`
          : `HEAD is detached with ${unpushedCount} commit(s) not on any remote branch and no merged pull request`;
        const failed = byCommit?.error ? `, and the pull request lookup by commit ${head.slice(0, 7)} failed: ${byCommit.error.message ?? byCommit.error}` : '';
        problems.push(`${subject}${failed}`);
      }
    }
  }
  if (issueUnpushed.length > 0 && !mergedAt(tip)) problems.push(...issueUnpushed);
  problems.push(...workedUnpushed);

  problems.push(...proof.problems);

  // The nothing-to-lose proof (#103), only when the merge proof refused, the caller asked for it, and nothing is left in
  // the folder or a stash. It replaces every other problem when it holds; otherwise its reasons are added.
  let proofs = proof.proofs;
  let provenTip = proof.provenTip;
  let pr = proof.pr;
  if (requireMerged && problems.length > 0 && workLeft === 0 && typeof readIssueRefs === 'function') {
    const held = [];
    if (tip) held.push({ branch: t.branch, tip, ownCommits });
    if (current && current !== t.branch) held.push({ branch: current, tip: head });
    if (detached) held.push({ branch: 'HEAD (detached)', tip: head });
    for (const w of worked) held.push({ branch: w.branch, tip: w.tip });
    const ntl = await nothingToLose(deps, t, { readIssueRefs, held, defaultBranch, known: found.concat(byCommit?.prs ?? []) });
    if (ntl.problems.length === 0) {
      problems.length = 0;
      via = 'nothing-to-lose';
      proofs = ntl.proofs;
      provenTip = tip && ntl.proven.has(t.branch) ? tip : null;
      pr = ntl.proofs[0]?.pr ?? pr;
      // A worked branch kept on a merged pull request only is not pushed, but it is kept like a pushed one.
      for (const w of worked) if (!otherBranches.some((x) => x.branch === w.branch)) otherBranches.push({ branch: w.branch, tip: w.tip });
    } else {
      problems.push(...ntl.problems.map((p) => `no nothing-to-lose proof: ${p}`));
    }
  }
  return {
    safe: problems.length === 0, problems, via, head, tip, remoteBranch: proof.pushedBranch, pr, proofs, provenTip: provenTip ?? (waiveEmpty && tip && !ownCommits ? tip : null), otherBranches, current, cwd, submodules,
    // The branch the worktree has checked out when it is not the issue (or task) branch; null on the branch itself or a detached HEAD.
    checkedOutBranch: current && current !== t.branch ? { branch: current, tip: head } : null,
  };
}

const sameText = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const LS_REMOTE_TIMEOUT_MS = 20000; // the same bound the holder lookups use for an external program

/** Drop the `worktree-<name>` entry the coordinator wrote for this issue (older versions recorded it at create). */
function dropOwnEntry(br, t, key) {
  return dropBranch({ recordFile: br.recordFile, lockFile: br.lockFile, repo: t.repo, branch: t.branch, matches: (e) => e.by === 'coordinator' && sameText(e.issue, key) });
}

/**
 * Record the branch a safe worktree was pushed under, in the branch record, so that the open issue stays
 * "not ready" while that branch exists. `br` is {recordFile, lockFile, config, cache, clock}.
 * The `worktree-<name>` entry the coordinator wrote for this issue is dropped first. The pushed branch is recorded
 * only when `git ls-remote` on the base clone lists it (or fails: then a warning says so), and never over
 * an entry that is not by the coordinator. Returns {recorded, dropped, warning?}: branch names, or null.
 * `recorded` is null when the entry already held the same values. A failed record write becomes a warning;
 * it never fails the removal. `check` needs only `remoteBranch`; `wrap` passes `{ remoteBranch: null }` when the issue
 * branch is gone, which drops the entry and records nothing.
 */
export async function recordPushedBranch(deps, t, key, check, br) {
  const out = { recorded: null, dropped: null };
  try {
    // check.remoteBranch is the remote name of the issue branch, whatever is checked out. It is null only when that branch is absent.
    const remote = check.remoteBranch;
    // When the remote name is the local name, the entry is the one to record: it is not dropped and re-written.
    if (remote !== t.branch && dropOwnEntry(br, t, key).dropped) out.dropped = t.branch;
    if (!remote) return out;
    const ls = await deps.git.run(['ls-remote', '--heads', 'origin', `refs/heads/${remote}`], { cwd: t.base, env: GIT_ENV, timeoutMs: LS_REMOTE_TIMEOUT_MS });
    if (ls.code === 0 && ls.stdout.trim() === '') {
      // The branch is gone from the remote: the same-name entry kept above is stale, so drop it now.
      if (remote === t.branch && dropOwnEntry(br, t, key).dropped) out.dropped = t.branch;
      return out;
    }
    if (ls.code !== 0) out.warning = `cannot read the remote branches (git ls-remote: ${ls.stderr.trim()}); ${remote} is recorded without checking that it exists`;
    // The never-overwrite guard runs under the record lock, on the entry read there.
    const done = setBranch({
      ...br, repo: t.repo, branch: remote, disposition: 'issue', issueArg: key, allowMissing: true, by: 'coordinator',
      onlyIf: (prior) => prior === undefined || prior.by === 'coordinator',
    });
    if (!done.written) return out;
    const prior = done.prior;
    const same = prior !== undefined && prior.disposition === done.entry.disposition && prior.issue === done.entry.issue && prior.decided === done.entry.decided;
    if (!same) out.recorded = remote;
  } catch (e) {
    out.warning = `branch record not written: ${e.message}`;
  }
  return out;
}

async function rmWithRetry(deps, id, opts) {
  let attempts = 0;
  let res;
  for (;;) {
    attempts += 1;
    res = await deps.claude.rm(id, opts);
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (res.code === 0 || !LOCK_ERROR(text) || attempts >= RM_ATTEMPTS) break;
    await deps.sleep(RM_RETRY_MS);
  }
  return { res, attempts };
}

/** The `<commit>@<worktree-id>` value a refused `claude rm` reports for --discard-unpushed. */
export function parseDiscardValue(text) {
  return /\b([0-9a-f]{7,40}@[^\s'"`]+)/.exec(text)?.[1] ?? null;
}

/** `claude rm` with the lock retry; with consent, one more call that passes the value the first one reported. */
async function rmSession(deps, id, consent) {
  let { res, attempts } = await rmWithRetry(deps, id);
  let usedDiscard = false;
  if (res.code !== 0 && consent) {
    const value = parseDiscardValue(`${res.stdout}\n${res.stderr}`);
    if (value) {
      const again = await rmWithRetry(deps, id, { discardUnpushed: value });
      res = again.res;
      attempts += again.attempts;
      usedDiscard = true;
    }
  }
  return { res, attempts, usedDiscard, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** The tip of the local branch, or null when it does not exist. */
async function tipOf(deps, t) {
  if (!fs.existsSync(t.base)) return null;
  const r = await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], { cwd: t.base });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Delete the local branch. `-D` only when the recorded discard commit is the branch's current tip;
 * or when the merge proof holds; otherwise `-d`. Returns {ok, flag, reason}; a failed result also has `noRemote`, true when the
 * merge proof held for the tip but no remote-tracking branch contains it.
 * Options: `discardHead` is the recorded discard commit (or null).
 * `provenTip` is the tip a merged pull request covers (or null). The proof consent holds when the tip re-read now equals it
 * and `git branch -r --contains <tip>` prints something (a failure counts as empty).
 * `proofOnlyOther` says a proof was found but only for a pull request of another branch, so `provenTip` is null and the
 * reason for not using `-D` is named.
 * `remote` ({tip}) turns on the remote consent, which applies only when neither the discard nor the proof consent does (the wrap
 * of a task). `tip` is the tip of the task branch that the last safety check judged, or null when the checked-out branch was not
 * the task branch (no remote consent then). The consent holds when the tip re-read now equals it and
 * `git branch -r --contains <tip>` prints something (a failure counts as empty). A refusal is named in the reason.
 * `pullHeadKeeps` (default false) waives the remote-tracking condition of the proof consent: `removeWorktree` sets it after it
 * passed the --discard-unpushed consent of `claude rm` for that proven tip, which a merged pull request has as its head, so
 * GitHub keeps its commits under the pull request (#142).
 */
async function deleteBranch(deps, t, { discardHead = null, provenTip = null, proofOnlyOther = false, remote = null, pullHeadKeeps = false } = {}) {
  const tip = await tipOf(deps, t);
  const discardConsent = Boolean(discardHead) && tip === discardHead;
  let proofConsent = false;
  let proofWhy = '';
  let noRemote = false;
  if (!discardConsent && provenTip) {
    if (tip !== provenTip) {
      proofWhy = `${t.branch} moved from ${short7(provenTip)} to ${short7(tip)} after the check`;
    } else {
      const r = await deps.git.run(['branch', '-r', '--contains', tip], { cwd: t.base });
      if ((r.code === 0 && r.stdout.trim() !== '') || pullHeadKeeps) proofConsent = true;
      else {
        proofWhy = `no remote-tracking branch contains ${short7(tip)}`;
        noRemote = true;
      }
    }
  } else if (!discardConsent && proofOnlyOther) {
    proofWhy = 'only a pull request of another branch proved the merge';
  }
  let remoteConsent = false;
  let remoteWhy = '';
  if (!discardConsent && !proofConsent && remote) {
    if (!remote.tip) {
      remoteWhy = `${t.branch} was not the branch checked out in the worktree`;
    } else if (tip !== remote.tip) {
      remoteWhy = `${t.branch} moved from ${short7(remote.tip)} to ${short7(tip)} after the check`;
    } else {
      const r = await deps.git.run(['branch', '-r', '--contains', tip], { cwd: t.base });
      if (r.code === 0 && r.stdout.trim() !== '') remoteConsent = true;
      else remoteWhy = `no remote-tracking branch contains ${short7(tip)}`;
    }
  }
  const consent = discardConsent || proofConsent || remoteConsent;
  const flag = consent ? '-D' : '-d';
  const del = await deps.git.run(['branch', flag, t.branch], { cwd: t.base });
  if (del.code === 0) return { ok: true, flag };
  const moved = discardHead && !consent ? `; ${t.branch} moved after discard consent was given at ${short7(discardHead)} (now ${short7(tip)}), so -d was used` : '';
  const whys = [proofWhy, remoteWhy !== proofWhy ? remoteWhy : ''].filter(Boolean);
  const proofNote = whys.length > 0 ? `; -D was not used: ${whys.join('; ')}` : '';
  const why = consent ? '' : "; git branch -d deletes only a branch that is merged into its upstream, or into the base clone's HEAD when it has no upstream, so a squash-merged branch, or one whose remote-tracking branch was pruned, is kept as well";
  return { ok: false, flag, noRemote, reason: `git branch ${flag} ${t.branch} failed: ${del.stderr.trim()}${why}${moved}${proofNote}` };
}

/**
 * Delete the hook file of the worker (state/workers/<owner>/<name>/<worktree>.jsonl), built by the same
 * `workerFile` the hook script writes with. Does nothing without `stateDir`. A missing file is fine.
 * Returns null, or a note when the delete failed; a failed delete never changes the removal result.
 */
export function deleteHookFile(stateDir, key, t) {
  if (!stateDir) return null;
  const { owner, repoName } = readLeaseKey(key);
  const file = workerFile(stateDir, { owner, repoName, worktree: t.name });
  try {
    fs.rmSync(file, { force: true });
    return null;
  } catch (e) {
    return `hook file ${file} was not deleted: ${e.message}`;
  }
}

/**
 * Remove the worktree, its session and its branch.
 * Returns {status: 'removed'|'branch-kept'|'half-removed'|'refused'|'failed', key, ...}.
 * 'branch-kept': the worktree and session are removed but `git branch -d` refused; `reason` says why.
 * args: {claims, key, reposDir, discard?, requireMerged?, branchRecord?, stateDir?}
 * With `stateDir`, 'removed' (including `nothing: true`) and 'branch-kept' delete the worker's hook file; 'refused',
 * 'half-removed' and 'failed' keep it. A failed delete is a note, not a failure.
 * `branchRecord` ({recordFile, lockFile, config, cache, clock}) turns on the branch record: after the check passes and before
 * `claude rm`, the pushed branch is recorded and the coordinator's own `worktree-<name>` entry for the issue is dropped.
 * The result then carries `branchRecord: {recorded, dropped, warning?}`. Nothing is recorded when `--discard` skips a failed check.
 * `requireMerged` also demands a merged pull request whose head is the tip of the issue branch `worktree-<name>`, found by the
 * remote name of that branch or among the closing pull requests (`closingPrs`, from the cache); see safetyCheck. A detached HEAD
 * does not refuse by itself: it follows the checked-out rule of safetyCheck, and the issue branch still needs its own proof.
 * `defaultBranch` is the repository default branch, used to tell whether the issue branch has commits of its own.
 * `requireClosing` (wrap passes it) counts only a closing pull request of the issue at the tip of a branch with commits of its
 * own (see decideProof).
 * `readIssueRefs` (optional) turns on the nothing-to-lose proof of the check (see safetyCheck); `wrap` passes it, the
 * `worktree remove` command does not. Both checks of one run share its single read.
 * Every result after the check carries `pushedBranch` (the remote name of the issue branch, or null when it is absent), `pr`
 * ({number, state, mergedAt, headSha} or null), `proofs` ([{branch, pr}]: the merged pull requests that proved the work,
 * `[]` when none did) and `otherBranches` ([{branch, tip}]: pushed branches the worktree checked out; they are not deleted).
 * A result after the check also carries `checkedOutBranch`: {branch, tip, kept} when the branch checked out in the worktree is
 * not the issue (or task) branch, else null. `kept` is true or false once the worktree step ran (the branch is still, or no
 * longer, in the base clone, read after the removal; also set on a half-removed result), and null before that. The coordinator
 * does not delete this branch; `claude rm` may, and `kept` reports what happened.
 * The 'failed' result for an unreadable claude agents list comes before the check and carries `pushedBranch` and `pr` as null
 * and `proofs` as `[]`.
 * `deleteWithProof` (default false) lets the branch step use `-D` on the merge proof of the last check (`provenTip`), and adds
 * `branchStep` ('deleted' | 'gone' | 'kept') and `branchFlag` ('-d' | '-D', absent when `gone`) to the 'removed' and 'branch-kept' results.
 * A 'branch-kept' result of that kind also has `noRemote: true` when the merge proof held but no remote-tracking branch contains the tip.
 * A task key (see parseLeaseKey) sets `waiveEmpty` in the check, so a task whose branch has no commits of its own and whose
 * tree is clean is removed without `--discard`; its branch is then deleted with `-D` under the same tip and remote guard.
 * With `deleteWithProof` on a task key, a branch with commits of its own is also deleted with `-D` (remote consent) when its tip
 * is the one the last check judged on the checked-out task branch and `git branch -r --contains <tip>` prints something;
 * otherwise `-d` is used and the reason says why `-D` was not.
 * `consentProvenTip` (default false; `wrap` sets it for an issue) passes the `--discard-unpushed` value that a refused
 * `claude rm` reports back to it once, but only when the value's commit is the issue-branch tip that the merge proof covers
 * (`provenTip`) and that tip is checked out in the worktree (#142). The branch step may then use `-D` without a remote-tracking
 * branch that contains the tip, and a note says what was passed.
 * `--discard` applies to this run only. The commit it was given at is recorded on the claim (`discardHead`)
 * for `finish`; every run without `--discard`, and every refused run, clears it.
 * A removal that ends half-removed because `claude rm` output names EBUSY or EPERM is tried again when `findHolders` finds no
 * holder: up to BUSY_ATTEMPTS attempts in all, waiting BUSY_WAITS_MS[i] ms (through `deps.sleep`) after attempt i + 1. Before
 * each new attempt the worktree is observed again, and the step that is still open is repeated: `claude rm` while git lists the
 * worktree; else the leftover-folder step (see clearLeftover) when the folder holds at most a `.git` file. Anything else stops
 * the retry, and so do a session that runs again and an unreadable `claude agents` list (both add a note). A holder found, or
 * any other failure, ends it at once; a failed holder lookup counts as no holder. The merge proof and the unpushed checks run once.
 * `removalAttempts` (1 to BUSY_ATTEMPTS) is the number of removal attempts; it is on the 'removed', 'branch-kept' and
 * 'half-removed' results. `attempts` still counts the `claude rm` calls.
 */
export async function removeWorktree(deps, { claims, key, reposDir, discard = false, requireMerged = false, requireClosing = false, closingPrs = [], readClosingPrs, readIssueRefs, defaultBranch, branchRecord: br, stateDir, deleteWithProof = false, consentProvenTip = false }) {
  const t = { ...target(reposDir, key), key };
  // The second safety check (a running session) reuses the first live reads instead of asking GitHub again.
  let liveRead = null;
  const readOnce = typeof readClosingPrs === 'function' ? () => (liveRead ??= Promise.resolve(readClosingPrs())) : undefined;
  let refsRead = null;
  const refsOnce = typeof readIssueRefs === 'function' ? () => (refsRead ??= Promise.resolve(readIssueRefs())) : undefined;
  const waiveEmpty = t.kind === 'task';
  const lease = leaseFor(claims, key);
  const priorState = lease?.wtState ?? 'created';
  let info = { pushedBranch: null, pr: null, proofs: [] };
  // `kept` stays null until the worktree step has run; the final results fill it in.
  const infoOf = (c) => ({
    pushedBranch: c.remoteBranch, pr: c.pr, proofs: c.proofs, otherBranches: c.otherBranches,
    checkedOutBranch: c.checkedOutBranch ? { ...c.checkedOutBranch, kept: null } : null,
  });
  // Observed after the removal: whether the checked-out branch is still in the base clone. The coordinator deletes nothing here.
  const withKept = async () => {
    const co = info.checkedOutBranch;
    if (!co) return info;
    const v = await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${co.branch}`], { cwd: t.base });
    return { ...info, checkedOutBranch: { ...co, kept: v.code === 0 } };
  };
  let recorded = null;
  const rec = () => (recorded ? { branchRecord: recorded } : {});
  const refuse = (extra) => {
    setWtState(claims, lease, priorState, { discardHead: null });
    return { status: 'refused', key, path: t.path, ...info, ...rec(), ...extra };
  };
  const o = await observe(deps, t);
  if (o.agentsError) return { status: 'failed', key, pushedBranch: null, pr: null, proofs: [], reason: `cannot read claude agents: ${o.agentsError}` };

  if (!o.session && !o.folder.exists && !o.listed && !o.branchExists && o.dropped.length === 0) {
    setWtState(claims, lease, 'removed', { discardHead: null });
    const hookNote = deleteHookFile(stateDir, key, t);
    const nothing = { status: 'removed', key, nothing: true, pushedBranch: null, pr: null, proofs: [], ...(hookNote ? { notes: [hookNote] } : {}) };
    if (!br) return nothing;
    try {
      return { ...nothing, branchRecord: { recorded: null, dropped: dropOwnEntry(br, t, key).dropped ? t.branch : null } };
    } catch (e) {
      return { ...nothing, branchRecord: { recorded: null, dropped: null, warning: `branch record not written: ${e.message}` } };
    }
  }
  if (o.folder.unsafe) return refuse({ reason: o.folder.unsafe });
  const check = await safetyCheck(deps, t, o, { requireMerged, requireClosing, closingPrs, readClosingPrs: readOnce, readIssueRefs: refsOnce, defaultBranch, waiveEmpty });
  info = infoOf(check);
  if (!discard && !check.safe) {
    const hint = requireMerged ? 'merge the pull request first' : 'push the branch, or pass --discard';
    return refuse({ problems: check.problems, reason: `${check.problems.join('; ')}; ${hint}` });
  }
  // A registered worktree whose session is gone is removed with git, after the same check (#143, #126; see the decision
  // record "Remove a worktree whose session is gone with git, after the same checks").
  const orphan = !o.session && o.listed && o.folder.exists;
  if (!o.session && !orphan) {
    return refuse({ reason: `no session is listed for ${t.name}; if the folder is left over, run gvt-fleet worktree finish ${key}` });
  }
  if (orphan && !check.safe) {
    return refuse({ problems: check.problems, reason: `${check.problems.join('; ')}; no session is listed for ${t.name}, and a worktree with no session is removed only when nothing would be lost, also with --discard` });
  }
  if (orphan) {
    const link = firstLinkIn(t.path);
    if (link) return refuse({ reason: `${link.reason}; a worktree with no session is removed only when it holds no link, so nothing was removed` });
  }
  const id = orphan ? null : sessionIdOf(o, lease);
  setWtState(claims, lease, 'removing', { discardHead: discard ? check.head : null });

  let latest = check;
  const notes = [];
  // The removal step: `claude rm` of the session, or, with no session, `git worktree remove` of the unlocked entry.
  // git refuses a worktree with a submodule checked out unless forced; the check above takes the place of its own.
  const label = orphan ? 'git worktree remove' : 'claude rm';
  const removeStep = orphan
    ? async () => {
        const r = await deps.git.run(['worktree', 'remove', ...(check.submodules > 0 ? ['--force'] : []), t.path], { cwd: t.base });
        return { res: r, attempts: 0, usedDiscard: false, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
      }
    : () => rmSession(deps, id, discard);
  if (orphan && o.locked !== null) {
    const u = await unlockStale(deps, t, o.locked);
    if (u.error) return refuse({ reason: `${u.error}; nothing was removed`, notes });
    notes.push(u.note);
  }
  if (o.running) {
    try {
      await deps.claude.stop(id);
    } catch (e) {
      notes.push(`claude stop failed: ${e.message}`);
    }
    // A running session can commit between the check and the stop.
    if (!discard) {
      const again = await safetyCheck(deps, t, o, { requireMerged, requireClosing, closingPrs, readClosingPrs: readOnce, readIssueRefs: refsOnce, defaultBranch, waiveEmpty });
      info = infoOf(again);
      latest = again;
      if (!again.safe) {
        const hint = requireMerged ? 'merge the pull request first' : 'push the branch, or pass --discard';
        return refuse({ problems: again.problems, notes, reason: `${again.problems.join('; ')} (found after the session was stopped; it is stopped, nothing was removed); ${hint}` });
      }
    }
  }
  if (br && latest.safe) recorded = await recordPushedBranch(deps, t, key, latest, br);
  const rm = await removeStep();
  let { res, attempts, usedDiscard, output } = rm;

  // A lock that outlived the lock retries, while the session is not live, names a process that is not this worker: its pid
  // can have been reused by any program (#126). It is removed as stale, and `claude rm` runs once more.
  if (!orphan && res.code !== 0 && LOCK_ERROR(output)) {
    const o3 = await observe(deps, t);
    if (!o3.agentsError && !o3.running && o3.listed && o3.locked !== null) {
      const u = await unlockStale(deps, t, o3.locked);
      if (u.error) {
        notes.push(u.error);
      } else {
        notes.push(u.note);
        const again = await removeStep();
        ({ res, usedDiscard, output } = again);
        attempts += again.attempts;
      }
    }
  }

  // The proven-tip consent (#142, decision record 0026): GitHub deletes a pull request's head branch when it merges, so claude rm
  // can read a merged tip as unpushed. When the value it reports names exactly the issue-branch tip that a merged pull request
  // has as its head, checked out in the worktree, wrap passes that value back once. Any other commit gets no consent.
  let provenDiscard = false;
  if (consentProvenTip && !orphan && !discard && res.code !== 0 && latest.provenTip) {
    const value = parseDiscardValue(output);
    const sha = value?.split('@')[0] ?? '';
    const tip = latest.provenTip;
    if (sha.length >= 7 && tip.startsWith(sha) && latest.current === t.branch && latest.head === tip) {
      const again = await rmWithRetry(deps, id, { discardUnpushed: value });
      res = again.res;
      attempts += again.attempts;
      output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      usedDiscard = true;
      provenDiscard = res.code === 0;
      const number = (latest.proofs ?? []).find((p) => p.pr?.headSha === tip || p.pr?.head?.sha === tip)?.pr?.number ?? latest.pr?.number;
      notes.push(`claude rm read ${short7(tip)} as unpushed; it is the head of merged pull request ${number !== undefined ? `#${number}` : 'that proved the work'}, so wrap passed --discard-unpushed ${value} for that commit only`);
    }
  }

  let after = await observe(deps, t);
  if (after.agentsError) notes.push(`cannot re-read claude agents: ${after.agentsError}`);
  const isHalf = () => (after.folder.exists && !after.listed ? true : res.code !== 0 && halfFailedText(output));
  let removalAttempts = 1;
  let transient = res.code !== 0 && BUSY_TEXT.test(output);
  let holders = null;
  while (isHalf()) {
    holders = await deps.findHolders(t.path);
    if (holders.holders.length > 0 || !transient || removalAttempts >= BUSY_ATTEMPTS) break;
    await deps.sleep(busyWait(removalAttempts));
    const o2 = await observe(deps, t);
    if (o2.agentsError) {
      notes.push(`cannot re-read claude agents: ${o2.agentsError}`);
      break;
    }
    // A session that runs again was not stopped and checked for this attempt: stop the retry.
    if (o2.running) {
      notes.push(`the session for ${t.name} is running again; the removal was not retried`);
      break;
    }
    removalAttempts += 1;
    transient = false;
    if (o2.listed) {
      // git still lists the worktree: the same `claude rm` is still the open step.
      const again = await removeStep();
      res = again.res;
      attempts += again.attempts;
      usedDiscard = usedDiscard || again.usedDiscard;
      output = again.output;
      transient = res.code !== 0 && BUSY_TEXT.test(output);
    } else if (isLeftoverFolder(o2.folder)) {
      // git no longer lists it: only the leftover folder (and perhaps the session) is open.
      const step = await clearLeftover(deps, t, o2, { lease, consent: discard, steps: {} });
      notes.push(...(step.notes ?? []));
      if (step.kind === 'failed') return { status: 'failed', key, removalAttempts, reason: step.reason, notes, ...info, ...rec() };
      res = step.kind === 'ok' ? OK_RM : { code: 1, stdout: '', stderr: '' };
      output = step.kind === 'held' ? `${t.path} is still held (${step.code})` : step.kind === 'refused' ? step.output : '';
      attempts += step.attempts ?? 0;
      transient = step.kind === 'held' && BUSY_CODES.has(step.code);
    } else {
      break;
    }
    after = await observe(deps, t);
    if (after.agentsError) notes.push(`cannot re-read claude agents: ${after.agentsError}`);
  }
  if (isHalf()) {
    setWtState(claims, lease, 'half-removed');
    return {
      status: 'half-removed', key, path: t.path, folder: t.path, attempts, removalAttempts, output, holders: holders.holders, holderSource: holders.source,
      hint: holdersHint(holders.holders, `gvt-fleet worktree finish ${key}`), notes, ...(await withKept()), ...rec(),
    };
  }
  if (res.code !== 0) return refuse({ attempts, output, reason: `${label} refused: ${output}`, notes });
  if (after.folder.exists || after.listed) {
    return refuse({ attempts, output, reason: `${label} reported success but the worktree is still there`, notes });
  }
  let branchKept = null;
  let branchStep = 'gone';
  let branchFlag;
  let noRemote = false;
  if (after.branchExists) {
    const discardHead = discard ? check.head : null;
    const proofOpts = deleteWithProof || waiveEmpty
      ? { provenTip: latest.provenTip ?? null, proofOnlyOther: !latest.provenTip && (latest.proofs ?? []).length > 0 }
      : {};
    // Remote consent: the wrap of a task (deleteWithProof and waiveEmpty) may delete a branch that a remote-tracking branch contains.
    const remoteOpts = deleteWithProof && waiveEmpty ? { remote: { tip: latest.current === t.branch ? latest.tip ?? null : null } } : {};
    const del = await deleteBranch(deps, t, { discardHead, ...proofOpts, ...remoteOpts, pullHeadKeeps: provenDiscard });
    branchFlag = del.flag;
    branchStep = del.ok ? 'deleted' : 'kept';
    if (!del.ok) {
      branchKept = del.reason;
      noRemote = del.noRemote;
    }
  }
  const branchInfo = deleteWithProof ? { branchStep, ...(branchFlag ? { branchFlag } : {}), ...(noRemote ? { noRemote } : {}) } : {};
  setWtState(claims, lease, 'removed', { discardHead: null });
  const hookNote = deleteHookFile(stateDir, key, t);
  if (hookNote) notes.push(hookNote);
  info = await withKept();
  if (branchKept) {
    // The worktree and the session are gone; only the branch is left. `finish` retries the branch step.
    return { status: 'branch-kept', key, attempts, removalAttempts, usedDiscard, notes, ...info, branch: t.branch, ...branchInfo, ...rec(), reason: `the worktree is removed but the branch ${t.branch} was kept: ${branchKept}` };
  }
  return { status: 'removed', key, attempts, removalAttempts, usedDiscard, notes, ...info, ...branchInfo, ...rec() };
}

// ---- finish ----

const HOLD_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/** True when the observed folder is gone, or holds at most a `.git` file: the only state `finish` deletes. */
function isLeftoverFolder(folder) {
  if (!folder.exists) return true;
  if (folder.unsafe) return false;
  return folder.entries.every((e) => e === '.git') && (!folder.entries.includes('.git') || folder.gitIsFile);
}

/**
 * The leftover-folder step shared by `finish` and the retry in `removeWorktree`, from an observation `o` of a worktree that
 * git does not list: delete the folder, `claude rm` the session if it is still listed, and `git worktree prune`.
 * Records what it did in `steps`. Returns {kind: 'ok'} | {kind: 'held', code} (the folder delete failed with a hold code;
 * other codes throw) | {kind: 'refused', attempts, output} (`claude rm` failed) | {kind: 'failed', reason} (prune failed).
 * 'ok', 'refused' and 'failed' also carry `attempts`: the number of `claude rm` calls made (0 when the session was not listed).
 * A listed entry that is locked is unlocked before the prune, which skips a locked entry; 'ok' and a failed prune then carry
 * `notes` with the lock that was removed.
 */
async function clearLeftover(deps, t, o, { lease, consent, steps }) {
  const notes = [];
  if (o.folder.exists) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
    } catch (e) {
      if (!HOLD_CODES.has(e.code)) throw e;
      return { kind: 'held', code: e.code };
    }
    steps.folder = 'deleted';
  }
  let attempts = 0;
  if (o.session) {
    const rm = await rmSession(deps, sessionIdOf(o, lease), consent);
    attempts = rm.attempts;
    if (rm.res.code !== 0) return { kind: 'refused', attempts, output: rm.output };
    steps.rm = 'done';
  }
  if (o.dropped.length > 0 || steps.folder === 'deleted' || (o.listed && !o.folder.exists)) {
    // `git worktree prune` skips a locked entry. No session of this worktree runs on this path (finish refuses a running
    // one), so the lock is stale (#143).
    if (o.listed && o.locked !== null && !o.running) {
      const u = await unlockStale(deps, t, o.locked);
      if (u.error) return { kind: 'failed', attempts, reason: u.error };
      notes.push(u.note);
    }
    const prune = await deps.git.run(['worktree', 'prune'], { cwd: t.base });
    if (prune.code !== 0) return { kind: 'failed', attempts, notes, reason: `git worktree prune failed: ${prune.stderr.trim()}` };
    steps.prune = 'done';
  }
  return { kind: 'ok', attempts, notes };
}

/**
 * Finish a half-failed removal. Each sub-step is skipped when the observation shows it is done.
 * Returns {status: 'removed'|'held'|'refused'|'branch-kept'|'failed', key, steps, ...}.
 * args: {claims, key, reposDir, stateDir?, provenTip?, noDiscard?}
 * `noDiscard` (default false) ignores the discard consent recorded on the claim: `claude rm` gets no discard value and the
 * branch delete gets no discard commit. `wrap` sets it.
 * `provenTip` (default null) is passed to the branch delete as the merge-proof consent; when the option is passed at all, the
 * result gains `branchStep` ('deleted' | 'gone' | 'kept') and `branchFlag` ('-d' | '-D', absent when `gone`), and `noRemote: true`
 * on a 'branch-kept' result when the merge proof held but no remote-tracking branch contains the tip.
 * With `stateDir`, 'removed' deletes the worker's hook file (a failed delete adds `notes`); every other status keeps it.
 * A folder delete that fails with EBUSY or EPERM is tried again when `findHolders` finds no holder: up to BUSY_ATTEMPTS attempts
 * in all, waiting BUSY_WAITS_MS[i] ms (through `deps.sleep`) after attempt i + 1. A holder found, or ENOTEMPTY or EACCES, gives
 * 'held' at once. Before each new attempt the worktree is observed again; when the folder is no longer a leftover (see
 * isLeftoverFolder), git lists it, or the session runs, the result is 'refused' and nothing is deleted.
 * `removalAttempts` (1 to BUSY_ATTEMPTS) is the number of attempts; it is on the 'removed', 'branch-kept' and 'held' results.
 */
export async function finishWorktree(deps, { claims, key, reposDir, stateDir, provenTip, noDiscard = false }) {
  const withProof = provenTip !== undefined;
  const t ={ ...target(reposDir, key), key };
  const lease = leaseFor(claims, key);
  let o = await observe(deps, t);
  if (o.agentsError) return { status: 'failed', key, reason: `cannot read claude agents: ${o.agentsError}` };
  const steps = { folder: 'skipped', rm: 'skipped', prune: 'skipped', branch: 'skipped' };
  if (o.running) {
    return { status: 'refused', key, path: t.path, steps, reason: `the session for ${t.name} is still running; run gvt-fleet worktree remove ${key} first` };
  }
  if (o.folder.unsafe) return { status: 'refused', key, path: t.path, steps, reason: o.folder.unsafe };
  // The discard consent holds only while the branch is still at the commit it was given at.
  // `noDiscard` (set by `wrap`) ignores a consent left on the claim by an earlier `remove --discard`.
  const discardHead = noDiscard ? null : (lease?.discardHead ?? null);
  const consentNow = Boolean(discardHead) && (await tipOf(deps, t)) === discardHead;

  if (o.folder.exists) {
    const extra = o.folder.entries.filter((e) => e !== '.git');
    if (extra.length > 0 || (o.folder.entries.includes('.git') && !o.folder.gitIsFile)) {
      return { status: 'refused', key, path: t.path, steps, extra, reason: `${t.path} holds more than a .git file (${o.folder.entries.join(', ')}); finish deletes nothing else` };
    }
    if (o.listed) {
      return { status: 'refused', key, path: t.path, steps, reason: `git still lists ${t.path} as a worktree; use gvt-fleet worktree remove ${key}` };
    }
  }

  let removalAttempts = 0;
  const leftNotes = [];
  const notesOf = (more = []) => (leftNotes.length + more.length > 0 ? { notes: [...leftNotes, ...more] } : {});
  for (;;) {
    removalAttempts += 1;
    const step = await clearLeftover(deps, t, o, { lease, consent: consentNow, steps });
    leftNotes.push(...(step.notes ?? []));
    if (step.kind === 'ok') break;
    if (step.kind === 'refused') return { status: 'refused', key, path: t.path, steps, attempts: step.attempts, reason: `claude rm refused: ${step.output}` };
    if (step.kind === 'failed') return { status: 'failed', key, steps, reason: step.reason, ...notesOf() };
    const holders = await deps.findHolders(t.path);
    if (holders.holders.length === 0 && BUSY_CODES.has(step.code) && removalAttempts < BUSY_ATTEMPTS) {
      await deps.sleep(busyWait(removalAttempts));
      // Delete again only while the folder is still the leftover that the checks above allowed.
      o = await observe(deps, t);
      if (o.agentsError) return { status: 'failed', key, steps, removalAttempts, reason: `cannot re-read claude agents: ${o.agentsError}` };
      if (o.running || o.listed || !isLeftoverFolder(o.folder)) {
        return { status: 'refused', key, path: t.path, steps, removalAttempts, reason: `${t.path} changed while finish waited to delete it again; run gvt-fleet worktree finish ${key} again` };
      }
      continue;
    }
    return {
      status: 'held', key, path: t.path, steps, removalAttempts, reason: `${t.path} is still held (${step.code})`,
      holders: holders.holders, holderSource: holders.source, hint: holdersHint(holders.holders, `gvt-fleet worktree finish ${key}`),
    };
  }

  let branchInfo = withProof ? { branchStep: 'gone' } : {};
  if ((await tipOf(deps, t)) !== null) {
    const del = await deleteBranch(deps, t, { discardHead, provenTip: provenTip ?? null });
    if (withProof) branchInfo = { branchStep: del.ok ? 'deleted' : 'kept', branchFlag: del.flag, ...(del.noRemote ? { noRemote: true } : {}) };
    if (!del.ok) return { status: 'branch-kept', key, steps, removalAttempts, ...branchInfo, ...notesOf(), reason: del.reason };
    steps.branch = 'deleted';
  }
  setWtState(claims, lease, 'removed', { discardHead: null });
  const hookNote = deleteHookFile(stateDir, key, t);
  return { status: 'removed', key, steps, removalAttempts, ...branchInfo, ...notesOf(hookNote ? [hookNote] : []) };
}

// ---- likely holders ----

/**
 * Programs that likely hold `folder` open. Uses handle64 when it resolves on PATH and exits 0 with
 * matches, else the running Code.exe and GitExtensions.exe processes from tasklist.
 * Returns {source: 'handle64'|'tasklist'|'none', holders: [{process, pid}], error?}.
 */
export function createFindHolders({ run, resolve = resolveExe }) {
  return async function findHolders(folder) {
    let exe = null;
    try {
      exe = resolve('handle64');
    } catch {
      exe = null;
    }
    if (exe) {
      try {
        const res = await run([exe, '-accepteula', '-nobanner', folder], { timeoutMs: 20000 });
        const holders = [];
        if (res.code === 0) {
          for (const line of res.stdout.split(/\r?\n/)) {
            const m = /^(\S+)\s+pid:\s*(\d+)/i.exec(line.trim());
            if (m) holders.push({ process: m[1], pid: Number(m[2]) });
          }
        }
        if (holders.length > 0) return { source: 'handle64', holders };
      } catch {
        // fall through to the process list
      }
    }
    try {
      const res = await run([resolve('tasklist'), '/FO', 'CSV', '/NH'], { timeoutMs: 20000 });
      if (res.code !== 0) return { source: 'none', holders: [], error: `tasklist exited ${res.code}: ${res.stderr.trim()}` };
      const holders = [];
      for (const line of res.stdout.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && HOLDER_PROCESSES.includes(m[1].toLowerCase())) holders.push({ process: m[1], pid: Number(m[2]) });
      }
      return { source: 'tasklist', holders };
    } catch (e) {
      return { source: 'none', holders: [], error: e.message };
    }
  };
}
