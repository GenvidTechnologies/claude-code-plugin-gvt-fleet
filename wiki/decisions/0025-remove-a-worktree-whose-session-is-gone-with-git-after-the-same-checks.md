---
type: decision-context
title: 'Remove a worktree whose session is gone with git, after the same checks'
description: 'When no Claude session is listed for a registered worktree whose safety check passed, the coordinator unlocks and removes it with git itself, after checking its submodules and refusing any link inside it.'
tags: [decisions]
status: stable
---
# 0025. Remove a worktree whose session is gone with git, after the same checks

- **Status:** accepted
- **Date:** 2026-11-27
- **Issue:** #143, and outcome 2 of #126
- **Amends:** [0013](0013-retry-a-busy-worktree-removal-in-place.md)

## Context

`worktree remove` and `wrap` removed a worktree only through `claude rm`, which needs a listed session. Twice the session went away and a full worktree stayed (#126, #143). `claude rm` had reported success, but a git lock kept the folder: `locked claude session <name> (pid N)` in one case, `locked initializing` in the other. After that:

- `removeWorktree` refused with `no session is listed for <name>`, after its safety check had passed. The refusal ignored `--discard`.
- `worktree finish` refused, because it deletes only a folder that holds at most a `.git` file.

The coach finished by hand both times. In #126: `git worktree unlock`, then `git worktree remove` without `--force`. In #143 the repository has a submodule, and git refuses that: `fatal: working trees containing submodules cannot be moved or removed`. There the coach checked that the folder held no junction, deleted it, and ran `git worktree prune`. In a second case of #143 the folder was gone and the entry was still `locked initializing`, which `git worktree prune` skips, so the branch delete failed with `cannot delete branch … used by worktree`.

A lock names a pid, but the pid does not tell whether a worker holds it. In #126 Windows had given both pids to other programs, one of them a `claude.exe` process of the Claude desktop app, so even the image name of the pid would have passed.

## Decision

When no session is listed for a worktree that git lists and whose folder exists, and the safety check passed (with no `--discard` waiver), `removeWorktree` removes it with git itself. `wrap` reaches this path through `removeWorktree`, so the proof, the branch step and the release are those of the session path.

1. **No links.** It walks the folder without following links. A symbolic link or junction anywhere in it refuses the removal, and nothing is deleted. A recursive delete that follows a junction would empty its target.
2. **Submodules.** The safety check now looks at each submodule checked out in the worktree (`git submodule status --recursive`), on every path, the session path included: it must have no uncommitted changes, every commit of its HEAD on a remote-tracking branch of the submodule, and no stash entry. These count as work in the folder, so the nothing-to-lose proof cannot waive them.
3. **The lock.** With no session listed, no Claude Code worker of this worktree holds a lock, so a `locked` entry is stale: it is unlocked (`git worktree unlock`), and a note names the lock reason. `worktree finish`, and the leftover step that `removeWorktree` and `wrap` share with it, unlock a listed entry of a missing folder before `git worktree prune` for the same reason.
4. **The removal.** `git worktree remove <path>`, with `--force` only when a submodule is checked out. git refuses such a worktree without `--force`, and `--force` skips git's own check for local changes; the coordinator's check above takes its place. A removal that fails is `refused`, with git's message, and nothing more is deleted.

A `--discard` run with no listed session still refuses when its check failed: a dirty tree is never removed without `claude rm`. When the check passed, `--discard` takes the same path.

## Compromise

```
Option 1: `git worktree remove`, unlocking first (chosen)
Option 2: a recursive delete of the folder, then `git worktree prune` (the manual fix of #143)
Option 3: `claude rm --force-remove-worktree <worktree-id>`
```

**Option 2 (rejected).** It works with submodules, but it deletes before git has looked at anything, and the delete code would have to guard against links on its own. `git worktree remove` keeps the admin folder and the folder in step.

**Option 3 (rejected).** It needs a listed session and a value from an earlier refusal of `claude rm`; here no session is listed.

**The pid of the lock (rejected).** Reading the pid's image name or command line cannot tell a live worker from a reused pid: in #126 one reused pid belonged to `claude.exe`. The session list is the coordinator's record of its workers, so it decides.

## Consequences

- A worktree whose session is gone, with clean, proven work, no longer needs the coach's hand: `wrap` ends `wrapped`, also with a submodule checked out or a lock left behind.
- A lock taken by a `git worktree add` that runs at the same moment (reason `initializing`) would be removed too. `wrap` and `worktree remove` run on a claimed worker whose worktree was created earlier, so this is not expected.
- Every safety check of a worktree with a `.gitmodules` file runs a few more git commands per submodule.
