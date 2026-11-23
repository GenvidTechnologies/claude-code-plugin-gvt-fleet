---
type: decision-context
title: 'Resolve the idle prompt detail in the reader'
description: 'Resolve the idle prompt detail in the reader'
tags: [decisions]
status: stable
---
# 0007. Resolve the idle prompt detail in the reader

- **Status:** accepted
- **Date:** 2026-11-06
- **Issue:** workspace #41 (the coach cannot see the worker's question behind an idle prompt)

## Context

The hook writes one record for each event of a session into the worker file. A worker that ends its turn with a question writes a `Stop` record that holds the question in `last_message`. About 60 s later Claude Code sends a `Notification` of type `idle_prompt`. The status row takes its state from the last record of the session. The last record is now the notification, so `detail` read "Claude is waiting for your input" and the question was lost. The coach skill shows `detail` as the worker's last message or question.

Evidence from live hook records (Claude Code 2.1.319, 2026-11-06):

- Every `idle_prompt` record reads "Claude is waiting for your input". Each one directly follows a `Stop` of the same session, about 60 s earlier.
- Every `permission_prompt` record reads "Claude needs your permission". It fires mid-turn, after the user started a new turn. The `Stop` before it belongs to an earlier turn, so its last message does not describe the request.
- No live record carries a `title` or a tool name.

So `idle_prompt` is the only notification type that has no content of its own and follows a `Stop` of the same turn. `agent_needs_input` carries its own content.

## Decision

For an `idle_prompt`, the reader (`lib/worker-state.mjs`) resolves `detail` and `since` from the `Stop` that ended the turn. The reader tracks the turn `Stop` of each session while it walks the last 64 KB of the worker file in one pass. A pure helper, `classifySession`, applies it. `lib/status.mjs` calls the helper for the row's session: the matched session, else the session named by the lease.

- **Which Stop.** The `Stop` of the same session that is the first record found when the session's own records are read back from the notification, other `idle_prompt` records aside. Records of other sessions do not break the walk, and a `Stop` of another session is never used.
- **What is taken.** `detail` is the last message of that `Stop`. `since` is the time of that `Stop`. `reason` stays `notification:idle_prompt`, so the turn-boundary check in `lib/status.mjs` still holds.
- **Fallback.** When another record of the session comes first, the `Stop` is not in the last 64 KB, or it has no last message, `detail` is the notification message and `since` the notification time.
- **Other types.** `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` and `agent_needs_input` keep their own message and time.
- **Hook unchanged.** `lib/hook-state.mjs` and the record format do not change.
- **Coach contract.** `COACH_CONTRACT` stays 1. `detail` keeps its key, type and documented meaning. `since` is not in the contract table, and `reason` does not change.

Decided on workspace #41: only `idle_prompt` takes the `Stop` message; `since` is the time of the `Stop`; and the fallback is the notification message.

## Compromise

**Option B, rejected: the hook enriches the `idle_prompt` record when it writes it.** It adds a read to the hook path of every session, which runs on every event. It changes the record format, and records already on disk stay unfixed.

**Option C, rejected: the reader approach plus a time window.** The `Stop` would count only when it is at most W seconds before the notification. The idle threshold of Claude Code is not documented, so W would be an unvalidated constant. It would catch only the slow cases.

**Accepted limit.** A turn that ends with no `Stop` record leaves the `Stop` of an earlier turn as the first record before the `idle_prompt`, but only when that turn writes no other record the reader counts: a `SessionStart`, `StopFailure`, `SessionEnd` or any notification other than `idle_prompt` of the session clears it. The row then shows that earlier message, with the earlier time in `since`. No hook records the start of a turn, so the reader cannot tell the two cases apart. Whether Claude Code skips the `Stop` hook on a user interrupt is not confirmed.

## Consequences

- The coach sees the worker's question for a row in the state `needs-you` with the reason `notification:idle_prompt`. A done session whose last record is an idle prompt also shows the time of the `Stop`.
- `readWorkerRecords` entries carry a `turnStops` map next to `sessions`. The read stays bounded to the 64 KB tail, in one pass.
- The rule is documented in "State of a row" and "Accepted limit" in `wiki/coordinator/workers.md`, and in the `status` entry of the `HELP` table.
- Another notification type with no content of its own, if Claude Code adds one, needs a new decision. It does not take the `Stop` message by default.
