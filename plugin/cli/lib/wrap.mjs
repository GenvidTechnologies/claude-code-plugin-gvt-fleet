// `wrap`: prove the issue's work is merged, remove its worktree and branch, then release the claim.
// It is built from the primitives of worktrees.mjs and claims.mjs. The claim is released last, and only after the
// proof passed and the branch is gone or deleted. It never passes `discard` to anything, and it tells `finishWorktree` to ignore a discard consent left on the claim (`noDiscard`).
//
// Every run observes the disk first and starts at the step that is still open, so a rerun after any stop is safe:
//   A  live tree: a running session, a registered folder, or a folder with more than a lone .git file
//   B  leftover: no live tree, but a folder, a git listing, dropped admin dirs or a session remain
//   C  branch only: the issue branch is the only thing left (the state after `branch-kept`)
//   D  nothing on disk

import { releaseClaim } from './claims.mjs';
import { decideProof } from './merge-proof.mjs';
import {
  deleteHookFile,
  finishWorktree,
  holdersHint,
  findPullRequest,
  nothingToLose,
  observe,
  recordPushedBranch,
  removeWorktree,
  safetyCheck,
  setWtState,
  target,
} from './worktrees.mjs';

const WRAPPED = 'wrapped';
const NOT_REQUIRED = 'not-required';

const refusedHint = (key) =>
  `merge the pull request first, or push the work. To drop it, use gvt-fleet worktree remove ${key} --discard, then gvt-fleet release ${key}`;
// The hints after the proof passed name no merge, push or --discard, and ask to close holders only when some were found (#126).
const againHint = (key, holders) => holdersHint(holders, `run gvt-fleet wrap ${key} again`);
const passedHint = (key) =>
  `the safety check passed, so nothing needs merging, pushing or discarding. Fix what the reason names, then run gvt-fleet wrap ${key} again`;
const unsafeHint = (key) => `the coordinator removes only a plain folder. Look at it, fix it, then run gvt-fleet wrap ${key} again`;

/** A, B, C or D, from one observation. */
function classify(o) {
  const entries = o.folder.entries;
  const loneGit = o.folder.exists && entries.every((e) => e === '.git') && (!entries.includes('.git') || o.folder.gitIsFile);
  const registered = o.listed && o.folder.exists;
  if (o.running || registered || (o.folder.exists && !loneGit)) return 'A';
  if (o.session || o.folder.exists || o.listed || o.dropped.length > 0) return 'B';
  if (o.branchExists) return 'C';
  return 'D';
}

/**
 * The proof when the issue branch is absent: the cached closing pull requests, looked up one by one
 * (decideProof rules 2, 3, 5 and 7). A closing pull request proves the work only when it merged into `defaultBranch`, at or
 * after `notBefore` (the claim time). Returns {problems, proofs, pr}.
 */
async function closingProof(deps, t, closingPrs, readClosingPrs, { defaultBranch, notBefore, readIssueRefs }) {
  // With no cached closing pull request, the optional reader asks GitHub once; its `{error}` or empty list leaves the work unproven.
  let closingRead = null;
  if (closingPrs.length === 0 && typeof readClosingPrs === 'function') {
    closingRead = (await readClosingPrs()) ?? null;
    if (closingRead?.prs) closingPrs = closingRead.prs;
  }
  const l2 = [];
  for (const c of closingPrs) l2.push({ number: c.number, ...(await findPullRequest(deps, c.repo ?? t.repo, c.number)) });
  const proof = decideProof({
    requireMerged: true, tip: null, headIsTip: false, ownCommits: false, branch: t.branch, key: t.key, repo: t.repo,
    issueRemote: null, hasUpstream: false, l1: null, l2, closingPrs, closingRead, defaultBranch, notBefore,
  });
  if (proof.problems.length === 0 || typeof readIssueRefs !== 'function') return proof;
  // The nothing-to-lose proof (#103). No branch and no folder is left, so only the issue and its pull requests are read.
  const ntl = await nothingToLose(deps, t, { readIssueRefs, held: [], defaultBranch });
  if (ntl.problems.length > 0) return { ...proof, problems: [...proof.problems, ...ntl.problems.map((p) => `no nothing-to-lose proof: ${p}`)] };
  return { problems: [], proofs: ntl.proofs, pr: ntl.proofs[0]?.pr ?? proof.pr };
}

/**
 * Wrap one issue. Returns {status: 'wrapped'|'refused'|'half-removed'|'held'|'branch-kept'|'failed', key, nothing?, steps,
 * branchFlag?, noRemote?, pushedBranch, pr, proofs, otherBranches, problems?, reason?, holders?, holderSource?, hint?, branchRecord?, notes?}.
 * `steps` is {proof: 'proven'|'earlier'|'refused'|'not-required'|'not-run' ('not-required' only for a task, see wrapTask), worktree: 'removed'|'gone'|'half-removed'|'held'|'refused'|'failed'|'not-run',
 * branch: 'deleted'|'gone'|'kept'|'not-run', claim: 'released'|'released-earlier'|'failed'|'not-run'}.
 * args: {claims, cache, config, clock, closingPrs, key, reposDir, defaultBranch, branchRecord?, stateDir?}
 * `closingPrs` ([{number, repo?}]) are the pull requests the cache says close the issue; the caller reads them.
 * `readClosingPrs` (optional, async, `{prs}` or `{error}`) reads them live from GitHub when the cache list is empty and nothing else proved the work.
 * `readIssueRefs` (optional, async, see readIssueRefs in nothing-to-lose.mjs) turns on the nothing-to-lose proof (#103) when
 * the merge proof refuses: the issue is closed, every pull request of its repository that refers to it is merged, and every
 * branch the worker holds has no commits of its own or its tip at the head of a merged pull request (see safetyCheck).
 * `deps` is the same as for the worktree primitives; `deps.gh` also does the release.
 * With `branchRecord`, the result can carry `branchRecord` ({recorded, dropped, warning?}). On a live tree removeWorktree
 * writes it, just before `claude rm`; on the other classes wrap writes it once the proof passed, before anything is removed.
 * The `wrapped` marker is written to `wt_state` after the branch step; a run that finds nothing on disk and that marker
 * skips the proof (`steps.proof: 'earlier'`).
 */
export function wrapIssue(deps, a) {
  return wrapWorker(deps, a, ISSUE_POLICY);
}

const release = (deps, { claims, cache, config, clock, key }) => releaseClaim({ gh: deps.gh, clock, config }, { claims, cache, key });

/** What is issue-specific in a wrap. */
const ISSUE_POLICY = {
  requireMerged: true,
  // An open issue is wrapped only on a closing pull request, not on one that merged with `Part of #N` (#128).
  requireClosing: true,
  waiveEmpty: false,
  closingProof,
  refusedHint,
  keptHint,
  release,
};

// A task writes nothing to GitHub, so no merge proof is needed: a task that wrote nothing is removed, and a task that committed must have pushed.
const taskRefusedHint = (key) =>
  `push the work, or to drop it use gvt-fleet worktree remove ${key} --discard, then gvt-fleet release ${key}`;

function taskKeptHint(key, branch) {
  return `the lease is still held. Push ${branch} or delete it by hand, then run gvt-fleet wrap ${key} again. gvt-fleet release ${key} releases the lease and leaves the branch.`;
}

const TASK_POLICY = {
  requireMerged: false,
  requireClosing: false,
  waiveEmpty: true,
  closingProof: null,
  refusedHint: taskRefusedHint,
  keptHint: taskKeptHint,
  release,
};

/**
 * Wrap one task worker (key `owner/name@slug.YYYYMMDD.n`). Same result as wrapIssue, with `steps.proof` always `not-required`.
 * A task wrote nothing when it has no uncommitted changes, its branch is absent or has no commits of its own, and every other
 * branch it checked out is on a remote; a task that committed must have pushed. The release makes no GitHub call and nothing
 * is written to config/branches.json. Takes the same args as wrapIssue; `closingPrs`, `readClosingPrs` and `branchRecord` are ignored.
 */
export function wrapTask(deps, a) {
  const { closingPrs, readClosingPrs, readIssueRefs, branchRecord, ...rest } = a;
  return wrapWorker(deps, rest, TASK_POLICY);
}

/**
 * The wrap state machine, shared by every kind of worker. `a` is the argument object of wrapIssue; `policy` is
 * {requireMerged, waiveEmpty, closingProof(deps, t, closingPrs, readClosingPrs, {defaultBranch, notBefore, readIssueRefs}) | null, refusedHint(key), keptHint(key, branch, noRemote, proofs), release(deps, a)}:
 * `requireMerged` goes to the safety gate and to removeWorktree; `waiveEmpty` lets a branch with no commits of its own pass
 * the gate; `closingProof` decides the proof of class C and D (no branch to look at), and a policy without it requires no proof
 * (`steps.proof` is `not-required`); `release` frees the claim and returns the releaseClaim result.
 */
export async function wrapWorker(deps, a, policy) {
  const { claims, closingPrs = [], readClosingPrs, readIssueRefs, key, reposDir, defaultBranch, branchRecord, stateDir } = a;
  const { requireMerged, requireClosing, waiveEmpty, refusedHint, keptHint } = policy;
  const proofRequired = Boolean(policy.closingProof);
  const t = { ...target(reposDir, key), key };
  // The marker lives on the current claim: the active row, else the latest released row, also when that claim never had a worktree
  // path. leaseFor would return an older row of a reopened issue that has one (see leaseFor for why the primitives keep it).
  // A failed row is not a claim, so it never carries the marker: claimIssue reuses it, and the marker would skip the new claim's proof.
  const lease = claims.getActiveLease(key) ?? claims.listLeases({ states: ['released'] }).filter((l) => l.key === key).at(-1) ?? null;
  // A closing pull request merged before this claim is the work of an earlier claim of a reopened issue. With no active or
  // released row, the newest row (a failed claim) gives the time.
  const notBefore = (lease ?? claims.listLeases().filter((l) => l.key === key).at(-1))?.claimedAt ?? null;
  const steps = { proof: proofRequired ? 'not-run' : NOT_REQUIRED, worktree: 'not-run', branch: 'not-run', claim: 'not-run' };
  let info = { pushedBranch: null, pr: null, proofs: [], otherBranches: [], checkedOutBranch: null };
  const extras = {};
  const out = (status, more = {}) => ({ status, key, steps: { ...steps }, ...info, ...extras, ...more });
  const refuseProof = (problems) => {
    if (proofRequired) steps.proof = 'refused';
    else {
      steps.proof = NOT_REQUIRED;
      steps.worktree = 'refused';
    }
    return out('refused', { problems, reason: problems.join('; '), hint: refusedHint(key) });
  };
  const markProven = () => {
    if (steps.proof === 'not-run') steps.proof = proofRequired ? 'proven' : NOT_REQUIRED;
  };

  // Step 0: observe.
  const o = await observe(deps, t);
  if (o.agentsError) return out('failed', { reason: `cannot read claude agents: ${o.agentsError}`, hint: `run gvt-fleet wrap ${key} again` });
  if (o.folder.unsafe) return out('refused', { reason: o.folder.unsafe, hint: unsafeHint(key) });

  // Step 1: classify.
  const cls = classify(o);
  if (cls === 'D' && !claims.listLeases().some((l) => l.key === key)) {
    return out('refused', { reason: `no claim and nothing left to wrap for ${key}`, hint: `check the reference; gvt-fleet status lists the claims` });
  }

  // Step 2: the proof. A live tree is proved inside removeWorktree; the other classes are proved here.
  // With no issue branch and no live folder the gate has nothing to look at: the marker of an earlier wrap, or the closing pull requests, decide.
  const nothingToProtect = !o.branchExists && !(cls === 'A' && o.folder.exists);
  let provenTip = null;
  let recordFrom = { remoteBranch: null }; // what the branch record step reads when the issue branch is gone
  if (nothingToProtect) {
    if (!proofRequired) {
      steps.proof = NOT_REQUIRED;
    } else if (lease?.wtState === WRAPPED) {
      steps.proof = 'earlier';
    } else {
      const cp = await policy.closingProof(deps, t, closingPrs, readClosingPrs, { defaultBranch, notBefore, readIssueRefs });
      info = { ...info, pr: cp.pr, proofs: cp.proofs };
      if (cp.problems.length > 0) return refuseProof(cp.problems);
      steps.proof = 'proven';
    }
  } else if (cls !== 'A') {
    const check = await safetyCheck(deps, t, o, { requireMerged, requireClosing, closingPrs, readClosingPrs, readIssueRefs, defaultBranch, leftoverFolder: true, waiveEmpty });
    info = { pushedBranch: check.remoteBranch, pr: check.pr, proofs: check.proofs, otherBranches: check.otherBranches, checkedOutBranch: null };
    if (!check.safe) return refuseProof(check.problems);
    steps.proof = proofRequired ? 'proven' : NOT_REQUIRED;
    provenTip = check.provenTip;
    recordFrom = check;
  }

  // The branch record, on the paths that removeWorktree does not take: once the proof passed and before anything is removed,
  // as removeWorktree does on a live tree. It drops the coordinator's own `worktree-<name>` entry for the issue and records
  // the branch the work was pushed under, when that branch is still there.
  if (branchRecord && cls !== 'A') extras.branchRecord = await recordPushedBranch(deps, t, key, recordFrom, branchRecord);

  // Steps 3 and 4: the worktree and the branch, inside the primitive.
  if (cls === 'A') {
    const r = await removeWorktree(deps, { claims, key, reposDir, requireMerged, requireClosing, closingPrs, readClosingPrs, readIssueRefs, defaultBranch, branchRecord, stateDir, deleteWithProof: true });
    info = {
      pushedBranch: r.pushedBranch ?? null, pr: r.pr ?? null, proofs: r.proofs?.length ? r.proofs : info.proofs, otherBranches: r.otherBranches ?? [],
      checkedOutBranch: r.checkedOutBranch ?? null,
    };
    if (r.branchRecord) extras.branchRecord = r.branchRecord;
    if (r.notes?.length) extras.notes = r.notes;
    if (r.status === 'refused') {
      if (r.problems) return refuseProof(r.problems);
      markProven();
      steps.worktree = 'refused';
      return out('refused', { reason: r.reason, hint: passedHint(key) });
    }
    if (r.status === 'failed') {
      steps.worktree = 'failed';
      return out('failed', { reason: r.reason, hint: `run gvt-fleet wrap ${key} again` });
    }
    markProven();
    if (r.status === 'half-removed') {
      steps.worktree = 'half-removed';
      return out('half-removed', { holders: r.holders, holderSource: r.holderSource, removalAttempts: r.removalAttempts, reason: r.output, hint: againHint(key, r.holders) });
    }
    steps.worktree = 'removed';
    steps.branch = r.branchStep;
    if (r.branchFlag) extras.branchFlag = r.branchFlag;
    if (r.noRemote) extras.noRemote = true;
    if (r.status === 'branch-kept') {
      return out('branch-kept', { reason: r.reason, hint: keptHint(key, t.branch, r.noRemote, info.proofs) });
    }
  } else if (cls !== 'D') {
    const r = await finishWorktree(deps, { claims, key, reposDir, stateDir, provenTip, noDiscard: true });
    if (r.notes?.length) extras.notes = r.notes;
    if (r.status === 'refused' || r.status === 'failed') {
      steps.worktree = r.status;
      return out(r.status, { reason: r.reason, hint: r.status === 'refused' ? passedHint(key) : `run gvt-fleet wrap ${key} again` });
    }
    if (r.status === 'held') {
      steps.worktree = 'held';
      return out('held', { reason: r.reason, holders: r.holders, holderSource: r.holderSource, removalAttempts: r.removalAttempts, hint: againHint(key, r.holders) });
    }
    const touched = r.steps.folder === 'deleted' || r.steps.rm === 'done' || r.steps.prune === 'done';
    steps.worktree = touched ? 'removed' : 'gone';
    steps.branch = r.branchStep;
    if (r.branchFlag && r.branchStep !== 'gone') extras.branchFlag = r.branchFlag;
    if (r.noRemote) extras.noRemote = true;
    if (r.status === 'branch-kept') return out('branch-kept', { reason: r.reason, hint: keptHint(key, t.branch, r.noRemote, info.proofs) });
  } else {
    steps.worktree = 'gone';
    steps.branch = 'gone';
    // Nothing on disk and the proof passed (or was earlier, or not required): the worker's hook file goes too, as on the
    // `nothing` path of removeWorktree, so `status` drops the row (#147). A failed delete is a note, not a failure.
    const hookNote = deleteHookFile(stateDir, key, t);
    if (hookNote) extras.notes = [...(extras.notes ?? []), hookNote];
  }

  // Step 5: the marker, so that a rerun after a failed release skips the proof.
  if (lease?.wtState !== WRAPPED) setWtState(claims, lease, WRAPPED);

  // Step 6: release, only now.
  const rel = await policy.release(deps, a);
  if (rel.status === 'released') {
    steps.claim = 'released';
    // The release takes the active row, else the latest failed one. That can be newer than `lease`: a re-claim that failed
    // after an earlier wrap. It is the latest released row now, and the one the next run reads, so the marker moves to it.
    // A released row is never reused by claimIssue, so the marker cannot reach a new claim this way.
    if (rel.leaseId && rel.leaseId !== lease?.leaseId) setWtState(claims, { leaseId: rel.leaseId }, WRAPPED);
    return out('wrapped');
  }
  if (rel.status === 'none') {
    const last = claims.listLeases().filter((l) => l.key === key).at(-1);
    if (last?.state === 'released') {
      steps.claim = 'released-earlier';
      return out('wrapped', cls === 'D' ? { nothing: true } : {});
    }
    steps.claim = 'failed';
    return out('failed', { reason: `no claim to release for ${key}`, hint: `run gvt-fleet wrap ${key} again` });
  }
  steps.claim = 'failed';
  return out('failed', { reason: rel.reason ?? `release ${rel.status}`, hint: `run gvt-fleet wrap ${key} again. It retries only the release.` });
}

// `noRemote` is set by deleteBranch when the merge proof held but the tip is on no remote-tracking branch.
function keptHint(key, branch, noRemote, proofs) {
  const number = proofs?.[0]?.pr?.number;
  if (noRemote && number !== undefined) {
    return `the claim is still held. Pull request #${number} is merged and holds the commits of ${branch}, but no remote-tracking branch has them. Delete the branch by hand with git branch -D ${branch} in the base clone, then run gvt-fleet wrap ${key} again. gvt-fleet release ${key} releases the claim and leaves the branch.`;
  }
  return `the claim is still held. Push or merge ${branch}, or delete it by hand, then run gvt-fleet wrap ${key} again. gvt-fleet release ${key} releases the claim and leaves the branch.`;
}
