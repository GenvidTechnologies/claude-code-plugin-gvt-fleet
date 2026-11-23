// GitHub project access for the Iteration field (ADR 0015). A project is named "owner/number".
// Reads are lean paged GraphQL queries (never `gh project item-list`, which fetches every body and
// hits the secondary rate limit). Each writer reads back what it wrote.

import {
  ITERATION_FIELD,
  assertKeepsEveryId,
  assertValidLayout,
  compareLayout,
} from './iterations.mjs';

const PROJECT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([1-9][0-9]*)$/;

export function parseProject(name) {
  const m = PROJECT_RE.exec(String(name ?? ''));
  if (!m) return null;
  return { owner: m[1], number: Number(m[2]), name: `${m[1]}/${m[2]}` };
}

export const isProjectName = (name) => parseProject(name) !== null;

const ITER = 'id title startDate duration';
const FIELD = `field(name: "${ITERATION_FIELD}") { ... on ProjectV2IterationField { id configuration { duration iterations { ${ITER} } completedIterations { ${ITER} } } } }`;
const RATE = 'rateLimit { cost remaining resetAt }';

/** The project query of sync: the field on the first page, the items on every page. */
export const PROJECT_ITEMS_QUERY = `query SyncProject($owner: String!, $number: Int!, $cursor: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id
        ${FIELD}
        items(first: 100, after: $cursor) {
          nodes {
            id
            content { ... on Issue { number repository { nameWithOwner } } }
            fieldValueByName(name: "${ITERATION_FIELD}") { ... on ProjectV2ItemFieldIterationValue { iterationId } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
  ${RATE}
}`;

const FIELD_QUERY = `query ProjectField($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id ${FIELD} } } }
}`;

const iterOf = (n) => ({ id: n.id, title: n.title, startDate: n.startDate, duration: n.duration });

/** Field node -> {fieldId, defaultDuration, iterations (all, completed included)}, or nulls when absent. */
export function fieldFromNode(node) {
  if (!node || !node.id || !node.configuration) return { fieldId: null, defaultDuration: null, iterations: [] };
  const c = node.configuration;
  return {
    fieldId: node.id,
    defaultDuration: c.duration ?? null,
    iterations: [...(c.completedIterations ?? []), ...(c.iterations ?? [])].map(iterOf),
  };
}

const errText = (res) => (res.errors ?? []).map((e) => e.message).join('; ');

/**
 * True for the error GitHub returns when the project has no field of that name: `field(name:)`
 * fails with "Could not resolve to a Unions::ProjectV2FieldConfiguration with the name …" on the
 * path …projectV2.field, and the rest of the data comes back (seen 2026-11-12, #108).
 */
export function isMissingFieldError(e) {
  const p = Array.isArray(e?.path) ? e.path : [];
  // Keyed on the type and the path, not on the message text, which GitHub may reword. An item's
  // fieldValueByName for a missing field is null with no error (checked live, #108).
  return e?.type === 'NOT_FOUND' && p.at(-1) === 'field' && p.at(-2) === 'projectV2';
}

/**
 * Read the Iteration field of a project, live.
 * @returns {Promise<{project: string, projectId: string, fieldId: string|null, defaultDuration: number|null, iterations: object[]}>}
 */
export async function readProjectField(gh, project) {
  const p = parseProject(project);
  if (!p) throw new Error(`not a project name: ${project} (use owner/number)`);
  const res = await gh.graphql(FIELD_QUERY, { owner: p.owner, number: p.number });
  const node = res.data?.repositoryOwner?.projectV2;
  const other = (res.errors ?? []).filter((e) => !isMissingFieldError(e));
  if (!node || other.length > 0) throw new Error(`cannot read project ${project}: ${errText({ errors: other }) || errText(res) || 'not found'}`);
  return { project: p.name, projectId: node.id, ...fieldFromNode(node.field) };
}

const lit = (s) => JSON.stringify(String(s));

/** The GraphQL list literal of an iteration layout. Ids are passed for every existing iteration. */
export function iterationsLiteral(list) {
  return `[${list
    .map((it) => `{${it.id ? `id: ${lit(it.id)}, ` : ''}title: ${lit(it.title)}, startDate: ${lit(it.startDate)}, duration: ${Number(it.duration)}}`)
    .join(', ')}]`;
}

/**
 * Write a whole iteration layout and read it back. `before` is the layout read just before; every id
 * in it must be in `layout`, and the layout must be one that GitHub keeps whole (no iteration under
 * one day, no overlap). Both are checked here before the write. `applied` is true when GitHub took
 * the update with no error, even if the readback then failed.
 * @returns {Promise<{status: 'changed'|'failed', applied: boolean, iterations: object[], problems: string[], reason?: string}>}
 */
export async function writeIterations(gh, { project, fieldId, defaultDuration }, before, layout) {
  assertKeepsEveryId(before, layout);
  assertValidLayout(layout);
  const first = [...layout].sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const mutation = `mutation UpdateIterations {
  updateProjectV2Field(input: {fieldId: ${lit(fieldId)}, iterationConfiguration: {startDate: ${lit(first.startDate)}, duration: ${Number(defaultDuration ?? 7)}, iterations: ${iterationsLiteral(layout)}}}) {
    projectV2Field { ... on ProjectV2IterationField { id } }
  }
}`;
  let res;
  try {
    res = await gh.graphql(mutation);
  } catch (e) {
    return { status: 'failed', applied: false, iterations: before, problems: [], reason: e.message };
  }
  if (res.errors?.length) return { status: 'failed', applied: false, iterations: before, problems: [], reason: errText(res) };
  let back;
  try {
    back = await readProjectField(gh, project);
  } catch (e) {
    return { status: 'failed', applied: true, iterations: before, problems: [], reason: `readback: ${e.message}` };
  }
  const problems = compareLayout(layout, back.iterations);
  return problems.length > 0
    ? { status: 'failed', applied: true, iterations: back.iterations, problems, reason: `readback: ${problems.join('; ')}` }
    : { status: 'changed', applied: true, iterations: back.iterations, problems };
}

const VALUE = `fieldValueByName(name: "${ITERATION_FIELD}") { ... on ProjectV2ItemFieldIterationValue { iterationId } }`;

const ITEMS_OF_ISSUE = `query IssueItems($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id state
      projectItems(first: 50, includeArchived: true) {
        nodes { id project { id } ${VALUE} }
      }
    }
  }
}`;

// The project side of the lookup. GitHub leaves an item out of the issue's projectItems when the
// project's owner is not the repository's owner (read live on 2026-11-16, #143), so an issue that
// the issue side does not place in the project is looked for in the project's own items, filtered
// by repository. The filter returns the repo's items only; the issue is matched here by number.
const ITEMS_OF_REPO = `query RepoItems($projectId: ID!, $q: String!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor, query: $q, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        nodes { id content { ... on Issue { number repository { nameWithOwner } } } ${VALUE} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ITEM_VALUE = `query ItemValue($id: ID!) {
  node(id: $id) { ... on ProjectV2Item { id project { id } ${VALUE} } }
}`;

const MAX_ITEM_PAGES = 50;

/** The issue's item in the project, read from the project side: {itemId, iterationId} or null. */
async function findRepoItem(gh, { repo, number, projectId }) {
  const vars = { projectId, q: `repo:${repo}` };
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const res = await gh.graphql(ITEMS_OF_REPO, vars);
    const items = res.data?.node?.items;
    if (!items || res.errors?.length) throw new Error(`cannot read the items of ${repo} in the project: ${errText(res) || 'not found'}`);
    const item = (items.nodes ?? []).find(
      (n) => n?.content?.number === number && String(n.content.repository?.nameWithOwner ?? '').toLowerCase() === repo.toLowerCase(),
    );
    if (item) return { itemId: item.id, iterationId: item.fieldValueByName?.iterationId ?? null };
    if (!items.pageInfo?.hasNextPage) return null;
    vars.cursor = items.pageInfo.endCursor;
  }
  throw new Error(`cannot read the items of ${repo} in the project: more than ${MAX_ITEM_PAGES} pages`);
}

/**
 * The issue's item in `projectId`: {issueId, state, itemId|null, iterationId|null}. The issue side
 * answers for a project of the repository's owner; any other miss is checked on the project side.
 */
export async function readIssueItem(gh, { repo, number, projectId }) {
  const [owner, name] = repo.split('/');
  const res = await gh.graphql(ITEMS_OF_ISSUE, { owner, name, number });
  const issue = res.data?.repository?.issue;
  if (!issue) throw new Error(`cannot read ${repo}#${number}: ${errText(res) || 'not found'}`);
  const base = { issueId: issue.id, state: String(issue.state).toLowerCase() };
  const item = (issue.projectItems?.nodes ?? []).find((n) => n?.project?.id === projectId) ?? null;
  if (item) return { ...base, itemId: item.id, iterationId: item.fieldValueByName?.iterationId ?? null };
  const found = await findRepoItem(gh, { repo, number, projectId });
  return { ...base, itemId: found?.itemId ?? null, iterationId: found?.iterationId ?? null };
}

/** The Iteration value of one item, read by its id. Throws when it is not an item of `projectId`. */
export async function readItemIteration(gh, { itemId, projectId }) {
  const res = await gh.graphql(ITEM_VALUE, { id: itemId });
  const node = res.data?.node;
  if (!node?.id || res.errors?.length) throw new Error(`cannot read item ${itemId}: ${errText(res) || 'not found'}`);
  if (node.project?.id !== projectId) throw new Error(`item ${itemId} is not in the project`);
  return node.fieldValueByName?.iterationId ?? null;
}

/**
 * Set (or clear, with iterationId null) the Iteration value of one issue's item, adding the issue to
 * the project first when it is not in it. Reads the value back.
 * @returns {Promise<{status: 'changed'|'failed', itemId: string|null, added: boolean, iterationId: string|null, reason?: string}>}
 */
export async function setIssueIteration(gh, { repo, number, projectId, fieldId, issueId, itemId, iterationId }) {
  let id = itemId;
  let added = false;
  try {
    if (!id) {
      const r = await gh.graphql(`mutation AddProjectItem { addProjectV2ItemById(input: {projectId: ${lit(projectId)}, contentId: ${lit(issueId)}}) { item { id } } }`);
      id = r.data?.addProjectV2ItemById?.item?.id ?? null;
      if (!id) return { status: 'failed', itemId: null, added, iterationId: null, reason: `cannot add the issue to the project: ${errText(r) || 'no item'}` };
      added = true;
    }
    const m = iterationId
      ? `mutation SetItemIteration { updateProjectV2ItemFieldValue(input: {projectId: ${lit(projectId)}, itemId: ${lit(id)}, fieldId: ${lit(fieldId)}, value: {iterationId: ${lit(iterationId)}}}) { projectV2Item { id } } }`
      : `mutation ClearItemIteration { clearProjectV2ItemFieldValue(input: {projectId: ${lit(projectId)}, itemId: ${lit(id)}, fieldId: ${lit(fieldId)}}) { projectV2Item { id } } }`;
    const w = await gh.graphql(m);
    if (w.errors?.length) return { status: 'failed', itemId: id, added, iterationId: null, reason: errText(w) };
    // Read back by item id: the issue side does not list an item of another owner's project (#143).
    const back = await readItemIteration(gh, { itemId: id, projectId });
    if (back !== (iterationId ?? null)) {
      return { status: 'failed', itemId: id, added, iterationId: back, reason: `readback: the item holds ${back ?? 'no iteration'}` };
    }
    return { status: 'changed', itemId: id, added, iterationId: back };
  } catch (e) {
    return { status: 'failed', itemId: id, added, iterationId: null, reason: e.message };
  }
}
