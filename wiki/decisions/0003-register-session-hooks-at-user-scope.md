---
type: decision-context
title: 'Register the session hooks at user scope until the gvt-loop plugin exists'
description: 'Register the session hooks at user scope until the gvt-loop plugin exists'
tags: [decisions]
status: stable
---
# 0003. Register the session hooks at user scope until the gvt-loop plugin exists

- **Status:** accepted
- **Date:** 2026-11-04
- **Issue:** #8 (sub-issue of #7)

## Context

[ADR 0002](0002-ship-gvt-loop-as-separate-plugin.md) puts the session-state hooks (`SessionStart`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`) in the `gvt-loop` plugin, enabled at user scope. It leaves the plugin's source location open, to be decided before the team pane. The plugin does not exist yet.

The coordinator needs the hooks to fire in worker sessions now, to read worker state. Two further facts apply:

- Claude Code merges hooks from user settings, project settings, local settings and plugins.
- A plugin cannot set the main `statusLine`. The account-wide rate-limit snapshot comes from the status line, so that part needs the user's settings whatever the packaging.

The write path for worker state also had to be chosen. Three options were compared.

## Decision

Option A: user-scope registration, one append file per worker, one snapshot file.

- `gvt-loop install-hooks [--dry-run]` writes a hook entry for each of the five events into `~/.claude/settings.json`. Each entry runs `bin/gvt-loop-hook.mjs`.
- The same command wraps the user's existing `statusLine` command with `bin/gvt-loop-statusline.mjs`. The helper first reads its stdin, for at most 2 seconds, and keeps what it read. It then starts the user's command with that input, and records the rate limits while the command runs. The output shown is the user's command's own output, unchanged. `install-hooks` backs up the original settings file to `state/settings.json.bak`.
- The hook script appends to one file per worker, `state/workers/<owner>/<repo>/<worktree>.jsonl`. Hook failures go to `state/hook-errors.jsonl`.
- The status-line helper writes the one account-wide snapshot, `state/rate-limits.json`. It replaces the file and retries the replace.
- A hook acts only when the `cwd` in its stdin JSON is at or below a worktree root. The check follows `cd`, so a session that changes directory inside its worktree is still recorded.

This is an interim deviation from the mechanism in ADR 0002, not from its decision. The code stays coach-side and `gvt-dev` gains nothing. When the plugin exists, the hooks move into it (see Consequences).

## Compromise

**Option B: one shared append log plus per-worker "latest" files replaced by rename, rejected.**

- Each event needs two writes.
- A "latest" file is replaced by rename. On this machine a write-temp-then-rename over one shared file failed with `EPERM` in 3072 of 3200 attempts, under 16 writers and a reader. The failure occurs whenever a reader has the target open.
- The shared log grows without bound. Rotation under concurrent appenders would be needed.

**Option C: SQLite `state/hooks.db`, rejected.**

- Every in-scope hook would load `node:sqlite`. Its ExperimentalWarning goes to stderr, outside the main CLI's warning filter.
- It adds a schema version and a digest to maintain.
- Its start-up cost is higher than an append.

**Passing `--plugin-dir` to `claude --bg`, rejected.**

- It needs a plugin manifest.
- The flag applies to one session and must be passed again on every resume. A session resumed by hand loses the hooks.
- The status line still needs user settings, because a plugin cannot set it.

**Writing each base clone's `.claude/settings.local.json`, rejected.**

- It is one write per repository, into a file that other tools own.
- It also fires in sessions that run in the base clone itself.

**Measured basis for Option A.** Concurrent `fs.appendFileSync` calls from 16 processes lost or tore no line. The snapshot is the one shared file that is replaced. Under contention it loses writes but never exposes a partial file: with 8 writers and a 5-attempt retry, about a third of snapshot writes gave up (127 of 400 and 133 of 400 in two runs), and no read was torn.

**Cost of the chosen option.** Every Claude Code session on the machine runs the hook script on these five events, including sessions outside any worktree. Every status-line refresh runs one extra node start before the user's own status-line command.

## Consequences

- When the `gvt-loop` plugin ships, its `hooks.json` registers the same script. `install-hooks` must then remove the hook entries from user settings. Otherwise each event is recorded twice. The status-line wrapper stays in user settings.
- Two facts were unverified when this record was written. A live check after merge settles them:
  - whether hooks in user settings fire in `--bg` worker sessions;
  - whether `SessionEnd` finishes inside its default timeout of 1.5 s.
- **Update 2026-11-04: live check M1 on #8.** One live `--bg` worker ran on `main` at `747bfcd`, with the hooks installed in user settings.
  - The hooks fired in the `--bg` session. The first bullet above is settled.
  - The worker file holds a `SessionEnd` record with reason `other`. The check concluded that the line was written within the default timeout.
  - The check measured no duration and no timing margin. It did not run a hook with stdin that never closes. The second bullet above is settled only for a hook whose stdin closes normally.
- **What the code fixes, whatever the timing.**
  - `bin/gvt-loop-hook.mjs` sets `READ_LIMIT_MS = 2000`. When that bound fires, the hook calls `finish('')` and drops any partial input. `JSON.parse('')` then fails, and the hook records nothing.
  - So a hook with stdin that never closes writes no record, whether Claude Code stops it at 1.5 s or the hook gives up at 2 s. The order of the two limits cannot change a record.
  - Claude Code's hooks reference (https://code.claude.com/docs/en/hooks.md, `timeout` row of the common fields table) says that `SessionEnd` hooks share a 1.5-second budget, and that a longer per-hook `timeout` in settings raises the budget to match, up to 60 seconds. This wording was checked against the live page on 2026-11-04.
- **Decision: the `SessionEnd` entry still omits `timeout`.** `lib/user-settings.mjs` sets `entry.timeout = 10` for every other event and skips `SessionEnd`. Raising it was considered and not taken.
  - It gains nothing for the case of stdin that never closes, because no record is written in that case.
  - It could add up to the raised budget to Claude Code's exit time when a `SessionEnd` hook hangs.
  - It stays a follow-up if `SessionEnd` records go missing.
- A session that changes directory outside its worktree drops its events.
- A snapshot write can be lost under contention. The cost is freshness only. The quota governor must allow for a stale snapshot.
- `install-hooks` is the only code that writes `~/.claude/settings.json`. Tests inject the settings path.
- A project `statusLine` overrides the user's. In a repository that sets one, the snapshot is not written. (This follows from the Claude Code documentation as read when this record was written. It was not tested here.)
