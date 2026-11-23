---
type: reference
title: 'Commands: classes and iterations'
description: 'The class command, which puts an issue in the Now, Next or Later class through the project Iteration field, and the iteration commands, which plan iterations and start the next one.'
tags: [command-reference]
status: stable
---
# Commands: classes and iterations

This page is part of the [gvt-fleet command reference](../coordinator.md).

Each open managed issue is in one class: Now, Next or Later. The class comes from the native Iteration field of the GitHub project that the repo's config entry names (`"project": "owner/number"`, see [Local config](../configuration.md)). [ADR 0015](../decisions/0015-derive-the-class-from-the-project-iteration-field.md) records the decision, and [ADR 0022](../decisions/0022-record-the-now-iteration-so-a-project-can-promote-more-than-once-a-day.md) the recorded Now pointer.

- **Now** is the iteration that `iteration promote` recorded as Now for the project, whatever the date.
- **Next** is the first iteration that starts after Now.
- **Later** is every other iteration (planned or completed), an item with no iteration, an issue that is not in the project, and every issue of a repo with no project.

**The Now pointer.** `iteration promote` records the new Now's id in `now-pointers.json` in the state folder (next to `cache.db`). It is durable state, not cache: deleting the cache keeps it. A project with no recorded Now, or whose recorded id is no longer in the field, falls back to the dates: Now is the iteration that holds today, and Next the first one that starts after today. "Today" is the UTC day, so in a timezone west of UTC the date pointers move in the evening. A `now-pointers.json` that is not valid JSON, or not version 1, stops `ready`, `why`, `class` and the `iteration` commands with exit 1; fix or delete it.

An iteration's title is its goal. Now lasts 365 days, so its dates do not end it: only a promote does. `sync` reads the field and the items into the cache, and `ready` and `why` derive the class from there with the recorded Now. The labels `class:now` and `class:next` are no longer read or written.

The class is not a ready reason. `claim` and `dispatch` ignore it.

**The id rule.** GitHub writes the whole list of iterations in one update. An update that leaves out the id of an existing iteration deletes that iteration and clears its items, and that includes a completed iteration. An iteration that overlaps another is dropped, and so is one of two iterations with the same start date. Neither returns an error. An iteration of zero days is refused with an error. So every command here that writes iterations passes every id, gives every iteration at least one day, lays the iterations out back to back, checks all three before the write, and reads the field back after it.

## gvt-fleet class

```
gvt-fleet class <ref> <class>
```

Sets the class of an open issue. `<class>` is `now`, `next` or `later`, in lowercase.

1. It reads the Iteration field of the repo's project and the issue's item in it, live from GitHub. GitHub lists an issue's items only for projects of the repository's owner, so when the issue lists no item in the project, `class` looks for it in the project's items of that repository ([ADR 0018](../decisions/0018-find-a-class-item-from-the-project-side-when-the-issue-side-misses-it.md)).
2. For `now` or `next` it adds the issue to the project when it is not in it.
3. It writes the item's value: the Now iteration for `now`, the Next one for `next`, no value for `later`. Now and Next come from the live field and the recorded Now pointer.
4. It reads the value back, by the item's id.
5. When the readback agrees and `sync` has read the project, it writes the value and the iterations to the cache. `ready` then shows the change without a `sync`.

- An issue that already has the class prints `noop` and makes no GitHub write. An item in a planned or completed iteration is Later already, so `later` leaves it there. `later` does not add an issue to the project.
- A closed issue is refused. So is a project with no Iteration field, and `now` or `next` when the project has no Now or no Next iteration (see [gvt-fleet iteration plan](#gvt-fleet-iteration-plan)). The reason says "has no current iteration" or "has no next iteration".
- With `--json`, it prints `{key, status, class, previous, project, iteration, addedToProject, cached}`, and `reason` when `status` is `refused` or `failed`. `status` is `changed`, `noop`, `refused` or `failed`. `previous` is the class before the change. `iteration` is `{id, title}` of the iteration the item was put in, or `null` for `later`. `addedToProject` says whether the issue was added to the project. `cached` is `false` when the cache was not written.
- Side effects: GitHub reads, and at most two project writes (add the item, set or clear its value). It writes `state/cache.db`. It does not open `state/claims.db`.
- Exit codes: 0 for `changed` or `noop`. 1 for `refused` or `failed` (a GitHub error, or a readback that disagrees; the cache is then unchanged), and for a `now-pointers.json` that cannot be read (nothing is written then). 2 for an invalid configuration, or a repo with no `project`. 64 for an unknown class, a ref it cannot read, a task id (stderr says it is a task, not an issue reference), or the wrong number of arguments.

## gvt-fleet iteration list

```
gvt-fleet iteration list [<owner/number>]
```

Lists the iterations of each project that an enabled repo names, or of the one project given, read live from GitHub.

- One line per iteration, by start date: its role (`now`, `next`, `planned` or `completed`), its start and end date, its id and its title. The end date is the first day after the iteration (the start date plus the duration in days), so `2026-11-20 to 2026-11-21` is one day, 2026-11-20. The `endDate` key of `--json` is the same day.
- With a recorded Now, an iteration that starts before it is `completed` and one after Next is `planned`, whatever its dates. So after a second promote on one day, `now` can be an iteration that starts tomorrow. With no record, the dates decide the roles.
- It warns on stderr when the recorded Now of a project is not in its field, and then uses the dates.
- With `--json`, it prints `{today, projects: [{project, field, pointer, iterations: [{id, title, startDate, duration, endDate, role}]}]}`. `field` is `false` when the project has no Iteration field. `pointer` is `recorded` when the roles follow the recorded Now, and `dates` when they follow the dates. A project that could not be read carries `error`.
- Side effects: GitHub reads only.
- Exit codes: 0, 1 when a project could not be read or `now-pointers.json` cannot be read, 2 for an invalid configuration, 64 for a project that no enabled repo names or a wrong argument count.

## gvt-fleet iteration plan

```
gvt-fleet iteration plan <owner/number> <title>
```

Adds an iteration whose title is the goal. It lasts 365 days and starts where the last iteration ends. When no iteration ends after today it starts today. With no recorded Now, it then becomes Now; with one, it comes after Now, so it is Next or planned. It does not change the recorded Now.

- It writes the whole field in one update with every existing id (see the id rule above), reads it back and compares the result with the layout it wrote. It writes no item.
- The new layout goes to the cache, so `ready` sees it without a `sync`.
- With `--json`, it prints `{project, status, added, iterations, reason?}`. `status` is `changed`, `refused` or `failed`. `added` is the new iteration with its id.
- Side effects: one GitHub field write. It writes `state/cache.db`.
- Exit codes: 0 for `changed`. 1 for a project with no Iteration field, an empty title, a GitHub error, a readback that disagrees, or a `now-pointers.json` that cannot be read. 2 for an invalid configuration. 64 for a project that no enabled repo names or a wrong argument count.

## gvt-fleet iteration promote

```
gvt-fleet iteration promote <owner/number> [<iteration>]
```

Starts the next iteration: Next becomes Now at once, and no date check limits how often it runs. In one update of the field it:

1. ends Now today: it moves to the completed iterations and its items keep it. When Now started today, or later, it keeps one day instead, because GitHub refuses an iteration of zero days;
2. starts Next for 365 days where the last kept iteration ends, but not before today. Usually that is today. After a promote earlier the same day, it is the next day;
3. lays out the planned iterations back to back after it. `<iteration>` (an id or an exact title) puts that planned iteration first, so it becomes the new Next. Without it, the planned iteration that starts first becomes Next.

Then it records the new Now (see "The Now pointer" above), so `ready`, `why` and `class` treat it as Now even when it starts tomorrow. The dates of the field stay a log: a goal ends on the day it closed, except on a day with more than one promote, where each later goal is dated one day after the one before it. GitHub's own `@current` in a project view follows the dates, so on such a day the board shows the earlier goal until the dates catch up.

- It writes no item. Each issue keeps its iteration; the pointers move. The update passes every id, completed ones included, and this is checked before the write. It reads the field back and compares the result with the layout it wrote, then writes the new layout to the cache.
- It records the new Now once GitHub has taken the update, also when the readback then fails. The `reason` then says that Now is recorded: run `iteration list` before another promote, or you promote twice.
- It refuses when there is no Next, and when `<iteration>` is not a planned iteration after Next.
- With `--json`, it prints `{project, status, from: {now, next}, to: {now, next}, iterations, reason?}`. `status` is `changed`, `refused` or `failed`.
- Side effects: one GitHub field write. It writes `state/cache.db` and `state/now-pointers.json`.
- Exit codes: 0 for `changed`. 1 for `refused` or `failed`, and when `now-pointers.json` cannot be read (nothing is written then). 2 for an invalid configuration. 64 for a project that no enabled repo names or a wrong argument count.
