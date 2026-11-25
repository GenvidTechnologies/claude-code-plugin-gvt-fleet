---
type: reference
title: 'Commands: reading'
description: 'The read commands: check-config, sync, ready and why.'
tags: [command-reference]
status: stable
---
# Commands: reading

This page is part of the [gvt-fleet command reference](../coordinator.md).

## gvt-fleet check-config

```
gvt-fleet check-config
```

Validates `config/repos.json` and the branch record beside it.

- Reports every invalid entry on stderr.
- Prints the number of repos, how many are enabled, and the size of the branch record.
- With `--json`, prints the effective settings of each repo (labels, `enabled` and `project`, which is `null` when unset) and the size of the branch record, and a `coach` block (below).
- Side effects: none. It reads two files. With `--json` it also reads the `origin` remote of the workspace.
- Exit codes: 0 when valid, 2 when any entry is invalid, 64 when given an argument.

The `coach` block is `{ "contract": 2, "workspaceRepo": "owner/name" }`. A coach skill runs `check-config --json` first, for three reasons: to confirm that the folder is a gvt-fleet workspace, to compare `contract` with the number the skill was written for, and to learn which repository is the workspace's own. `dispatch` refuses an issue in that repository unless `--allow-self` is given.

- `contract` is the version number of the `coach` block (`COACH_CONTRACT` in `plugin/cli/lib/dispatch.mjs`). It goes up when a key that a coach skill reads is removed, renamed, or changes type or meaning. Adding a key does not raise it. A coach skill refuses a number it does not know.
- `workspaceRepo` is the `owner/name` of the workspace's `origin` remote. It is `null` when the value cannot be read: there is no `origin` remote, the workspace is not the top level of a git repository, git returns an error, or the remote URL is not a GitHub URL.
- The human output line does not show the `coach` block.

## gvt-fleet sync

```
gvt-fleet sync [--full]
```

Refreshes the issue cache from GitHub for every enabled repo. It needs gvt-dev 4.45.0 or later for the reference grammar (see [The gvt-dev requirement](../coordinator.md#the-gvt-dev-requirement)).

- The first run for a repo is a full sync. Later runs fetch only changed issues, unless the last full sync is older than `fullSyncHours`.
- `--full` fetches every issue again.
- It also looks up issues that are named but not in a managed repo, and reads the remote branch heads.
- For each project that an enabled repo names (the `project` key), it reads the Iteration field and the Iteration value of every item, 100 items per page. A project write does not change the issue, so an incremental sync could not see it: the items are read in full on every run. `ready` and `why` take the class from this (see [Commands: classes and iterations](classes.md#commands-classes-and-iterations)). Stderr prints one line per project: pages, items, and the number of iterations or `no Iteration field`. A project that cannot be read is an error, and its cached items stay.
- Cached issues of a repo that is no longer enabled in the config (removed, disabled or renamed) are kept, but are no longer managed. `ready` does not list them, and an issue among them that a managed issue names is looked up as an external issue. Stderr reports how many issues changed this way.
- It prints the number of issues, pages, external lookups, points used and points left, then the unresolved refs and cycles, then the number of unknown branches.
- Progress and warnings go to stderr, one line per repo.
- It stops when the rate limit is reached, or when the points left fall below `rateReserve`. It prints the reset time on stderr.
- Side effects: GitHub reads only (GraphQL, and `gh` calls). It writes `state/cache.db` and one line to the log. It makes no GitHub write.
- Exit codes: 0, 1 when a repo or a project failed, 2 when an overlay entry is invalid or the config is invalid, 64 for a wrong argument, 75 when it stopped at the rate limit. When more than one applies, 2 wins over 1, and 1 wins over 75.

## gvt-fleet ready

```
gvt-fleet ready [--all | --class <class>]
```

Lists the ready issues of the managed repos, from the cache. It also lists the Now issues and counts the Next issues (see [Commands: classes and iterations](classes.md#commands-classes-and-iterations)). It needs gvt-dev 4.45.0 or later for the reference grammar (see [The gvt-dev requirement](../coordinator.md#the-gvt-dev-requirement)).

- An issue is ready when no reason code applies to it.
- It never calls GitHub. Run `sync` first. If the cache is empty, it says so on stderr.
- `--all` also lists the issues that are not ready, each with its reasons.
- With `--json`, it prints `{ready: [{key, title}], untriaged: [...]}`. With `--all` it prints `{ready, issues: [...], untriaged}`, where `issues` holds every issue with its reasons.
- Untriaged summary: `untriaged` has one entry for each managed repo that has untriaged open issues, `{repo, count, keys, onlyReason}`. An issue counts when its reasons include `not-triaged`, whatever its other reasons. `keys` lists those issues in issue-number order. `onlyReason` is how many of them have `not-triaged` as their only reason, which is how many the `triaged` label alone would make ready. Entries follow the cache order (repo, then issue number). The array is `[]` when no issue is untriaged. It is computed from every open managed issue, with and without `--all`.
- The human output prints one line after the list for each entry: `untriaged <repo>: <count> issues, <onlyReason> with no other reason`, with `1 issue` for a count of 1. It prints nothing when the summary is empty. The ready list is the same with or without the summary.
- Now and Next: the output always carries `now` and `next`, and both are `[]` when empty. `now` lists every open managed Now issue, ready or not, as `{key, title, ready, reasons, conflict}`. The class comes from the cached project of the repo: an issue whose item is in the Now iteration is Now, one in the Next iteration is Next. Now is the iteration that `iteration promote` recorded, whatever its dates, or with no record the one that holds today (see "The Now pointer" in [Commands: classes and iterations](classes.md)). `conflict` is always `false`; it meant "both class labels", which are no longer read (ADR 0015). `next` has one entry `{repo, count}` for each managed repo that has open Next issues.
- `--all`: each entry of `issues` also carries `class` and `conflict`.
- `--class <class>`: `<class>` is `now`, `next` or `later`. The output adds `issues`, the open managed issues of that class, ready or not, each as `{key, title, state, ready, reasons, class, conflict}`. The other keys stay. Without `--json` it prints only that list, one line per issue and its reasons below it. `--class` cannot be combined with `--all`.
- The human output prints, after the `untriaged` lines, one line `now <key> ready|not ready <title>` for each Now issue (its reasons follow, indented), then one line `next <repo>: <count>` for each repo.
- The class is not a ready reason. `ready[]` is the same in every class, and `why` is unchanged. `claim` and `dispatch` ignore the class.
- Side effects: none.
- Exit codes: 0, 1 when the schema version of `state/claims.db` differs from this tool's (older or newer; see [Claims database version mismatch](../coordinator.md#claims-database-version-mismatch)) or `state/now-pointers.json` cannot be read, 2 for an invalid config, 64 for a wrong argument, including an unknown or missing class and `--class` together with `--all`.

## gvt-fleet why

```
gvt-fleet why <ref>
```

Explains the ready verdict of one issue, from the cache. It needs gvt-dev 4.45.0 or later for the reference grammar (see [The gvt-dev requirement](../coordinator.md#the-gvt-dev-requirement)).

- It prints ready or not ready, then a line `  class: now`, `  class: next` or `  class: later`, then every reason with its detail and every edge that points at the issue, with its source and line.
- When the issue's item has an iteration, the class line ends with ` (iteration <title>)`. See [Commands: classes and iterations](classes.md#commands-classes-and-iterations) for what a class is.
- The class does not change the ready verdict or the reasons.
- `ready` and `why` use the same code, so they cannot disagree.
- With `--json`, it prints `{key, title, state, managed, ready, reasons, edges, class, conflict, iteration}`. `class` is `now`, `next` or `later`. `iteration` is `{id, title}` of the item's iteration, or `null`. `conflict` is always `false`.
- Side effects: none.
- Exit codes: 0 whether the issue is ready or not, 1 when the issue is not in the cache (run `sync`) or `state/now-pointers.json` cannot be read, 64 for a ref it cannot read or a repo that is not in the config. A task id gets exit 64 too: stderr says it is a task, not an issue reference. `why` does not explain a task.

The class line comes second, after the first line (the verdict and the title). For an issue whose item is in the Now iteration, titled "Goal A", it reads:

```
  class: now (iteration Goal A)
```
