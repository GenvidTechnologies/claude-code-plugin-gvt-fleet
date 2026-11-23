---
type: reference
title: 'Commands: claims'
description: 'The claim commands: claim, release, heartbeat and expire.'
tags: [command-reference]
status: stable
---
# Commands: claims

This page is part of the [gvt-fleet command reference](../coordinator.md).

A claim is a local lease plus two marks on GitHub: the in-progress label and the claim account as assignee. The lease length is `leaseMinutes`. `claimAccount` must be set in the config.

## gvt-fleet claim

```
gvt-fleet claim <ref>
```

Takes a lease on an issue. It needs gvt-dev 4.45.0 or later for the reference grammar (see [The gvt-dev requirement](../coordinator.md#the-gvt-dev-requirement)).

1. It writes the local lease as `claiming`.
2. It reads the issue from GitHub again and runs the readiness check on the fresh data.
3. If any reason applies, it marks the lease `failed`, prints each reason on stderr, and exits 1.
4. It makes sure the in-progress label exists in the repo (it creates it when GitHub answers 404).
5. It records whether the assignee was there before and whether it added the label. Then it adds the label and the claim account as assignee.
6. It reads the issue back. If the label or the assignee is missing, the claim fails.
7. It marks the lease `held` and prints the expiry. If another assignee appeared during the claim, it warns on stderr (contention).

- A claim that is already held and not expired prints `noop` and exits 0.
- A lease in `releasing` state blocks a new claim. Run `release` first.
- Side effects: GitHub reads and writes on one issue (label create if missing, label add, assignee add). It writes `state/claims.db`.
- Exit codes: 0 for held or noop, 1 for refused or failed, 2 when `claimAccount` is not set or the config is invalid, 64 for a wrong ref. A task id gets exit 64 too: stderr says it is a task, not an issue reference.

## gvt-fleet release

```
gvt-fleet release <ref | task id>
```

Ends the lease on an issue or a task.

- For a task id, the lease goes straight to `released`. There is no `releasing` step and no GitHub call, because a task has nothing on GitHub to undo.
- For an issue, it removes the label only if the claim added it. It removes the assignee only if the claim added it. A label or assignee that was there before stays.
- It reads the issue back and fails if a mark is still there.
- It retries a release that failed earlier (state `releasing` or `failed`).
- Side effects: for an issue, GitHub writes on that issue. For a task, none. It writes `state/claims.db`.
- Exit codes: 0 when released, 1 when there is no claim to release or the GitHub update failed, 64 for a wrong ref or task id.

## gvt-fleet heartbeat

```
gvt-fleet heartbeat <ref | task id>
```

Extends a held lease on an issue or a task to `leaseMinutes` from now.

- It does not revive a lease that has already expired. Run `expire`, then `claim` again.
- Side effects: it writes `state/claims.db`. It makes no GitHub call.
- Exit codes: 0 when refreshed, 1 when there is no held claim or the lease has expired, 64 for a wrong ref or task id.

## gvt-fleet expire

```
gvt-fleet expire
```

Handles leases that are past their expiry.

- A held lease whose worker is [live](workers.md#live-workers) is extended by `leaseMinutes`. The worker's session is found by the session id on the claim, or by the worktree name in the base clone, so a worker that runs under a new session id still counts.
- Any other expired held lease is released, as `release` does.
- A lease in `releasing` state, and a `failed` lease that wrote to GitHub, are released again. They need no session check.
- A `claiming` lease whose start or last heartbeat is older than `leaseMinutes` is residue of a claim that died mid-way, and is released the same way. A younger `claiming` lease is left alone.
- If `claude agents` cannot be read, the held leases stay as they are and are reported as failed.
- A task lease (key `owner/name@<slug>.<YYYYMMDD>.<n>`) is handled the same way, with no GitHub call: a live one is refreshed, and a dead, expired one is released and listed under released.
- A lease whose key is neither an issue key (`owner/name#N`) nor a task key is reported as failed with the reason `cannot read lease key`. The other leases are still handled.
- A label or assignee that was set by hand is left alone.
- It prints how many leases it refreshed, released and failed.
- Side effects: GitHub writes (through the release), a `claude agents` call, and `state/claims.db`.
- Exit codes: 0, 1 when any lease could not be handled, 64 for an argument.
