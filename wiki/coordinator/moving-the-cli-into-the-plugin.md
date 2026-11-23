---
type: reference
title: 'Moving the CLI into the plugin'
description: 'The release and machine steps that move the hooks, the status line and the coach skill from the workspace checkout to the CLI copy that the gvt-fleet plugin ships.'
tags: [command-reference, migration]
status: stable
---
# Moving the CLI into the plugin

This page is part of the [gvt-fleet command reference](../coordinator.md).

[ADR 0019](../decisions/0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md) ships the CLI inside the `gvt-fleet` plugin, and [ADR 0021](../decisions/0021-find-the-workspace-and-switch-the-hooks-to-the-plugin.md) settles how. Before the move, the hooks and the status line in `~/.claude/settings.json` run the workspace checkout's `bin/`, and the coach skill runs `${CLAUDE_PROJECT_DIR}/bin/gvt-fleet.mjs`. After it, the plugin's `hooks/hooks.json` runs the hook, the status line runs a launcher in the plugin data folder, and the skill runs the copy in the plugin's `cli/` folder.

## The release

The CLI's source is in this repository, at `plugin/cli/`, and the plugin's session hooks are the committed `plugin/hooks/hooks.json` ([ADR 0023](../decisions/0023-move-the-gvt-fleet-cli-source-into-the-plugin-repository.md)). A plugin release ships both as they are at its tag. There is no tag of another repository and no copy step. Releases up to v0.5.0 ship no `cli/`.

The first release that ships `cli/` takes two steps (#58):

1. Point every command line of the coach skill at the plugin's copy: `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs" --workspace "${CLAUDE_PROJECT_DIR}" --json …`.
2. Release the plugin with `gvt-dev:release-plugin`: one annotated tag `v<version>` of this repository. The plugin's leak guard checks `plugin/cli/` like every other file.

A later release takes step 2 only. A change to the hook events, the matcher or the timeouts regenerates `plugin/hooks/hooks.json` in the same commit; the `R216` tests check that the file equals `pluginHooksJson` of `plugin/cli/lib/user-settings.mjs`.

Before ADR 0023, the plan was to copy `bin/` and `lib/` from a tag of the workspace repository into `plugin/cli/` with a bundle script of that repository. The move dropped that step, with its script, its tag and `cli/SOURCE.json`.

## The machine

1. Stop or wrap up every worker. Run `status` and check that it lists no workers.
2. Update the plugin with `/plugin`, and run the plugin's `install-hooks` right after it. Keep the two steps together: between them, both the user-settings entry and the plugin hook run, so each event is recorded twice.

   ```
   node "<install folder>/cli/bin/gvt-fleet.mjs" --workspace "<workspace>" install-hooks
   ```

   `<install folder>` is the `installPath` of `gvt-fleet@gvt-plugins` in `~/.claude/plugins/installed_plugins.json`. In plugin mode it removes the hook entries, writes the launcher, and points `statusLine` at it (see [gvt-fleet install-hooks](session-state.md#gvt-fleet-install-hooks)).
3. Check the settings: `install-hooks --dry-run` must print `noop`. `~/.claude/settings.json` holds no `gvt-fleet-hook.mjs` entry, and `statusLine` names `gvt-fleet-statusline-launcher.mjs`.
4. Restart every Claude Code session that was open.

## Going back

Install the previous plugin release with `/plugin`, then run `install-hooks` from the workspace checkout (`node bin/gvt-fleet.mjs install-hooks`). With no `cli/` in the installed plugin, it is not in plugin mode, so it writes the hook entries again and points `statusLine` at the checkout's `bin/`.

This needs the workspace's own copy of the CLI in its `bin/`, and the coach skill of the releases without `cli/` runs that copy too. Step 5 of ADR 0023 removes it from the workspace repository. After that step, these steps no longer work as written.

## Not known

- Whether a plugin that is installed at both user and project scope runs its hooks once or twice in one session. `installed_plugins.json` on the coach machine lists `gvt-fleet@gvt-plugins` at both scopes. Check after step 2 of "The machine" that a worker's events appear once in `state/workers/`.
- Whether a running session reads its hooks again. Treat a session that was open during the switch as still using the old entries until it is restarted.
