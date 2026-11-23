---
type: decision-context
title: 'Derive the class from the project Iteration field'
description: 'Derive the class from the project Iteration field'
tags: [decisions]
status: stable
---
# 0015. Derive the class from the project Iteration field

- **Status:** accepted
- **Date:** 2026-11-12
- **Issue:** #108 (plan iterations ahead), which folds in #110 (`ready` reads the class from the project)
- **Supersedes:** the class storage of [ADR 0010](0010-store-the-issue-class-as-github-labels.md), and the `Class` field design of #69

## Context

ADR 0010 stored the class (Now, Next or Later) as the labels `class:now` and `class:next`. On 2026-11-11 the GitHub projects took over: each project got a single-select field `Class`, and the goal of Now and of Next went into the option descriptions (#69). Three problems followed.

- **Starting an iteration wrote every item.** Changing an option description through `updateProjectV2Field` without the option ids recreates the options and clears every item's value. On 2026-11-12 promoting Next to Now in both projects cleared every `Class`, and a script had to restore 41 values (#95).
- **Only one Next.** An option is a class, not an iteration, so nothing could be planned past Next.
- **Two sources that drift.** `ready` read the labels, the coach read the field. On 2026-11-12, 13 of the 16 open Now issues had no label and so were missing from `ready` (#110).

A probe on a throwaway project (2026-11-12, recorded on #108) found how the native Iteration field behaves through the API:

- An update that passes the id of every existing iteration keeps all item values. That holds for adding an iteration, retitling one and moving its dates.
- An update that leaves out an id deletes that iteration and clears its items. This holds for a completed iteration too. The mutation has one `iterations` list, so it must carry the completed iterations (read from `completedIterations`) as well as the others.
- An iteration that ends before today moves to `completedIterations` and keeps its items.
- An iteration that overlaps another is dropped, and GitHub returns no error.
- An iteration has a title, a start date and a duration, and no description. A duration of 365 or 1000 days and a 408-character title are stored in full.

## Decision

**The class is derived from the native Iteration field of the repo's GitHub project.**

- A repo entry in `config/repos.json` names its project as `"project": "owner/number"`.
- The current iteration (the one that holds today, as a UTC day) is Now. The first iteration that starts after today is Next. Every other iteration, and no iteration, is Later. The CLI computes these pointers itself. They are meant to match GitHub's `@current` and `@next` in views, but that is not verified (see Consequences).
- The goal is the iteration's title.
- Now gets a long duration (365 days), so it lasts until its goal is reached, not until a date.
- `sync` reads the field and the Iteration value of every item of each configured project. A project write does not change the issue, so the incremental issue sync cannot see it; the items are read in full on each sync, 100 per page.
- `ready` and `why` derive the class from the cache. The `now` and `next` keys of `ready --json` keep their meaning.
- `gvt-fleet class <ref> now|next|later` puts the item in the current or the next iteration, or clears its value. It adds the issue to the project when it is missing.
- `gvt-fleet iteration plan` adds an iteration after the last one. `gvt-fleet iteration promote` ends Now today, starts Next today for 365 days, and lays out the planned iterations back to back after it. Neither writes an item. `iteration list` shows the layout.
- **Rule for every write:** an iteration update passes the id of every existing iteration, completed ones included. The code checks the layout for every id before the write, and reads the field back after it.
- The `class:now` and `class:next` labels are no longer read or written. The `nowLabel` and `nextLabel` config keys are removed: a config that sets one is invalid.
- `conflict` stays in `ready`'s `now[]` and in `why --json`, and is always `false`. It meant "both class labels", which can no longer happen. A contract-2 skill that reads it sees no conflict, which is the truth, so the coach contract keeps number 2 (ADR 0008).

## Compromise

**Where the class lives.**

- **Rejected: keep the `Class` single-select field and pass the option ids.** It fixes #95, but there is still one Next, and starting an iteration still writes every item.
- **Rejected: keep the labels.** They are per repository, they drift from the project, and a label cannot hold a goal.
- **Chosen: the Iteration field.** Starting an iteration moves two pointers in one field write. A completed iteration keeps its items, so the history stays in the project. The cost: GitHub drops an update that leaves out an id or overlaps, without an error, so every write is checked before and read back after.

**How `sync` reads the items.**

- **Rejected: `projectItems` on each issue in the issue query.** The incremental sync only fetches issues whose `updatedAt` moved, and a project write does not move it.
- **Rejected: `gh project item-list`.** It fetches every body and hit the secondary rate limit on the 515-item project (CLAUDE.md, Safety rules).
- **Chosen: one lean paged query per project, on every sync.** About 2 pages for the private organization's project and 6 for gvt-plugins, 1 point each.

**Who promotes.** The three `iteration` commands are in the CLI, so the id rule is enforced in one place and tested. The coach skill calls them.

## Consequences

- `state/cache.db` goes to schema version 2 (three project tables). The first command after the upgrade recreates the cache and the next sync is a full one, as for any version change (ADR 0001).
- A project that a sync cannot read is a sync error (exit 1), and its cached items stay.
- `class` needs a project. A repo with no `project` exits 2.
- `promote` refuses when Now started today: an iteration cannot end before today. Plan Now to start at least a day before its promotion.
- Two open questions from #108 stay open: whether the web UI's `@current` shows a 365-day iteration as expected, and whether a view is right on a day that no iteration holds. The CLI does not depend on either.
- Issues closed in a finished iteration keep that iteration, so "Done" is a completed iteration, not a class.
- `wiki/issue-triage.md` sets the class with `gvt-fleet class` only; the `Class` field is no longer written.
