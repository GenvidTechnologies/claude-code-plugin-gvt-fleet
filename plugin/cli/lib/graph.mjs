// Dependency graph over the cached issue rows. Pure: `extract` (the installed refs grammar)
// and the config enter as arguments. Nothing here throws on bad data; a problem becomes a
// warning.

import { resolveRef } from './refs.mjs';
import { effectiveRepoSettings, shortName } from './config.mjs';

/**
 * Minimal cached row. `sync` produces it.
 * Keys are `owner/name#N`. `parent`, `subIssues`, `blockedBy` and `blocking` hold keys; a bare
 * number is read as an issue of the same repo.
 * @typedef {object} IssueRow
 * @property {string} key
 * @property {string} repo
 * @property {number} number
 * @property {string} state   'open' or 'closed' (case-insensitive)
 * @property {string[]} [labels]
 * @property {string} [title]
 * @property {string} [body]
 * @property {{body?: string, createdAt?: string}[]} [comments]
 * @property {string|number|null} [parent]
 * @property {(string|number)[]} [subIssues]
 * @property {(string|number)[]} [blockedBy]
 * @property {(string|number)[]} [blocking]
 */

/**
 * @typedef {object} Edge
 * @property {string|null} from  blocker key; null for the `label` source (blocker not named)
 * @property {string} to          blocked key
 * @property {'native-dependency'|'sub-issue'|'body-ref'|'label'} source
 * @property {string} relation    blocked-by | depends-on | blocks | child-row | native | sub-issue | blocked-label
 * @property {string|null} line   the source line for a body-ref, else null
 */

/**
 * @typedef {object} Graph
 * @property {Edge[]} edges
 * @property {{key: string, ref: object, reason: string, line: string|null}[]} unresolved
 *   Blocker refs that could not be resolved. Every entry BLOCKS its issue (`blocked-unresolved`).
 *   An ambiguous `word #N` ref whose word is not a configured short name does NOT appear here;
 *   it resolves to the issue's own repo, blocks through a normal edge, and adds an inferred
 *   warning (see below). A consumer reads `unresolved` and treats every entry as blocking.
 * @property {string[][]} cycles  Strongly connected components of two or more keys (sorted members)
 * @property {{kind: string, key: string, message: string, line?: string|null, ref?: object}[]} warnings
 *   Kinds: `ambiguous-ref` (`inferred: true`, `key` is the inferred own-repo key; the edge still
 *   blocks, user decision 2026-11-03), `native-mismatch`,
 *   `self-reference`, `extract-failed`, `bad-row`.
 * @property {{from: string|null, to: string, line: string|null}[]} deferrals
 *   Refs with relation `deferral`, carried for the deferred rule. They are not edges and block nothing.
 * @property {string[]} umbrellas  Keys of issues with at least one open sub-issue (native or `child-row`)
 */

const BLOCKER_RELATIONS = new Set(['blocked-by', 'depends-on']);

const isStr = (v) => typeof v === 'string' && v.length > 0;

function normKey(value, repo) {
  if (isStr(value)) return value;
  if (Number.isInteger(value) && isStr(repo)) return `${repo}#${value}`;
  return null;
}

function keysOf(list, repo) {
  if (!Array.isArray(list)) return [];
  return list.map((v) => normKey(v, repo)).filter((k) => k !== null);
}

function numberOf(key) {
  const m = /#(\d+)$/.exec(key ?? '');
  return m ? Number(m[1]) : undefined;
}

function shortNameMap(config) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const byShort = new Map();
  for (const e of repos) {
    if (!e || typeof e.repo !== 'string' || !e.repo.includes('/')) continue;
    const s = shortName(e.repo);
    const list = byShort.get(s.toLowerCase()) ?? [];
    list.push({ short: s, repo: e.repo });
    byShort.set(s.toLowerCase(), list);
  }
  const out = {};
  for (const list of byShort.values()) if (list.length === 1) out[list[0].short] = list[0].repo;
  return out;
}

function blockedLabelFor(config, repo) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const entry = repos.find((e) => e && typeof e.repo === 'string' && e.repo.toLowerCase() === String(repo).toLowerCase());
  return effectiveRepoSettings(entry ?? { repo }).blockedLabel;
}

/**
 * @param {IssueRow[]} issues
 * @param {{extract: Function, config?: object}} deps
 * @returns {Graph}
 */
export function buildGraph(issues, { extract, config } = {}) {
  const edges = [];
  const unresolved = [];
  const warnings = [];
  const deferrals = [];
  const shortNames = shortNameMap(config);

  const rows = (Array.isArray(issues) ? issues : []).filter((r) => {
    const ok = r && isStr(r.key);
    if (!ok) warnings.push({ kind: 'bad-row', key: String(r?.key ?? ''), message: 'row has no key' });
    return ok;
  });
  const byLower = new Map(rows.map((r) => [r.key.toLowerCase(), r]));
  const canon = (key) => byLower.get(key.toLowerCase())?.key ?? key;
  const isOpen = (key) => {
    const row = byLower.get(key.toLowerCase());
    return !row || String(row.state ?? '').toLowerCase() !== 'closed';
  };

  const seen = new Set();
  const addEdge = (from, to, source, relation, line = null) => {
    const f = from === null ? null : canon(from);
    const t = canon(to);
    if (f !== null && f.toLowerCase() === t.toLowerCase()) {
      warnings.push({ kind: 'self-reference', key: t, message: `${t} names itself as a blocker`, line });
      return;
    }
    const id = JSON.stringify([f, t, source, relation]);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ from: f, to: t, source, relation, line });
  };

  const openChildOf = new Set(); // parent keys with at least one open child
  const noteChild = (child, parent, source, relation, line) => {
    addEdge(child, parent, source, relation, line);
    if (isOpen(child)) openChildOf.add(canon(parent));
  };

  for (const row of rows) {
    const { key } = row;

    // Native dependencies. `blocking` only cross-checks `blockedBy`.
    for (const b of keysOf(row.blockedBy, row.repo)) {
      addEdge(b, key, 'native-dependency', 'native');
      const other = byLower.get(b.toLowerCase());
      if (other && !keysOf(other.blocking, other.repo).some((k) => k.toLowerCase() === key.toLowerCase())) {
        warnings.push({ kind: 'native-mismatch', key, message: `${key} lists ${b} in blockedBy but ${b} does not list it in blocking` });
      }
    }
    for (const t of keysOf(row.blocking, row.repo)) {
      const other = byLower.get(t.toLowerCase());
      if (other && !keysOf(other.blockedBy, other.repo).some((k) => k.toLowerCase() === key.toLowerCase())) {
        warnings.push({ kind: 'native-mismatch', key, message: `${key} lists ${t} in blocking but ${t} does not list it in blockedBy` });
      }
    }

    // Native sub-issues: an open child blocks its parent. Both directions are read.
    for (const c of keysOf(row.subIssues, row.repo)) noteChild(c, key, 'sub-issue', 'sub-issue', null);
    const parent = normKey(row.parent, row.repo);
    if (parent) noteChild(key, parent, 'sub-issue', 'sub-issue', null);

    // Body and comment refs.
    let refs = [];
    try {
      const out = extract(
        { number: row.number, title: row.title, body: row.body ?? '', comments: Array.isArray(row.comments) ? row.comments : [] },
        { repo: row.repo, parent: parent ? numberOf(parent) : undefined },
      );
      refs = Array.isArray(out?.refs) ? out.refs : [];
    } catch (err) {
      warnings.push({ kind: 'extract-failed', key, message: `extract failed: ${err?.message ?? err}` });
    }
    for (const ref of refs) {
      if (!ref || ref.retracted) continue;
      const rel = ref.relation ?? null;
      const isChildRow = ref.source === 'child-row';
      // The grammar marks deferral refs by source ('deferral') with relation null.
      const isDeferral = ref.source === 'deferral' || rel === 'deferral';
      if (rel === 'relates-to' || rel === 'qualifier') continue;
      if (!isChildRow && !isDeferral && rel !== 'blocks' && !BLOCKER_RELATIONS.has(rel)) continue;
      const r = resolveRef(ref, { ownRepo: row.repo, shortNames });
      const line = typeof ref.line === 'string' ? ref.line : null;
      if (!r.key && !r.keys) {
        if (isChildRow || !BLOCKER_RELATIONS.has(rel)) continue; // only a blocker ref that cannot be read blocks
        unresolved.push({ key, ref, reason: r.unresolved, line });
        continue;
      }
      for (const k of r.keys ?? [{ key: r.key, via: r.via }]) {
        if (k.via === 'inferred-own-repo') {
          warnings.push({ kind: 'ambiguous-ref', inferred: true, key: k.key, message: `inferred own-repo reference ${k.key} from "${line ?? ''}"`, line });
        }
        if (isDeferral) deferrals.push({ from: k.key, to: key, line });
        else if (isChildRow) noteChild(k.key, key, 'body-ref', 'child-row', line);
        else if (rel === 'blocks') addEdge(key, k.key, 'body-ref', 'blocks', line);
        else addEdge(k.key, key, 'body-ref', rel, line);
      }
    }
  }

  // Label edge: only when the issue carries the repo's blocked label and no named blocker edge.
  const named = new Set(edges.filter((e) => e.from !== null).map((e) => e.to.toLowerCase()));
  for (const row of rows) {
    const label = blockedLabelFor(config, row.repo);
    const labels = Array.isArray(row.labels) ? row.labels : [];
    const has = labels.some((l) => (typeof l === 'string' ? l : l?.name) === label);
    if (has && !named.has(row.key.toLowerCase())) addEdge(null, row.key, 'label', 'blocked-label', null);
  }

  const cycles = findCycles(edges);
  const umbrellas = [...openChildOf].sort();
  return { edges, unresolved, cycles, warnings, deferrals, umbrellas };
}

/** True when the issue has an open sub-issue or an open `child-row` child. */
export function isUmbrella(graph, key) {
  const lower = String(key).toLowerCase();
  return Array.isArray(graph?.umbrellas) && graph.umbrellas.some((k) => k.toLowerCase() === lower);
}

// Iterative Tarjan SCC over edges with a non-null `from`. Returns components of size >= 2.
function findCycles(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (e.from === null) continue;
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from).add(e.to);
  }
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;
  for (const root of adj.keys()) {
    if (index.has(root)) continue;
    const work = [{ node: root, it: adj.get(root).values() }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const next = frame.it.next();
      if (!next.done) {
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, it: adj.get(w).values() });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(w)));
        }
        continue;
      }
      work.pop();
      const v = frame.node;
      if (work.length > 0) {
        const p = work[work.length - 1].node;
        low.set(p, Math.min(low.get(p), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length >= 2) result.push(comp.sort());
      }
    }
  }
  return result.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
