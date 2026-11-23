// Issue classes (ADR 0015, ADR 0022). Each open managed issue is Now, Next or Later. The class is
// derived from the issue's item in the GitHub project of its repo (the repo setting `project`): an
// item in the Now iteration of the Iteration field is Now, one in the Next iteration is Next, and
// anything else is Later. Now is the iteration that `iteration promote` recorded, or, with no record,
// the one that holds today (`pointers` in lib/iterations.mjs). An issue of a repo with no project is
// Later. classOf, groupByClass and issuesOfClass are pure: rows, readiness entries, the cached
// projects (each with its recorded `nowId`) and the day enter as arguments. setClass is the one
// writer: it sets the item's Iteration value.

import { ClaimError, parseClaimRef } from './claims.mjs';
import { effectiveRepoSettings } from './config.mjs';
import { classOfIteration, isoDay, pointers } from './iterations.mjs';
import { nowPointerOf } from './now-pointer.mjs';
import { readIssueItem, readProjectField, setIssueIteration } from './projects.mjs';
import { applyOverlays } from './sync.mjs';

export const CLASSES = ['now', 'next', 'later'];

const lower = (s) => String(s ?? '').toLowerCase();

function settingsFor(config, repo) {
  const repos = Array.isArray(config?.repos) ? config.repos : [];
  const entry = repos.find((e) => e && typeof e.repo === 'string' && lower(e.repo) === lower(repo)) ?? { repo };
  return effectiveRepoSettings(entry);
}

/** The project of a repo from its config entry, or null. */
export function projectOf(config, repo) {
  return settingsFor(config, repo).project ?? null;
}

/**
 * The class of one cached row, whatever its state.
 * @param {object} row  a cached issue row
 * @param {{config: object, projects: Map<string, {iterations: object[], items: Map<string, string|null>, nowId?: string|null}>, today: string}} ctx
 * @returns {{class: 'now'|'next'|'later', conflict: false, iteration: {id: string, title: string}|null}}
 */
export function classOfRow(row, { config, projects, today }) {
  const project = projectOf(config, row?.repo);
  const p = project ? projects?.get(project) : null;
  if (!p) return { class: 'later', conflict: false, iteration: null };
  const iterationId = p.items.get(lower(row.key)) ?? null;
  const it = iterationId ? p.iterations.find((x) => x.id === iterationId) ?? null : null;
  return {
    class: classOfIteration(iterationId, pointers(p.iterations, today, p.nowId ?? null)),
    conflict: false,
    iteration: it ? { id: it.id, title: it.title } : null,
  };
}

/** Open managed rows with their class, in row order. */
function classified({ rows, entries, config, projects, today }) {
  const byKey = new Map((Array.isArray(entries) ? entries : []).map((e) => [lower(e.key), e]));
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.managed === false || row.managed === 0) continue;
    if (lower(row.state) === 'closed') continue;
    const c = classOfRow(row, { config, projects, today });
    const entry = byKey.get(lower(row.key));
    out.push({
      repo: row.repo,
      key: row.key,
      title: row.title,
      state: row.state,
      ready: entry?.ready ?? false,
      reasons: entry?.reasons ?? [],
      class: c.class,
      conflict: false,
    });
  }
  return out;
}

/**
 * now: the open managed Now issues. `conflict` is always false: it meant "both class labels", and
 * an item holds one iteration (kept so that contract-2 readers keep working, ADR 0015).
 * next: managed repos with at least one open Next issue, sorted by repo.
 */
export function groupByClass(args) {
  const all = classified(args);
  const now = all
    .filter((r) => r.class === 'now')
    .map((r) => ({ key: r.key, title: r.title, ready: r.ready, reasons: r.reasons, conflict: false }));
  const counts = new Map();
  for (const r of all) if (r.class === 'next') counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
  const next = [...counts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  return { now, next };
}

/** Open managed rows of class `cls`, for the --class listing. */
export function issuesOfClass(args, cls) {
  return classified(args)
    .filter((r) => r.class === cls)
    .map(({ key, title, state, ready, reasons, class: c, conflict }) => ({ key, title, state, ready, reasons, class: c, conflict }));
}

/**
 * Set the class of one issue through its project item: now puts it in the Now iteration, next in
 * the Next one, later clears its Iteration value. The field is read live, so the iterations are
 * GitHub's, not the cache's; `nowPointers` holds the recorded Now of each project (ADR 0022). An issue that is not in the project is added to it first. The value is
 * read back, then written to the cache.
 * A closed issue is refused, and so is a class whose iteration does not exist (no Now or no Next).
 * Throws ClaimError (exit 64) for a bad ref or class, and ClaimError (exit 2) when the repo has no
 * project in the config.
 * @returns {Promise<{key: string, status: 'changed'|'noop'|'refused'|'failed', class: string, previous: string, project: string, iteration: {id: string, title: string}|null, addedToProject: boolean, cached: boolean, reason?: string}>}
 */
export async function setClass({ gh, config: rawConfig, now = new Date(), nowPointers = new Map() }, { cache, key, target }) {
  if (!CLASSES.includes(target)) throw new ClaimError(`unknown class "${target}" (use now, next or later)`);
  const config = applyOverlays(rawConfig, cache);
  const ref = parseClaimRef(key, config);
  const project = projectOf(config, ref.repo);
  if (!project) throw new ClaimError(`${ref.repo}: no project in the config; set "project" on its entry`, 2);
  const today = isoDay(now);
  const base = { key: ref.key, class: target, previous: 'later', project, iteration: null, addedToProject: false, cached: false };

  let field;
  let item;
  try {
    field = await readProjectField(gh, project);
    if (!field.fieldId) return { ...base, status: 'refused', reason: `project ${project} has no Iteration field` };
    item = await readIssueItem(gh, { repo: ref.repo, number: ref.number, projectId: field.projectId });
  } catch (e) {
    return { ...base, status: 'failed', reason: `cannot read the issue or the project: ${e.message}` };
  }
  const ptrs = pointers(field.iterations, today, nowPointerOf(nowPointers, project));
  base.previous = classOfIteration(item.iterationId, ptrs);
  if (item.state === 'closed') return { ...base, status: 'refused', reason: 'the issue is closed' };
  const want = target === 'now' ? ptrs.now : target === 'next' ? ptrs.next : null;
  if (target !== 'later' && !want) return { ...base, status: 'refused', reason: `project ${project} has no ${target === 'now' ? 'current' : 'next'} iteration` };
  base.iteration = want ? { id: want.id, title: want.title } : null;
  // Later keeps an item that is in a planned or completed iteration: it is Later already.
  const wantId = want ? want.id : base.previous === 'later' ? item.iterationId : null;

  // Only a project that sync has read is cached: a lone item would not make the class readable.
  const cacheIt = (itemId, iterationId) => {
    if (cache.getProject(project) === null) return false;
    cache.transaction(() => {
      cache.replaceProject(project, { projectId: field.projectId, fieldId: field.fieldId, iterations: field.iterations });
      cache.setProjectItem(project, ref.key, itemId, iterationId);
    });
    return true;
  };
  // An issue outside the project is Later already: later does not add it.
  if (item.itemId ? item.iterationId === wantId : wantId === null) {
    return { ...base, status: 'noop', cached: item.itemId ? cacheIt(item.itemId, item.iterationId) : false };
  }
  const r = await setIssueIteration(gh, {
    repo: ref.repo,
    number: ref.number,
    projectId: field.projectId,
    fieldId: field.fieldId,
    issueId: item.issueId,
    itemId: item.itemId,
    iterationId: wantId,
  });
  base.addedToProject = r.added;
  if (r.status !== 'changed') return { ...base, status: 'failed', reason: r.reason };
  return { ...base, status: 'changed', cached: cacheIt(r.itemId, r.iterationId) };
}
