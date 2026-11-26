---
type: reference
title: 'The coach skill contract'
description: 'The JSON keys that the coach skill reads from the CLI, the contract number, and when each key is present.'
tags: [command-reference, coach]
status: stable
---
# The coach skill contract

This page is part of the [gvt-fleet command reference](../coordinator.md).

The coach skill drives `gvt-fleet` and reads its JSON output. This section lists the keys the skill reads. For what each command does, follow its link in the table below.

Rules:

1. The skill runs each command with `--json` and reads stdout only. Errors and warnings go to stderr.
2. The contract number is `coach.contract` in the output of `check-config --json`. It comes from `COACH_CONTRACT` in `plugin/cli/lib/dispatch.mjs` and is now 2. The number goes up when a key in the table below is removed, renamed, or changes type or meaning. A coach skill refuses any number other than the one it was written for. Adding a key never raises the number. A skill that reads a key added after the contract it was written for treats a missing key as "not reported". A missing key is not the same as an empty array. See [ADR 0008](../decisions/0008-add-coach-keys-without-a-new-contract-number.md).
3. `test/coach-contract.test.mjs` pins these keys, with one test for each command. To change a key, change that test, this section and the contract number together.

A key is in the contract when the skill reads it in some outcome. It need not appear in every outcome.

| Command | Keys the skill reads |
|---|---|
| [`check-config`](reading.md#gvt-fleet-check-config) | `coach.contract`, `coach.workspaceRepo` |
| [`sync`](reading.md#gvt-fleet-sync) | `errors`, `stopped.reason`, `stopped.resetAt` |
| [`status`](workers.md#gvt-fleet-status) | `agents.ok`, `agents.error`, `workers[].key`, `state`, `reason`, `detail`, `questions`, `lease.state`, `session.agentsState`, `session.shortId`, `issue.title`, `issue.state`, `issue.closingPrs`, `tasks[].key`, `tasks[].state`, `tasks[].reason`, `tasks[].detail`, `tasks[].questions`, `tasks[].lease.state`, `tasks[].session.agentsState`, `tasks[].session.shortId` |
| [`watch`](workers.md#gvt-fleet-watch) | `event`, `key`, `reason`, `detail`, `since`, `questions`, `cursor`, `polls`, `agentsErrors` |
| [`ready`](reading.md#gvt-fleet-ready) | `ready[].key`, `ready[].title`, `untriaged[].repo`, `untriaged[].count`, `untriaged[].keys`, `untriaged[].onlyReason`, `now[].key`, `now[].title`, `now[].ready`, `now[].reasons`, `now[].conflict`, `next[].repo`, `next[].count`, `issues[].key`, `issues[].title`, `issues[].ready` |
| [`why`](reading.md#gvt-fleet-why) | `ready`, `reasons` |
| [`dispatch`](workers.md#gvt-fleet-dispatch) | `status`, `key`, `step`, `claim`, `rollback`, `reasons`, `reason`, `shortId`, `path` |
| [`worktree remove`](worktrees.md#gvt-fleet-worktree-remove) | `status`, `problems`, `reason`, `holders`, `hint`, `pushedBranch`, `pr`, `proofs`, `branchRecord`, `nothing` |
| [`worktree finish`](worktrees.md#gvt-fleet-worktree-finish) | `status`, `reason`, `holders`, `hint` |
| [`release`](claims.md#gvt-fleet-release) | `status`, `reason` |
| [`class`](classes.md#gvt-fleet-class) | `status`, `class`, `previous`, `reason` |
| [`wrap`](worktrees.md#gvt-fleet-wrap) | `status`, `steps`, `problems`, `reason`, `holders`, `hint`, `pushedBranch`, `pr`, `proofs`, `otherBranches`, `checkedOutBranch`, `nothing` |

When each key is present:

- `check-config`: `coach.contract` is the number, `coach.workspaceRepo` the workspace repository.
- `sync`: `stopped` is null when the run finished. It is an object `{reason, resetAt}` when the run stopped (exit 75). `errors` is an array of `{repo, message}`.
- `status`: `detail` (and `tasks[].detail`) of a row whose session is `done`, `failed` or `stopped` is the worker's last message from its hook records, as for a live session, or null when the last hook record has none. Before #178 it was always null on such a row. `agents.error` is absent, not null, when `claude agents` is readable. It is a string when it is not readable. Then the exit code is 1 and the rows have `session: null`. `tasks` is always present on this version, and is `[]` when there is no task worker. A skill run against an older CLI finds it missing. `questions` (and `tasks[].questions`) is an array of `{question, header, options, multiSelect}` while the worker waits on an `AskUserQuestion` call, and `null` otherwise. It is always present on this version. A skill run against an older CLI finds it missing, which means "not reported". The wait keeps `reason` `notification:permission_prompt`, so a skill tells it from a tool permission prompt by `questions` not being `null` ([ADR 0017](../decisions/0017-show-an-askuserquestion-wait-from-a-pretooluse-record.md)).
- `watch`: the output is one JSON object per line, and `event` tells the two kinds apart. A `needs-you` line has `key`, `reason`, `detail`, `since` and `questions`; `detail` is `""` when the worker has none. A line with `reason` `agents:done` reports a worker whose session the agents list shows `done` while its claim or task lease is held; its `detail` is the end of the worker's last message (#178). The reason is a new value of `reason`, and no key changes type, so the contract number does not change. `questions` has the meaning and the default given for `status`: an array while the worker waits on an `AskUserQuestion` call, and `null` otherwise. `key` is an issue key or a task id. The last line has `event` `watch-end` and the keys `cursor`, `polls` and `agentsErrors`. Those three appear only on that line. A skill passes `cursor` as `--since` to the next run.
- `ready`: `untriaged` is always present on this version, and is `[]` when nothing is untriaged. A skill run against an older CLI finds it missing. `now` and `next` are always present on this version, and are `[]` when no issue is Now or Next. Since ADR 0015 the class comes from the project Iteration field, not from labels; the keys keep their meaning, and `now[].conflict` is always `false`. `issues` is present with `--all` or `--class`.
- `why`: `ready` is a boolean. `reasons` is an array of `{code, detail}`.
- `dispatch`: `step`, `claim`, `rollback` and `reason` appear on a failed or refused run. `reasons` appears on a refused claim. `key` is always present: the issue key, or on a `--task` run the task id once it is allocated. A `--task` refusal made before allocation reports `owner/name@<slug>`. `step: 'task-active'` and the task id of the active task appear only on a `--task` run.
- `worktree remove`: `problems` appears on `refused`. `holders` and `hint` appear on `half-removed`. `nothing` is `true` when nothing was left to remove. `pushedBranch` is the name of the issue branch on the remote, or null (the issue branch is absent, or no check ran). `pr` is the pull request that proves the work, `{number, state, mergedAt, headSha}`, or null when no lookup ran or none was found. `proofs` is `[{branch, pr}]`, the merged pull requests that proved the work under `--require-merged`, and `[]` otherwise. `otherBranches` (`[{branch, tip}]`, pushed branches the worktree checked out) is not in the contract: the skill does not read it. `branchRecord` is `{recorded, dropped, warning?}`.
- `worktree finish`: `holders` and `hint` appear on `held`.
- `class`: `status` is `changed`, `noop`, `refused` or `failed`. `class` is the requested class and `previous` the class before the change (`now`, `next` or `later`). `reason` appears only on `refused` and `failed`.
- `wrap`: `steps` is always present, as `{proof, worktree, branch, claim}`. `steps.proof` is `not-required` for a task on every outcome. `problems` appears on `refused` when the proof failed. `reason` appears on every status except `wrapped`. `holders` appears on `half-removed` and `held`. `hint` appears on every status except `wrapped`. `nothing` is `true` on a `wrapped` run that found nothing to do. `pushedBranch`, `pr`, `proofs` and `otherBranches` have the meaning and defaults given for `worktree remove`. `checkedOutBranch` is `{branch, tip, kept}` when the worktree had a branch checked out that is not the issue branch or the task branch, and is null when HEAD is that branch, when HEAD is detached, and when no worktree was there to check. A skill run against an older CLI finds it missing.
