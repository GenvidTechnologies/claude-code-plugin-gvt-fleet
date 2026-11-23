---
type: decision-context
title: 'Share one session liveness rule across status, dispatch, expire and observe'
description: 'Share one session liveness rule across status, dispatch, expire and observe'
tags: [decisions]
status: stable
---
# 0004. Share one session liveness rule across status, dispatch, expire and observe

- **Status:** accepted
- **Date:** 2026-11-04
- **Issue:** workspace #13

## Context

The coordinator must decide whether a worker session is live in several places: `worktree create`, `worktree remove`, `worktree finish`, `expire`, and the commands added for dispatch and status. Before this record, `observe` and the create confirm loop in `lib/worktrees.mjs` matched a listed session by name only. `expireClaims` in `lib/claims.mjs` matched by session id.

The two matched different sessions for the same lease. They also used different sets of dead states.

The hook state alone cannot decide liveness. A dead session that wrote no `SessionEnd` record looks the same as a working one. The list from `claude agents --all` is the source.

Two choices were open: how far the one rule reaches, and what identifies a worker when records from several sources are joined.

## Decision

**Option C1 (recommended): one rule for status, dispatch, `expire` and `observe`, with the confirm loop.**

The rule lives in `lib/sessions.mjs` and is pure. It does no I/O.

- `DEAD_STATES` is `done`, `failed` and `stopped`. A worker is live when the chosen session is not in a dead state.
- `matchSessions(agents, {name, base, sessionId})` matches by name an entry that is not `interactive` and whose `cwd` is at or below the base clone. The comparison ignores case and treats `\` and `/` alike. An entry with no `cwd` never matches by name. When a session id is given, an entry of any kind whose `sessionId` or `id` equals it also matches.
- `pickSession` prefers a live match over a dead copy.
- `observe` and the create confirm loop call the rule without a session id, because they identify a worktree by name. `expireClaims` calls it with the session id of the lease and, when `reposDir` is passed, the worktree name and the base clone.

The rule is documented in [Live workers](../coordinator/workers.md#live-workers).

**Option B1 (recommended): key by worker identity `(repo, worktree name)`, compared in lowercase.** This is the key for joining a lease, a hook file and a listed session into one worker. A lease, a hook file and a listed session each yield a repository and a worktree name.

An unknown agents state counts as live, so a claim is not lost on a value the code does not recognise.

`stopped` counts as dead. A stopped worker does not keep its lease.

## Compromise

**Option C2 (alternative): the helper for new code only; `expire` and `observe` unchanged, rejected.** It gives a smaller diff, and it was rejected for two reasons:

- "`status` and `expire` disagree on cases 7 and 8. The same lease is refreshed by `status` and released by `expire`."
- "`dispatch` inherits the `c3source-58` collision through `createWorktree`."

**Option B2 (alternative): key by `sessionId`, rejected.** `lease.sessionId` is set once, at create. A hook file has no single id. A resume may change the id, and this was an open question. Records that have a hook file but no lease, or that hold another session's id, cannot be keyed by it.

**`stopped` counts as dead, not live.** The alternative is to treat `stopped` as live. A stopped session that is never resumed would then keep its label indefinitely. That contradicts the design rule that a dead session's claim expires. The cost of the chosen option is a worker that was only idle-stopped. It loses its claim.

**Recovery for a resumed worker.** Run a new `dispatch`. The claim is taken again and `createWorktree` adopts the live session.

**An unknown agents state counts as live.** The cost is that a dead session with an unrecognised state keeps its claim. The rule trades that for never losing a claim on a state it does not know.

## Consequences

The change affects existing commands:

- `expire` releases a lease whose session shows `failed` or `stopped`. Before, it refreshed the lease.
- `expire` refreshes a lease whose worker shows under a new session id, matched by name. Before, it released the lease. The name match applies only when the caller passes `reposDir`.
- `worktree remove` no longer runs `claude stop` on a `failed` entry.
- `worktree finish` no longer refuses on a `failed` entry.
- `worktree create` no longer adopts an interactive session that has the same name.

The reference docs and the `HELP` text of each changed command change in the same commit as the code.

A future change to the dead set or the match rule changes all callers at once. That is the intended effect. A new caller must use `lib/sessions.mjs` and must not keep its own copy.
