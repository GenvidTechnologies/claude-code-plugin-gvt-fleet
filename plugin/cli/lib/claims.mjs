// Claims: the local lease plus the GitHub label and assignee that mark an issue as taken.
// Order of a claim: local row `claiming`, fresh read and readiness, label, granular adds,
// readback, then `held`. gh, claude and the clock are injected.

import { randomUUID } from 'node:crypto';
import { effectiveRepoSettings, repoShortName, resolveRepoArg } from './config.mjs';
import { buildGraph } from './graph.mjs';
import {
  ensureLabel,
  isNotFound,
  issuePath,
  labelNames,
} from './labels.mjs';
import { computeReady } from './ready.mjs';
import { isLive, matchSessions, pickSession } from './sessions.mjs';
import { applyOverlays, ISSUE_QUERY, issueNodeToRow } from './sync.mjs';
import { target } from './worktrees.mjs';
import { parseLeaseKey, taskKey } from './worker-key.mjs';

const lower = (s) => String(s ?? '').toLowerCase();
const FULL_REF_RE = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
const NAME_REF_RE = /^([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

export class ClaimError extends Error {
  constructor(message, exitCode = 64) {
    super(message);
    this.name = 'ClaimError';
    this.exitCode = exitCode;
  }
}

/** Read `owner/name#N` or `short#N` into {repo, number, key}. The repo must be in the config. */
export function parseClaimRef(arg, config) {
  const repos = config.repos ?? [];
  if (TASK_REF_RE.test(arg ?? '')) throw new ClaimError(`"${arg}" is a task, not an issue reference`);
  const full = FULL_REF_RE.exec(arg ?? '');
  const named = full ? null : NAME_REF_RE.exec(arg ?? '');
  if (!full && !named) throw new ClaimError(`cannot read "${arg}" as an issue reference (use name#N or owner/repo#N)`);
  let entry;
  if (full) {
    entry = repos.find((e) => lower(e.repo) === lower(full[1]));
    if (!entry) throw new ClaimError(`${full[1]} is not in the config`);
  } else {
    const matches = repos.filter((e) => lower(repoShortName(e.repo, config)) === lower(named[1]));
    if (matches.length !== 1) throw new ClaimError(`"${named[1]}" is not a configured short name`);
    entry = matches[0];
  }
  const number = Number((full ?? named)[2]);
  return { repo: entry.repo, number, key: `${entry.repo}#${number}` };
}

const TASK_REF_RE = /^([^@#\s]+)@([a-z0-9]+(?:-[a-z0-9]+)*)\.([0-9]{8})\.([1-9][0-9]*)$/;

/**
 * Read a worker reference. A task ref (`short@slug.YYYYMMDD.n` or `owner/name@slug.YYYYMMDD.n`) gives
 * {repo, key, kind: 'task', slug, date, n}; the repo must be in the config. Anything else is read by
 * parseClaimRef and gives its {repo, number, key}.
 */
export function parseWorkerRef(arg, config) {
  const m = TASK_REF_RE.exec(arg ?? '');
  if (!m) return parseClaimRef(arg, config);
  const entry = resolveRepoArg(m[1], config);
  if (!entry) throw new ClaimError(`${m[1]} is not in the config`);
  return { repo: entry.repo, key: taskKey(entry.repo, { slug: m[2], date: m[3], n: Number(m[4]) }), kind: 'task', slug: m[2], date: m[3], n: Number(m[4]) };
}

function settingsFor(config, repo) {
  const entry = (config.repos ?? []).find((e) => lower(e.repo) === lower(repo)) ?? { repo };
  return effectiveRepoSettings(entry);
}

const assigneeLogins = (data) => (data?.assignees ?? []).map((a) => (typeof a === 'string' ? a : a.login));
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000).toISOString();

async function freshRow(gh, config, repo, number) {
  const [owner, name] = repo.split('/');
  const res = await gh.graphql(ISSUE_QUERY, { owner, name, number });
  const node = res.data?.repository?.issue;
  if (!node) {
    const why = (res.errors ?? []).map((e) => e.message).join('; ');
    throw new ClaimError(`${repo}#${number}: cannot read the issue${why ? `: ${why}` : ''}`, 1);
  }
  if (node.labels.pageInfo?.hasNextPage || node.assignees.pageInfo?.hasNextPage) {
    throw new ClaimError(`${repo}#${number}: more labels or assignees than one page; cannot judge readiness`, 1);
  }
  const canon = new Map((config.repos ?? []).map((e) => [lower(e.repo), e.repo]));
  return issueNodeToRow(repo, node, (nwo, n) => `${canon.get(lower(nwo)) ?? nwo}#${n}`);
}

/**
 * Claim one issue.
 * @returns {Promise<{status: 'held'|'noop'|'refused'|'failed', key: string, leaseId?: string, reasons?: object[], reason?: string, contention?: string[]}>}
 */
export async function claimIssue({ gh, clock, config: rawConfig }, { claims, cache, key, extract, branchRecord = {}, sessionId = null }) {
  const config = applyOverlays(rawConfig, cache);
  const { repo, number } = parseClaimRef(key, config);
  const settings = settingsFor(config, repo);
  const account = config.claimAccount;
  if (!account) throw new ClaimError('claimAccount is not set in the config', 2);
  const leaseMs = (config.leaseMinutes ?? 120);
  const now0 = clock.now();

  // Step 1: the local row. The lease row is reused when one is claiming, held-but-expired or failed.
  const step1 = claims.immediate(() => {
    const active = claims.getActiveLease(key);
    if (active?.state === 'held' && Date.parse(active.expiresAt) > now0.getTime()) return { noop: active };
    if (active?.state === 'releasing') return { busy: active };
    const failed = active ? null : claims.listLeases({ states: ['failed'] }).filter((l) => l.key === key).at(-1);
    const row = active ?? failed ?? null;
    const leaseId = row?.leaseId ?? randomUUID();
    if (row) {
      // An old session id belongs to the old claim. The two flags stay as they are: they describe GitHub.
      // claimedAt restarts so that expire can tell this claim from a stale `claiming` row.
      claims.updateLease(leaseId, { state: 'claiming', sessionId, shortId: null, claimedAt: now0.toISOString(), heartbeatAt: null });
    } else {
      // assigneePreexisting and labelAdded stay NULL (unknown) until step 4 decides them.
      claims.putLease({ leaseId, key, state: 'claiming', claimedAt: now0.toISOString(), sessionId });
    }
    return { leaseId, reused: row !== null, flags: row ? { assigneePreexisting: row.assigneePreexisting, labelAdded: row.labelAdded } : {} };
  });
  if (step1.noop) return { status: 'noop', key, leaseId: step1.noop.leaseId, expiresAt: step1.noop.expiresAt };
  if (step1.busy) return { status: 'refused', key, reasons: [{ code: 'releasing', detail: `a release did not finish; run gvt-fleet release ${key}` }] };
  const { leaseId, reused, flags } = step1;

  const fail = (reason, extra = {}) => {
    claims.immediate(() => claims.updateLease(leaseId, { state: 'failed' }));
    return { status: 'failed', key, leaseId, reason, ...extra };
  };

  try {
    // Step 2: fresh read, then the one readiness implementation.
    const fresh = await freshRow(gh, config, repo, number);
    const others = cache.readIssues().filter((r) => lower(r.key) !== lower(key));
    const rows = [...others, fresh];
    const graph = buildGraph(rows, { extract: extract ?? (() => ({ refs: [] })), config });
    const claimsHeld = claims.listLeases({ states: ['held'] });
    const entry = computeReady({ issues: rows, graph, claims: claimsHeld, branchRecord, config, now: clock.now(), extract }).find((e) => lower(e.key) === lower(key));
    const ownedByUs = fresh.labels.includes(settings.inProgressLabel) && fresh.assignees.some((a) => lower(a) === lower(account));
    const reasons = entry.reasons.filter((r) => !(r.code === 'in-progress-label' && reused && ownedByUs));
    if (reasons.length > 0) {
      claims.immediate(() => claims.updateLease(leaseId, { state: 'failed' }));
      return { status: 'refused', key, leaseId, reasons };
    }
    const hadAssignee = fresh.assignees.some((a) => lower(a) === lower(account));

    // Step 3: the label exists.
    if (!(await ensureLabel(gh, repo, settings.inProgressLabel))) return fail(`label ${settings.inProgressLabel} is missing after create`);

    // Step 4: granular adds, after both flags are on disk. A flag that is already decided is kept:
    // after a crash GitHub shows our own earlier write, which would read as pre-existing.
    const decided = {};
    if (flags.assigneePreexisting == null) decided.assigneePreexisting = hadAssignee;
    if (flags.labelAdded == null) decided.labelAdded = !fresh.labels.includes(settings.inProgressLabel);
    if (Object.keys(decided).length > 0) claims.immediate(() => claims.updateLease(leaseId, decided));
    await gh.rest('POST', `${issuePath(repo, number)}/labels`, { labels: [settings.inProgressLabel] });
    await gh.rest('POST', `${issuePath(repo, number)}/assignees`, { assignees: [account] });

    // Step 5: readback.
    const back = (await gh.rest('GET', issuePath(repo, number))).data;
    const missing = [];
    if (!labelNames(back).includes(settings.inProgressLabel)) missing.push(`label ${settings.inProgressLabel}`);
    if (!assigneeLogins(back).some((a) => lower(a) === lower(account))) missing.push(`assignee ${account}`);
    if (missing.length > 0) return fail(`readback lacks ${missing.join(' and ')}`);
    const contention = assigneeLogins(back).filter((a) => lower(a) !== lower(account) && !fresh.assignees.some((b) => lower(b) === lower(a)));

    // Step 6: held.
    const now = clock.now();
    claims.immediate(() =>
      claims.updateLease(leaseId, { state: 'held', claimedAt: now.toISOString(), heartbeatAt: now.toISOString(), expiresAt: addMinutes(now, leaseMs) }),
    );
    const out = { status: 'held', key, leaseId, expiresAt: addMinutes(now, leaseMs) };
    if (contention.length > 0) out.contention = contention;
    return out;
  } catch (e) {
    // A throw leaves the row `claiming` if nothing else did; a re-run starts again at step 2.
    const failed = fail(e.message);
    if (e instanceof ClaimError) throw e;
    return failed;
  }
}

/**
 * Undo what the claim added, read back, set `released`. The label is deleted only when the claim added it
 * (`labelAdded`), the assignee only when it was not there before (`assigneePreexisting === false`). A flag
 * that is still unknown means the claim never reached the GitHub writes, so nothing is removed.
 * `stillDue(row)` is checked under the write lock; a row that no longer qualifies is skipped.
 * Returns {status: 'released'}, {status: 'failed', reason} or {status: 'skipped'}.
 */
async function releaseRow({ gh, config }, { claims, lease, stillDue = () => true }) {
  const { repo, number } = parseClaimRef(lease.key, config);
  const settings = settingsFor(config, repo);
  const account = config.claimAccount;
  const row = claims.immediate(() => {
    const current = claims.getLease(lease.leaseId);
    if (!current || !stillDue(current)) return null;
    claims.updateLease(lease.leaseId, { state: 'releasing' });
    return current;
  });
  if (!row) return { status: 'skipped', key: lease.key };
  const dropLabel = row.labelAdded === true;
  const dropAssignee = row.assigneePreexisting === false;
  if (dropLabel || dropAssignee) {
    try {
      const deletes = [];
      if (dropLabel) deletes.push([`${issuePath(repo, number)}/labels/${encodeURIComponent(settings.inProgressLabel)}`, undefined]);
      if (dropAssignee) deletes.push([`${issuePath(repo, number)}/assignees`, { assignees: [account] }]);
      for (const [path, body] of deletes) {
        try {
          await gh.rest('DELETE', path, body);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }
      const back = (await gh.rest('GET', issuePath(repo, number))).data;
      const left = [];
      if (dropLabel && labelNames(back).includes(settings.inProgressLabel)) left.push(`label ${settings.inProgressLabel}`);
      if (dropAssignee && assigneeLogins(back).some((a) => lower(a) === lower(account))) left.push(`assignee ${account}`);
      if (left.length > 0) return { status: 'failed', key: lease.key, reason: `readback still shows ${left.join(' and ')}` };
    } catch (e) {
      return { status: 'failed', key: lease.key, reason: e.message };
    }
  }
  claims.immediate(() => claims.updateLease(lease.leaseId, { state: 'released' }));
  return { status: 'released', key: lease.key, leaseId: lease.leaseId, labelKept: !dropLabel, assigneeKept: !dropAssignee };
}

/**
 * Release a task lease. A task lease has no label and no assignee, so this makes no GitHub call: the
 * active lease goes straight to `released`. `stillDue(row)` is checked under the write lock.
 */
function releaseTask({ claims, lease, stillDue = () => true }) {
  const done = claims.immediate(() => {
    const current = claims.getLease(lease.leaseId);
    if (!current || !stillDue(current)) return false;
    claims.updateLease(lease.leaseId, { state: 'released' });
    return true;
  });
  if (!done) return { status: 'skipped', key: lease.key };
  return { status: 'released', key: lease.key, leaseId: lease.leaseId, labelKept: true, assigneeKept: true };
}

/** Release the claim of one issue or one task on demand. A `releasing` row left by an earlier failure is retried. */
export async function releaseClaim({ gh, clock, config: rawConfig }, { claims, cache, key }) {
  const config = applyOverlays(rawConfig, cache);
  const ref = parseWorkerRef(key, config);
  const lease =
    claims.getActiveLease(ref.key) ?? claims.listLeases({ states: ['failed'] }).filter((l) => l.key === ref.key).at(-1) ?? null;
  if (!lease) return { status: 'none', key: ref.key };
  if (ref.kind === 'task') return releaseTask({ claims, lease });
  return releaseRow({ gh, config }, { claims, lease });
}

/** Refresh heartbeat and expiry of a held lease (an issue or a task). */
export function heartbeatClaim({ clock, config }, { claims, key }) {
  const ref = parseWorkerRef(key, config);
  const now = clock.now();
  return claims.immediate(() => {
    const lease = claims.getActiveLease(ref.key);
    if (lease?.state !== 'held') return { status: 'none', key: ref.key };
    if (Date.parse(lease.expiresAt) <= now.getTime()) return { status: 'expired', key: ref.key, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
    const expiresAt = addMinutes(now, config.leaseMinutes ?? 120);
    claims.updateLease(lease.leaseId, { heartbeatAt: now.toISOString(), expiresAt });
    return { status: 'refreshed', key: ref.key, leaseId: lease.leaseId, expiresAt };
  });
}

const hasResidue = (l) => l.labelAdded === true || l.assigneePreexisting === false;

// The match query for a lease: its session id, plus the worktree name in the base clone when `reposDir` is given.
function leaseWorker(lease, reposDir) {
  const query = { sessionId: lease.sessionId ?? null };
  if (reposDir) {
    const t = target(reposDir, lease.key);
    query.name = t.name;
    query.base = t.base;
  }
  return query;
}

/**
 * Held leases past their expiry are refreshed when their worker is live, and released otherwise.
 * A worker is live when `claude agents` lists its session (matched by session id, or by worktree name in the base clone
 * when `reposDir` is passed) and the state is not done, failed or stopped. A `releasing` row (an earlier release failed) and a `failed` row that wrote to GitHub
 * are released without the session check. A `claiming` row whose start or heartbeat is older than the lease length
 * is residue of a process that died mid-claim; it is released the same way. A younger `claiming` row is left alone,
 * because another process may be mid-claim. When the session list cannot be read, held leases are left alone.
 */
export async function expireClaims({ gh, claude, clock, config: rawConfig }, { claims, cache, reposDir = null }) {
  const config = applyOverlays(rawConfig, cache);
  const now = clock.now();
  const nowMs = now.getTime();
  const leaseMs = (config.leaseMinutes ?? 120) * 60 * 1000;
  const staleClaiming = (l) => {
    const last = Math.max(Date.parse(l.claimedAt ?? '') || 0, Date.parse(l.heartbeatAt ?? '') || 0);
    return nowMs - last > leaseMs;
  };
  const all = claims.listLeases({ states: ['held', 'releasing', 'failed', 'claiming'] });
  const heldDue = all.filter((l) => l.state === 'held' && Date.parse(l.expiresAt) <= nowMs);
  const retry = all.filter(
    (l) => l.state === 'releasing' || (l.state === 'failed' && hasResidue(l)) || (l.state === 'claiming' && staleClaiming(l)),
  );
  const out = { refreshed: [], released: [], failed: [] };
  const finish = (lease, r) => {
    if (r.status === 'released') out.released.push({ key: lease.key });
    else if (r.status === 'failed') out.failed.push({ key: lease.key, reason: r.reason });
  };
  for (const lease of retry) {
    const kind = parseLeaseKey(lease.key)?.kind;
    if (kind !== 'issue' && kind !== 'task') {
      out.failed.push({ key: lease.key, reason: 'cannot read lease key' });
      continue;
    }
    if (kind === 'task') {
      finish(lease, releaseTask({ claims, lease, stillDue: (l) => l.state === lease.state }));
      continue;
    }
    finish(lease, await releaseRow({ gh, config }, { claims, lease, stillDue: (l) => l.state === lease.state && (l.state !== 'claiming' || staleClaiming(l)) }));
  }
  if (heldDue.length === 0) return out;
  let agents;
  try {
    agents = await claude.agents({ all: true });
  } catch (e) {
    for (const l of heldDue) out.failed.push({ key: l.key, reason: `cannot read claude agents: ${e.message}` });
    return out;
  }
  const dueNow = (l) => l.state === 'held' && Date.parse(l.expiresAt) <= nowMs;
  for (const lease of heldDue) {
    const kind = parseLeaseKey(lease.key)?.kind;
    if (kind !== 'issue' && kind !== 'task') {
      out.failed.push({ key: lease.key, reason: 'cannot read lease key' });
      continue;
    }
    const live = isLive(pickSession(matchSessions(agents, leaseWorker(lease, reposDir))));
    if (live) {
      const refreshed = claims.immediate(() => {
        const current = claims.getLease(lease.leaseId);
        if (!current || !dueNow(current)) return false;
        claims.updateLease(lease.leaseId, { heartbeatAt: now.toISOString(), expiresAt: addMinutes(now, config.leaseMinutes ?? 120) });
        return true;
      });
      if (refreshed) out.refreshed.push({ key: lease.key });
      continue;
    }
    if (kind === 'task') finish(lease, releaseTask({ claims, lease, stillDue: dueNow }));
    else finish(lease, await releaseRow({ gh, config }, { claims, lease, stillDue: dueNow }));
  }
  return out;
}
