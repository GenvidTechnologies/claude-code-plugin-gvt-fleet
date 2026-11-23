---
type: decision-context
title: 'Retry a busy worktree removal in place'
description: 'Retry a busy worktree removal in place'
tags: [decisions]
status: stable
---
# 0013. Retry a busy worktree removal in place

- **Status:** accepted
- **Date:** 2026-11-09
- **Issue:** workspace #60
- **Amends:** none

## Context

Since 2026-11-06, five wraps ended `half-removed` on `EBUSY`. The cases are GenvidTechnologies/claude-code-plugin-gvt-fleet#3 and the workspace repository's #43, #45, #38 and #34. In each case:

- the holder lookup found nothing (`holderSource: tasklist`);
- nothing was closed;
- a plain rerun within about a minute removed the folder through the `worktree finish` path.

In the fifth case (2026-11-09, `wrap` of workspace #34) the coach ran no command in the worktree folder before the wrap, so its own `git -C <worktree>` reads were not involved there. Git in the folder is still a candidate: for a live worktree, the safety check of `wrap` runs `git status` in the folder seconds before the removal. The cause is not known.

A probe on 2026-11-09 showed one way to get the same failure on this Windows machine. A process whose current folder is the leftover folder makes the recursive delete of Node fail with `EPERM`. The delete succeeds once that process exits.

So the failure is transient, and a rerun by hand is the recovery that works. The question is where the command repeats it.

## Decision

```
Option 1: finish in place, with a bounded retry in the removal itself
Option 2: retry `claude rm` only, by extending the lock retry to EBUSY output
```

**Option 1 (chosen).** A removal attempt that fails with `EBUSY` or `EPERM`, with no likely holder found, waits and tries again. There are up to 3 attempts in all, with a wait of 2 seconds and then 5 seconds. Only `EBUSY` and `EPERM` retry. Before each retry the command reads the state again:

- if git still lists the worktree, it runs `claude rm` again;
- if git no longer lists it and the folder holds at most a `.git` file, it deletes the folder through the step that `worktree finish` shares, removes the Claude session if `claude agents` still lists it, and runs `git worktree prune`;
- in any other state, the retry stops.

`worktree finish` has the same retry around its folder delete. `wrap` gets the retry through both paths. The result gains `removalAttempts`, the number of removal attempts. The existing key `attempts` keeps its meaning: the number of `claude rm` calls.

The reason: it repeats the recovery that worked in all five cases, and it covers both removal paths.

A likely holder, `ENOTEMPTY` and `EACCES` do not retry. Waiting does not help with them, so the command reports at once, as before. The safety checks (merge proof, unpushed commits, uncommitted changes) run once, before the first attempt. Between two attempts the command only waits and reads the state. It changes nothing in the worktree. A delete that fails half-way can take the folder's `.git` file; git then marks the entry `prunable`, and the command counts such a folder as not listed, so the next attempt can delete it when it is empty.

## Compromise

**Option 2 (rejected).** Extending the lock retry to `EBUSY` output would only repeat `claude rm`. No observation shows a second `claude rm` succeeding on a half-removed worktree. `worktree finish` would get no retry.

**A wait inside the safety window.** The checks run once, so the state can change between the first attempt and the last. The retry reads the state before each step and stops on a state it does not handle. This keeps the command from deleting a folder that gained content.

## Consequences

- A removal can take up to about 7 seconds longer when the folder stays busy.
- The likely-holder lookup falls back to `tasklist`, which names any running `Code.exe` or `GitExtensions.exe` whatever folder it has open. With VS Code open, a holder is always found, the retry is off, and the result is reported at once, as before.
- A rerun by hand is still needed when the folder stays busy after 3 attempts. The text of the rerun does not change.
- The cause of the `EBUSY` is still unknown. The retry hides it when it clears within about 7 seconds.
- Exit codes do not change.
