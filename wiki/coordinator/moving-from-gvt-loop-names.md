---
type: reference
title: 'Moving from the gvt-loop names'
description: 'The steps to move a machine from the gvt-loop names to the gvt-fleet names.'
tags: [command-reference, migration]
status: stable
---
# Moving from the gvt-loop names

This page is part of the [gvt-fleet command reference](../coordinator.md).

Use these steps on a machine whose `~/.claude/settings.json` still holds entries from the old CLI (`gvt-loop-hook.mjs`, `gvt-loop-statusline.mjs`).
1. Stop or wrap up every worker. Before the pull, run the `status` command of the old CLI (the `gvt-loop.mjs` file in `bin/`) and check that it lists no workers.
2. In the workspace checkout, note the current commit with `git rev-parse HEAD`. Then run both steps in one command: `git pull --ff-only && node bin/gvt-fleet.mjs install-hooks`. Do not run them apart. After the pull and before the install, the old script files are gone. Every hook event then fails and the status line is blank.
3. When `install-hooks` refuses or fails, run `git checkout --detach <commit>` with the commit noted in step 2. This brings the old files back and leaves the checkout detached. Find the cause of the refusal or failure and fix it. Then run `git checkout main` and run the one-line pull-and-install command again.
4. Check the settings with `node bin/gvt-fleet.mjs install-hooks --dry-run`. It must print `noop`.
5. Restart every Claude Code session that was open.

A running session picks up an edit of a settings file, so a session that was open during the install runs the new entries from its next event. This was probed on 2026-11-25 with Claude Code 2.1.332 on a project `.claude/settings.json`, not on `~/.claude/settings.json` (see [Observed answers](moving-the-cli-into-the-plugin.md#observed-answers)). Step 5 stays the safe course.

The old log, `state/gvt-loop.log.jsonl`, is carried over on the first write (see [Where state lives](../coordinator.md#where-state-lives)). It needs no step.
