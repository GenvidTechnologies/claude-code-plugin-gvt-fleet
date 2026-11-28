---
type: decision-context
title: 'Pass the discard consent of claude rm for a proven tip'
description: 'wrap passes the --discard-unpushed value of a refused claude rm back to it once, only for the issue-branch tip that a merged pull request has as its head, and then deletes the branch with -D without a remote-tracking branch.'
tags: [decisions]
status: stable
---
# 0026. Pass the discard consent of claude rm for a proven tip

- **Status:** accepted
- **Date:** 2026-11-28
- **Issue:** #142
- **Amends:** [0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md)

## Context

GitHub deletes a pull request's head branch when the pull request merges. When the worktree's tip is the head of that merged pull request but no remote-tracking branch holds it, `claude rm` reads the tip as unpushed. It refuses with `kept <id> — its worktree is still at …`, names the commit, and offers `--discard-unpushed <commit>@<worktree-id>`. `wrap` had already proven the tip, but it could not finish. The coach pushed the branch back by hand, fetched, ran `wrap`, and deleted the remote branch again, which needs its own approval. The rule of the coach skill is not to run `claude rm` by hand, so the consent that `claude rm` offers was not available to the coach.

0011 says that `wrap` "never discards" and "never passes `discard` to anything". It also requires, for `-D`, that a remote-tracking branch contains the tip. Probe 08 of the workspace repository found that `--discard-unpushed` keeps the branch, so with that rule the wrap still ended `branch-kept`.

The mechanism exists: `worktree remove --discard` passes the reported value to a second `claude rm` (0012, probe 08, Claude Code 2.1.319). `claude rm --help` on Claude Code 2.1.332 still documents `--discard-unpushed <commit>@<worktree-id>` as "pass the value a previous 'claude rm <id>' reported".

Of the two cases in #142, the second (a merge of `main` made after the final pull request merged) has a tip that is the head of no merged pull request. Its proof fails, so it is refused before `claude rm` and is not covered here.

## Decision

**Option 1 of #142 (chosen): `wrap` passes the consent for the proven tip.** For an issue, after `claude rm` refuses, `removeWorktree` (with `consentProvenTip`, which `wrap` sets) reads the reported value and passes it back to `claude rm` once, with the lock retry, when all of these hold:

- the safety check proved the issue-branch tip with a merged pull request whose head is that tip (`provenTip`);
- the issue branch is checked out in the worktree, and its HEAD is that tip;
- the value's commit is that tip (at least 7 characters, and the tip starts with it).

A note names the commit, the pull request and the value. Any other refusal stays `refused`, with no second call.

**The `-D` rule.** After a second `claude rm` that succeeded on this consent, the proof consent of the branch step no longer needs a remote-tracking branch that contains the tip. The tip is the head of a merged pull request, so GitHub keeps its commits under the pull request. Every other case keeps the 0011 rule, so a branch-kept result with `noRemote` still appears when `claude rm` succeeded on its own.

What 0011 meant by "never discards" stands: the commit that `claude rm` is told it may drop is kept on GitHub. `worktree remove` passes no value without `--discard`, and a task gets no consent.

## Compromise

```
Option 1: wrap passes the consent for the proven tip (chosen)
Option 2: wrap pushes the tip back under its old branch name, then deletes that remote branch after the removal
Option 3: docs only: merge main in the worker's worktree before the final pull request merges
```

**Option 2 (rejected).** It makes two GitHub writes for a branch that is already merged, and the remote delete needs its own approval.

**Option 3 (rejected).** It avoids only the first case, and it relies on every worker and coach following it. It is followed already, in the workspace's instructions.

**Waive the remote-tracking condition for every merged-pull-request proof (rejected).** It would also turn the `noRemote` branch-kept of a follow-up branch case into a `-D`. That case needs no consent from `claude rm`, and its hint already names the pull request, so the narrower rule keeps the old behaviour where the issue did not ask for a change.

## Consequences

- A wrap whose tip is the head of the merged final pull request ends `wrapped` after GitHub deleted the head branch, with no push and no remote delete.
- R119 now pins that no value is passed for a commit that the proof does not cover, instead of no value at all.
- The value's format is read by `parseDiscardValue`, as for `worktree remove --discard`. If a later Claude Code changes it, the consent is not passed and the wrap is refused as before.
