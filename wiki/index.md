---
okf_version: "0.2"
---

# Wiki Index

This wiki is the documentation of the `gvt-fleet` plugin and of the gvt-fleet CLI that it ships from `plugin/cli/`. It lists every page under `wiki/`, grouped under section headings, one line each. Each entry's text is the linked page's frontmatter `description`. The page format and the maintenance rules are in [the schema](schema.md). The change log is [log.md](log.md).

## Command reference

* [gvt-fleet command reference](coordinator.md) - Entry page of the gvt-fleet command reference: usage, global flags, exit codes, where state lives, the workflows, recovery and safety, with links to one page per command group.
* [Command reference pages](coordinator/index.md) - One page per command group, and the coach skill contract.
* [Local config](configuration.md) - Reference for the two committed config files, config/repos.json and config/branches.json.

## Design

* [gvt-fleet: design (draft, 2026-11-03)](design.md) - The design of the multi-repo coordinator and coach: goal, constraints, team model, workspace layout, worktree initialization, issue tracking, robustness and packaging.
* [Acceptance criteria: gvt-loop coordinator, phase 1](acceptance/gvt-loop-coordinator-phase1.md) - The acceptance criteria pledged for phase 1 of the coordinator, with the command block of each row.

## Process

* [Issue Triage Conventions](issue-triage.md) - Project conventions that /gvt-dev:triage-issues reads: types, priorities, class, road block, labels, required fields, splitting, duplicates, dependencies and mutation recipes.

## Decisions

* [Decision Records](decisions/index.md) - The decision records of this plugin and of the gvt-fleet CLI, in MADR-lite format.
* [0024. Run the triage pass in the coach session](decisions/0024-run-the-triage-pass-in-the-coach-session.md) - The coach skill runs the triage pass in the coach session, one repository at a time from its base clone, with a wrong-repository guard, no file writes and the coach approving each change.
* [0025. Remove a worktree whose session is gone with git, after the same checks](decisions/0025-remove-a-worktree-whose-session-is-gone-with-git-after-the-same-checks.md) - When no Claude session is listed for a registered worktree whose safety check passed, the coordinator unlocks and removes it with git itself, after checking its submodules and refusing any link inside it.

## Schema

* [Wiki Maintenance Schema](schema.md) - The maintenance rules for this wiki: page format, links, the locations of the triage contract and the decision records, create-vs-update lifecycle, staleness policy and the verb contract.
