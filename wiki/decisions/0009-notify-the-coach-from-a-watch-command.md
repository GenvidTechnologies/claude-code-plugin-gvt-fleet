---
type: decision-context
title: 'Notify the coach from a watch command'
description: 'Notify the coach from a watch command'
tags: [decisions]
status: stable
---
# 0009. Notify the coach from a watch command

- **Status:** accepted
- **Date:** 2026-11-06
- **Issue:** #43 (nothing tells the coach that a worker needs it)

## Context

The coach learns that a worker needs it only by running `status`. Nothing tells the coach when a wait begins. The recipient of a notice is the coach session. This was decided on #43. The issue proposed that the session hooks send the notice.

Facts that shaped the decision:

- No documented way exists for a process outside a session to post into another session. The inbox-socket framing and cross-session posting are undocumented.
- Nothing records which session is the coach.
- So a hook can only write a file, and the coach still needs a reader of that file.
- A Monitor tool in the coach session feeds each output line of a command back to the session.

## Decision

**Option B: coach-side `gvt-fleet watch` that reuses the status join, run under Monitor** (chosen). The hook is unchanged, the result agrees with `status` because it is the same function, and it covers `agents:blocked`.

`watch` polls, joins the worker files with `claude agents --json --all` as `status` does, and prints one line for each new wait. The coach runs it under Monitor, so each line reaches the coach session.

- **What a wait is.** A wait is a worker row in the state `needs-you`. It is identified by the worker key and the time the wait began (`since`). An idle prompt that follows a printed turn end of the same worker, with no other state of that worker seen in between, is the same wait. A `Stop` with a non-empty last message and its idle prompt share `since` (ADR 0007). A `Stop` with an empty last message gives its idle prompt its own `since`, so the rule is made on the worker and the turn end, not on `since`.
- **Why not `prompt_id`.** In the live worker files on 2026-11-06, a permission prompt was repeatedly followed by a second permission prompt, or by the turn's `Stop`, with the same `prompt_id`. As the key it would hide real new waits.
- **No return-to-work event.** No hook event marks the return to work, so a transition cannot be seen from the events alone.
- **`agents:blocked`.** The watch covers it only for a session with no live hook record: the agents list shows it blocked and it has no hook record, or only a done one. A session with a live hook record takes its state from the hook. The state has no record time. It notifies only on a change seen between two readable polls, and the `since` of the line is the time of the poll that saw it.

## Compromise

**Option A: the hook appends a notification line to a shared `state/notifications.jsonl`, and the coach tails it under Monitor** (rejected). It changes the hook in every session to gain only latency, and it still needs the coach-side reader. Three more faults:

- To skip the idle prompt, the hook must read the worker file, which ADR 0007 rejected, or guess.
- It would copy the classification into the narrow import set of the hook, so `status` and the notice could disagree.
- It cannot see `agents:blocked`.

**Option C: skill-only, `SendMessage` `notify_when_idle` for each worker** (rejected). It needs no CLI code, but its coverage is unverified and it carries no reason or detail.

**Also rejected:**

- The hook posts to the coach's messaging socket. The socket is undocumented, and the coach is not identified.
- A desktop toast. The user chose the coach session. One PowerShell start was measured at 580 to 666 ms for pwsh 7 and 406 to 452 ms for Windows PowerShell 5.1, and a toast would put a process spawn in the hook.

**Accepted limits.**

- Latency is up to one poll interval.
- A Monitor run lasts at most 30 minutes (source: the Monitor tool documentation of Claude Code, read 2026-11-06; not re-verified), so the coach restarts it with the cursor. A wait in the 5 s margin can print twice. The turn-end memory does not carry over to the next run, so a Stop with an empty last message in one run and its idle prompt in the next print one line each. A repeat is preferred to a miss.

## Consequences

- ADR 0007's "Hook unchanged" stands. The hook and the status line do not change, so no cutover is needed.
- Each poll costs one `claude agents --json --all` call, measured at 972, 981 and 1112 ms (3 samples, 2026-11-06). At the 15 s default that is four calls a minute.
- `COACH_CONTRACT` stays 1 (ADR 0008).
- Open: whether a Monitor line wakes a fully idle coach session is not documented. The user checks it by hand. The coach skill change, in GenvidTechnologies/claude-code-plugin-gvt-fleet, waits for that result.
