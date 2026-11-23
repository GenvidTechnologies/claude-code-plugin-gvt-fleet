---
type: decision-context
title: 'Judge nothing to lose by any remote branch and read closing pull requests live'
description: 'Judge nothing to lose by any remote branch and read closing pull requests live'
tags: [decisions]
status: stable
---
# 0014. Judge nothing to lose by any remote branch and read closing pull requests live

- **Status:** accepted
- **Date:** 2026-11-10
- **Issue:** workspace #70
- **Amends:** [0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md)

## Context

On 2026-11-10 `wrap` refused seven merged workers. Each refusal had a different shape:

- the worker's own checked-out branch had no cache row (workspace #52);
- a squash-merged follow-up branch tracked `origin/main`;
- HEAD was detached on `origin/main` (workspace #60);
- a follow-up branch had `origin/main` as its upstream;
- a task branch was pushed under another name and had no upstream;
- a commit was cherry-picked onto another merged branch;
- the checked-out branch was not reported in the result.

The gate answered two questions with one rule. The first is whether the issue's work is done. The second is whether the checked-out branch holds anything that the removal would lose. ADR 0011 settled the first: only the issue branch, or a closing pull request, proves the work. The second needs a different test. A branch with all its commits on some remote-tracking branch has nothing to lose, whatever its upstream is. The old test read the upstream, so it failed for a branch that tracked the default branch, for a branch with no upstream, and for a detached HEAD. The old text said "HEAD is detached, so no pull request can be matched to it", and a detached HEAD ended the proof at once.

A second gap showed in the same runs. A full `sync` can add an issue's row again without its closing pull requests. The proof then had nothing to read and refused.

## Decision

1. A merged pull request of the checked-out branch, or of another branch, still never proves an issue branch that has commits of its own. ADR 0011 stays as it is on this point.
2. When the cache holds no closing pull request and nothing else proved the work, the proof reads the closing pull requests of the issue live. It makes one GraphQL call that reads the first 10. Each pull request is still verified by number. A failed read leaves the work unproven. The cache does not change.
3. The checked-out branch and a detached HEAD have nothing to lose when every commit is on some remote-tracking branch, whatever the upstream is. Otherwise the tip must be the head of a merged pull request, looked up by commit (`GET repos/{repo}/commits/{sha}/pulls`; HTTP 422 "No commit found" means there is none). A detached HEAD no longer refuses the proof by itself. The issue branch is still proven by its own merged pull request or by a merged closing pull request.
4. The result reports the checked-out branch as `checkedOutBranch: {branch, tip, kept}`. The coordinator does not delete it itself; `claude rm` may, and `kept` reports what happened.
5. The wrap of a task deletes its branch with `git branch -D` when the branch was checked out, its tip is still the one that was checked, and a remote-tracking branch contains the tip. Otherwise it uses `git branch -d`.

This fits the architecture of ADR 0011: the gate keeps one proof path for the issue branch, and the checked-out branch gets its own loss test beside it. The live read is a fallback inside the proof. It adds no command and no flag.

## Compromise

Quoted design labels below are the labels of the design that led to this record.

- "Eager live read in wrapCommand" is rejected. It would make a GraphQL call on every such wrap, also when the proof already held.
- "Apply the SHA waiver to worked branches too" is not chosen. It does not fix the cherry-pick case, because GitHub does not know an unpushed commit. It would also change what `otherBranches` means.
- "Report the checked-out branch in otherBranches" is rejected. That key lists pushed branches that are not deleted, and `claude rm` can delete the checked-out branch.
- "Keep closed rows across a full sync" is deferred. The live read covers the proof, and the cache would grow without bound (workspace #83).
- Patch equivalence for a cherry-picked commit is deferred (workspace #81).
- Deleting the checked-out branch is deferred (workspace #82).

## Consequences

- There are new GitHub calls:
  - a `--require-merged` run on a detached HEAD now makes the issue-branch lookups;
  - a checked-out branch other than the issue branch, with commits on no remote, is looked up by commit;
  - a failed proof with an empty cache makes one GraphQL call.
- `claude rm` still refuses a checked-out tip that is on no remote-tracking branch. A tip accepted only through a merged pull request found by commit can therefore still end `refused` at the worktree step (ADR 0011).
- The "any remote-tracking branch" rule trusts the local remote-tracking refs. `wrap` does not fetch them. ADR 0011 already accepts this for `-D`.
- A pushed task branch that has an upstream is now deleted with `-D` and not `-d`.
