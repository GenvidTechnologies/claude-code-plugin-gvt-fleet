---
type: reference
title: 'Local config'
description: 'Reference for the two committed config files, config/repos.json and config/branches.json.'
tags: [configuration]
status: stable
---
# Local config

Two files configure `gvt-fleet`:

- `config/repos.json` lists the managed repos and the claim and sync policy.
- `config/branches.json` records what to do with branches that no issue owns.

Both are committed. The command reference is [gvt-fleet command reference](coordinator.md).

## `config/repos.json`

The file is one JSON object. `version` is required and must be `1`. The loader rejects any key that is not listed here.

### Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `version` | number | Required. Must be `1`. |
| `claimAccount` | string | The GitHub login that claims issues. An issue assigned to any other login is not ready (`assigned-to-other`). |
| `leaseMinutes` | number >= 0 | Length of a claim lease. |
| `rateReserve` | number >= 0 | GitHub API budget that sync leaves unused: sync stops when the remaining rate-limit points fall below it. Default 0. |
| `fullSyncHours` | number >= 0 | Hours since a repo's last full sync after which the next sync of that repo is a full sync instead of an incremental one. Default 24. |
| `repos` | array | Required. One entry per managed repo. |

### Entry keys in `repos`

| Key | Type | Meaning |
|---|---|---|
| `repo` | string | Required. `owner/name`. Case-insensitive duplicates are an error. |
| `enabled` | boolean | `false` leaves the repo out. Absent means enabled. |
| `triagedLabel` | non-empty string | Label that marks an issue as triaged. |
| `inProgressLabel` | non-empty string | Label that marks a claimed issue. |
| `blockedLabel` | non-empty string | Label that marks a blocked issue. |
| `defaultBranch` | non-empty string | Branch that worktrees start from. |
| `project` | string | The GitHub project of the repo's issues, as `owner/number` (for example `example-org/6`). Its Iteration field gives the class of each issue. Without it, every issue of the repo is Later and `gvt-fleet class` exits 2. See [Commands: classes and iterations](coordinator/classes.md#commands-classes-and-iterations). |

The keys `nowLabel` and `nextLabel` were removed by ADR 0015, which replaced the class labels: an entry that sets one is invalid (`unknown key`).

The short name of a repo is the part after the `/`. Two entries cannot share a short name, because commands accept `name#N` as an issue reference.

### Precedence

For each label key and for `defaultBranch`, the effective value is the first of these that is set, from lowest to highest priority:

1. The built-in default. The labels default to `triaged`, `in-progress` and `blocked`. `defaultBranch` has no built-in value. It starts as the repo's default branch on GitHub, which sync records.
2. The `bugTracker` block of the repo's own `.gvt-agent.json`. Sync reads it from GitHub.
3. The entry in `config/repos.json`.

A key in a higher layer replaces the same key in a lower layer. A key that is absent from a layer leaves the lower value in place.

### Config errors

`gvt-fleet` validates `config/repos.json` and `config/branches.json` before it does anything else. An invalid file makes the command exit with code 2. The message names each bad entry, for example `repos[3] owner/name: unknown key "x"`, or `(config)` for a top-level problem. The command stops before any GitHub write.

## `config/branches.json`

The branch record holds a decision for each remote branch that is not the default branch and is not tied to an issue.

```json
{
  "version": 1,
  "repos": {
    "owner/name": {
      "some-branch": { "disposition": "issue", "issue": "owner/name#12", "decided": "2026-11-03", "by": "coach" }
    }
  }
}
```

`version` must be `1`. `repos` maps `owner/name` to an object of branch entries. Each entry has these keys, and no others:

| Key | Meaning |
|---|---|
| `disposition` | Required. `issue` (the branch belongs to an issue), `keep` (leave it alone) or `remove` (it should go). |
| `issue` | Required when `disposition` is `issue`, and not allowed otherwise. A full `owner/repo#N` reference. |
| `decided` | Required. Date of the decision, `YYYY-MM-DD`. |
| `by` | Required. Non-empty name of who decided. |

### Commands

- `gvt-fleet branches` lists the recorded entries. Each shows `on-remote`, or `gone` when the branch left the remote.
- `gvt-fleet branches --unknown` lists remote branches that are not the default branch and not recorded. Each line shows the head commit and its last commit date. A hint line names an open or merged closing PR from that branch and the issue it closes. Hints come from the cache and are never written to the record.
- `gvt-fleet branch set <owner/repo> <branch> (--issue <ref> | --keep | --remove)` writes one entry. `--issue` takes `#N`, `name#N` or `owner/repo#N`. The branch must be in the cached remote list, or `--allow-missing` must be given. `--by <name>` sets `by`; the default is `coach`.

`branch set` changes the file in the working tree only. It prints `config/branches.json changed; commit it` on stderr. Commit the file yourself.

### Effect on readiness

A recorded entry with `disposition` `issue` ties its branch to that issue. While the branch is on the remote and the issue is open, the issue is not ready. The reason is `existing-branch`, with the value `owner/name:branch`.
