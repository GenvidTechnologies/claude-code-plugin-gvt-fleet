// Sync: refresh state/cache.db from GitHub. One pass per enabled repo (incremental or full),
// then a lookup pass for blockers the cache does not hold. gh and the clock are injected.

import { GhError } from './gh.mjs';
import { buildGraph } from './graph.mjs';
import { LABEL_KEYS } from './config.mjs';
import {
  PROJECT_ITEMS_QUERY,
  fieldFromNode,
  isMissingFieldError,
  parseProject,
} from './projects.mjs';

export const OVERLAP_MS = 2 * 60 * 1000;
export const BACKOFF_START_MS = 60 * 1000;
export const MAX_TRIES = 3;
export const BATCH_SIZE = 50;

const OVERLAY_KEYS = [...LABEL_KEYS, 'defaultBranch'];
const RATE = 'rateLimit { cost remaining resetAt }';
const REF = 'number state repository { nameWithOwner }';

const NODE_FIELDS = `
  number state title body updatedAt
  labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }
  assignees(first: 20) { nodes { login } pageInfo { hasNextPage endCursor } }
  comments(first: 100) { nodes { body createdAt } pageInfo { hasNextPage endCursor } }
  parent { ${REF} }
  subIssues(first: 50) { nodes { ${REF} } }
  blockedBy(first: 50) { nodes { ${REF} } }
  blocking(first: 50) { nodes { ${REF} } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state headRefName repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }`;

/** The issue page query. A full sync reads OPEN issues without `since`; an incremental one reads OPEN and CLOSED. */
export function issuesQuery(full) {
  const states = full ? '[OPEN]' : '[OPEN, CLOSED]';
  const filter = full ? '' : ', filterBy: {since: $since}';
  const since = full ? '' : ', $since: DateTime';
  return `query SyncIssues($owner: String!, $name: String!, $cursor: String${since}) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, states: ${states}${filter}, orderBy: {field: UPDATED_AT, direction: ASC}) {
      nodes {${NODE_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${RATE}
}`;
}

const META_QUERY = `query SyncRepoMeta($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    agentConfig: object(expression: "HEAD:.gvt-agent.json") { ... on Blob { text } }
    refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
      nodes { name target { oid ... on Commit { committedDate } } }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${RATE}
}`;

/** One issue by number, with the fields of the sync query. Used by claim for the fresh read. */
export const ISSUE_QUERY = `query ClaimIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {${NODE_FIELDS}
    }
  }
  ${RATE}
}`;

/**
 * The pull requests that close an issue, read live: `{ prs: [{ number, state, headRefName, repo }] }`, or `{ error }` when the call
 * throws or the issue node is missing. Only the first page (10) is read; a later page can only remove proofs, so a miss leads to refusal.
 */
export async function readClosingPrs(gh, repo, number) {
  const [owner, name] = repo.split('/');
  try {
    const res = await gh.graphql(ISSUE_QUERY, { owner, name, number });
    const node = res.data?.repository?.issue;
    if (!node) {
      const why = (res.errors ?? []).map((e) => e.message).join('; ');
      return { error: new Error(`${repo}#${number}: cannot read the issue${why ? `: ${why}` : ''}`) };
    }
    return {
      prs: node.closedByPullRequestsReferences.nodes.map((p) => ({
        number: p.number,
        state: p.state,
        headRefName: p.headRefName,
        repo: p.repository?.nameWithOwner ?? null,
      })),
    };
  } catch (error) {
    return { error };
  }
}

/**
 * Normalise the first page of one issue node into a cache row. Unlike the sync pass it does not page
 * later connection pages; a caller that needs complete labels or assignees checks `pageInfo` itself.
 * @param {string} repo  canonical owner/name
 * @param {object} node  GraphQL issue node
 * @param {(nameWithOwner: string, number: number) => string} keyOf
 */
export function issueNodeToRow(repo, node, keyOf) {
  const refKey = (n) => keyOf(n.repository.nameWithOwner, n.number);
  return {
    key: `${repo}#${node.number}`,
    repo,
    number: node.number,
    state: lower(node.state),
    title: node.title,
    body: node.body,
    updatedAt: node.updatedAt,
    labels: node.labels.nodes.map((l) => l.name),
    assignees: node.assignees.nodes.map((a) => a.login),
    comments: node.comments.nodes.map((c) => ({ body: c.body, createdAt: c.createdAt })),
    parent: node.parent ? refKey(node.parent) : null,
    subIssues: node.subIssues.nodes.map(refKey),
    blockedBy: node.blockedBy.nodes.map(refKey),
    blocking: node.blocking.nodes.map(refKey),
    closingPrs: node.closedByPullRequestsReferences.nodes.map((p) => ({
      number: p.number,
      state: p.state,
      headRefName: p.headRefName,
      repo: p.repository?.nameWithOwner ?? null,
    })),
    managed: true,
  };
}

// Later pages of one issue connection. The first page comes with the issue query.
function connectionQuery(op, field, args, selection) {
  return `query ${op}($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${field}(${args}after: $cursor) { nodes { ${selection} } pageInfo { hasNextPage endCursor } }
    }
  }
  ${RATE}
}`;
}

const CONNECTIONS = {
  labels: connectionQuery('SyncLabels', 'labels', 'first: 100, ', 'name'),
  assignees: connectionQuery('SyncAssignees', 'assignees', 'first: 20, ', 'login'),
  closedByPullRequestsReferences: connectionQuery(
    'SyncClosingPrs',
    'closedByPullRequestsReferences',
    'first: 10, includeClosedPrs: true, ',
    'number state headRefName repository { nameWithOwner }',
  ),
  comments: connectionQuery('SyncComments', 'comments', 'first: 100, ', 'body createdAt'),
};

class SyncStop extends Error {
  constructor(reason, resetAt) {
    super(`sync stopped: ${reason}`);
    this.name = 'SyncStop';
    this.reason = reason;
    this.resetAt = resetAt ?? null;
  }
}

const lower = (s) => String(s ?? '').toLowerCase();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isSecondary(e) {
  if (!(e instanceof GhError)) return false;
  if (e.rate?.secondary) return true;
  const text = `${e.message}\n${e.stderr ?? ''}`;
  return /HTTP (403|429)/.test(text) && /retry-after|secondary|abuse/i.test(text);
}

/** Read the `bugTracker` block of a `.gvt-agent.json` text. Returns {bugTracker, error}. */
export function parseOverlay(text) {
  if (text === null || text === undefined) return { bugTracker: null, error: null };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { bugTracker: null, error: `.gvt-agent.json is not valid JSON: ${e.message}` };
  }
  const block = isObject(obj) ? obj.bugTracker : undefined;
  if (block === undefined) return { bugTracker: null, error: null };
  if (!isObject(block)) return { bugTracker: null, error: '.gvt-agent.json bugTracker must be an object' };
  for (const k of OVERLAY_KEYS) {
    if (k in block && (typeof block[k] !== 'string' || block[k] === '')) {
      return { bugTracker: null, error: `.gvt-agent.json bugTracker.${k} must be a non-empty string` };
    }
  }
  const out = {};
  for (const k of OVERLAY_KEYS) if (k in block) out[k] = block[k];
  return { bugTracker: out, error: null };
}

/**
 * A config whose entries carry the cached `.gvt-agent.json` overlay under the entry's own keys, so
 * `effectiveRepoSettings(entry)` yields: built-in default, then overlay, then config entry.
 */
export function applyOverlays(config, cache) {
  return {
    ...config,
    repos: config.repos.map((entry) => {
      const state = cache.getRepoState(entry.repo);
      let overlay = {};
      try {
        overlay = state?.bugTracker ? JSON.parse(state.bugTracker) : {};
      } catch {
        overlay = {};
      }
      return { ...overlay, ...entry };
    }),
  };
}

/** Remote heads that are not the default branch and are not in the branch record. */
export function unknownBranches(cache, config, branchRecord) {
  const out = [];
  const record = branchRecord?.repos ?? {};
  for (const entry of applyOverlays(config, cache).repos) {
    if (entry.enabled === false) continue;
    const state = cache.getRepoState(entry.repo);
    const recorded = Object.entries(record).find(([r]) => lower(r) === lower(entry.repo))?.[1] ?? {};
    const defaultBranch = entry.defaultBranch ?? state?.defaultBranch;
    for (const head of cache.readBranchHeads(entry.repo)) {
      if (head.name === defaultBranch || Object.hasOwn(recorded, head.name)) continue;
      out.push({ repo: entry.repo, ...head });
    }
  }
  return out;
}

/**
 * @param {{gh: {graphql: Function}, clock: {now: () => Date, sleep: (ms: number) => Promise<void>}, config: object}} ctx
 * @param {{cache: object, full?: boolean, extract?: Function, branchRecord?: object}} opts
 * @returns {Promise<object>} summary: repos, pages, issues, mode per repo, errors, stopped, points, counts
 */
export async function runSync({ gh, clock, config }, { cache, full = false, extract, branchRecord = {} }) {
  const reserve = config.rateReserve ?? 0;
  const fullMs = (config.fullSyncHours ?? 24) * 3600 * 1000;
  const start = clock.now();
  const startIso = start.toISOString();
  const enabled = config.repos.filter((e) => e.enabled !== false);
  const canonRepo = new Map(config.repos.map((e) => [lower(e.repo), e.repo]));
  const managedSet = new Set(enabled.map((e) => lower(e.repo)));
  const keyOf = (nwo, n) => `${canonRepo.get(lower(nwo)) ?? nwo}#${n}`;
  const refKey = (n) => keyOf(n.repository.nameWithOwner, n.number);

  const summary = {
    repos: [],
    pages: 0,
    issues: 0,
    external: 0,
    queries: 0,
    cost: 0,
    remainingFirst: null,
    remaining: null,
    resetAt: null,
    errors: [],
    overlayErrors: [],
    stopped: null,
    unknownBranches: 0,
    unresolved: 0,
    cycles: 0,
    notFound: [],
    unmanaged: 0,
    projects: [],
  };

  // `partial` lets a reply with GraphQL errors through (the external lookup reads per-alias nulls).
  async function query(q, vars, { partial = false } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await gh.graphql(q, vars);
        summary.queries += 1;
        if (res.errors?.some((e) => e.type === 'RATE_LIMITED')) throw new SyncStop('rate-limited', res.data?.rateLimit?.resetAt ?? summary.resetAt);
        const rl = res.data?.rateLimit;
        if (rl) {
          summary.cost += rl.cost ?? 0;
          summary.remaining = rl.remaining;
          summary.resetAt = rl.resetAt;
          if (summary.remainingFirst === null) summary.remainingFirst = rl.remaining + (rl.cost ?? 0);
        }
        if (!partial && res.errors?.length) throw new Error(`GraphQL errors: ${failMessage(res)}`);
        return res;
      } catch (e) {
        if (e instanceof SyncStop) throw e;
        if (e instanceof GhError && e.rate?.limited && !e.rate?.secondary) throw new SyncStop('rate-limited', summary.resetAt);
        if (!isSecondary(e)) throw e;
        if (attempt >= MAX_TRIES) throw new SyncStop('secondary-limit', summary.resetAt);
        await clock.sleep(BACKOFF_START_MS * 2 ** (attempt - 1));
      }
    }
  }

  const checkReserve = () => {
    if (summary.remaining !== null && summary.remaining < reserve) throw new SyncStop('rate-reserve', summary.resetAt);
  };

  const failMessage = (res) => (res.errors ?? []).map((e) => e.message).join('; ') || 'no data';

  // All nodes of one issue connection: the first page came with the issue, the rest is paged here.
  async function loadAll(owner, name, node, field) {
    const first = node[field];
    const out = [...first.nodes];
    let page = first.pageInfo;
    while (page?.hasNextPage) {
      const res = await query(CONNECTIONS[field], { owner, name, number: node.number, cursor: page.endCursor });
      const conn = res.data?.repository?.issue?.[field];
      if (!conn) throw new Error(`${field} query failed for ${owner}/${name}#${node.number}: ${failMessage(res)}`);
      out.push(...conn.nodes);
      page = conn.pageInfo;
    }
    return out;
  }

  async function toRow(repo, owner, name, node) {
    return {
      key: `${repo}#${node.number}`,
      repo,
      number: node.number,
      state: lower(node.state),
      title: node.title,
      body: node.body,
      updatedAt: node.updatedAt,
      labels: (await loadAll(owner, name, node, 'labels')).map((l) => l.name),
      assignees: (await loadAll(owner, name, node, 'assignees')).map((a) => a.login),
      comments: (await loadAll(owner, name, node, 'comments')).map((c) => ({ body: c.body, createdAt: c.createdAt })),
      parent: node.parent ? refKey(node.parent) : null,
      subIssues: node.subIssues.nodes.map(refKey),
      blockedBy: node.blockedBy.nodes.map(refKey),
      blocking: node.blocking.nodes.map(refKey),
      closingPrs: (await loadAll(owner, name, node, 'closedByPullRequestsReferences')).map((p) => ({
        number: p.number,
        state: p.state,
        headRefName: p.headRefName,
        repo: p.repository?.nameWithOwner ?? null,
      })),
      managed: true,
    };
  }

  async function syncMeta(entry, owner, name) {
    let cursor = null;
    let first = true;
    const heads = [];
    let defaultBranch = null;
    let text = null;
    for (;;) {
      const res = await query(META_QUERY, cursor ? { owner, name, cursor } : { owner, name });
      const repoNode = res.data?.repository;
      if (!repoNode) throw new Error(`repository query failed: ${failMessage(res)}`);
      if (first) {
        defaultBranch = repoNode.defaultBranchRef?.name ?? null;
        text = repoNode.agentConfig?.text ?? null;
        first = false;
      }
      for (const n of repoNode.refs.nodes) {
        heads.push({ name: n.name, headOid: n.target?.oid ?? null, lastCommitDate: n.target?.committedDate ?? null });
      }
      if (!repoNode.refs.pageInfo.hasNextPage) break;
      cursor = repoNode.refs.pageInfo.endCursor;
    }
    const { bugTracker, error } = parseOverlay(text);
    if (error) summary.overlayErrors.push({ entry: entry.repo, message: error });
    cache.transaction(() => {
      // An invalid overlay keeps the last valid one; the error is still reported.
      const patch = error ? { defaultBranch } : { defaultBranch, bugTracker: bugTracker ? JSON.stringify(bugTracker) : null };
      cache.setRepoState(entry.repo, patch);
      cache.replaceBranchHeads(entry.repo, heads);
    });
    checkReserve();
  }

  async function syncRepo(entry) {
    const repo = entry.repo;
    const [owner, name] = repo.split('/');
    const prev = cache.getRepoState(repo);
    const lastFull = prev?.lastFullSync ? Date.parse(prev.lastFullSync) : Number.NaN;
    let reason = null;
    if (full) reason = 'requested';
    else if (cache.fresh) reason = cache.reason;
    else if (!prev?.hwm) reason = 'no-high-water-mark';
    else if (!(start.getTime() - lastFull <= fullMs)) reason = 'full-sync-due';
    const isFull = reason !== null;
    const info = { repo, mode: isFull ? 'full' : 'incremental', reason, pages: 0, issues: 0 };
    summary.repos.push(info);

    await syncMeta(entry, owner, name);

    const q = issuesQuery(isFull);
    const since = isFull ? null : new Date(Date.parse(prev.hwm) - OVERLAP_MS).toISOString();
    const seen = [];
    let cursor = null;
    for (;;) {
      const vars = { owner, name };
      if (cursor) vars.cursor = cursor;
      if (since) vars.since = since;
      const res = await query(q, vars);
      const conn = res.data?.repository?.issues;
      if (!conn) throw new Error(`issues query failed: ${failMessage(res)}`);
      const rows = [];
      for (const node of conn.nodes) rows.push(await toRow(repo, owner, name, node));
      seen.push(...rows.map((r) => r.key));
      const lastUpdated = rows.at(-1)?.updatedAt ?? null;
      const more = conn.pageInfo.hasNextPage;
      // The high-water mark moves in the same transaction as the page that earned it. A full sync
      // has no usable mark until its last page, so an interrupted full sync starts over.
      cache.transaction(() => {
        for (const row of rows) cache.upsertIssue(row);
        const current = cache.getRepoState(repo)?.hwm;
        if (!isFull && lastUpdated && !(current && Date.parse(current) >= Date.parse(lastUpdated))) {
          cache.setRepoState(repo, { hwm: lastUpdated });
        }
        if (isFull && !more) {
          cache.deleteIssuesNotIn(repo, seen);
          cache.setRepoState(repo, { hwm: startIso, lastFullSync: startIso });
        }
      });
      info.pages += 1;
      info.issues += rows.length;
      summary.pages += 1;
      summary.issues += rows.length;
      checkReserve();
      if (!more) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  const noExtract = () => ({ refs: [] });

  async function syncExternal() {
    const rows = cache.readIssues();
    const graph = buildGraph(rows, { extract: extract ?? noExtract, config: applyOverlays(config, cache) });
    const known = new Set(rows.map((r) => lower(r.key)));
    const wanted = new Map();
    for (const e of graph.edges) {
      if (e.from !== null && !known.has(lower(e.from))) wanted.set(lower(e.from), e.from);
    }
    for (const r of rows) {
      if (!managedSet.has(lower(r.repo)) && lower(r.state) === 'open') wanted.set(lower(r.key), r.key);
    }
    const targets = [];
    for (const key of wanted.values()) {
      const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key);
      if (m) targets.push({ key, owner: m[1], name: m[2], number: Number(m[3]) });
    }
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const body = batch
        .map(
          (t, j) =>
            `r${j}: repository(owner: "${t.owner}", name: "${t.name}") { issueOrPullRequest(number: ${t.number}) { __typename ... on Issue { state title updatedAt } ... on PullRequest { state title updatedAt merged } } }`,
        )
        .join('\n  ');
      const res = await query(`query SyncExternal {\n  ${body}\n  ${RATE}\n}`, {}, { partial: true });
      for (const e of res.errors ?? []) {
        if (e.type !== 'NOT_FOUND') summary.errors.push({ repo: '(external lookup)', message: e.message ?? String(e.type) });
      }
      cache.transaction(() => {
        batch.forEach((t, j) => {
          const node = res.data?.[`r${j}`]?.issueOrPullRequest;
          if (!node) {
            summary.notFound.push(t.key);
            return;
          }
          const isPr = node.__typename === 'PullRequest';
          const repo = `${t.owner}/${t.name}`;
          cache.upsertExternal({
            key: t.key,
            repo,
            number: t.number,
            state: isPr && node.merged ? 'closed' : lower(node.state),
            title: node.title,
            updatedAt: node.updatedAt,
            managed: !isPr && managedSet.has(lower(repo)),
          });
          summary.external += 1;
        });
      });
      checkReserve();
    }
  }

  // The Iteration field and every item of each project that an enabled repo names (ADR 0015). A
  // project write does not move an issue's updatedAt, so the items are read in full on every sync.
  async function syncProject(project) {
    const p = parseProject(project);
    const info = { project: p.name, pages: 0, items: 0, iterations: 0, field: false };
    summary.projects.push(info);
    let cursor = null;
    let field = null;
    let projectId = null;
    const items = [];
    for (;;) {
      const vars = { owner: p.owner, number: p.number };
      if (cursor) vars.cursor = cursor;
      // A project with no Iteration field answers with an error on `field` and the rest of the data.
      const res = await query(PROJECT_ITEMS_QUERY, vars, { partial: true });
      const node = res.data?.repositoryOwner?.projectV2;
      const other = (res.errors ?? []).filter((e) => !isMissingFieldError(e));
      if (!node || other.length > 0) throw new Error(`project query failed: ${failMessage({ errors: other.length > 0 ? other : res.errors })}`);
      if (field === null) {
        field = fieldFromNode(node.field);
        projectId = node.id;
      }
      for (const n of node.items.nodes) {
        const c = n?.content;
        if (!c || typeof c.number !== 'number' || !c.repository) continue;
        items.push({ key: keyOf(c.repository.nameWithOwner, c.number), itemId: n.id, iterationId: n.fieldValueByName?.iterationId ?? null });
      }
      info.pages += 1;
      checkReserve();
      if (!node.items.pageInfo.hasNextPage) break;
      cursor = node.items.pageInfo.endCursor;
    }
    cache.transaction(() =>
      cache.replaceProject(p.name, { projectId, fieldId: field.fieldId, iterations: field.iterations, items, syncedAt: startIso }),
    );
    info.items = items.length;
    info.iterations = field.iterations.length;
    info.field = field.fieldId !== null;
  }

  async function syncProjects() {
    const seen = new Map();
    for (const e of enabled) if (e.project && !seen.has(lower(e.project))) seen.set(lower(e.project), e.project);
    for (const project of seen.values()) {
      try {
        await syncProject(project);
      } catch (e) {
        if (e instanceof SyncStop) throw e;
        summary.errors.push({ repo: project, message: e.message });
      }
    }
  }

  // A repo that left the config (removed, disabled or renamed) keeps no managed rows. Its rows stay
  // as external ones, so an issue that a managed issue names is still looked up below.
  summary.unmanaged = cache.transaction(() => cache.unmanageReposNotIn(enabled.map((e) => e.repo)));

  try {
    for (const entry of enabled) {
      try {
        await syncRepo(entry);
      } catch (e) {
        if (e instanceof SyncStop) throw e;
        summary.errors.push({ repo: entry.repo, message: e.message });
      }
    }
    await syncExternal();
    await syncProjects();
  } catch (e) {
    if (!(e instanceof SyncStop)) throw e;
    summary.stopped = { reason: e.reason, resetAt: e.resetAt };
  }

  const graph = buildGraph(cache.readIssues(), { extract: extract ?? noExtract, config: applyOverlays(config, cache) });
  summary.unresolved = graph.unresolved.length;
  summary.cycles = graph.cycles.length;
  summary.unknownBranches = unknownBranches(cache, config, branchRecord).length;
  return summary;
}
