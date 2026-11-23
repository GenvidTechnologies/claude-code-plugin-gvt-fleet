// The merge proof of a worktree removal as a pure rule table: no git, no gh, no I/O.
// The caller gathers the facts (see decideProof) and this module turns them into problems and proofs.

const sha7 = (s) => String(s ?? '').slice(0, 7);
const errText = (e) => e?.message ?? e;

/** The summary of a pull request as the safety check reports it: {number, state, mergedAt, headSha}. */
export function prSummary(p) {
  return { number: p.number, state: p.merged_at ? 'merged' : p.state, mergedAt: p.merged_at ?? null, headSha: p.head?.sha ?? null };
}

const sameText = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * Decides what the lookups prove. Facts:
 *   requireMerged  true when the gate needs a merged pull request
 *   tip            tip of the issue branch, or null when the branch is absent
 *   headIsTip      the worktree HEAD is on the issue branch (shapes the "not merged at" wording)
 *   ownCommits     the issue branch has commits that are not on the default branch
 *   branch         the issue branch name, `worktree-<name>`
 *   key            the issue key, for the message when nothing closes the branch
 *   repo           the repository (`owner/name`) the issue branch belongs to
 *   issueRemote    the remote name of the issue branch (null when the branch is absent)
 *   hasUpstream    `branch.<b>.merge` is set for the issue branch
 *   l1             `{ prs }` or `{ error }` from the lookup by head branch, or null when it did not run
 *   l2             one entry per cached closing pull request: `{ number, pr }` or `{ number, error }`
 *   closingPrs     the cached closing pull requests (only their count is used)
 *   closingRead    null (no live read), `{ prs }` or `{ error }` from a live read of the closing pull requests of the issue
 *   defaultBranch  the repository default branch; a merged pull request proves the work only when its `base.ref` is this
 *                  branch (rule 7). When it is unknown, no pull request proves the work.
 *   notBefore      optional ISO time: a merged closing pull request of another branch (rule 5) proves the work only when
 *                  it merged at or after this time. `wrap` passes the claim time, so an old pull request of a reopened issue
 *                  does not prove the new claim.
 *   requireClosing optional: with commits of its own (rules 4 and 6), only a closing pull request of the issue (from `l2`)
 *                  proves the work. `wrap` passes it, so a merged pull request that only refers to the issue, with no
 *                  closing keyword, does not release an open issue (#128).
 * Returns { problems, proofs: [{branch, pr}], provenTip, pushedBranch, pr }.
 * Without requireMerged no rule runs: there is no problem and no proof.
 */
export function decideProof(facts) {
  const { requireMerged, tip, headIsTip, ownCommits, branch, key, repo, issueRemote, hasUpstream, defaultBranch, notBefore, requireClosing = false } = facts;
  const l1 = facts.l1 ?? null;
  const l2 = facts.l2 ?? [];
  const closingPrs = facts.closingPrs ?? [];
  const closingRead = facts.closingRead ?? null;
  const problems = [];
  const l1Prs = l1?.prs ?? [];
  const l2Prs = l2.filter((e) => e.pr).map((e) => e.pr);
  const fallback = () => {
    const p = l1Prs.find((x) => x.head?.sha === tip) ?? l1Prs.find((x) => x.merged_at) ?? l1Prs[0];
    return p ? prSummary(p) : null;
  };
  const none = (pr) => ({ problems, proofs: [], provenTip: null, pushedBranch: tip ? issueRemote : null, pr });
  if (!requireMerged) return none(fallback());

  // Rule 2: a failed lookup leaves the work unproven.
  let lookupFailed = false;
  if (l1?.error) {
    problems.push(`cannot look up pull requests from ${issueRemote}: ${errText(l1.error)}`);
    lookupFailed = true;
  }
  if (closingRead?.error) {
    problems.push(`cannot read the closing pull requests of ${key}: ${errText(closingRead.error)}`);
    lookupFailed = true;
  }
  for (const e of l2) {
    if (e.error) {
      problems.push(`cannot look up closing pull request #${e.number}: ${errText(e.error)}`);
      lookupFailed = true;
    }
  }

  // Rule 3: a closing pull request that is still open.
  for (const p of l2Prs) {
    if (!p.merged_at && p.state === 'open') problems.push(`closing pull request #${p.number} from ${p.head?.ref} is open`);
  }

  // Rule 7: a pull request proves the merge only when it merged into the default branch. One merged into a release or
  // integration branch leaves the work off the default branch, so the claim must not be released on it.
  if (!defaultBranch) problems.push(`the default branch of ${repo} is unknown, so no pull request can prove the merge; run gvt-fleet sync`);
  const onDefault = (p) => Boolean(defaultBranch) && p.base?.ref === defaultBranch;
  const intoOther = (what, p) => `${what} #${p.number} from ${p.head?.ref} is merged into ${p.base?.ref ?? 'an unknown branch'}, not into the default branch ${defaultBranch}`;

  let satisfying = null;
  let proofs = [];
  let provenTip = null;
  if (ownCommits) {
    // Rules 4 and 6: only a merged pull request whose head is the tip counts. A merged pull request of another head does not.
    // Under requireClosing it must also be a closing pull request of the issue.
    const mergedAtTip = (p) => p.merged_at && tip && p.head?.sha === tip;
    const atTip = (requireClosing ? l2Prs : [...l1Prs, ...l2Prs]).filter(mergedAtTip);
    satisfying = atTip.find(onDefault) ?? null;
    if (satisfying) {
      proofs = [{ branch: satisfying.head?.ref ?? issueRemote, pr: prSummary(satisfying) }];
      provenTip = tip;
    } else if (atTip.length > 0) {
      if (defaultBranch) problems.push(intoOther('pull request', atTip[0]));
    } else if (!lookupFailed) {
      const where = headIsTip ? `HEAD ${sha7(tip)}` : `the tip of ${branch} ${sha7(tip)}`;
      const seen = l1Prs.find((p) => p.head?.sha === tip) ?? l1Prs.find((p) => p.merged_at) ?? l1Prs[0];
      const notClosing = requireClosing ? l1Prs.find(mergedAtTip) : null;
      // One merged into another branch would not prove the work even as a closing pull request: rule 7 names it.
      if (notClosing && defaultBranch && !onDefault(notClosing)) problems.push(intoOther('pull request', notClosing));
      else if (notClosing) {
        // The cached list is not read live again, so a closing keyword added after the last sync is not seen.
        const sync = closingPrs.length > 0 && !closingRead ? `; if it closes ${key}, run gvt-fleet sync` : '';
        problems.push(`pull request #${notClosing.number} from ${issueRemote} is merged at ${where} but is not a closing pull request of ${key}; the work is proven by the merged pull request that closes ${key}${sync}`);
      } else if (!seen) problems.push(`no pull request from ${issueRemote}`);
      else {
        const s = prSummary(seen);
        problems.push(`pull request #${s.number} (${s.state}) from ${issueRemote} is not merged at ${where}`);
      }
    }
  } else {
    // Rule 5: with no commits of its own, a merged closing pull request of another branch is the proof: merged into the
    // default branch (rule 7), and not before `notBefore` when it is given.
    const merged = l2Prs.filter((p) => p.merged_at);
    const notOlder = (p) => !notBefore || Date.parse(p.merged_at) >= Date.parse(notBefore);
    const good = merged.filter((p) => onDefault(p) && notOlder(p));
    if (good.length > 0) proofs = good.map((p) => ({ branch: p.head?.ref ?? null, pr: prSummary(p) }));
    else if (merged.length > 0) {
      for (const p of merged) {
        if (defaultBranch && !onDefault(p)) problems.push(intoOther('closing pull request', p));
        else if (!notOlder(p)) problems.push(`closing pull request #${p.number} from ${p.head?.ref} was merged at ${p.merged_at}, before the claim at ${notBefore}`);
      }
    } else if (!lookupFailed) {
      const sync = closingPrs.length === 0 && !closingRead ? '; run gvt-fleet sync' : '';
      problems.push(`${branch} has no commits of its own and no closing pull request of ${key} is merged${sync}`);
    }
  }

  let pushedBranch = null;
  if (tip) {
    const sameRepo = satisfying && (l1Prs.includes(satisfying) || sameText(satisfying.head?.repo?.full_name, repo));
    pushedBranch = hasUpstream ? issueRemote : sameRepo && satisfying.head?.ref ? satisfying.head.ref : issueRemote;
  }
  const pr = satisfying ? prSummary(satisfying) : (proofs[0]?.pr ?? fallback());
  return { problems, proofs, provenTip, pushedBranch, pr };
}
