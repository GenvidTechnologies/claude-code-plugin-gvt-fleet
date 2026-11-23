---
type: reference
title: 'gvt-fleet: design (draft, 2026-11-03)'
description: 'The design of the multi-repo coordinator and coach: goal, constraints, team model, workspace layout, worktree initialization, issue tracking, robustness and packaging.'
tags: [design]
status: draft
---
# gvt-fleet: design (draft, 2026-11-03)

Status: proposal. Tracking issue: GenvidTechnologies/claude-code-plugin-gvt-dev#814

## Goal

Replace "one Claude Code terminal per repo, manual loop of
`/plan-next-issue` → `/run-retro` → `/create-pr` → clean up → `/clear`" with a
coordinated team of sessions across all repos, coached by one human.

The aim is **not** fewer interactions. It is cheaper interactions: the coach
answers questions after discovery, inspection and test runs, from one place,
with fast access to the worker's files and commit history.

## Constraints

- **Subscription only** (no API key). The weekly ceiling is hit several times a
  week, so every session must survive a usage-limit stop and restart cleanly.
  Interactive terminal sessions already continue automatically at quota reset
  (confirmed by the user). That is good enough for the waiting part.
- Agent SDK / `claude -p` on subscription credentials is outside the documented
  usage model, so workers are **real interactive Claude Code sessions**
  (`claude --bg`, agent view, `claude attach`).
- GitHub only (no Bitbucket for now).
- The coach ships as its own plugin, **gvt-fleet**, that depends on
  gvt-dev ([ADR 0002](decisions/0002-ship-gvt-loop-as-separate-plugin.md),
  [ADR 0006](decisions/0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md)).
  The `gvt-fleet` CLI (renamed from `gvt-loop`) stays in this workspace.
  gvt-dev skills can still be changed to make this easier.
- Each repo's own `.claude/`, `CLAUDE.md` and `.gvt-agent.json` must apply in its
  worktrees.

## Team model

- **Workers:** one background session per issue (or per task, when there is no
  issue; see ADR 0012), each in its own worktree. They
  are full interactive sessions: attach, converse, detach (detach never stops
  them).
- **Coach session:** home base, running `/gvt-fleet:coach`. A team pane (plugin mod) beside
  the chat lists workers by issue and state (working / needs you /
  rate-limited / done) with their last question. From it the coach dispatches,
  reprioritises, or asks the coach session to inspect a worker's worktree.
  Cross-session messaging lets coach and workers message each other directly.
- **Inspection:** per worker, open the worktree in VS Code (`code <wt>`) or
  GitExtensions (`gitex browse <wt>`), and show the diff vs base and the commit log.
- **Launchers are configurable (user request, 2026-11-03).** The pane's buttons
  aren't a fixed list. A tracked config holds a set of named launch commands,
  each a command template with placeholders. For example:
  `{ "label": "VS Code", "hotkey": "v", "command": "wt -w 0 nt -d {wd} pwsh /c code ." }`.
  Placeholders: `{wd}` (worktree path), `{base}` (base clone), `{repo}`,
  `{issue}`, `{branch}`, `{session}` (background session id). Each placeholder
  value is passed as a single argument and never spliced into a shell string.
  The defaults are the three buttons proven in probe 2 (VS Code, GitExtensions,
  attach). A per-repo override list is allowed.
- **Attention ordering:** a worker that is blocked on you sorts before one that
  is still working with an optional question.
- **The coach never removes its own session.** A cleanup that removes "all
  other sessions" skips every `claude agents --json --all` entry whose
  `sessionId` equals the coach session's own. After a resume, the earlier
  background copy of the coach session is listed with the same `sessionId`
  (state `failed`). Removing it can delete the transcript that the live coach
  session runs from. Observed 2026-11-03.

### Building the team pane

Lessons from probe 2 (`probes/02-team-pane`, `probes/FINDINGS.md`):

- **Develop the mod with `claude --plugin-dir <folder>`.** Do not keep it in
  `~/.claude/dev-mods/<session-id>/`. That folder is keyed by session ID, so a
  resumed session does not load it. Observed: the `/workers` command
  disappeared after the session ID changed. An installed plugin does not have
  this problem.
- **A command name must not be a prefix of a built-in command name.**
  Autocomplete changed `/team` into the built-in `/team-onboarding` two times.
  `/coach` and `/workers` are safe.
- **Helper functions that receive `$` are top-level functions.**
  `claude plugin validate` rejects a closure inside `register` that receives
  `$`.
- **`$.process.run` runs an argv list with no shell and waits for the exit.**
  Launch a GUI program through `cmd /c start "" <exe> …`, so that the call
  returns at once and the mod does not own the child process. Resolve each
  executable to an absolute path first (CLAUDE.md, Windows rules).

## Workspace layout

This folder is the coordinator's root and is tracked in git for local config.

```
<workspace>/
  config/            repos list, concurrency limits, budget policy   (tracked)
  wiki/              documentation, in the maintain-wiki format      (tracked)
  probes/            throwaway phase-0 probes                        (tracked)
  repos/<owner>/<name>/   base clone per repo (untracked)
  state/             SQLite cache, hook events, rate-limit snapshot  (untracked)
```

- **Base clone:** a normal (non-bare) clone, kept on the default branch and never
  worked in. It holds the gitignored local files (`settings.local.json`, `.env`)
  that `.worktreeinclude` copies into each new worktree.
- **Worktrees:** created with `claude --bg --worktree` (or a `WorktreeCreate` hook
  if a custom `issue/<n>` branch name is required. Note that a `WorktreeCreate`
  hook disables `.worktreeinclude`, so the hook must copy those files itself).
- Nothing in the user's other checkouts is touched.
- Branch naming: accept the `worktree-<name>` that `claude -w` imposes, and name
  the worktree `<repo>-<issue>` (branch `worktree-webapp-412`). Decided
  2026-11-03.

## Worktree initialization

Initialization has two levels, so that per-repo work isn't repeated for each
worktree.

### Per repo: base refresh (coordinator, before dispatching into a repo)

Runs once per (base clone `origin/<default>` SHA, installed gvt-dev version):

1. Fetch, then fast-forward the base clone to `origin/<default>`.
2. Make sure the base clone's local `.worktreeinclude` exists. If the repo doesn't
   commit one, the coordinator writes it and adds it to `.git/info/exclude`.
   Claude Code reads the file from disk, so it doesn't have to be tracked. Make
   sure the gitignored source files it lists exist in the base clone.
3. **Plugin check:** compare the installed gvt-dev (and other marketplace
   plugins) with the latest marketplace version. If an update exists, tell the
   coach ("gvt-dev 4.49 available: update, then `claude respawn --all`") rather
   than updating in the middle of running work.
4. **Conventions audit:** run `gvt-dev:audit-conventions` read-only on the base
   clone, cached by the key above. Drift doesn't block every worker. It queues a
   "sync-config <repo>" work item that is dispatched like an issue, so it gets
   fixed once in its own PR instead of N workers each fixing it. Only a
   `required` miss pauses dispatch for that repo.

`gvt-fleet dispatch` runs step 1 only (the workspace repository's #13). Steps 2 to 4 are not built yet.

### Per worktree: setup (worker, at first start)

- Each repo declares its setup in `.gvt-agent.json` as `commands.setup`, for
  example `"npm ci"`, alongside the existing `test`, `lint`, `build` and
  `validate`. If it's absent, nothing runs.
- A **gvt-dev `SessionStart` hook** runs it when the worktree has no
  `$(git rev-parse --git-path gvt-setup-done)` marker. That path is inside the
  worktree's own git dir, so it's untracked and per worktree. The hook writes the
  marker on success. It injects a short result into the session context ("setup
  ok", or "setup FAILED" plus the log tail and log path), so the worker knows
  before it starts on the task and can report the failure to the coach.
- Resumed or respawned sessions find the marker and skip setup.
- Probe 6 passed: the hook holds the first turn until setup ends and the context
  arrives (see FINDINGS). Fallback if a repo needs it anyway: the
  dispatch prompt starts with `/init-worktree` (a gvt-dev skill running the same
  `commands.setup`) before the task.

## Issue tracking (490 open issues)

Measured 2026-11-03: 490 open issues across the 30 managed repos. The largest
are claude-code-plugin-gvt-dev (370), two private repositories (47 and 37) and
construct3-chef (24). 20 of the 30 repos had none.

Command reference: [gvt-fleet command reference](coordinator.md).

- Incremental GitHub GraphQL sync (by `updatedAt`) into SQLite. GitHub is the
  source of truth and the cache is disposable.
- Dependencies come from native sub-issues and "blocked by" links, plus
  `Depends on #N` / `Blocked by owner/repo#N` text in issue bodies. Together they
  form one cross-repo graph.
- **Ready set:** open, triaged, no open blockers, not claimed, and no branch or
  PR already references the issue. That last check catches work already
  started by hand. Branches with no PR are covered by the branch record
  `config/branches.json`: a recorded branch tied to an open issue makes it not
  ready (`existing-branch`). See [Local config](configuration.md).
- **Parallel safety:** two issues in the same repo can run concurrently only if
  the files their plans list don't overlap. Before a plan exists, fall back to
  labels or areas.
- **Claims:** an `in-progress` label plus an assignee on GitHub, so others see
  them, plus a lease with a heartbeat in SQLite. A dead session's claim expires
  instead of leaving a label stuck forever.

## Robustness at the usage ceiling

Rule: **progress lives in git and the plan doc, never only in the
conversation context.**

1. `plan-task` records its current phase in the plan doc and commits WIP after
   each task. A fresh session resumes from the first unchecked step. Transcript
   resume is a bonus, not something the design depends on.
2. Detection:
   - `StopFailure` hook with `error: rate_limit`.
   - `Notification` types (`idle_prompt`, `permission_prompt`,
     `agent_needs_input`, `quota_auto_resume_*`).
   - Status line JSON `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`,
     written to `state/rate-limits.json` by the `gvt-fleet` status-line helper,
     which `gvt-fleet install-hooks` puts in front of the user's own status-line
     command. Plugins can't ship the main status line.
3. The coordinator governs one shared quota. Above a threshold it stops starting
   new sessions and lets near-finished work drain first. A weekly budget policy
   (for example "keep 15% for interactive work") stops background work using up
   the coach's own sessions. Idle background sessions stopped after about an
   hour are treated as normal and resumed when the coach replies.

## Packaging

Two plugins. `gvt-fleet` depends on `gvt-dev`; the reverse is never true. See
[ADR 0002](decisions/0002-ship-gvt-loop-as-separate-plugin.md) and
[ADR 0006](decisions/0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md).

### gvt-fleet (coach side)

The plugin lives in the public repository `GenvidTechnologies/claude-code-plugin-gvt-fleet`. The `gvt-fleet` CLI (`bin/`, `lib/`) stays in this workspace. The skill reaches it with `node "${CLAUDE_PROJECT_DIR}/bin/gvt-fleet.mjs" --json …`. The plugin has no MCP server.

| Component | Role |
|---|---|
| Skills | `/gvt-fleet:coach`. It also covers dispatch; there is no separate `/dispatch` skill. |
| Hooks (later) | `SessionStart`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` and `PreToolUse` (matcher `AskUserQuestion`) write each session's state |
| Mod (later) | Team pane and the `/open` commands |

The CLI (`bin/gvt-fleet`) does the coordinator work: sync, graph, ready set, claims, clones and worktrees, dispatch and resume.

The plugin is enabled at user scope, because workers run in other repos'
worktrees. Plugin hooks have no per-cwd scoping, so each hook script reads `cwd`
from its stdin JSON and exits 0 at once unless `cwd` is under a base clone's
`.claude/worktrees/` in this workspace's `repos/`. The test is that `cwd` is at
or below a worktree root, so it follows `cd` inside a worktree. Until the plugin
ships its hooks, `gvt-fleet install-hooks` registers the hooks in user settings. See
[ADR 0003](decisions/0003-register-session-hooks-at-user-scope.md).

### gvt-dev (worker side, useful without the coordinator)

| Component | Role |
|---|---|
| Convention | `.gvt-agent.json` `commands.setup` (per-worktree setup command), run by the `SessionStart` setup hook |
| Skill | `/init-worktree` (fallback that runs `commands.setup`) |
| Changed skills | `plan-next-issue`: mode that takes a pre-selected issue. `plan-task`: checkpoint and resume. `run-retro`: one grouped gvt-dev issue across repos |

## Phase 0: probes (in `probes/`)

1. `claude --bg --worktree` with a custom branch name: does it work, or is a
   `WorktreeCreate` hook required? Does `.worktreeinclude` copy from the base
   clone?
2. Mod pane: can it render clickable actions (open VS Code / GitExtensions), or
   only text plus slash commands?
3. Cross-session messaging on native Windows (needs v2.1.234+, local is
   2.1.317): can a coach session reach a `--bg` worker and get a reply?
4. Hook payloads: capture real `Notification` / `StopFailure` /
   status line `rate_limits` JSON from a background session.
5. Is a background session's per-repo `.claude` (settings, hooks, agents)
   loaded from the worktree as in an interactive terminal?

6. `SessionStart` setup hook in a background worktree: does a long command (for
   example a 2-minute `npm ci`) block the session's first turn until it finishes?
   What hook timeout applies? Does `additionalContext` reach the worker?

Results: see `probes/FINDINGS.md` at the repository root (outside the wiki).

## Related gvt-dev issues

- #626: plan-task, the orchestrator owns the clone and branch for a
  cross-repo task.
- #812: plan-next-issue / triage-issues scratch-file name collisions (gets
  worse with concurrent sessions).
- #652: orchestrated agents leave scratch output in the repo tree.
