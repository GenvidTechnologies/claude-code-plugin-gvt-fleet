// A scripted GitHub for the claims tests: per-issue labels and assignees, and whether the label exists in the repo.
import { GhError } from '../../lib/gh.mjs';
import { createFakeGh } from '../fakes/fake-gh.mjs';

export const LABEL = 'in-progress';

export function notFound(what) {
  return new GhError(`gh api failed (1): gh: Not Found (HTTP 404) ${what}`, { code: 1, stderr: 'HTTP 404' });
}

/** What `gh api repos/<r>/commits/<unknown sha>/pulls` fails with, as captured live on 2026-11-10: exit 1, stderr `gh: No commit found for SHA: <sha> (HTTP 422)`. */
export function noCommitFound(sha) {
  return new GhError(`gh api failed (1): gh: No commit found for SHA: ${sha} (HTTP 422)`, {
    code: 1,
    stderr: `gh: No commit found for SHA: ${sha} (HTTP 422)\n`,
  });
}

/**
 * A `cross-referenced` timeline event, in the shape read live from a managed repository's issue on 2026-11-13:
 * `source.issue` carries `number`, `state`, `repository.full_name`, and `pull_request.merged_at` when the source is a pull request.
 * `pr: false` makes the source a plain issue (no `pull_request` key).
 */
export function crossRef(number, { state = 'closed', mergedAt = null, repo = 'acme/app', pr = true } = {}) {
  const issue = { number, state, repository: { full_name: repo } };
  if (pr) issue.pull_request = { url: `https://api.github.com/repos/${repo}/pulls/${number}`, merged_at: mergedAt };
  return { event: 'cross-referenced', source: { type: 'issue', issue } };
}

export function serverError() {
  return new GhError('gh api failed (1): gh: Server Error (HTTP 500)', { code: 1, stderr: 'HTTP 500' });
}

/**
 * A scripted GitHub: per-issue labels and assignees, and whether the in-progress label exists in the repo.
 * `dropLabelAdd` makes the label POST a silent no-op, so a readback can see the difference.
 * `failDelete` makes every DELETE (label removal and assignee removal) fail with an HTTP 500 and change nothing.
 * `extraAssignee` is a login that appears on the issue when the assignee POST lands, as if a second person took it at the same time.
 * `repoLabels` lists other labels that exist in the repo (`state.repoLabels`); a label GET for a name outside that list and not `in-progress` is a 404, and the label-create POST adds its `name`.
 * Each issue takes an optional `state` (the REST issue GET returns 'open' when it is not set). It is kept in `state.issues` only when given, because tests deep-compare those entries.
 * Removing a label the issue does not carry is a 404, as on GitHub, except for `in-progress`, whose removal stays quiet as before.
 * The routes serve any repository; the issues are keyed by number only.
 * `pulls` (off by default) makes the fake answer the pull-request lookups of the gate: `{ byHead: { '<branch>': [pr, ...] }, byNumber: { '<n>': pr } }`.
 * The head lookup is `GET repos/<repo>/pulls?head=<owner>:<branch>&state=all&per_page=100` and returns the list for that branch (empty when none).
 * The number lookup is `GET repos/<repo>/pulls/<number>` and fails with a 404 for a number not in `byNumber`.
 * `pulls.byCommit` is `{ '<sha>': [pr, ...] }` and answers `GET repos/<repo>/commits/<sha>/pulls`; a SHA not in it fails with the 422 of GitHub (`noCommitFound`).
 * `closing` is a list of `{ number, state, headRefName, repository: { nameWithOwner } }` that the `ClaimIssue` query returns as `closedByPullRequestsReferences.nodes` (empty by default).
 * `timeline` is `{ '<n>': [event, ...] }` and answers `GET repos/<repo>/issues/<n>/timeline?per_page=100&page=<p>` with page p of
 * that list, 100 events a page (an empty list for an issue not in it). Build the events with `crossRef`.
 */
export function github({ issues, labelExists = true, dropLabelAdd = false, failDelete = false, extraAssignee = null, repoLabels = [], pulls = null, closing = [], timeline = {} }) {
  const state = {
    labelExists,
    repoLabels: [...repoLabels],
    issues: Object.fromEntries(Object.entries(issues).map(([n, v]) => [n, { labels: [...v.labels], assignees: [...v.assignees], ...(v.state === undefined ? {} : { state: v.state }) }])),
  };
  const issueRe = /^(GET|POST|DELETE) repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/labels|\/assignees)?(?:\/(.+))?$/;
  const labelGetRe = /^GET repos\/[^/]+\/[^/]+\/labels\/([^/]+)$/;
  const labelPostRe = /^POST repos\/[^/]+\/[^/]+\/labels$/;
  const pullsByHeadRe = /^GET repos\/[^/]+\/[^/]+\/pulls\?head=[^&:]+%3A([^&]+)&state=all&per_page=100$/;
  const pullsByCommitRe = /^GET repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/pulls(?:\?per_page=100)?$/;
  const pullsByNumberRe = /^GET repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/;
  const timelineRe = /^GET repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline\?per_page=100&page=(\d+)$/;
  const script = new Proxy(
    {},
    {
      get(_, key) {
        if (key === 'ClaimIssue') {
          return (vars) => {
            const i = state.issues[vars.number];
            return {
              data: {
                repository: {
                  issue: {
                    number: vars.number,
                    state: 'OPEN',
                    title: 'T',
                    body: '',
                    updatedAt: '2026-11-01T00:00:00Z',
                    labels: { nodes: i.labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
                    assignees: { nodes: i.assignees.map((login) => ({ login })), pageInfo: { hasNextPage: false } },
                    comments: { nodes: [], pageInfo: { hasNextPage: false } },
                    parent: null,
                    subIssues: { nodes: [] },
                    blockedBy: { nodes: [] },
                    blocking: { nodes: [] },
                    closedByPullRequestsReferences: { nodes: closing, pageInfo: { hasNextPage: false } },
                  },
                },
                rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-11-03T13:00:00Z' },
              },
            };
          };
        }
        const lm = typeof key === 'string' ? labelGetRe.exec(key) : null;
        if (lm) {
          const name = decodeURIComponent(lm[1]);
          return () => {
            const exists = name === LABEL ? state.labelExists : state.repoLabels.includes(name);
            if (!exists) throw notFound('label');
            return { data: { name } };
          };
        }
        if (typeof key === 'string' && labelPostRe.test(key)) {
          return (body) => {
            const name = body?.name ?? LABEL;
            if (name === LABEL) state.labelExists = true;
            else if (!state.repoLabels.includes(name)) state.repoLabels.push(name);
            return { data: { name } };
          };
        }
        if (pulls && typeof key === 'string') {
          const byHead = pullsByHeadRe.exec(key);
          if (byHead) return () => ({ data: pulls.byHead?.[decodeURIComponent(byHead[1])] ?? [] });
          const byCommit = pullsByCommitRe.exec(key);
          if (byCommit) {
            return () => {
              const prs = pulls.byCommit?.[byCommit[1]];
              if (!prs) throw noCommitFound(byCommit[1]);
              return { data: prs };
            };
          }
          const byNumber = pullsByNumberRe.exec(key);
          if (byNumber) {
            return () => {
              const pr = pulls.byNumber?.[byNumber[1]];
              if (!pr) throw notFound(`pull ${byNumber[1]}`);
              return { data: pr };
            };
          }
        }
        const tl = typeof key === 'string' ? timelineRe.exec(key) : null;
        if (tl) {
          const page = Number(tl[2]);
          return () => ({ data: (timeline[tl[1]] ?? []).slice((page - 1) * 100, page * 100) });
        }
        const m = typeof key === 'string' ? issueRe.exec(key) : null;
        if (!m) return undefined;
        const [, method, n, sub, rest] = m;
        const i = state.issues[n];
        if (method === 'GET' && !sub) {
          return () => ({ data: { number: Number(n), labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((login) => ({ login })), state: i.state ?? 'open' } });
        }
        if (method === 'POST' && sub === '/labels') {
          return (body) => {
            if (!dropLabelAdd) for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l);
            return { data: [] };
          };
        }
        if (method === 'POST' && sub === '/assignees') {
          return (body) => {
            for (const a of [...body.assignees, ...(extraAssignee ? [extraAssignee] : [])]) if (!i.assignees.includes(a)) i.assignees.push(a);
            return { data: {} };
          };
        }
        if (method === 'DELETE' && sub === '/labels') {
          return () => {
            if (failDelete) throw serverError();
            const name = decodeURIComponent(rest);
            // Releasing an issue deletes `in-progress` whether or not it is there, and its callers rely on that being quiet.
            if (name !== LABEL && !i.labels.includes(name)) throw notFound('label');
            i.labels = i.labels.filter((l) => l !== name);
            return { data: [] };
          };
        }
        if (method === 'DELETE' && sub === '/assignees') {
          return (body) => {
            if (failDelete) throw serverError();
            i.assignees = i.assignees.filter((a) => !body.assignees.includes(a));
            return { data: {} };
          };
        }
        return undefined;
      },
    },
  );
  const gh = createFakeGh(script);
  return { gh, state };
}
