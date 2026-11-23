---
type: decision-context
title: 'Wrap on a nothing-to-lose proof when no pull request closes the issue'
description: 'Wrap on a nothing-to-lose proof when no pull request closes the issue'
tags: [decisions]
status: stable
---
# 0016. Wrap on a nothing-to-lose proof when no pull request closes the issue

- **Status:** accepted
- **Date:** 2026-11-13
- **Issue:** workspace #103
- **Amends:** [0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md), [0014](0014-judge-nothing-to-lose-by-any-remote-and-read-closing-prs-live.md)

## Context

`wrap` proved a worker's merge only through a merged pull request that closes the issue, or through the issue branch whose tip is the head of a merged pull request (ADR 0011). On 2026-11-12 the worker of an issue in a managed repository merged its work in three pull requests, none with a closing keyword, and the issue was closed by hand. `wrap` refused twice. The issue branch had no commits of its own, and each of the two other branches in the worktree had its tip at the head of a merged pull request. Nothing would have been lost. The only way out was `worktree remove --discard` and `release`, which reads as dropping work.

ADR 0014 answered "may this branch be deleted". This record answers "may this worker be wrapped" when no pull request closes the issue.

## Decision

The rule was decided on the issue on 2026-11-12. When the merge proof refuses, `wrap` of an issue tries a second proof. It accepts when all of these hold:

1. The issue is closed. A coach confirmation does not replace closing it.
2. Every pull request of the same repository that refers to the issue is merged. "Refers to" is a `cross-referenced` event in the issue's timeline, so a closing keyword and a plain `#N` both count. Pull requests of another repository are out of scope.
3. No work is left in the worktree. Every branch it holds (the issue branch, the checked-out branch or a detached HEAD, the other branches it checked out) has no commits of its own, or its tip is the head of a merged pull request. There are no uncommitted or untracked files and no stash entries on those branches.

Otherwise `wrap` refuses, and the reasons of both proofs are in `problems`.

Choices made in the implementation:

- The proof is a fallback. It runs only when the merge proof refuses, so a wrap that the merge proof accepts makes no new GitHub call and does not change.
- Condition 3 for a branch does not check the base of the pull request. The question is whether the commits are kept, as in the unpushed waivers of ADR 0014.
- The claim time (`notBefore`, rule 5 of the merge proof) is not applied to condition 2. On that issue, a pull request of its repository (number 428) refers to the issue and merged on 2026-11-03, probably before the claim. The proof is the closed issue with nothing left to lose, not one pull request carrying the work.
- When the proof holds, the issue branch counts as proven for the `-D` rule. Its tip is on the default branch of origin or at the head of a merged pull request.
- `worktree remove --require-merged` does not use the proof. It is the gate of `wrap` only.

## Compromise

- "Apply the rule to every wrap" is not chosen. Refuse conditions 1 and 2 would then also stop a wrap that a merged closing pull request already proves, for example when another open pull request mentions the issue. That is a change of behaviour for every worker, and it adds two GitHub calls to each wrap.
- "Ask the coach to confirm instead of closing the issue" is rejected by condition 1.
- Deleting the other branches the worktree holds stays with workspace #82.

## Consequences

- A refused wrap of an issue now makes at least one more GitHub call (the issue), and more when the issue is closed (the timeline, then a lookup by commit for each branch with commits of its own). No call is made while files or a stash are left.
- A worker that merged through several pull requests with no closing keyword can be wrapped once the issue is closed.
- An open pull request that mentions a closed issue, for any reason, stops this proof. Merge or close it, or wrap through the merge proof.
- `proofs` can list a pull request with `branch` null and `headSha` null: one that refers to the issue, read from the timeline.
