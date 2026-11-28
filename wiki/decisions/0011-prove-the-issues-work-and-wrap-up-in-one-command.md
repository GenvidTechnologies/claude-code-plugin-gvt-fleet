---
type: decision-context
title: 'Prove the issue''s work and wrap up in one command'
description: 'Prove the issue''s work and wrap up in one command'
tags: [decisions]
status: stable
---
# 0011. Prove the issue's work and wrap up in one command

- **Status:** accepted
- **Date:** 2026-11-06
- **Issue:** workspace #38 (the merge gate) and workspace #40 (the `wrap` command); both are sub-issues of workspace #39
- **Amends:** [0005](0005-prove-the-merge-at-wrap-up-and-record-the-pushed-branch.md)
- **Amended by:** [0014](0014-judge-nothing-to-lose-by-any-remote-and-read-closing-prs-live.md), [0026](0026-pass-the-discard-consent-of-claude-rm-for-a-proven-tip.md)

## Context

ADR 0005 proves the merge of "the branch that the worker pushed", read from `branch.<b>.merge` of the branch checked out in the worktree. That premise is the defect that workspace #38 corrects. A worker can switch to a follow-up branch. The checked-out branch is then not the issue's work. On 2026-11-06 three wrap-ups proved the pull request of a follow-up branch and not the fix pull request.

A probe on Claude Code 2.1.319 showed what `claude rm` protects. It was run in a throwaway sandbox, with one real background session per case.

- `claude rm` deletes only the branch that is checked out in the worktree, and only when the tip of that branch is on a remote-tracking ref. The branch needs no upstream.
- It checks only that branch for unpushed commits. A branch that is not checked out is neither deleted nor checked.
- So the coordinator's gate is the only protection for `worktree-<name>` when another branch is checked out.
- A pushed issue branch that is checked out is deleted by `claude rm`. So `branch-kept` comes from a checked-out follow-up branch, not from squash merges alone.

The HEAD reflog of a worktree lists the branches that were switched to in that worktree only. This was checked in a sandbox.

Workspace #40 asks for one command that goes from a merged pull request to a released claim. Before it, the coach ran `worktree remove --require-merged`, then possibly `worktree finish`, then `release`. A rerun after full success exited 1, because `release` found nothing to release.

## Decision

**Option A (chosen): one gate with a pure proof decision, and `wrap` built from the existing primitives.**

**The gate** (`safetyCheck` in `lib/worktrees.mjs`) checks three sets of branches. This applies in every mode, plain `remove` included.

- The checked-out branch keeps its rule: its commits are on its upstream, or a merged pull request has its tip as head.
- The issue branch `worktree-<name>`, when it is not checked out: its commits are on a remote-tracking branch, or a merged pull request has its tip as head.
- The worked branches: other local branches that the HEAD reflog of the worktree shows were checked out there. The default branch and any branch checked out in another worktree are excluded. Their commits must be on a remote-tracking branch, with no waiver. A pushed one is reported in `otherBranches` and is not deleted.

**The proof rules** are a pure function, `decideProof` in `lib/merge-proof.mjs`. It runs under `--require-merged`, which `wrap` always sets.

- The tip of the issue branch must be the head of a merged pull request. The pull request is looked up live, by the remote name of the issue branch and among the cached closing pull requests. A merged pull request of another head never satisfies this.
- The gate refuses while any closing pull request of the issue is open, checked live.
- When the issue branch has no commits of its own (its tip is on the default branch), a merged closing pull request is the proof. Such a branch is not refused for having no upstream.
- A failed lookup leaves the work unproven. A detached HEAD makes no lookup and is refused.

**The result keys** change. The branch record holds the issue branch (its remote name, or the head of the proving pull request when it has no upstream). A follow-up branch is never recorded. `pushedBranch` and `pr` describe the proof of the issue. `proofs` is new: `[{branch, pr}]`. `remove` results also carry `otherBranches`. `COACH_CONTRACT` is raised from 1 to 2.

**`wrap <ref>`** (`lib/wrap.mjs`) composes `removeWorktree`, `finishWorktree` and `releaseClaim`. It takes no flag. It observes the disk first and starts at the step that is still open, so a rerun after any stop is safe.

- It never discards. It never passes `discard` to anything.
- `deleteBranch` takes `{ discardHead, provenTip, proofOnlyOther }`. It uses `-D` only when a merged pull request has the tip as head, the tip re-read just before the delete still equals the proven tip, and `git branch -r --contains <tip>` prints something. No fetch is made first. Otherwise it uses `-d`, and the reason says why `-D` was not used.
- The claim is released last. A kept branch (`branch-kept`, exit 1) withholds the release, and a rerun continues from there.
- A rerun after full success reports `wrapped` with `nothing: true` and exits 0.

## Compromise

The design weighed three ways to build the command.

```
Option A: one gate with a pure proof decision, and `wrap` built from the existing primitives
Option B: `wrap` as its own state machine in `lib/worktrees.mjs`
Option C: a flag on `remove` (`--require-merged --release`) instead of a command
```

**Option B (rejected).** It would copy the lock retry, the half-failure detection and the hook-file rules of the primitives. The two copies drift, and the existing tests cover only one.

**Option C (rejected).** Workspace #40 asks for a command. A flag mixes claim release into a worktree command, and a rerun after success needs a special case inside `remove`.

**Which other branches count.** Three rules were weighed.

- The checked-out branch only (rejected): it is exact for the two observed cases but misses a branch the worker made and then left.
- The HEAD reflog of the worktree (chosen): it also catches a branch the worker switched away from, and it is scoped to this worktree.
- A branch-mtime or "created after `claimedAt`" rule (rejected): concurrent workers share a base clone.

**A kept branch.** Releasing the claim anyway was rejected. `wrap` stops before the release, because the claim is the only record that work is still open on the branch.

**The contract.** Keeping the number at 1 and adding keys (rejected): the old keys would keep naming the follow-up pull request. The skill would read wrong values under an unchanged number. This follows [ADR 0008](0008-add-coach-keys-without-a-new-contract-number.md): an added key needs no new number, but a key whose meaning changes does.

## Relation to 0005

0005 rejected M2, a new read command, partly as "a 19th command". Its real objection was the gap between the check and the removal. That objection does not apply to `wrap`, which proves, removes and releases in one process.

M3 (cache only) stays rejected. Cached closing pull requests now guide the proof, and every one is verified live. M4 (`gh` logic in the skill) stays rejected. The Option M1 and Option 19-A choices of 0005 stand, except where this record redefines the pushed branch.

## Consequences

- The coach skill must accept `coach.contract: 2` and call `wrap`. That change is a follow-up in the plugin repository. Until it ships, a coach on contract 1 stops at `check-config`.
- A closing pull request opened after the last `sync` is not seen by the open-pull-request rule. The tip proof is live, so a merged pull request is still required.
- `-D` trusts a remote-tracking ref that may be stale, because no fetch runs first and `fetch.prune` is false on this machine. The merged-pull-request head check backs it.
- Plain `remove` now refuses unpushed commits on the issue branch and on worked branches. It refused neither before.
- Each lookup is a REST call: one by head branch, and one per cached closing pull request.
