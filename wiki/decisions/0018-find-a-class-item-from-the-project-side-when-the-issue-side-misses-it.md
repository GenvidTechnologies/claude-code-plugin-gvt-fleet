---
type: decision-context
title: 'Find a class item from the project side when the issue side misses it'
description: 'Find a class item from the project side when the issue side misses it'
tags: [decisions]
status: stable
---
# 0018. Find a class item from the project side when the issue side misses it

- **Status:** accepted
- **Date:** 2026-11-16
- **Issue:** workspace #143 (a cross-organization project item is invisible to `class`)
- **Amends:** how `gvt-fleet class` reads an item, in [ADR 0015](0015-derive-the-class-from-the-project-iteration-field.md)

## Context

`gvt-fleet class` found the issue's item through the issue's `projectItems` list, and read the value back the same way. For an issue whose repository and project belong to different organizations, that list is empty. So `class … now` on an item already in the project reported `failed` (`readback: the item holds no iteration`, exit 1) after a write that landed, and `class … later` on an item in Now printed `noop` and left it there. On 2026-11-16 every open issue of the workspace repository, which the private organization owns, moved to the project `GenvidTechnologies/1`, which made 45 more items cross-organization.

**Hidden by design, not by token access.** A read-only probe on 2026-11-16 (workspace #143) found:

- The token (`gh`'s OAuth token with the `repo`, `project` and `admin:org` scopes) reads issues and projects of both organizations. The viewer is a member of the private organization and an administrator of `GenvidTechnologies`. A same-organization item is listed on the issue side in both organizations.
- The issue side is empty in both directions: the workspace repository's #35 in `GenvidTechnologies/1`, and `GenvidTechnologies/c3addon-gcore-video-plugin#6` in the private organization's project 6. `projectItems` (with `includeArchived: true`) and `projectsV2` both return 0.
- The same issue object, reached through the project's own `items` list, still returns `projectItems.totalCount: 0`. The filter is in the issue's connection, whatever the path to the issue.
- The issue's timeline shows an `AddedToProjectV2Event` for the cross-organization project, with its id. The token can see that project from the issue.

So GitHub lists, on the issue side, only the items of projects owned by the repository's owner. The schema says only "List of project items associated with this issue", and no GitHub page states the rule, so it is inferred from these reads. The token sees both resources and the join is still empty, so a different token would not change it.

The same probe found two reads that work across organizations:

- `ProjectV2.items(query: "repo:<owner/name>")` returns that repository's items only (57 for the workspace repository in `GenvidTechnologies/1`, 1 for c3addon-gcore-video-plugin in the private organization's project 6, 0 for a repository that does not exist). `archivedStates: [ARCHIVED, NOT_ARCHIVED]` includes archived items. A free-text term such as `#35`, the number of workspace #35, also narrowed the list to one item, but how it matches is not documented, so it is not used.
- `node(id: <item id>) { ... on ProjectV2Item { project { id } fieldValueByName(…) } }` reads one item's value. An id that does not exist returns `node: null` with a `NOT_FOUND` error on the path `node`.

The issue's comments also record that `addProjectV2ItemById` returns the existing item's id when the issue is already in the project.

## Decision

**`class` reads the issue side first, then the project side; it reads the value back by item id.**

- The issue query stays: it gives the issue's id and state, and the item when the project's owner is the repository's owner.
- When the issue side lists no item in the project, `class` reads the project's items filtered by `repo:<owner/name>`, 100 per page, and takes the one whose content is the issue (same repository, same number). No item there means the issue is not in the project.
- After the write, it reads the item by id and checks that the item is in the project. The value read there is the readback.

## Compromise

- **Rejected: the cached items from the last `sync`.** The cache can be a day old, and `class` reads the field live for that reason (ADR 0015). An item added since the sync would be missed, and `later` would print a false `noop`.
- **Rejected: always call `addProjectV2ItemById` to get the item id.** It is a write. `later` must not add an issue to the project, and the add cannot say whether the item was there before, so `previous` and `addedToProject` would be guessed.
- **Rejected: decide by comparing the two owners.** The rule above is inferred, not documented. Falling through to the project side on any miss keeps `class` right if GitHub's rule is wider or narrower. The cost is one extra query when a same-organization issue is not in the project.
- **Chosen: issue side, then a project-side lookup filtered by repository, and a readback by item id.** One more query for a cross-organization item, and one per page of that repository's items, which is one page today.

## Consequences

- `class` on a cross-organization item reports the right `previous`, `addedToProject` and readback, and `later` clears an item in Now.
- If the `repo:` filter ever lags behind a write made seconds earlier, `now` or `next` would add the issue again. GitHub returns the existing item, so the value is still right, and only `addedToProject` would read `true`.
- The test fake answers the issue side with an empty list when it is set to `crossOrg`, and answers the project-side and readback queries with the shapes read on 2026-11-16.
