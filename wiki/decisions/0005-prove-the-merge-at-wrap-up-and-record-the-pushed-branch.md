---
type: decision-context
title: 'Prove the merge at wrap-up and record the pushed branch'
description: 'Prove the merge at wrap-up and record the pushed branch (amended by 0011)'
tags: [decisions]
status: stable
---
# 0005. Prove the merge at wrap-up and record the pushed branch

- **Status:** accepted
- **Date:** 2026-11-05
- **Issue:** #21 (closes #17, #18 and #19; #19 is the origin of the branch-record half)
- **Amended by:** [0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md), which proves the issue branch and not the checked-out branch, and adds `wrap`

## Context

The coach wraps up a worker only after the worker's pull request is merged. Before this change, no command reported whether the pull request of a worker was merged. `worktree remove` accepted a pushed branch that had an open, unmerged pull request.

A second problem came from #19. `worktree create` recorded the local `worktree-<name>` branch in `config/branches.json`. A worker pushes under a branch name of its own choosing. The recorded branch therefore never existed on GitHub, and the branch the worker really pushed went unrecorded. `gvt-loop branches --unknown` showed it as unknown.

Both problems need the name of the branch that the worker pushed (`branch.<b>.merge` in the worktree git config).

## Decision

**Option M1 (chosen): `status` shows the cached issue state, and `worktree remove --require-merged` proves the merge live.**

The check and the removal happen in one command, so nothing can change between them. The check does not depend on GitHub linking the pull request as closing the issue. No command is added.

**Option 19-A (chosen): record the branch at wrap-up, and stop recording at create.**

`worktree remove` records the pushed branch after the safety check passes and before `claude rm`. The rules for the record are:

- It records nothing when `git ls-remote` shows that the branch is gone from the remote. When `git ls-remote` fails, it records the branch with a warning.
- It never writes over an entry that the coordinator did not write.
- It drops the coordinator's old `worktree-<name>` entry for the issue.

A merged branch that GitHub deleted keeps no entry.

**Related choices taken with these.** These were the only alternatives weighed for each of them.

- The turn-boundary exemption for `hook-live-session-gone` (#17). The narrower rule that exempts only a Stop (17-A) was measured on a real hook file and was not enough, because an `idle_prompt` notification follows each Stop.
- The worker hook file is deleted when its worktree is removed (#18). Hiding `records-only` rows behind a flag (18-B) is kept only as a fallback, for the case that a hook writes the file again after removal.
- `check-config --json` has a `coach` block with a contract number.

## Compromise

**Option M2 (rejected): a new read command `gvt-loop pr <ref>`.** It is a 19th command. It leaves a gap between the check and the removal. Hand use of `remove` stays unprotected.

**Option M3 (rejected): cache only (`issue.state` closed, or a MERGED closing pull request).** It depends on closing-keyword links. It is only as fresh as the last `sync`. It cannot tie the pull request to the worktree HEAD. It enforces nothing.

**Option M4 (rejected): the skill runs `gh pr list --head` itself.** The logic would sit in prose that cannot be tested.

**Option 19-B (rejected): keep the create-time entry and replace it at remove.** "Every dispatch then writes an entry for a branch that never exists on GitHub, and the coach commits `branches.json` twice per issue."

**Option 19-C (rejected): `sync` matches unknown branches to pull requests.** "It depends on closing links, and it would make `sync`, a read-only command, a second writer of the config."

## Consequences

- The merge proof needs a GitHub read at removal time.
- A pushed branch with an open pull request is still removable without the flag. The coach skill uses the flag; a person who runs `remove` by hand is not forced to.
- Readiness `existing-branch` now comes from the branch that the worker pushed.
- A coordinator entry written by an older version is dropped at the next `remove` of that issue.
- When `git ls-remote` fails, `remove` records the entry and prints a warning.
