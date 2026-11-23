---
type: decision-context
title: 'Find the workspace and switch the hooks to the plugin'
description: 'Find the workspace and switch the hooks to the plugin'
tags: [decisions]
status: stable
---
# 0021. Find the workspace and switch the hooks to the plugin

- **Status:** accepted; "The release copy" and steps 1 and 2 of "The cutover" are superseded by [0023](0023-move-the-gvt-fleet-cli-source-into-the-plugin-repository.md)
- **Date:** 2026-11-19
- **Issue:** workspace #157 (ship the gvt-fleet CLI inside the gvt-fleet plugin)
- **Builds on:** [0019](0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md), and settles the three forms it left to the implementation issue: how the CLI finds its workspace, the status-line launcher, and the release copy

## Context

ADR 0019 ships the CLI inside the `gvt-fleet` plugin. It leaves three forms open: how the CLI finds its workspace ("a flag, the session's project folder, a search upward for `config/repos.json`"), the form of a status-line entry that a plugin update does not move, and the details of the release copy. Workspace issue #157 adds the cutover.

These facts bear on the choice. All were checked on 2026-11-19 on the coach machine.

- `bin/gvt-fleet.mjs` sets `repoRoot` from its own location. `state/` and `config/repos.json` default under it, and `lib/commands.mjs` takes the workspace as `ctx.paths?.workspace ?? ctx.repoRoot`.
- `install-hooks` writes `node "<W>/bin/gvt-fleet-hook.mjs" --workspace "<W>"` and the status line `node "<W>/bin/gvt-fleet-statusline.mjs" --workspace "<W>" --chain …`. Its pattern for "our entry" needs the script folder and the workspace to be the same path (a backreference in `OURS_HOOK` and `OURS_STATUS`, `lib/user-settings.mjs`).
- The hook (`bin/gvt-fleet-hook.mjs`) takes the workspace from `--workspace`, else from its own location (`resolveWorkspace` in `lib/worktree-path.mjs`). A plugin hook gets no workspace argument: its command line is fixed in `hooks.json`.
- This repository is in the managed set, and `config/repos.json` is committed. So its base clone (`<W>/repos/<owner>/<name>`) and each of its worktrees hold a `config/repos.json` of their own.
- `~/.claude/plugins/installed_plugins.json` lists `gvt-fleet@gvt-plugins` with a `user` install and one `project` install per folder that opened it, all at the same `installPath`. `enabledPlugins` in user settings enables `gvt-fleet@gvt-plugins`, so a plugin hook runs in every session, worker sessions in other repositories included.
- The plugin data folders are named `<plugin>-<marketplace>` under `~/.claude/plugins/data/` (for example `gvt-dev-gvt-plugins`). The Bash tool's environment carries neither `CLAUDE_PLUGIN_ROOT` nor `CLAUDE_PLUGIN_DATA` (ADR 0019).
- ADR 0003 and ADR 0006: once the plugin ships `hooks.json`, `install-hooks` must remove its hook entries from user settings, or each event is recorded twice.
- This repository has no tags.

## Decision

**The CLI finds its workspace by flag, then by its own folder, then by the outermost workspace above the current folder. The plugin hook works out the workspace from the session folder. `install-hooks` switches to the plugin's hooks and to a status-line launcher only when the installed plugin ships them. A script in this repository builds the plugin's copy of the CLI and its `hooks.json` from one tag.**

### How the CLI finds its workspace

A workspace is a folder that holds `config/repos.json`. `bin/gvt-fleet.mjs` takes the first of:

1. `--workspace <dir>`, a new global flag. The folder is used as given.
2. The folder above the CLI's own `bin/`, when it is a workspace. This is a checkout that runs its own CLI, as today: the main checkout, or a worktree of this repository under test. The plugin's copy never matches, because its folder holds no `config/`.
3. The outermost folder at or above the current folder that is a workspace. Outermost, not nearest: a base clone or worktree of this repository sits inside the workspace and holds a `config/repos.json` of its own, and a command run from there means the workspace that manages it.

When none matches, the CLI prints that no workspace was found, names `--workspace`, and exits 64. `--help` needs no workspace. `--config` and `--state-dir` still override their defaults under the workspace.

Rule 2 keeps every command line in use today on the same workspace through the cutover. It can be dropped once nothing runs the CLI from a checkout.

### How the plugin hook finds the workspace

When the hook gets no `--workspace`, it reads the session folder (`cwd` in the payload) and looks for the shape `<W>/repos/<owner>/<repo>/.claude/worktrees/<name>`. Each match gives a candidate `<W>`, tried from the innermost: a worktree belongs to the workspace directly above its `repos/`. A candidate counts only when `<W>/config/repos.json` is a file. The state folder is `<W>/state`. A session outside every workspace costs string work only, and no file is read. With `--workspace`, as in today's user-settings entries, the hook behaves as before.

### What `install-hooks` writes

`install-hooks` looks up `gvt-fleet@gvt-plugins` in `installed_plugins.json` (the `user` install first, else the first one listed). It is in **plugin mode** when that install folder has `cli/bin/gvt-fleet-hook.mjs` and `hooks/hooks.json`.

- **Plugin mode.** It removes its hook entries from user settings. It writes a launcher, `statusline.mjs`, into the plugin data folder (`CLAUDE_PLUGIN_DATA` when set, else `~/.claude/plugins/data/gvt-fleet-gvt-plugins/`), and points `statusLine` at it: `node "<data>/statusline.mjs" --workspace "<W>" [--state-dir …] [--chain <user command>]`. On each run the launcher reads `installed_plugins.json`, finds the current install folder, and runs its `cli/bin/gvt-fleet-statusline.mjs` with the same arguments. When it finds no copy, it runs the chained command itself, so the user's status line still shows.
- **Otherwise.** It writes the entries it writes today, naming the scripts of the CLI it runs from (`<CLI folder>/bin/…`) and the workspace after `--workspace`. The two paths no longer have to be the same: the pattern for "our entry" accepts any script folder and any workspace. A gvt-fleet entry that names another workspace still counts as ours, as today; one entry per workspace is GenvidTechnologies/claude-code-plugin-gvt-fleet#2.

The gate makes the order of the cutover safe. Before the plugin ships its copy, a run changes nothing that matters. After it, a run moves the hooks to the plugin. Going back to an older plugin release and running `install-hooks` writes the user entries again.

### The release copy

`scripts/bundle-plugin.mjs` in this repository takes a clone of this repository, a tag and the plugin folder of a `claude-code-plugin-gvt-fleet` clone. It refuses a ref that is not a tag. It replaces `cli/bin/` and `cli/lib/` with the files of `bin/` and `lib/` at that tag (from `git archive`, not from the working tree). It writes `cli/SOURCE.json` with the tag and the commit. It writes `hooks/hooks.json` from the event table of the copied `lib/user-settings.mjs`, so the events and the matcher come from the same tag as the hook script. Each command names `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet-hook.mjs"`, with no workspace.

The folder is `cli/`, not the plugin's top-level `bin/`, which Claude Code puts on the Bash tool's PATH (ADR 0019). The tag names the plugin release it ships in: `gvt-fleet-v<plugin version>`.

### The skill

The coach skill runs `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs" --workspace "${CLAUDE_PROJECT_DIR}" --json …`. That change is in the plugin repository, in the release that first ships `cli/`.

### The cutover

1. Merge the CLI changes into `main` here and tag the merge commit `gvt-fleet-v<next plugin version>`.
2. Release the plugin with `scripts/bundle-plugin.mjs`, the new `hooks.json` and the skill's new command line.
3. On each machine: stop or wrap up every worker, update the plugin, and run the plugin's `install-hooks` at once (`node "<install folder>/cli/bin/gvt-fleet.mjs" --workspace "<W>" install-hooks`). Then `install-hooks --dry-run` must print `noop`. Restart every open session.

Between the plugin update and `install-hooks`, both the user entry and the plugin hook run, so each event is recorded twice. Step 3 keeps that window to one command. The steps go on a page of the command reference next to "Moving from the gvt-loop names".

## Compromise

- **Workspace from `CLAUDE_PROJECT_DIR`.** The skill can pass it, and does, as `--workspace`. As an implicit default it would tie the CLI to Claude Code's environment, and a human in a terminal has no such variable.
- **The nearest workspace above the current folder.** It is how git finds a repository. Here it would pick the base clone of this repository, or one of its worktrees, when the coach's shell is in one, as during a triage pass. The CLI would then read an empty `state/` and say nothing.
- **No rule 2 (no workspace from the CLI's own folder).** The plugin copy does not need it. Without it, a worktree of this repository that runs its own CLI would find the outer workspace by rule 3, and act on the real `repos/` and `state/`. Rule 2 keeps a worktree under test on its own files, as today.
- **`install-hooks` always in plugin mode.** It is simpler, but a run from the checkout before the plugin release would remove the hooks with nothing to replace them.
- **A launcher in the workspace's `state/`.** It survives plugin updates too, but the status line is one per machine (GenvidTechnologies/claude-code-plugin-gvt-fleet#2), and a launcher in one workspace ties every session's status line to that folder. The plugin data folder belongs to the plugin, not to a workspace.
- **A launcher that starts a second `node`.** It is simpler to read but costs one more process start on every status-line render. The launcher imports the script instead.
- **The bundle script in the plugin repository.** It would have to read the event table from this repository anyway, and the plugin repository is public while this one is private, so its CI cannot fetch the source. Here, the script is tested with the code it copies.
- **Cost.** A user's `--state-dir` passed to `install-hooks` does not reach the plugin hook, which always writes to `<W>/state`. The status line keeps it.

## Consequences

- One copy of the CLI serves any number of workspaces. The skill passes the workspace.
- `ctx.repoRoot` holds the workspace, as its callers already assume. The CLI's own folder is a new `ctx.cliRoot`, which only `install-hooks` reads.
- `install-hooks` reports the plugin mode in its change lines. Its section in the command reference (`wiki/coordinator/session-state.md`) states both modes.
- The CLAUDE.md "Safety rules" that say the hooks run this checkout's working tree hold until step 3 of the cutover, and change with it.
- The bundle script is the release step that ADR 0019 adds to `gvt-dev:release-plugin` for this plugin.
