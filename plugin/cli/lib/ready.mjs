// Ready set. Pure: the rows, the graph, the leases, the branch record, the config and the
// clock all enter as arguments. An issue is ready when no reason code applies. Every
// applicable reason is listed, never only the first.

import { effectiveRepoSettings, shortName } from './config.mjs';
import { resolveRef } from './refs.mjs';
import { isUmbrella } from './graph.mjs';

const BLOCKED_LABEL_TEXT = 'blocked (label, blocker not named)';
const TITLE_PREFIX_RE = /^\s*(?:epic|tracking)\s*:/i;

/**
 * A live local lease.
 * @typedef {object} Lease
 * @property {string} key        owner/name#N
 * @property {string} state      only 'held' counts
 * @property {string|number|Date} expiresAt  the lease is live while this is after `now`
 */

/**
 * `config/branches.json` plus the cached remote heads.
 * @typedef {object} BranchRecord
 * @property {Object<string, Object<string, {disposition: string, issue?: string}>>} [repos]
 * @property {Object<string, string[]>} [remoteHeads]  repo -> branch names currently on the remote
 */

const lower = (s) => String(s ?? '').toLowerCase();
const isClosed = (row) => lower(row?.state) === 'closed';
const labelName = (l) => (typeof l === 'string' ? l : l?.name);

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const ms = Date.parse(now);
  return Number.isNaN(ms) ? 0 : ms;
}

function repoEntry(config, repo) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  return repos.find((e) => e && typeof e.repo === 'string' && lower(e.repo) === lower(repo)) ?? { repo };
}

function shortNameMap(config) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const byShort = new Map();
  for (const e of repos) {
    if (!e || typeof e.repo !== 'string' || !e.repo.includes('/')) continue;
    const list = byShort.get(lower(shortName(e.repo))) ?? [];
    list.push(e.repo);
    byShort.set(lower(shortName(e.repo)), list);
  }
  const out = {};
  for (const list of byShort.values()) if (list.length === 1) out[shortName(list[0])] = list[0];
  return out;
}

/**
 * The deferral triggers of an issue that have not fired. A trigger fires when every issue it
 * names is closed. A trigger that names nothing (or names an issue that is open or unknown)
 * has not fired, because text such as "when the cache is warm" needs a human to observe.
 */
function unfiredTriggers(row, extracted, byKey, ownRepo, shortNames) {
  const out = [];
  const refs = Array.isArray(extracted?.refs) ? extracted.refs : [];
  for (const t of Array.isArray(extracted?.triggers) ? extracted.triggers : []) {
    const named = [];
    for (const ref of refs) {
      if (ref?.source !== 'deferral' || ref.retracted || ref.line !== t.line) continue;
      const r = resolveRef(ref, { ownRepo, shortNames });
      for (const k of r.keys ?? (r.key ? [{ key: r.key }] : [])) named.push(k.key);
    }
    const fired = named.length > 0 && named.every((k) => isClosed(byKey.get(lower(k))));
    if (!fired) out.push(t.line);
  }
  return out;
}

/**
 * @param {object} args
 * @param {object[]} args.issues      cached rows (see graph.mjs IssueRow), plus optional
 *   `assignees` (strings or `{login}`) and `closingPrs` (`{number, state}`)
 * @param {object} args.graph         output of buildGraph
 * @param {Lease[]} [args.claims]
 * @param {BranchRecord} [args.branchRecord]
 * @param {object} args.config
 * @param {string|number|Date} args.now
 * @param {Function} [args.extract]   the refs grammar's extract. Without it the banner and the
 *   text deferral triggers are not read; every other reason still applies.
 * @returns {{key: string, ready: boolean, reasons: {code: string, detail: string}[]}[]}
 */
export function computeReady({ issues, graph, claims = [], branchRecord = {}, config = {}, now, extract } = {}) {
  const rows = Array.isArray(issues) ? issues : [];
  const byKey = new Map(rows.map((r) => [lower(r.key), r]));
  const nowMs = toMs(now);
  const claimAccount = config?.claimAccount;
  const shortNames = shortNameMap(config);
  const live = new Map();
  for (const c of Array.isArray(claims) ? claims : []) {
    if (c?.state === 'held' && toMs(c.expiresAt) > nowMs) live.set(lower(c.key), c);
  }
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const cycles = Array.isArray(graph?.cycles) ? graph.cycles : [];
  const unresolved = Array.isArray(graph?.unresolved) ? graph.unresolved : [];
  const deferrals = Array.isArray(graph?.deferrals) ? graph.deferrals : [];

  return rows.map((row) => {
    const reasons = [];
    const add = (code, detail) => reasons.push({ code, detail });
    const key = row.key;
    const settings = effectiveRepoSettings(repoEntry(config, row.repo));
    const labels = (Array.isArray(row.labels) ? row.labels : []).map(labelName);

    if (isClosed(row)) add('closed', 'issue is closed');
    if (!labels.includes(settings.triagedLabel)) add('not-triaged', `missing label ${settings.triagedLabel}`);

    for (const e of edges) {
      if (lower(e.to) !== lower(key)) continue;
      if (e.from === null) {
        add('blocked-label', BLOCKED_LABEL_TEXT);
      } else if (!isClosed(byKey.get(lower(e.from)))) {
        add('blocked-by', `${e.from} (${e.source})`);
      }
    }

    for (const u of unresolved) {
      if (lower(u.key) === lower(key)) add('blocked-unresolved', `${u.reason}: "${u.line ?? ''}"`);
    }
    for (const members of cycles) {
      if (members.some((m) => lower(m) === lower(key))) add('cycle', members.join(', '));
    }

    const extracted = typeof extract === 'function' ? safeExtract(extract, row) : null;
    const umbrellaSources = [];
    if (isUmbrella(graph, key)) umbrellaSources.push('open sub-issue');
    if (TITLE_PREFIX_RE.test(row.title ?? '')) umbrellaSources.push('title prefix');
    if (extracted?.banner) umbrellaSources.push('banner');
    if (umbrellaSources.length > 0) add('umbrella', umbrellaSources.join(', '));

    const deferred = new Set(unfiredTriggers(row, extracted, byKey, row.repo, shortNames));
    for (const d of deferrals) {
      if (lower(d.to) === lower(key) && !isClosed(byKey.get(lower(d.from)))) deferred.add(d.line ?? `until ${d.from}`);
    }
    for (const line of deferred) add('deferred', line);

    const lease = live.get(lower(key));
    if (lease) add('claimed', `held until ${new Date(toMs(lease.expiresAt)).toISOString()}`);
    if (labels.includes(settings.inProgressLabel)) add('in-progress-label', lease ? 'local lease' : 'hand claim');

    const others = (Array.isArray(row.assignees) ? row.assignees : [])
      .map((a) => (typeof a === 'string' ? a : a?.login))
      .filter((a) => a && lower(a) !== lower(claimAccount));
    if (others.length > 0) add('assigned-to-other', others.join(', '));

    for (const pr of Array.isArray(row.closingPrs) ? row.closingPrs : []) {
      const state = String(pr?.state ?? '').toUpperCase();
      if (state === 'OPEN' || state === 'MERGED') add('closing-pr', `#${pr.number} (${state})`);
    }

    const remote = branchRecord?.remoteHeads ?? {};
    for (const [repo, branches] of Object.entries(branchRecord?.repos ?? {})) {
      const heads = Object.entries(remote).find(([r]) => lower(r) === lower(repo))?.[1] ?? [];
      for (const [branch, entry] of Object.entries(branches ?? {})) {
        if (entry?.disposition === 'issue' && lower(entry.issue) === lower(key) && heads.includes(branch)) {
          add('existing-branch', `${repo}:${branch}`);
        }
      }
    }

    return { key, ready: reasons.length === 0, reasons };
  });
}

/**
 * Summary of the untriaged open managed issues, one entry per repository.
 * An issue counts when it is managed, open, and has the not-triaged reason, whatever its other reasons.
 * `onlyReason` counts the issues whose only reason is not-triaged.
 * @param {Array<{key: string, reasons: Array<{code: string}>}>} entries computeReady output
 * @param {Array<{key: string, repo: string, state?: string, managed?: boolean}>} rows the issues given to computeReady
 * @returns {Array<{repo: string, count: number, keys: string[], onlyReason: number}>} repos in row order
 */
export function untriagedSummary(entries, rows) {
  const byKey = new Map((Array.isArray(entries) ? entries : []).map((e) => [e.key, e]));
  const byRepo = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = byKey.get(row.key);
    if (!entry || !row.managed || isClosed(row)) continue;
    if (!entry.reasons.some((r) => r.code === 'not-triaged')) continue;
    let acc = byRepo.get(row.repo);
    if (!acc) {
      acc = { repo: row.repo, count: 0, keys: [], onlyReason: 0 };
      byRepo.set(row.repo, acc);
    }
    acc.count += 1;
    acc.keys.push(row.key);
    if (entry.reasons.length === 1) acc.onlyReason += 1;
  }
  return [...byRepo.values()];
}

function safeExtract(extract, row) {
  try {
    return extract(
      { number: row.number, title: row.title, body: row.body ?? '', comments: Array.isArray(row.comments) ? row.comments : [] },
      { repo: row.repo },
    );
  } catch {
    return null;
  }
}

/**
 * Lines for the `why` command: each reason, then the edges that point at the issue.
 * @returns {string[]}
 */
export function explain(entry, graph) {
  const lines = [`${entry.key}: ${entry.ready ? 'ready' : 'not ready'}`];
  for (const r of entry.reasons) lines.push(`  ${r.code}: ${r.detail}`);
  const edges = (Array.isArray(graph?.edges) ? graph.edges : []).filter((e) => lower(e.to) === lower(entry.key));
  for (const e of edges) {
    const from = e.from === null ? '(blocker not named)' : e.from;
    lines.push(`  edge ${from} -> ${e.to} [${e.source}, ${e.relation}]${e.line ? ` "${e.line}"` : ''}`);
  }
  return lines;
}
