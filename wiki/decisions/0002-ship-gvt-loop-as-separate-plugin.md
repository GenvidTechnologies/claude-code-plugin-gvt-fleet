---
type: decision-context
title: 'Ship gvt-loop as a separate plugin that depends on gvt-dev'
description: 'Ship gvt-loop as a separate plugin that depends on gvt-dev'
tags: [decisions]
status: stable
---
# 0002. Ship gvt-loop as a separate plugin that depends on gvt-dev

- **Status:** accepted
- **Date:** 2026-11-03
- **Issue:** GenvidTechnologies/claude-code-plugin-gvt-dev#814

## Context

Issue #814 (now closed) and `wiki/design.md` assumed that the coordinator ships inside the `gvt-dev` plugin. The design states this in the constraint "Final result ships as part of the gvt-dev plugin" and in its "Packaging in gvt-dev" section. This record reverses that assumption.

Facts that bear on the choice:

- `gvt-dev` loads in every session in every repo.
- The coordinator is new and Windows-specific.
- It uses `node:sqlite`, which is experimental and prints an ExperimentalWarning.
- It does live GitHub writes. A claim adds a label and an assignee.

## Decision

The coordinator ships as a separate plugin, `gvt-loop`, that depends on `gvt-dev`.

**In `gvt-loop` (coach side):**

- `bin/gvt-loop`, the SQLite cache and claims, and the future MCP server.
- The team-pane mod and its launcher config.
- The `/coach` and `/dispatch` skills.
- The session-state hooks (`SessionStart`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`) that write to `state/`.

**In `gvt-dev` (worker side, useful without the coordinator, for anyone who runs one terminal per repo):**

- `plan-next-issue` taking a pre-selected issue.
- `plan-task` checkpointing its phase and resuming after a stop.
- The `.gvt-agent.json` `commands.setup` convention, with its `SessionStart` setup hook and the `/init-worktree` fallback.
- `run-retro` grouping lessons across repos.

Reasons:

- **Blast radius.** A coordinator bug must not reach sessions that never use the loop.
- **Different audiences.** Only the coach workspace needs the coordinator. Every repo needs `gvt-dev`.
- **Separate release pace.** `gvt-dev` has about 370 open issues and a full release process. The coordinator will change fast.
- **One-way dependency.** The loop calls `gvt-dev` skills. `gvt-dev` never needs the loop.

## Compromise

**Ship everything in `gvt-dev` (the original design), rejected.** It fails on all four reasons above. In particular, every session in every repo would load coordinator hooks and code that only the coach workspace uses.

**Put the worker-side conventions in `gvt-loop` too, rejected.** They help users with a single terminal and no coordinator. The workers of `gvt-loop` already need `gvt-dev` for `plan-task` and related skills, so the dependency exists anyway.

## Consequences

- There are two plugins to release and keep compatible. `gvt-loop` declares the minimum `gvt-dev` version in the `dependencies` array of its `.claude-plugin/plugin.json`, as an object with a semver range, for example `{ "name": "gvt-dev", "version": ">=X.Y.0" }`. `X.Y.0` is the `gvt-dev` version in which `plan-next-issue` takes a pre-selected issue. That version is not released yet, so it has no number.
- Claude Code plugin dependency behavior, from <https://code.claude.com/docs/en/plugins/dependencies.md> (read 2026-11-03):
  - A missing dependency is installed together with the plugin.
  - For git-backed sources, a constrained dependency resolves to the highest `<name>--v<version>` git tag that satisfies the range.
  - An unsatisfiable range fails the install or leaves the plugin disabled.
  - A cross-marketplace dependency is refused unless the root marketplace allows it.
- Checked 2026-11-03: the marketplace (`gvt-plugins`, repository `GenvidTechnologies/claude-code-gvt-marketplace`) lists `gvt-dev` as a `git-subdir` source pinned to `ref: v4.49.0`. The `gvt-dev` tags have the form `v4.49.0`, not `gvt-dev--v4.49.0`. A version range on `gvt-dev` therefore has no tag to resolve to, and the install would fail. Before `gvt-loop` declares a range, one of these must happen:
  - `gvt-dev` releases also push a `gvt-dev--v<version>` tag (a change to `release-plugin`, item 5 of GenvidTechnologies/claude-code-plugin-gvt-dev#826).
  - `gvt-loop` declares a bare `"gvt-dev"` dependency (it tracks the marketplace copy) and checks the minimum version itself, in the base-refresh plugin check.
- `gvt-loop` goes in the same marketplace, `gvt-plugins`, so no cross-marketplace allowance is needed.
- The base-refresh plugin check in `wiki/design.md` stays as a second line. It tells the coach when a newer `gvt-dev` version exists.
- `gvt-loop` must be enabled at user scope, because workers run in the worktrees of other repos. Claude Code has no per-cwd scoping for plugin hooks (<https://code.claude.com/docs/en/hooks.md>: a hook has a `matcher` and, on tool events, `if`). Therefore every `gvt-loop` hook script reads `cwd` from its stdin JSON. It exits 0 at once when `cwd` is outside a loop-managed worktree, meaning a path under a base clone's `.claude/worktrees/` in this workspace's `repos/`. The script still spawns on every matched event, so keep it cheap.
- Worker-side skill changes go to `gvt-dev` through an issue against GenvidTechnologies/claude-code-plugin-gvt-dev, as the cross-repo rule requires: GenvidTechnologies/claude-code-plugin-gvt-dev#826. It also covers the tag form for dependency ranges.
- This record does not decide where the `gvt-loop` plugin source lives: this repository or a new one.
