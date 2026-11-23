---
type: decision-context
title: 'Store the issue class as GitHub labels'
description: 'Store the issue class as GitHub labels'
tags: [decisions]
status: stable
---
# 0010. Store the issue class as GitHub labels

- **Status:** superseded in part by [ADR 0015](0015-derive-the-class-from-the-project-iteration-field.md): the class now comes from the project Iteration field, and the labels are no longer read. The `ready` keys and the rule that the class is not a ready reason still hold.
- **Date:** 2026-11-06
- **Issue:** #45 (the coach overview lists every ready issue)

## Context

The coach overview listed every ready issue. On 2026-11-06 that was 425 issues, and 334 of them were in one repository. A list that long is not read. Issue #45 gives each open managed issue a class: Now, Next or Later.

The class must survive the deletion of `state/cache.db`. ADR 0001 says the cache holds only what GitHub can rebuild, and the docs say that deleting it is safe.

## Decision

The class is stored as two GitHub labels. The per-repo settings `nowLabel` and `nextLabel` name them. The defaults are `class:now` and `class:next`. Later means neither label, and it is the default.

`gvt-fleet class <ref> <class>` is the one writer. It adds the wanted label before it removes the other one, and it reads the issue back. When the readback agrees, it writes the labels to the cached row, so `ready` shows the change without a `sync`.

`ready --json` always carries `now[]` and `next[]`. `ready --class <class>` lists the issues of one class.

The class is not a ready reason. `ready[]`, `computeReady`, `claim` and `dispatch` ignore it. An issue with both labels is in Now, with `conflict: true`.

The added keys keep the contract number (ADR 0008).

## Compromise

**Where the class lives.**

- **Rejected: a column in `cache.db` only.** Every sync rewrites the whole row with `INSERT OR REPLACE`, which would erase the column. Deleting the cache is documented as safe. ADR 0001 forbids state that GitHub cannot rebuild.
- **Rejected: a durable local database.** `claims.db` has no migration path, so a schema change stops every install. A new file is invisible to anyone else who works on the issues.
- **Rejected: a tracked file in the workspace, like `config/branches.json`.** Each promotion becomes a commit. Entries for closed issues need pruning.
- **Accepted cost of labels.** Labels are public on public repositories. Each class change is a GitHub write, so it asks the coach's permission.

**Where the overview reads it.** Three options were weighed.

- "Option A (recommended): always-present `now` and `next` on `ready --json`, and `--class <class>` for listing". **Chosen.** The overview stays on the one pre-approved `--json ready` command, as `untriaged` does.
- "Option B (alternative): grouping only behind a flag (`ready --classes`)". **Rejected.** The skill must pre-approve a new exact command form. The coach view splits across two invocations: `untriaged` on the default output, and Now behind a flag.
- "Option C (rejected): a separate read command `gvt-fleet board`". **Rejected.** It adds more than it saves: a 20th command, a second pre-approved command, and the view split again.

## Consequences

- A sync can read a page before a `class` write and upsert it after the write. The cache then holds the old labels until a later sync sees the issue as changed. Whether a label change moves `updatedAt` is not verified. The daily full sync repairs the row. So does a re-run of `class`, because its `noop` path rewrites the cached labels.
- A label added by hand on github.com shows after the next sync that sees it.
- A closed issue keeps its class label. Removing it at wrap-up is out of scope.
- On rollout no issue carries a class label, so Now is empty until the coach promotes issues.
- `wiki/issue-triage.md` tells the triager to leave the `class:*` labels alone.
