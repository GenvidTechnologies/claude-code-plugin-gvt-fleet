// The nothing-to-lose proof of `wrap` (#103): the fallback that runs when the merge proof of decideProof refuses.
// It proves that wrapping the worker loses nothing, not that one pull request carried the work:
//   1. the issue is closed;
//   2. every pull request of the same repository that refers to the issue (a `cross-referenced` event in the issue's
//      timeline) is merged;
//   3. every branch the worker holds has no commits of its own, or its tip is the head of a merged pull request.
// The caller checks the rest of condition 3 (no uncommitted or untracked files, no stash) before it asks for this proof.

import { prSummary } from './merge-proof.mjs';

const PAGE = 100;
// A guard against a timeline that never ends; 2000 events is far more than any issue here has.
const MAX_PAGES = 20;

const sameText = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const errText = (e) => e?.message ?? e;
const sha7 = (s) => String(s ?? '').slice(0, 7);

/**
 * Read the state of one issue and the pull requests of the same repository that refer to it.
 * Two REST calls at least: `GET repos/{repo}/issues/{n}`, then, only when the issue is closed, the timeline
 * (`GET repos/{repo}/issues/{n}/timeline`, 100 events per page, read until a short page).
 * Returns `{ state, prs: [{number, state: 'merged'|'open'|'closed', mergedAt}] }` or `{ error }`. `prs` is `[]` for an open issue.
 */
export async function readIssueRefs(gh, repo, number) {
  try {
    const { data: issue } = await gh.rest('GET', `repos/${repo}/issues/${number}`);
    const state = issue?.state ?? null;
    if (state !== 'closed') return { state, prs: [] };
    const prs = new Map();
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return { error: new Error(`the timeline of ${repo}#${number} has more than ${MAX_PAGES * PAGE} events`) };
      const { data } = await gh.rest('GET', `repos/${repo}/issues/${number}/timeline?per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(data)) return { error: new Error(`the timeline of ${repo}#${number} is not an array`) };
      for (const e of data) {
        const src = e?.event === 'cross-referenced' ? e.source?.issue : null;
        if (!src?.pull_request || !sameText(src.repository?.full_name, repo)) continue;
        const mergedAt = src.pull_request.merged_at ?? null;
        prs.set(src.number, { number: src.number, state: mergedAt ? 'merged' : src.state, mergedAt });
      }
      if (data.length < PAGE) break;
    }
    return { state, prs: [...prs.values()].sort((a, b) => a.number - b.number) };
  } catch (error) {
    return { error };
  }
}

/**
 * Decides the nothing-to-lose proof. Facts:
 *   key       the issue key, for the messages
 *   refs      the result of readIssueRefs
 *   branches  [{branch, tip, ownCommits, lookup}]: every branch the worker holds (the issue branch, the checked-out branch or
 *             a detached HEAD, the other branches it checked out). `lookup` is `{prs}` or `{error}` from the pull request
 *             lookup by the tip, or null when none ran (a branch with no commits of its own needs none).
 * Returns { problems, proofs: [{branch, pr}], proven: Set of the branch names that passed }.
 * `proofs` lists the merged pull requests that refer to the issue (`branch` null), then the one at each branch tip.
 */
export function decideNothingToLose({ key, refs, branches = [] }) {
  const problems = [];
  const proofs = [];
  const proven = new Set();
  if (refs?.error) return { problems: [`cannot read ${key} and the pull requests that refer to it: ${errText(refs.error)}`], proofs, proven };
  if (refs?.state !== 'closed') return { problems: [`${key} is ${refs?.state ?? 'in an unknown state'}`], proofs, proven };
  for (const p of refs.prs ?? []) {
    if (p.state === 'merged') proofs.push({ branch: null, pr: { number: p.number, state: 'merged', mergedAt: p.mergedAt, headSha: null } });
    else problems.push(`pull request #${p.number} refers to ${key} and is ${p.state === 'open' ? 'open' : 'closed without merge'}`);
  }
  for (const b of branches) {
    if (!b.ownCommits) {
      proven.add(b.branch);
      continue;
    }
    const merged = (b.lookup?.prs ?? []).find((p) => p.merged_at && b.tip && p.head?.sha === b.tip);
    if (merged) {
      proven.add(b.branch);
      // A pull request that also refers to the issue keeps one entry, now with its branch.
      const entry = { branch: b.branch, pr: prSummary(merged) };
      const i = proofs.findIndex((x) => x.pr.number === merged.number);
      if (i >= 0) proofs[i] = entry;
      else proofs.push(entry);
    } else if (b.lookup?.error) {
      problems.push(`cannot look up the pull requests of ${b.branch} at ${sha7(b.tip)}: ${errText(b.lookup.error)}`);
    } else {
      problems.push(`${b.branch} has commits of its own and its tip ${sha7(b.tip)} is the head of no merged pull request`);
    }
  }
  return { problems, proofs, proven };
}
