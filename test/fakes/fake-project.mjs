// A stateful fake of one GitHub project with an Iteration field, at the gh boundary. It answers the
// operations of lib/projects.mjs and lib/sync.mjs (ProjectField, SyncProject, IssueItems, RepoItems, ItemValue and the
// mutations UpdateIterations, AddProjectItem, SetItemIteration, ClearItemIteration) and applies
// GitHub's rule as probed on 2026-11-12 (#108): an iteration update that leaves out an existing id
// deletes that iteration and clears its items.

import { createFakeGh } from './fake-gh.mjs';

const DAY_MS = 86400000;
const endDay = (it) => new Date(Date.parse(`${it.startDate}T00:00:00Z`) + it.duration * DAY_MS).toISOString().slice(0, 10);

/** Parse the iterations list literal that lib/projects.mjs writes. */
export function parseIterationsLiteral(query) {
  const list = /iterations: \[(.*)\]\}\}\)/s.exec(query)?.[1] ?? '';
  const re = /\{(?:id: ("(?:[^"\\]|\\.)*"), )?title: ("(?:[^"\\]|\\.)*"), startDate: ("[^"]*"), duration: (\d+)\}/g;
  const out = [];
  for (const m of list.matchAll(re)) {
    out.push({ ...(m[1] ? { id: JSON.parse(m[1]) } : {}), title: JSON.parse(m[2]), startDate: JSON.parse(m[3]), duration: Number(m[4]) });
  }
  return out;
}

const arg = (query, name) => {
  const m = new RegExp(`${name}: ("(?:[^"\\\\]|\\\\.)*")`).exec(query);
  return m ? JSON.parse(m[1]) : null;
};

/**
 * @param {{today: string, field?: boolean, iterations?: object[], items?: {key: string, iterationId?: string|null}[],
 *   issues?: Record<string, {state?: string}>, pageSize?: number, tamper?: (op: string, state: object) => void,
 *   extra?: object}} opts
 *   `issues` are the issues GitHub knows, by key (owner/name#N); an item's issue is added to them.
 *   `crossOrg`: the project's owner is not the repositories' owner, so the issue side lists no item.
 */
export function fakeProject({ today, field = true, iterations = [], items = [], issues = {}, pageSize = 100, tamper = null, crossOrg = false, extra = {} }) {
  let n = 0;
  const state = {
    projectId: 'PVT_fake',
    fieldId: field ? 'PVTIF_fake' : null,
    iterations: iterations.map((it) => ({ ...it })),
    items: items.map((it) => ({ id: `PVTI_${++n}`, key: it.key, iterationId: it.iterationId ?? null })),
    issues: {},
    updates: [],
  };
  for (const [key, v] of Object.entries(issues)) state.issues[key] = { id: `I_${key}`, state: 'OPEN', ...v };
  for (const it of state.items) state.issues[it.key] ??= { id: `I_${it.key}`, state: 'OPEN' };

  const iter = (it) => ({ id: it.id, title: it.title, startDate: it.startDate, duration: it.duration });
  const fieldNode = () =>
    state.fieldId
      ? {
          id: state.fieldId,
          configuration: {
            duration: 7,
            iterations: state.iterations.filter((it) => endDay(it) > today).map(iter),
            completedIterations: state.iterations.filter((it) => endDay(it) <= today).map(iter),
          },
        }
      : null;
  // GitHub's answer when the project has no Iteration field (read live on 2026-11-12, #108).
  const missingField = () =>
    state.fieldId
      ? null
      : [{ type: 'NOT_FOUND', path: ['repositoryOwner', 'projectV2', 'field'], message: 'Could not resolve to a Unions::ProjectV2FieldConfiguration with the name Iteration' }];
  const value = (it) => (it.iterationId ? { iterationId: it.iterationId } : null);
  const parseKey = (key) => {
    const m = /^(.+)#(\d+)$/.exec(key);
    return { repo: m[1], number: Number(m[2]) };
  };
  const ok = (data) => ({ data });

  const gh = createFakeGh({
    ...extra,
    ProjectField: () => ({ data: { repositoryOwner: { projectV2: { id: state.projectId, field: fieldNode() } } }, errors: missingField() }),
    SyncProject: (vars) => {
      const start = vars.cursor ? Number(vars.cursor) : 0;
      const page = state.items.slice(start, start + pageSize);
      const more = start + pageSize < state.items.length;
      return { errors: missingField(), data: {
        repositoryOwner: {
          projectV2: {
            id: state.projectId,
            field: fieldNode(),
            items: {
              nodes: page.map((it) => {
                const { repo, number } = parseKey(it.key);
                return { id: it.id, content: { number, repository: { nameWithOwner: repo } }, fieldValueByName: value(it) };
              }),
              pageInfo: { hasNextPage: more, endCursor: more ? String(start + pageSize) : null },
            },
          },
        },
        rateLimit: { cost: 1, remaining: 4900, resetAt: '2026-11-12T13:00:00Z' },
      } };
    },
    IssueItems: (vars) => {
      const key = `${vars.owner}/${vars.name}#${vars.number}`;
      const issue = state.issues[key];
      if (!issue) return { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', message: 'not found' }] };
      // GitHub lists no item of a project whose owner is not the repository's owner (read live 2026-11-16, #143).
      const mine = crossOrg ? [] : state.items.filter((it) => it.key === key);
      return ok({
        repository: {
          issue: {
            id: issue.id,
            state: issue.state,
            projectItems: { nodes: mine.map((it) => ({ id: it.id, project: { id: state.projectId }, fieldValueByName: value(it) })) },
          },
        },
      });
    },
    // The project side, filtered by `repo:<owner/name>`; shapes read live on 2026-11-16 (#143).
    RepoItems: (vars) => {
      if (vars.projectId !== state.projectId) {
        return { data: { node: null }, errors: [{ type: 'NOT_FOUND', path: ['node'], message: `Could not resolve to a node with the global id of '${vars.projectId}'` }] };
      }
      const repo = /^repo:(\S+)$/.exec(vars.q)?.[1]?.toLowerCase();
      const mine = state.items.filter((it) => parseKey(it.key).repo.toLowerCase() === repo);
      const start = vars.cursor ? Number(vars.cursor) : 0;
      const page = mine.slice(start, start + pageSize);
      const more = start + pageSize < mine.length;
      return ok({
        node: {
          items: {
            nodes: page.map((it) => {
              const { repo: r, number } = parseKey(it.key);
              return { id: it.id, content: { number, repository: { nameWithOwner: r } }, fieldValueByName: value(it) };
            }),
            pageInfo: { hasNextPage: more, endCursor: more ? String(start + pageSize) : null },
          },
        },
      });
    },
    ItemValue: (vars) => {
      const item = state.items.find((it) => it.id === vars.id);
      if (!item) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', path: ['node'], message: `Could not resolve to a node with the global id of '${vars.id}'` }] };
      return ok({ node: { id: item.id, project: { id: state.projectId }, fieldValueByName: value(item) } });
    },
    UpdateIterations: (vars, query) => {
      const listed = parseIterationsLiteral(query);
      state.updates.push(listed);
      // GitHub refuses the whole update for an iteration of zero days (probed 2026-11-22, #202, on
      // one that ended today; the message names completed iterations).
      if (listed.some((it) => it.duration < 1)) {
        return { data: { updateProjectV2Field: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updateProjectV2Field'], message: 'Settings completed iterations duration must be greater than 0' }] };
      }
      // An iteration that overlaps one before it is dropped with no error, the same start date
      // included (probed 2026-11-22, #202: of two listed on one day, the second was dropped).
      const kept = [];
      for (const it of [...listed].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        if (kept.length > 0 && it.startDate < endDay(kept.at(-1))) continue;
        kept.push(it);
      }
      const keep = new Set(kept.filter((it) => it.id).map((it) => it.id));
      for (const it of state.items) if (it.iterationId && !keep.has(it.iterationId)) it.iterationId = null;
      state.iterations = kept.map((it) => ({ ...it, id: it.id ?? `it_new_${++n}` }));
      tamper?.('UpdateIterations', state);
      return ok({ updateProjectV2Field: { projectV2Field: { id: state.fieldId } } });
    },
    AddProjectItem: (vars, query) => {
      const contentId = arg(query, 'contentId');
      const key = Object.keys(state.issues).find((k) => state.issues[k].id === contentId);
      // GitHub returns the existing item when the issue is already in the project.
      let item = state.items.find((it) => it.key === key);
      if (!item) {
        item = { id: `PVTI_${++n}`, key, iterationId: null };
        state.items.push(item);
      }
      return ok({ addProjectV2ItemById: { item: { id: item.id } } });
    },
    SetItemIteration: (vars, query) => {
      const item = state.items.find((it) => it.id === arg(query, 'itemId'));
      item.iterationId = arg(query, 'iterationId');
      tamper?.('SetItemIteration', state);
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } });
    },
    ClearItemIteration: (vars, query) => {
      const item = state.items.find((it) => it.id === arg(query, 'itemId'));
      item.iterationId = null;
      return ok({ clearProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } });
    },
  });
  return { gh, state, itemOf: (key) => state.items.find((it) => it.key === key) ?? null };
}
