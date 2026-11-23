---
type: reference
title: 'Moving the CLI into the plugin'
description: 'The release and machine steps that move the hooks, the status line and the coach skill from the workspace checkout to the CLI copy that the gvt-fleet plugin ships.'
tags: [command-reference, migration]
status: stable
---
# Moving the CLI into the plugin

This page is part of the [gvt-fleet command reference](../coordinator.md).

[ADR 0019](../decisions/0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md) ships the CLI inside the `gvt-fleet` plugin, and [ADR 0021](../decisions/0021-find-the-workspace-and-switch-the-hooks-to-the-plugin.md) settles how. Before the move, the hooks and the status line in `~/.claude/settings.json` run this checkout's `bin/`, and the coach skill runs `${CLAUDE_PROJECT_DIR}/bin/gvt-fleet.mjs`. After it, the plugin's `hooks/hooks.json` runs the hook, the status line runs a launcher in the plugin data folder, and the skill runs the copy in the plugin's `cli/` folder.

## The release

[ADR 0023](../decisions/0023-move-the-gvt-fleet-cli-source-into-the-plugin-repository.md) replaces these steps: the source moves to the plugin repository, which ships `plugin/cli/` with no tag here and no bundle script. The steps below are kept as a record of the bundle step and are not to be run. "The machine" and "Going back" are unchanged by the move.

These steps are done once, by the maintainer, for the first plugin release that ships `cli/`.

1. Merge the CLI changes into `main` here. Tag the merge commit with the plugin version it ships in: `git tag -a gvt-fleet-v<version> -m "gvt-fleet <version>"`, then push the tag.
2. In a fresh clone of `GenvidTechnologies/claude-code-plugin-gvt-fleet`, run the bundle script of this repository against its `plugin/` folder:

   ```
   node scripts/bundle-plugin.mjs --source <clone of this repository> --tag gvt-fleet-v<version> --plugin <plugin clone>/plugin
   ```

   It replaces `plugin/cli/bin/` and `plugin/cli/lib/` with the files at the tag, writes `plugin/cli/SOURCE.json`, and writes `plugin/hooks/hooks.json`. It refuses a ref that is not a tag. Its exit codes: 0 when it wrote the bundle, 1 when a git read fails or the tag has no `bin/` or `lib/` files, 2 for a ref that is not a tag or a folder that is not a plugin, 64 for a missing or unknown argument.
3. In the same plugin change, point every command line of the coach skill at the copy: `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs" --workspace "${CLAUDE_PROJECT_DIR}" --json …`.
4. Release the plugin (`gvt-dev:release-plugin`). The plugin's leak guard checks `cli/` like every other file.

A later release repeats steps 1, 2 and 4. Step 3 is needed only once.

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

## Not known

- Whether a plugin that is installed at both user and project scope runs its hooks once or twice in one session. `installed_plugins.json` on the coach machine lists `gvt-fleet@gvt-plugins` at both scopes. Check after step 2 of "The machine" that a worker's events appear once in `state/workers/`.
- Whether a running session reads its hooks again. Treat a session that was open during the switch as still using the old entries until it is restarted.
