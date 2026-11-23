---
type: decision-context
title: 'Coordinator keeps a raw issue cache and computes the graph and ready set per command'
description: 'Coordinator keeps a raw issue cache and computes the graph and ready set per command'
tags: [decisions]
status: stable
---
# 0001. Coordinator keeps a raw issue cache and computes the graph and ready set per command

- **Status:** accepted
- **Date:** 2026-11-03
- **Issue:** GenvidTechnologies/claude-code-plugin-gvt-dev#814

## Context

The `gvt-loop` coordinator must answer "which issues are ready to work on" across 12 repos and about 650 issues. Readiness depends on data that comes from different places and changes at different times:

- GitHub issue state: labels, assignees, native `blockedBy` links, sub-issues, body references and closing pull requests.
- Local claims: leases that GitHub cannot rebuild.
- The branch record: which remote branch belongs to which issue.

The coordinator also has to survive crashes, re-runs and concurrent writers. Two rules shape the storage choice. GitHub is the source of truth, so the cache must be disposable. A lease is not reproducible from GitHub, so it cannot live in that cache.

## Decision

The coordinator stores the raw issue data it syncs and computes the blocker graph and the ready set from that data on each command (**Option A: raw cache, graph and ready set computed per command**). The graph (`lib/graph.mjs`) and the ready set (`lib/ready.mjs`) are pure functions. One implementation of readiness serves `ready`, `why` and the fresh check inside `claim`.

Storage is split by durability. Both stores use `node:sqlite`:

- `state/cache.db` is disposable. It holds synced issues, remote branch heads and external blockers. A missing file or a `PRAGMA user_version` mismatch triggers a full resync. The sync high-water mark advances per committed page, in one transaction with that page's upserts.
- `state/claims.db` is durable. It holds leases and worktree state. A version mismatch stops the run and is reported. It is never dropped silently.

The following product rules are part of this decision:

- An assignee other than the configured claim account is a not-ready reason, `assigned-to-other`. Such issues are not offered and then refused at claim time.
- Readiness follows plan-next-issue's umbrella sources (open checklist children, a banner, an `epic:` or `tracking:` title) and its unfired-deferral rule, in addition to native sub-issues.
- Branch-to-issue links are recorded in a tracked `config/branches.json`. They are never inferred from branch names or pull requests. A pull request hint may be shown to the coach but is never written. A `remove` disposition only records the decision. Phase 1 never deletes a remote branch.
- A claim adds the `in-progress` label (created on first claim if the repo lacks it) and the claim account as assignee, and records a local lease. A hand claim, meaning a label or assignee with no local lease, is never removed by the coordinator.
- A plain `blocked` label blocks. It is reported as "blocked (label, blocker not named)" when no named blocker edge exists.
- A closed blocker is cleared when it closes.

All process spawning goes through one module, `lib/proc.mjs`. It is the only importer of `node:child_process`. The `gh`, `claude` and `git` wrappers sit on it, and tests replace the wrappers with fakes.

## Compromise

**Option B: materialized graph and readiness at sync time (alternative).** Sync would write `edges` and `readiness` tables, and `ready` would become a SQL query. This makes `ready` instant and lets a future MCP server or mod pane query SQL without JavaScript. It was rejected because:

- It stores the same data in two representations.
- Claims, the branch record and lease expiry change between syncs, so readiness would need recomputing outside sync. Two code paths could then disagree.
- A grammar upgrade from a plugin update would need a full re-extract.
- An incremental sync of one blocker changes its dependents' readiness, so it needs a full recompute anyway.

Option A can add a materialized view later as a pure cache over `ready()` if timing requires it.

**Option C: JSON-file cache (alternative).** Per-repo files under `state/issues/` and a `state/claims.json` would avoid the `node:sqlite` ExperimentalWarning and be easy to read. It was rejected for claims because every store is whole-value. Several writers (`claim`, `expire`, `worktree create`, and later hooks or an MCP server) would clobber each other without a hand-built lock and merge. A repo file is rewritten on every page commit. Crash-safe per-page high-water marks would need a write-ahead protocol that SQLite provides. It is viable for the cache alone, but one storage mechanism is simpler.

Other trade-offs:

- Computing per command costs CPU on every `ready`. The expected cost on about 650 issues is under a second. That figure is an estimate to be checked by timing `ready` on a full cache.
- `node:sqlite` is experimental and prints a warning. The design filters that one warning with a `process.on('warning')` listener and lets other warnings through. It avoids the native-build dependency of `better-sqlite3`.
- The design uses `gh` rather than `fetch` with a token. This costs about 20 to 30 spawns per sync. `lib/gh.mjs` keeps a later switch to one module.
- Inferring branch links was rejected. A placeholder key such as `BUR-0000` appears on real branches, so a Jira key does not identify a ticket.
- Deleting remote branches for a `remove` disposition was rejected for phase 1. It is a destructive GitHub write that nothing requires yet.

## Consequences

- Deleting `state/cache.db` loses nothing. A full resync rebuilds the same ready set.
- Lease data survives cache loss, because `state/claims.db` is a separate file with its own version check.
- A change to the grammar, the claims or the branch record takes effect on the next command with no re-sync.
- Tests can inject fakes at the process boundary. Under `GVT_LOOP_FAKE_ONLY=1` the real runner refuses to spawn `gh` or `claude`, so a leaking test fails instead of writing to GitHub.
- `config/branches.json` is a tracked file. `branch set` and `worktree create` change it, and the coach commits it. The coordinator does not commit.
- Two stores mean two schema versions to maintain, with opposite failure behavior: the cache resets, the claims DB stops the run.
- If `ready` becomes slow on a larger cache, add a materialized view over `ready()`. Do not move readiness into sync.
