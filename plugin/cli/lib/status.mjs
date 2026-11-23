// The worker join behind `status`: leases, `claude agents` entries and hook worker files, joined by
// worker identity (repo, worktree name), compared in lowercase. Pure: no I/O, no clock reads.
import path from 'node:path';
import { isLive, matchSessions, pickSession } from './sessions.mjs';
import { classifySession } from './worker-state.mjs';
import { parseWorktreeCwd } from './worktree-path.mjs';
import { parseLeaseKey, parseTaskWorktreeName, taskNames } from './worker-key.mjs';
import { names, splitKey } from './worktrees.mjs';

export const MARKERS = [
  'no-session',
  'session-done',
  'no-claim',
  'records-only',
  'hook-done-session-live',
  'hook-live-session-gone',
  'stale-records',
  'revived',
  'lease-expired',
  'session-id-mismatch',
  'duplicate-session',
  'claiming',
  'releasing',
  'unknown-agents-state',
];

const KNOWN_AGENT_STATES = ['working', 'blocked', 'done', 'failed', 'stopped'];
const ACTIVE_LEASE_STATES = ['claiming', 'held', 'releasing'];
const STATE_RANK = ['needs-you', 'rate-limited', 'working', 'no-session', 'done', 'unknown'];

// A hook record at a turn boundary (a finished turn, an idle prompt, a turn error) is the normal last
// record before a session ends, so it is not "live work" when the session is gone.
const TURN_BOUNDARY = (r) => r === 'turn-ended' || r === 'notification:idle_prompt' || String(r).startsWith('error:');
const midTurn = (hook) => Boolean(hook) && hook.state !== 'done' && !TURN_BOUNDARY(hook.reason);

const lower = (s) => String(s ?? '').toLowerCase();
const idOf = (repo, worktree) => `${lower(repo)}|${lower(worktree)}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

const rank = (s) => {
  const i = STATE_RANK.indexOf(s);
  return i < 0 ? STATE_RANK.length : i;
};
const sortRows = (rows) => rows.sort((a, b) => rank(a.state) - rank(b.state) || cmp(a.key ?? a.worktree, b.key ?? b.worktree));

function hookFor(rec, sessionId) {
  // Returns {state, reason, detail, since, questions} or null, plus whether the records are stale.
  if (!rec || !rec.latest) return { hook: null, stale: false };
  if (sessionId != null) {
    const r = rec.sessions?.get(sessionId);
    if (r) {
      return { hook: classifySession(r, null, rec.turnStops?.get(sessionId) ?? null, rec.asks?.get(sessionId) ?? null), stale: false };
    }
    return { hook: null, stale: (rec.sessions?.size ?? 0) > 0 };
  }
  return { hook: { state: rec.state, reason: rec.reason, detail: rec.detail, since: rec.since, questions: rec.questions ?? null }, stale: false };
}

function buildRow({ id, key, repo, worktree, lease, matches, rec, base, agentsError, nowMs, issues = new Map() }) {
  const markers = [];
  const session = agentsError ? null : pickSession(matches);
  const live = isLive(session);
  const currentId = session?.sessionId ?? lease?.sessionId ?? null;
  const { hook, stale } = hookFor(rec, currentId);
  if (stale) markers.push('stale-records');

  const held = lease?.state === 'held';
  const expired = held && Date.parse(lease.expiresAt) <= nowMs;
  let refresh = null;
  let expiredAt = null;
  if (lease?.state === 'claiming') markers.push('claiming');
  if (lease?.state === 'releasing') markers.push('releasing');

  let state;
  let reason = null;
  let detail = null;
  let since = null;
  let questions = null;
  if (agentsError) {
    state = hook ? hook.state : 'unknown';
    if (hook) ({ reason, detail, since, questions = null } = hook);
    if (!lease) markers.push('records-only');
  } else if (!session) {
    state = 'no-session';
    if (held || !lease) markers.push(lease ? 'no-session' : 'records-only');
    if (midTurn(hook)) markers.push('hook-live-session-gone');
  } else if (!live) {
    state = 'done';
    reason = `agents:${session.state}`;
    since = hook?.since ?? null;
    if (held) markers.push('session-done');
    if (midTurn(hook)) markers.push('hook-live-session-gone');
  } else {
    if (hook && hook.state !== 'done') {
      ({ state, reason, detail, since, questions = null } = hook);
    } else {
      if (hook) markers.push('hook-done-session-live');
      state = session.state === 'blocked' ? 'needs-you' : 'working';
      if (session.state === 'blocked') reason = 'agents:blocked';
      since = hook?.since ?? null;
    }
  }
  if (!lease && session) markers.push('no-claim');
  if (matches.length > 1) markers.push('duplicate-session');
  if (session && session.kind !== 'interactive' && !KNOWN_AGENT_STATES.includes(session.state)) markers.push('unknown-agents-state');
  if (lease?.sessionId && session && session.sessionId !== lease.sessionId && session.id !== lease.sessionId) markers.push('session-id-mismatch');

  if (held) {
    if (expired) expiredAt = lease.expiresAt;
    if (!agentsError && live) {
      refresh = expired ? 'revive' : 'extend';
      if (expired) markers.push('revived');
    } else if (expired) {
      markers.push('lease-expired');
    }
  }
  if (since == null) since = (session?.startedAt != null ? new Date(session.startedAt).toISOString() : null) ?? lease?.claimedAt ?? null;

  const cached = key == null ? null : issues.get(lower(key)) ?? null;
  const issue = cached
    ? {
        title: cached.title ?? null,
        state: cached.state,
        closingPrs: (Array.isArray(cached.closingPrs) ? cached.closingPrs : []).map((p) => ({ number: p.number, state: p.state, headRefName: p.headRefName })),
      }
    : null;

  return {
    key,
    repo,
    worktree,
    state,
    reason,
    detail,
    questions,
    since,
    lease: lease ? { state: lease.state, expiresAt: lease.expiresAt ?? null, refreshed: false, expiredAt } : null,
    session: session ? { shortId: session.id ?? null, sessionId: session.sessionId ?? null, agentsState: session.state ?? session.status ?? null, kind: session.kind ?? null } : null,
    path: lease?.worktreePath ?? path.join(base, '.claude', 'worktrees', worktree),
    markers,
    issue,
    refresh,
    leaseId: lease?.leaseId ?? null,
    _id: id,
  };
}

/**
 * Pure join. `leases` are claims-db lease rows, `agents` the `claude agents --json --all` list,
 * `records` the entries of readWorkerRecords, `now` a Date or epoch ms.
 * `issues` is a Map from the lowercase issue key (`owner/name#N`) to its cached issue row.
 * Each row's `issue` is `{title, state, closingPrs: [{number, state, headRefName}]}` from the entry for its key (the lookup
 * lowercases the key), or `null` when the row has no key or the issue is not in the map.
 * A worker whose key is a task key (`owner/name@slug.YYYYMMDD.n`) is in `tasks`, a list always present, with the same row keys;
 * its `issue` is null. An active lease whose key is neither an issue key nor a task key is not shown: it is counted in `ignored.leases` and its key is listed in
 * `ignoredLeaseKeys` (a field the commands strip before they print).
 */
export function joinWorkers({ leases = [], agents = [], agentsError = null, records = [], config, workspace, reposDir, now, rateLimits, issues = new Map() }) {
  const nowMs = toMs(now);
  const list = agentsError ? [] : agents ?? [];
  const configured = (config?.repos ?? []).map((r) => r.repo);
  const configuredSet = new Set(configured.map(lower));
  const baseOf = (repo) => {
    const { owner, repoName } = splitKey(`${repo}#1`);
    return path.join(reposDir, owner, repoName);
  };

  const recById = new Map();
  for (const r of records) recById.set(idOf(r.repo, r.worktree), r);

  const rows = [];
  const seen = new Set();
  const taken = new Set();
  const ignoredLeaseKeys = [];
  const taskIds = new Set();

  for (const lease of leases) {
    if (!ACTIVE_LEASE_STATES.includes(lease.state)) continue;
    const parsed = parseLeaseKey(lease.key);
    if (!parsed) {
      ignoredLeaseKeys.push(String(lease.key));
      continue;
    }
    const { repo, number } = parsed;
    const worktree = parsed.kind === 'task' ? taskNames(repo, parsed, { config }).name : names(repo, number).name;
    const id = idOf(repo, worktree);
    if (seen.has(id)) continue;
    const base = baseOf(repo);
    const matches = agentsError ? [] : matchSessions(list, { name: worktree, base, sessionId: lease.sessionId ?? null });
    for (const m of matches) taken.add(m);
    seen.add(id);
    if (parsed.kind === 'task') taskIds.add(id);
    rows.push(buildRow({ id, key: lease.key, repo, worktree, lease, matches, rec: recById.get(id), base, agentsError, nowMs, issues }));
  }

  // Agents entries not taken by a lease: identity from the worktree cwd, else from the base clone.
  const groups = new Map();
  for (const a of list) {
    if (!a || taken.has(a) || a.kind === 'interactive') continue;
    let ident = null;
    const p = parseWorktreeCwd(a.cwd, workspace);
    if (p) {
      const task = p.issue || !configuredSet.has(lower(p.repo)) ? null : parseTaskWorktreeName(config, p.repo, p.worktree);
      ident = { repo: p.repo, worktree: p.worktree, key: p.issue ?? task, task: task !== null };
    } else if (typeof a.name === 'string') {
      for (const repo of configured) {
        const { repoName } = splitKey(`${repo}#1`);
        const m = new RegExp(`^${repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([1-9][0-9]*)$`, 'i').exec(a.name);
        const task = m ? null : parseTaskWorktreeName(config, repo, a.name);
        if ((m || task) && matchSessions([a], { name: a.name, base: baseOf(repo) }).length > 0) {
          ident = { repo, worktree: a.name, key: m ? `${repo}#${m[1]}` : task, task: Boolean(task) };
          break;
        }
      }
    }
    if (!ident) continue;
    const id = idOf(ident.repo, ident.worktree);
    if (seen.has(id)) {
      // A second entry for a worker that already has a row: say so on the row.
      const row = rows.find((r) => r._id === id);
      if (row && !row.markers.includes('duplicate-session')) row.markers.push('duplicate-session');
      continue;
    }
    if (!groups.has(id)) groups.set(id, { ident, matches: [] });
    groups.get(id).matches.push(a);
  }
  for (const [id, g] of groups) {
    seen.add(id);
    if (g.ident.task) taskIds.add(id);
    rows.push(buildRow({ id, key: g.ident.key, repo: g.ident.repo, worktree: g.ident.worktree, lease: null, matches: g.matches, rec: recById.get(id), base: baseOf(g.ident.repo), agentsError, nowMs, issues }));
  }

  // Hook files with neither lease nor session.
  let ignoredRecords = 0;
  for (const r of records) {
    const id = idOf(r.repo, r.worktree);
    if (seen.has(id)) continue;
    if (!configuredSet.has(lower(r.repo))) {
      ignoredRecords += 1;
      continue;
    }
    seen.add(id);
    const { repoName } = splitKey(`${r.repo}#1`);
    const m = new RegExp(`^${repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([1-9][0-9]*)$`, 'i').exec(r.worktree);
    const task = m ? null : parseTaskWorktreeName(config, r.repo, r.worktree);
    if (task) taskIds.add(id);
    rows.push(buildRow({ id, key: m ? `${r.repo}#${m[1]}` : task, repo: r.repo, worktree: r.worktree, lease: null, matches: [], rec: r, base: baseOf(r.repo), agentsError, nowMs, issues }));
  }

  sortRows(rows);
  const workers = rows.filter((r) => !taskIds.has(r._id));
  const tasks = rows.filter((r) => taskIds.has(r._id));
  for (const r of rows) delete r._id;

  const out = {
    agents: agentsError ? { ok: false, error: String(agentsError.message ?? agentsError) } : { ok: true },
    workers,
    tasks,
    ignored: { records: ignoredRecords, leases: ignoredLeaseKeys.length },
    ignoredLeaseKeys,
  };
  if (rateLimits !== undefined) out.rateLimits = rateLimits;
  return out;
}

/**
 * Extend the held leases whose worker is live. One `claims.immediate` per row: the lease is read again inside the
 * lock and changed only when it is still the same lease and still `held`. It never releases and makes no GitHub call.
 * A lease that was past its expiry keeps that expiry in `lease.expiredAt`. Updates the rows in place; the markers are the join's.
 * Returns {refreshed, revived}: the number of leases written, and how many of them had expired.
 */
export function refreshLiveLeases(claims, rows, { now, leaseMinutes }) {
  const nowMs = toMs(now);
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + leaseMinutes * 60 * 1000).toISOString();
  let refreshed = 0;
  let revived = 0;
  for (const row of rows) {
    if (!row.refresh || !row.leaseId) continue;
    const result = claims.immediate(() => {
      const current = claims.getLease(row.leaseId);
      if (!current || current.state !== 'held') return null;
      const wasExpired = Date.parse(current.expiresAt) <= nowMs;
      claims.updateLease(row.leaseId, { heartbeatAt: nowIso, expiresAt });
      return { wasExpired, previous: current.expiresAt };
    });
    if (!result) continue;
    refreshed += 1;
    row.lease.refreshed = true;
    row.lease.expiresAt = expiresAt;
    if (result.wasExpired) revived += 1;
    row.lease.expiredAt = result.wasExpired ? result.previous : null;
  }
  return { refreshed, revived };
}

const rowKey = (w) => w.key ?? `${w.repo}:${w.worktree}`;

const DETAIL_MAX = 100;
const oneLine = (s) => {
  if (s == null) return null;
  const flat = String(s).replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 3)}...` : flat;
};

/**
 * The restart steps of every worker and task worker, from the joined rows (before the command strips `leaseId`) and the
 * lease rows they came from. The session is the matched `claude agents` entry, else the session the lease names, so the
 * steps can still be built after a reboot when the agents list no longer holds the sessions. The short id is the listed
 * one, else the lease's, else the first 8 characters of the session id. `exists(path)` says whether the worktree folder
 * exists. Returns one entry per row, sorted as `status` sorts: {key, state, detail, shortId, sessionId, path, pathExists};
 * shortId and sessionId are null for a row with no session id at all.
 */
export function restartEntries(rows, leases, { exists }) {
  const byLease = new Map(leases.map((l) => [l.leaseId, l]));
  return sortRows([...rows]).map((w) => {
    const lease = w.leaseId ? byLease.get(w.leaseId) ?? null : null;
    const listed = w.session?.sessionId ?? null;
    const sessionId = listed ?? lease?.sessionId ?? null;
    const shortId = sessionId == null ? null : (listed ? w.session.shortId : lease?.shortId) ?? sessionId.slice(0, 8);
    return { key: rowKey(w), state: w.state, detail: oneLine(w.detail), shortId, sessionId, path: w.path, pathExists: Boolean(exists(w.path)) };
  });
}

/** The restart steps as a Markdown sheet: the workers, the `claude respawn` lines, and the `claude --bg --resume` fallback lines. */
export function formatRestart(entries, { generatedAt }) {
  const withSession = entries.filter((e) => e.sessionId != null);
  const fence = '```';
  const block = (lines) => [`${fence}bash`, ...(lines.length > 0 ? lines : ['# none']), fence];
  const out = [
    '# Restart steps',
    '',
    `Generated ${generatedAt} by gvt-fleet status --restart.`,
    '',
    '## Workers',
    '',
    `${fence}text`,
    ...(entries.length > 0 ? entries.map((e) => `${e.key} ${e.shortId ?? '-'} ${e.state} ${e.detail ?? '-'}`) : ['none']),
    fence,
    '',
    '## Respawn',
    '',
    ...block(withSession.map((e) => `claude respawn ${e.shortId}`)),
    '',
    '## Resume (fallback)',
    '',
    ...block(withSession.map((e) => (e.pathExists ? `cd "${e.path}" && claude --bg --resume ${e.sessionId}` : `# ${e.key}: worktree missing: ${e.path}`))),
  ];
  const noSession = entries.filter((e) => e.sessionId == null);
  if (noSession.length > 0) out.push('', `No session id: ${noSession.map((e) => e.key).join(', ')}.`);
  return out.join('\n');
}

/** One line per worker and per task worker (one sorted list), then `workers: N` counting both. */
export function formatStatus(out) {
  const all = sortRows([...out.workers, ...(out.tasks ?? [])]);
  const lines = all.map((w) => {
    const lease = w.lease ? `${w.lease.expiresAt ?? 'none'}${w.lease.expiredAt ? ` (expired at ${w.lease.expiredAt})` : ''}` : 'none';
    const marks = w.markers.length > 0 ? ` [${w.markers.join(',')}]` : '';
    return `${rowKey(w)} ${w.state}${w.reason ? ` ${w.reason}` : ''} lease ${lease} session ${w.session?.shortId ?? '-'} ${w.path}${marks}`;
  });
  lines.push(`workers: ${all.length}`);
  return lines.join('\n');
}
