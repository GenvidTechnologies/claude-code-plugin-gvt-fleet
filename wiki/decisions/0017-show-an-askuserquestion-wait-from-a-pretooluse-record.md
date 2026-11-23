---
type: decision-context
title: 'Show an AskUserQuestion wait from a PreToolUse record'
description: 'Show an AskUserQuestion wait from a PreToolUse record'
tags: [decisions]
status: stable
---
# 0017. Show an AskUserQuestion wait from a PreToolUse record

- **Status:** accepted
- **Date:** 2026-11-13
- **Issue:** workspace #105 (the coach cannot see the question of a worker that waits on an AskUserQuestion call)

## Context

A worker that calls `AskUserQuestion` waits for the user. `status` and `watch` showed that wait as `needs-you` with the reason `notification:permission_prompt` and the detail "Claude needs your permission". The question was lost, and the coach had to attach to the session to read it.

[ADR 0007](0007-resolve-idle-prompt-detail-in-the-reader.md) is the precedent: a notification with no content of its own gets its detail from an earlier record of the same session, resolved in the reader. The hook stays unchanged there. A `permission_prompt` has no earlier record of that kind, because the `Stop` before it belongs to an earlier turn. The hooks are registered at user scope ([ADR 0003](0003-register-session-hooks-at-user-scope.md)), so a new hook entry runs in every Claude Code session on the machine.

Evidence (read live on 2026-11-13, Claude Code 2.1.323):

- The `Notification` hook payload names no tool. Live `permission_prompt` records carry only `notification_type`, `message` and, in `extra`, `transcript_path`, `scratchpad_dir` and `prompt_id`.
- A probe ran a `claude --bg` session with a `PreToolUse` hook whose matcher was `AskUserQuestion`. In one session the hook saw, in this order: a `PreToolUse` event with `tool_name` `AskUserQuestion`, a `tool_input.questions` list (each question has `question`, `header`, `options[].label` and `description`, and `multiSelect`) and a `tool_use_id`; then a `Notification` of type `permission_prompt` ("Claude needs your permission"). A second probe registered the same two hooks for this workspace's hook script and gave the same two records.
- In both probes the question was answered after 30 to 50 s, and the turn then ended with a `Stop`. In the second probe, whose session the workspace's own hooks also recorded, an `idle_prompt` came 63 s after that `Stop`, as for any turn.
- The live worker file of an issue worker shows a longer wait: the question was asked at 18:06:43, the `permission_prompt` came at 18:06:50, and the answer at 18:09:07. No record of that session came between the `permission_prompt` and a `Stop` at 18:18:17, so no `idle_prompt` came during the 137 s wait, and none during the 9 minutes of work after the answer.
- Headless `claude -p` does not offer `AskUserQuestion`.
- Not verified: whether `PostToolUse` fires for `AskUserQuestion` after the answer. The probes did not register a `PostToolUse` hook.

## Decision

`install-hooks` adds a sixth hook entry. The hook script records the questions in a `PreToolUse` record, and the reader pairs that record with the `permission_prompt` that follows it.

- **Hook entry.** `PreToolUse`, in a group with the matcher `AskUserQuestion`. It runs the same `bin/gvt-fleet-hook.mjs` command, with timeout 10. It runs only on an `AskUserQuestion` call. An entry of ours found in a `PreToolUse` group with another matcher, or with no matcher, moves to a group with the matcher `AskUserQuestion`, or is dropped when such a group already holds our entry; the other entries of that group stay. A `hooks.PreToolUse` that is not a list is refused like the other events (exit 2).
- **Record.** The hook writes a `PreToolUse` record with `tool_name` and `tool_use_id`. For `AskUserQuestion` only, it also keeps `questions`: `[{question, header, options, multiSelect}]`, where `options` lists the option labels. The caps are 4 questions, 6 options, 600 characters for a question, 60 for a header and 120 for a label. The record line is capped in bytes (8 KB), so trailing questions are dropped until the list takes at most 6000 bytes; one question at its caps fits, also in 3-byte characters. `tool_input` is not kept in `extra`.
- **Pairing in the reader** (`lib/worker-state.mjs`). The row is `needs-you` with the reason `notification:permission_prompt` when the records of the session read, in order: a `PreToolUse` of `AskUserQuestion`, a `permission_prompt` directly after it, and then only `idle_prompt` records. No `idle_prompt` was seen during a question wait; the rule keeps the question if one comes, because only the answer ends the wait. `detail` is the questions as text, one line per question: `<question> [<label> | <label>]`. `since` is the time of the `permission_prompt`. Any other record of that session ends the pairing. Records of other sessions do not. A `PreToolUse` record that is the latest record of the session means `working`.
- **New key.** `status --json` rows (in `workers` and in `tasks`) and `watch --json` `needs-you` lines carry `questions`: the array above while the worker waits on an `AskUserQuestion` call, and `null` otherwise. The key is always present on this version. An `idle_prompt` during the wait would keep the same `since`, so `watch` would print no second line for it.
- **Coach contract.** `reason` keeps its values. `detail` keeps its key, its type and its documented meaning, the worker's last message or question; as in ADR 0007, a new source for the text of one wait does not change that meaning. `COACH_CONTRACT` stays 2, because adding a key never raises the number ([ADR 0008](0008-add-coach-keys-without-a-new-contract-number.md)). The coach skill tells the wait from a tool permission prompt by `questions` not being `null`. A skill run against an older CLI finds `questions` missing, which means "not reported".

Existing installs get the new entry only when `install-hooks` runs again. Open sessions keep the hooks they read at start, so they restart after the install.

## Compromise

**Chosen: a user-scope `PreToolUse` hook with the matcher `AskUserQuestion` records the questions, and the reader pairs the record with the `permission_prompt` that follows it.** The payload is a documented hook interface, and the hook runs only on that tool. It adds one entry to the user settings, and it adds a node start only on an `AskUserQuestion` call. The hook exits at once when the session is not in a worktree.

**Rejected: read the transcript at status time.** The notification carries `transcript_path`, but the transcript format is not a documented interface, and the transcript of one live worker was 4.5 MB. Every `status` and `watch` poll would read it.

**Rejected: a new `reason` value such as `question`.** It changes the meaning of `reason` for this wait. The contract number would go up, and the plugin would have to ship together with the CLI.

**Rejected, not probed: also record `PostToolUse` to mark the answer.** The probes registered no `PostToolUse` hook, so whether it fires for `AskUserQuestion` was not checked.

**Accepted limits.**

- After the user answers, the row keeps the question until the session writes its next record. No `PostToolUse` record marks the answer. In the live wait above, that was 9 minutes, until the turn ended. A tool permission prompt has the same limit today.
- Not checked: whether a question dismissed with Esc writes a hook record. If it does not, the row keeps the question until the next record.
- The hook is user-scope, so it runs in every Claude Code session on the machine, but only on an `AskUserQuestion` call.

## Consequences

- The coach sees the questions of a waiting worker in `detail` and in `questions`, without attaching to the session.
- `lib/hook-state.mjs` writes a new record shape for `PreToolUse`. Records already on disk are not changed, and a wait that began before the install shows as before.
- `install-hooks` writes six entries. The documentation that names the number of entries follows: "gvt-fleet install-hooks" in `wiki/coordinator/session-state.md` and the undo steps in `wiki/coordinator.md`.
- The rule is documented in "State of a row" and "Accepted limit" in `wiki/coordinator/workers.md`, and the key in "The coach skill contract" (`wiki/coordinator/coach-skill-contract.md`).
- If a later Claude Code version names the tool in the `permission_prompt` payload, or fires `PostToolUse` for `AskUserQuestion`, the pairing and its limits can be revisited with a new decision.
