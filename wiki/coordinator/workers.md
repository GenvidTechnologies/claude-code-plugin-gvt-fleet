---
type: reference
title: 'Commands: workers'
description: 'The live worker rule and the worker commands: dispatch, status and watch.'
tags: [command-reference]
status: stable
---
# Commands: workers

This page is part of the [gvt-fleet command reference](../coordinator.md).

A worker is a background Claude session that the coordinator starts in a worktree. This section holds the rule that finds a worker, the command that starts one together with its claim, and the command that shows all workers.

## Live workers

`worktree create`, `worktree remove`, `worktree finish` and `expire` find the worker session of a worktree with one rule.

A worker is live when `claude agents --all` lists its session in a state other than `done`, `failed` or `stopped`.

Every `claude agents` call has a time limit of 30 seconds. When the limit passes, the `claude` process is killed (on Windows with `taskkill /T`, which ends its whole process tree) and the call fails with result code 124 and `timed out after 30000 ms` in the error. The call returns after about 30 seconds, and after at most about 38 seconds when the kill is slow. The command then treats the agents list as unreadable, and does what the command's own section says for that case (for example [`status`](#gvt-fleet-status) exits 1). A `watch` poll whose call times out can end its run up to one such call after `--minutes`. A call took 0.5 to 1.1 s on the measured machine (972 to 1112 ms on 2026-11-06, 526 to 572 ms on 2026-11-09).

A listed entry is the session of a worktree when all of these hold:

- Its `kind` is not `interactive`.
- Its name equals the worktree name. The comparison ignores case.
- Its `cwd` is at or below the base clone folder `repos/<owner>/<name>`. The comparison ignores case and treats `\` and `/` alike. An entry with no `cwd` never matches by name.

`expire` also accepts an entry, of any kind, whose `sessionId` or `id` field equals the session id on the claim.

When several entries match, a live one wins over a dead one. The match does not require the session to be live. `worktree create` therefore prints `noop` for a matching dead entry. `worktree remove`, `worktree finish`, `expire` and `dispatch` look at liveness.

An unknown state counts as live. So an unrecognised state never lets `worktree remove` skip `claude stop`, and never lets `worktree finish` go on while the session may still run.

`failed` and `stopped` count as dead because the session no longer runs.

## gvt-fleet dispatch

```
gvt-fleet dispatch [--allow-self] <ref> [prompt]
gvt-fleet dispatch --task [--allow-self] <repo> <slug> [prompt]
```

The first form is described here. The second form starts a task worker (see [Task worker](#task-worker)).

Claims an issue and starts its worktree session in one step. It runs the steps of `claim` and then those of `worktree create`, and adds checks before the claim and a rollback after it. This form needs gvt-dev 4.45.0 or later for the reference grammar (see [The gvt-dev requirement](../coordinator.md#the-gvt-dev-requirement)); the task form does not.

1. Pre-checks. They make no GitHub call and write nothing. Any of them stops the command with exit 1:
   - The issue is in the workspace repository. The workspace repository is read from the `origin` remote of the workspace. If the remote cannot be read, the command also stops. `--allow-self` skips this check.
   - The default branch of the repository is not known. Run `sync` first.
   - The base clone is dirty or is on another branch.
2. It claims the issue, as `claim` does. A refused claim prints each reason, as `claim` does, and exits 1.
3. It runs `worktree create`: it fetches and fast-forwards the base clone, trusts it, and starts a background session named for the issue. It writes nothing to the branch record.
4. It prints the worktree path, the session short id and the lease expiry. With `--json` it prints the result, including `status`, `step`, `claim` and `rollback`.

The prompt is the first prompt of the session. It is passed to `claude` unchanged. An empty prompt counts as no prompt, so the default is used. A prompt of only spaces (or other whitespace) is passed as given. The default is `Work on GitHub issue <owner/name#N>. When you open a pull request for this issue, put a closing keyword for it in the body (Fixes <owner/name#N>), so that gvt-fleet wrap can prove the merge.` A worker that pushes from a branch of its own name leaves the issue branch with no commits of its own, and `wrap` then needs a merged closing pull request as its proof (see [the proof](worktrees.md#gvt-fleet-worktree-remove)). A prompt must not start with `-`: the command exits 64 for it. The global flag parsing takes the exact tokens `--json`, `--help`, `-h`, `--config` and `--state-dir` from anywhere in the arguments, before `dispatch` sees them. A prompt that equals one of these tokens is therefore consumed as a flag. `--config` and `--state-dir` also consume the next token as their value.

Contention and rollback:

- If another assignee appeared while the claim was taken, `dispatch` releases the claim and exits 1. `claim` keeps the claim in that case and only warns.
- If a step after the claim fails (the base clone, trust, `claude agents`, a worktree folder that exists without a session, or `claude --bg` that left nothing behind), `dispatch` releases the claim it took and exits 1. The base clone, its exclude line and its trust entry stay.
- If the release fails, the command says so on a separate line, names the lease (left in `releasing`) and exits 1. Run `gvt-fleet release <ref>`.
- A claim that was held before the command is never released, even when its lease had expired. The command prints that the claim is kept. This also holds when another assignee appeared: the command exits 1 and keeps the claim.

Cases that keep the claim:

- Lost session: `claude --bg` printed an id but no session is listed (or `claude agents` failed while the command looked for it), or it failed and left a folder or a session behind. The claim is kept and the command exits 1. Nothing is removed. When no session is listed, `gvt-fleet status` shows the claim as `no-session`. Run `dispatch` again to adopt the session, or run `release`.
- Second run: on an issue that is already held, with a listed live session (matched as in [Live workers](#live-workers)), `dispatch` makes no GitHub write, starts nothing, prints `noop` and exits 0.
- Adoption: a session that already exists after a fresh claim is adopted and the claim is kept. So is a dead session found on a second run. The exit code is 0 when the session is live and 1 when it is `done`, `failed` or `stopped`. For a dead session, run `gvt-fleet worktree remove <ref>`, then `gvt-fleet release <ref>`.

- Side effects: GitHub reads and writes on one issue (as `claim`, and as the release on rollback), a fetch and fast-forward of the base clone, a trust entry, a background `claude` session, and `state/claims.db`. It does not change the branch record (`config/branches.json`); `worktree remove` writes it.
- Exit codes: 0 for `created`, `noop`, or an adopted live session. 1 for a refusal, a failure, a rollback, or an adopted session that is not live. 2 when `claimAccount` is not set (checked once the pre-checks pass) or the config is invalid. 64 for wrong arguments (no ref, more than two arguments, a bad ref, or an argument that starts with `-` other than `--allow-self`).

For `dispatch --task`, the exit codes are these. 0 for `created`, `noop`, or an adopted live session. 1 for a refusal (including `task-active`), a failure, a rollback, or an adopted session that is not live. 2 for an invalid config; the task form never reads `claimAccount`. 64 for a usage error (see [Task worker](#task-worker)).

### Task worker

`dispatch --task` starts a task worker: a worker in the base clone of a managed repository, with no issue.

- `<repo>` is `owner/name` or the short name of a managed repository.
- `<slug>` is required. It has lowercase letters, digits and single hyphens, and at most 24 characters. The worktree name must also fit in 64 characters. For the longest managed short name (36 characters), the maximum is 16. The usage error names the maximum.
- The coordinator makes the task id `owner/name@<slug>.<YYYYMMDD>.<n>`. The date is the UTC date, so a task started late in the local evening can carry the next day's date. `n` is one more than the highest `n` of any lease with the same repository, slug and date, current or past. It skips a number whose worktree folder or branch already exists.
- The worktree is `repos/<owner>/<name>/.claude/worktrees/<short>.<slug>.<YYYYMMDD>.<n>`. The branch is `worktree-<short>.<slug>.<YYYYMMDD>.<n>`, and the session has the same name. A task has a branch, so the worker can commit, push and open a pull request.
- There is no GitHub write: no label and no assignee. There is no claiming step. The lease is written to `state/claims.db` as held.
- The pre-checks are those of an issue dispatch, and they write nothing. The workspace repository is refused (`step: 'self-repo'`) unless `--allow-self` is given. The default branch must be known. The base clone is checked.
- A second task with the same repository and slug while one is active is refused with `step: 'task-active'`. The reason names the active task id. Wrap or release the first task.
- Start, rollback, keep and adopt follow the rules for an issue. A rollback releases the task lease with no GitHub call. To adopt the session after a confirm failure, run `gvt-fleet worktree create <task id>`. A second `dispatch --task` makes a new task id.
- A usage error exits 64 before any write: a missing or bad slug, a slug that is too long, or an unknown repository.

Every task prompt ends with this rule, which the coordinator appends. This holds for `dispatch --task` and for `worktree create <task id>`:

```
There is no GitHub issue for this task. Do not write to the issue tracker (no new issues, comments, labels, assignees or closing) unless the coach approves that one write: ask, then wait for the answer. You may commit, push your branch and open a pull request.
```

With no prompt, the prompt is `Task <slug> in <owner/name> (<task id>).` followed by the rule. The coordinator cannot enforce the rule. The `gh` calls of the worker are outside the CLI, so the rule is only an instruction to the worker.

With `--json`, the result has `status`, `key` (the task id), `shortId` and `path`. On a refusal it also has `step`, `claim`, `rollback` and `reason`, as for an issue. A refusal made before the task id is allocated (`self-repo`, `default-branch`, `base-clone`, `task-active`, and `task-id` for a name that is too long or an id that has no free number) reports `owner/name@<slug>` in `key`. A refusal or failure made after the id is allocated reports the task id.

## gvt-fleet status

```
gvt-fleet status [--restart]
```

Shows one line per worker, for issue workers and task workers. With `--restart` it prints the restart steps instead (see [Restart steps](#restart-steps)). It reads the leases (`state/claims.db`), `claude agents --json --all` and the hook worker files (`state/workers`) once each. It joins them in memory by repo and worktree name.

- A worker is a lease in the `claiming`, `held` or `releasing` state, a listed session that is not interactive and runs in a managed worktree, or a hook worker file. A hook file with no lease and no session still gets a row when its repo is in the config. A hook file of another repo is not shown. It is counted in `ignored.records`.
- A hook file with no lease and no session gets an issue key only when its worktree is named `<repo name>-<N>`, the rule the hook uses. Any other worktree name gets no key. For example, the worktree `foo-3` in `acme/app` has no key.
- A task worker is a worker with no issue. Its key is the task id (see [Global flags](../coordinator.md#global-flags)). It comes from an active task lease, from a session whose worktree is a task worktree of a managed repository, or from a hook file of such a worktree. The liveness rule, the lease refresh and the states are the same as for an issue worker. A live task lease is extended like an issue lease.
- A lease whose key is neither an issue key (`owner/name#N`) nor a task key is not shown. It is counted in `ignored.leases`, and stderr prints one line for it: `<key>: cannot read lease key; ignored`. The other workers are still shown.
- A held lease whose worker is [live](#live-workers) is extended to `leaseMinutes` from now. If the lease had already expired, the worker is revived: the lease is extended, the row is marked `revived`, and the line shows when the lease had expired. The lease is read again under the claims lock and is written only if it is still `held`.
- The command never releases a lease. A lease whose worker is not live is left as it is. Run `gvt-fleet expire` to release the claims of workers that are no longer live.
- It makes no GitHub call. It reads the issue cache (`state/cache.db`) for the `issue` key of the `--json` rows. That data is as old as the last `sync`.
- The status line does not show the issue title. Only the `--json` row carries it, in `issue`.

State of a row:

- A live session takes the state of the last hook record of that session. The state is `working`, `needs-you` or `rate-limited`.
- If the session has no hook record, or the hook state is `done`, the state comes from `claude agents`. A session in the state `blocked` gives `needs-you` with the reason `agents:blocked`. Any other live state gives `working`.
- A session that is not live gives `done`, with the reason `agents:<state>`.
- No matched session gives `no-session`.
- When the agents list cannot be read, the state is the hook state, or `unknown` when there is none.
- For a row whose session's last hook record is an `idle_prompt` notification, `detail` is the last message of the Stop that ended the turn, and `since` is the time of that Stop. That Stop is the first record found when the session's own records are read back from the notification, other `idle_prompt` records aside. When another record of the session comes first, the Stop is not in the last 64 KB of the file, or it has no last message, `detail` is the notification message and `since` the notification time. A Stop of another session is never used. Other notification types keep their own message. The row's session is the matched session, else the session named by the lease; a row with neither uses the last record of the file.
- A worker that waits on an `AskUserQuestion` call is `needs-you` with the reason `notification:permission_prompt`, as before, and now shows its questions. The rule applies when the records of the session read, in order, a `PreToolUse` record of `AskUserQuestion`, a `permission_prompt` directly after it, and then only `idle_prompt` records. `detail` is then the questions as text, one line per question, in the form `<question> [<label> | <label>]`. `since` is the time of the `permission_prompt`. Any other record of that session ends the pairing; records of other sessions do not. A `PreToolUse` record that is the latest record of the session means `working`. See [ADR 0017](../decisions/0017-show-an-askuserquestion-wait-from-a-pretooluse-record.md).

Rows are sorted `needs-you`, `rate-limited`, `working`, `no-session`, `done`, `unknown`, and then by key.

Output: one line for each worker, issue and task workers in one sorted list, and then `workers: N`, which counts both. A line has this form. The reason, the expiry note and the markers are shown only when they apply:

```
<key> <state>[ <reason>] lease <expiresAt|none>[ (expired at <time>)] session <shortId|-> <path>[ [marker,marker]]
```

With `--json` it prints `{agents, workers, tasks, ignored, rateLimits}`. `agents` is `{ok}`, or `{ok, error}` when the list could not be read. `workers` holds the issue workers, and the rows that have no key. `tasks` holds the task workers. It is always present and is `[]` when there is no task worker. `ignored` is `{records, leases}`: two counts, of the hook files of other repos and of the leases with an unreadable key. `rateLimits` is the content of `state/rate-limits.json`. Each worker and each task has `key`, `repo`, `worktree`, `state`, `reason`, `detail`, `since`, `questions`, `lease`, `session`, `path`, a `"markers"` list and `issue`. `questions` is `[{question, header, options, multiSelect}]` (`options` lists the option labels) while the worker waits on an `AskUserQuestion` call, and `null` otherwise. It is always present on this version. `lease` is `null` or `{state, expiresAt, refreshed, expiredAt}`. `session` is `null` or `{shortId, sessionId, agentsState, kind}`. `issue` is `null` or `{title, state, closingPrs}`, where `closingPrs` is a list of `{number, state, headRefName}`. It comes from the issue cache. It is `null` when the row has no issue key or the issue is not in the cache (run `gvt-fleet sync` to fill it). For a task, `key` is the task id and `issue` is `null`.

Markers name a mismatch between the three sources, or a lease that is not in the normal state. A healthy worker has none.

| Marker | Meaning |
|---|---|
| `no-session` | A held lease and no session matches it. This is a lost session (see [gvt-fleet dispatch](#gvt-fleet-dispatch)). |
| `session-done` | The lease is held and its session is `done`, `failed` or `stopped`. |
| `no-claim` | A session matches and there is no active lease. |
| `records-only` | There is a hook file, and neither a lease nor a session. Also set for a row with no lease when the agents list cannot be read. |
| `hook-done-session-live` | The hook records say the session ended, and `claude agents` lists it as live. |
| `hook-live-session-gone` | The hook records say the worker is mid-turn, and no live session matches (or the matched session is not live). Not raised when the last hook record is a turn boundary: `turn-ended` (`Stop`), `notification:idle_prompt` (idle `Notification`) or any `error:<e>` (`StopFailure`). A session that went `done` after a turn boundary is normal. |
| `stale-records` | The hook file holds records of other session ids and none of the current session. They are not used. |
| `revived` | The lease had expired, its worker is live, and this run extended it. |
| `lease-expired` | The lease is held and past its expiry, and the worker is not live (or the agents list could not be read). The lease is left to `gvt-fleet expire`. |
| `session-id-mismatch` | The session id on the lease differs from the id of the matched session. |
| `duplicate-session` | More than one `claude agents` entry matches the worker. This includes a second entry for a worker that already has a row. |
| `claiming` | The lease is in the `claiming` state. |
| `releasing` | The lease is in the `releasing` state. Run `gvt-fleet release <ref>` or `gvt-fleet expire`. |
| `unknown-agents-state` | The session has a state other than `working`, `blocked`, `done`, `failed` or `stopped`. It counts as live. |

Accepted limit: the hook worker file keeps every record, and the reader keeps the last record of each session from the last 64 KB. A session whose last record is a notification that says nothing about its state shows as `working`, even if it was waiting for you before that notification. A turn that ends with no Stop record leaves the Stop of an earlier turn in place only when that turn writes no other record the reader counts: a SessionStart, StopFailure, SessionEnd or any notification other than `idle_prompt` of the session clears it. Then an `idle_prompt` after it shows that earlier message, with the earlier time in `since`.

Accepted limit for an `AskUserQuestion` wait: after you answer, the row keeps the question until the session writes its next record. No `PostToolUse` record marks the answer, and a tool permission prompt has the same limit. When the turn ends after the answer, its `Stop` ends the question wait. Not checked: whether a question that you dismiss with Esc writes a hook record; if it does not, the question keeps showing until the next record.

- Side effects: a `claude agents` call, and writes to `state/claims.db` (the lease expiry and heartbeat of live workers) and to the log. It writes nothing else and makes no GitHub call.
- Exit codes: 0 when the view is complete. 1 when the agents list cannot be read, or when `state/claims.db` has another schema version. If the agents list cannot be read, the view is still printed from the claims and the hook files, stderr says `claude agents unavailable: <error>`, and no lease changes. 2 for an invalid config. 64 for any argument other than `--restart`.

### Restart steps

`gvt-fleet status --restart` prints the steps that restart every worker session, as a Markdown sheet. Run it before a planned reboot and save the output, or run it after the reboot. It replaces the hand-edited restart sheet (workspace #106).

It reads the same sources as `status`, joins them the same way, extends the same leases and writes the same log event, with `restart: true` added. Only the output differs:

1. `## Workers`: one line per worker and task worker, sorted as `status` sorts them: `<key> <shortId|-> <state> <detail|->`. `detail` is the last message, on one line, cut at 100 characters.
2. `## Respawn`: one `claude respawn <shortId>` line per session.
3. `## Resume (fallback)`: one `cd "<worktree path>" && claude --bg --resume <session id>` line per session. When the worktree folder does not exist, the line is `# <key>: worktree missing: <path>` instead.

An empty block holds `# none`. A worker with no session id gets no command line, and a last line names it: `No session id: <key>, …`.

The session of a worker is the matched `claude agents` entry, else the session that the lease names. The lease in `state/claims.db` keeps the session id, the short id and the worktree path, so the steps can still be built after a reboot when `claude agents` no longer lists the sessions. When the lease has no short id, the short id is the first 8 characters of the session id; that held for every one of the 19 background sessions listed on 2026-11-13. Run `--restart` before `gvt-fleet expire`: `expire` releases the leases of workers that are not live, and a released lease is no longer read.

Not checked: whether `claude respawn` (one id or `--all`) restarts a session after a reboot. The resume lines do not depend on it.

Check each respawn with `claude logs <shortId>`: a session that restarted shows its prompt. On 2026-11-16, `claude respawn` printed `respawned <shortId>` for a session whose log then read `job not found`, and a second `claude respawn` restarted it. Why the first one did not was not found. `claude agents --json` without `--all` does not list a background session in the state `done`, even while it runs, so that list cannot confirm a respawn. `status` reads the list with `--all`.

With `--json` it prints `{generatedAt, agents, entries}`. `agents` is as in `status`. Each entry is `{key, state, detail, shortId, sessionId, path, pathExists}`. `shortId` and `sessionId` are `null` for a worker with no session id.

### Passing a secret to workers

This is an option for one machine, not a feature of the coordinator. It gives every worker a secret, such as a 1Password service account token, without writing the secret to disk and without an approval for each worker.

A background session does not take its environment from the session that dispatches it. It takes it from the background supervisor (`claude daemon`), which keeps the environment of the shell that started it. The [agent view docs](https://code.claude.com/docs/en/agent-view.md) name only some variables that reach a background session (`PATH`, the cloud provider, model aliases, gateway variables). They say nothing about other variables. So start the supervisor from a shell that already holds the secret:

1. Start the coach session under `op run --env-file <file> -- claude …`. The env file holds an `op://` reference, not the secret. 1Password asks for approval once, at this launch.
2. Run `claude daemon stop --any`. Add `--keep-workers` to leave the running sessions up for the next supervisor.
3. Dispatch from the coach session. The first `claude --bg` (or `claude agents`) starts a new supervisor with the coach's environment. Check it with `claude daemon status`.
4. Run `claude respawn <shortId>` for each session that was running before step 2. A session keeps the environment it started with, and a respawn restarts it under the new supervisor.

To check a worker, dispatch a read-only task whose prompt runs `[ -n "$OP_SERVICE_ACCOUNT_TOKEN" ] && echo set || echo unset`. The command prints no value.

Measured 2026-11-16 on Claude Code 2.1.325 (Windows): a task worker dispatched while an older supervisor ran reported `unset`. After `claude daemon stop` and a dispatch from a coach launched under `op run`, a new task worker reported `set`.

Limits:

- Every worker under that supervisor gets the secret, in every repository, and any shell command it runs can read it. Use a token scoped to what the workers need.
- A supervisor started any other way has no secret. An auto-update restarts the supervisor onto the new version; whether the restarted supervisor keeps the environment was not checked. When a worker reports `unset`, repeat steps 1 to 4.
- An `env` block in a settings file also reaches background sessions, but it writes the secret to disk.

## gvt-fleet watch

```
gvt-fleet watch [--minutes N] [--interval S] [--since <iso>]
```

Prints one line each time a worker starts to need you. The coach runs it under Monitor, so it learns about a waiting worker without calling `status` in a loop.

| Option | Default | Meaning |
|---|---|---|
| `--minutes N` | 25 | How long to watch, from 0 to 1440. `0` makes one poll and ends. |
| `--interval S` | 15 | Seconds between polls, from 5 to 3600. |
| `--since <iso>` | the start time of the run | Print a wait only if it began at or after this time. |

`N` and `S` are whole numbers. A value outside the range exits 64.

Each poll reads the same inputs as `status` (the leases, `claude agents --json --all` and the hook worker files) and joins them the same way, so `watch` and `status` agree on the state of a worker. The command makes one `claude agents` call per poll. Measured on this machine, `claude agents --json --all` took 972 ms, 981 ms and 1112 ms (3 samples, 2026-11-06). The command changes no lease, makes no GitHub call and never reads the issue cache. Like every command, it opens the state databases, and that can create them. It writes to the log.

A wait is a worker row whose state is `needs-you`. A task worker that needs you is reported like an issue worker, with its task id as `key`. The identity of a wait is the worker key and the time the wait began (`since`). The command prints a line once for each identity.

| Sequence of events | Lines |
|---|---|
| The worker is working, then a Stop. | 1 |
| A Stop, then its idle prompt. | 1 (an idle prompt that follows a printed turn end of the same worker in the same run is the same wait, also when the Stop had an empty last message) |
| A Stop, a new turn, a Stop. | 2 |
| A permission prompt, you approve it, a second permission prompt. | 2 |
| The session is resumed with a new session id, then a Stop. | 1 (the key is the worker, not the session) |
| An `AskUserQuestion` call, its permission prompt, then an idle prompt before the answer. | 1 (the idle prompt keeps the `since` of the permission prompt, so the identity is the same; no such idle prompt has been seen during a question wait) |
| An `AskUserQuestion` call, its permission prompt, you answer it, a Stop. | 2 (the Stop ends the question wait) |

The join reports `agents:blocked` for a session that the agents list shows as blocked and that has no hook record, or only a done one. A session with a live hook record takes its state from the hook (for a permission prompt the hook already reports `needs-you`). An `agents:blocked` row has no begin time, so the command prints a line only when the session turns blocked during the watch. The first poll with a readable agents list sets the baseline. A session that is blocked at that poll gives no line. While the list is unreadable, the baseline is kept and no `agents:blocked` line is printed. The `since` of that line is the time of the poll that saw the session blocked, not the time the wait began.

A worker whose session the agents list does not show has the state `no-session` while the agents list is readable. That state is not `needs-you`, so it prints no line. When the agents list cannot be read, the state comes from the hook records (see `status`).

Output: one line for each wait, and a last `watch-end` line. The detail is one line: whitespace is collapsed, and when it is longer than 160 characters the last 160 are kept behind `...`.

```
<key> needs-you <reason> since <time>[: <detail>]
watch-end <cursor>
```

With `--json`, each line is one JSON object, and the output is one object per line (not an indented document):

```
{"event":"needs-you","key":"...","reason":"...","detail":"...","since":"...","questions":null}
{"event":"watch-end","cursor":"...","polls":N,"agentsErrors":N}
```

`questions` is `null`, or the array `[{question, header, options, multiSelect}]` while the worker waits on an `AskUserQuestion` call (see [gvt-fleet status](#gvt-fleet-status)). It is always present on this version. `polls` is the number of polls. `agentsErrors` is the number of polls where the agents list could not be read. The text form of `watch-end` carries only the cursor.

The cursor is the start of the last poll minus 5 seconds. Pass it as `--since` to the next run, so a wait that began between two runs is not missed. A wait that began in the 5 s margin can print twice, once in each run. A run does not remember the turn ends of the previous run, so a Stop with an empty last message printed in one run and its idle prompt in the next also print one line each. A repeat is preferred to a miss.

When the agents list cannot be read, the poll goes on with the hook records. The first failure of a run prints `claude agents unavailable: <error>` on stderr; later failures in a row are not repeated. The exit code does not change.

- Side effects: one `claude agents` call per poll, and a read of `state/claims.db` and the hook worker files. It writes `watch-start`, `watch-wait` and `watch-end` entries to the log. It changes no lease and makes no GitHub call.
- Exit codes: 0 when the watch ends, whether or not the agents list could be read. 1 when `state/claims.db` has another schema version. 2 for an invalid config. 64 for a bad argument (an unknown option, a missing value, a value that is not a whole number, `--minutes` above 1440, `--interval` below 5 or above 3600, or a `--since` that is not a date).
