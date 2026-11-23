---
type: decision-context
title: 'Run task workers without an issue'
description: 'Run task workers without an issue'
tags: [decisions]
status: stable
---
# 0012. Run task workers without an issue

- **Status:** accepted
- **Date:** 2026-11-08
- **Issue:** workspace #34
- **Amends:** none

## Context

Some work has no issue: maintenance, an investigation, or a triage pass over one repository. Triage is the first use. A triage pass may scaffold `docs/issue-triage.md` or a `bugTracker` block, so the worker needs a branch to commit on and a pull request to open.

Until now every worker was tied to an issue. The lease key was `owner/name#N`, the worktree was `<short>-<N>`, and `claim` wrote a label and an assignee on GitHub. A worker with no issue has none of these.

Three questions needed a decision: where the state of such a worker lives, what its id and names look like, and how `status` reports it without changing the coach contract.

## Decision

### Where task state lives

```
Option A: the task is a lease row with its own key shape
Option B: tasks in a separate `state/tasks.db`
Option C: claims schema version 3 with `kind`, `repo` and `task_name` columns
```

**Option A (chosen).** A task is a row in `state/claims.db`. Its key is `owner/name@<slug>.<YYYYMMDD>.<n>`. It reuses every column. `label_added` and `assignee_preexisting` stay NULL, because a task makes no GitHub write. One pure key grammar in `lib/worker-key.mjs` tells an issue key from a task key. The primitives that take a key (`createWorktree`, `removeWorktree`, `finishWorktree`, `wrapWorker`, `joinWorkers`, `expireClaims`) read the key through that grammar.

A task key cannot equal an issue key, so `ready` is not affected. It matches leases by the issue key.

**What an older CLI does.** The measurement was made on 2026-11-08 against the CLI of main (672ded6). A scratch `claims.db` held one issue lease and one task lease, `acme/app@triage.20261108.1`.

- `status` exited 1 with `cannot read "acme/app@triage.20261108.1" as owner/repo#N`. The error comes from the issue-key parser in the status join. `status` wrote nothing.
- `expire` exited 1. The sha256 of `claims.db` was the same before and after.

So an older CLI fails loudly and makes no wrong write. It is not fail safe: `status`, `watch` and `expire` stop while a task lease is active.

**Guard in the new code.** A lease key that the new CLI cannot read never throws. `status` counts it in `ignored.leases`. `expire` reports it as failed and continues. A later key shape cannot repeat this stop against this CLI.

**Consequence of the choice.** No task is dispatched against the real `state/` until the main checkout runs this version.

### Identifier and names

| Part | Form |
|---|---|
| Lease key | `owner/name@<slug>.<YYYYMMDD>.<n>` |
| Worktree and session | `<short>.<slug>.<YYYYMMDD>.<n>` |
| Branch | `worktree-<short>.<slug>.<YYYYMMDD>.<n>` |

- The key holds the full repository name, so it does not change when a short name changes.
- `@` is not used in the worktree name. The worktree name never ends in `-<digits>`, so neither of the two issue-worktree parsers (in `lib/worktree-path.mjs` and `lib/status.mjs`) reads it as an issue.
- The name has at most 64 characters. The slug has at most 24 characters and must also be short enough for the 64.
- The date is the UTC date.
- `n` is unique over every lease row, history included, because `leases_key` is not unique. The dispatch also skips a number whose folder or branch exists.

**Probe.** A probe was run on 2026-11-08 with Claude Code 2.1.319 on Windows 11, in a trusted sandbox repository.

- `claude --bg -w <name> -n <name>` with a 64-character name, the longest managed repository name (36 characters) followed by `.triage-pass-abcd.20261108.1`, exited 0. It created `.claude/worktrees/<name>` and the branch `worktree-<name>`. `claude agents --json --all` listed the session under that name.
- After an unpushed commit, `claude rm` refused and printed `--discard-unpushed <commit>@<worktree id>`. The worktree id is a 32-hex id, not the name. `parseDiscardValue` read the value whole. `claude rm … --discard-unpushed <value>` removed the session and the worktree.
- Not tested: a 65-character name. The 64-character limit comes from the documentation of the worktree tool of Claude Code.

### Status shape

**S1: task rows in a new top-level `tasks[]` array.** `status --json` gains `tasks`. A `tasks[]` row has the keys of a worker row. Its `key` is the task key and its `issue` is `null`. `workers[]` is unchanged.

```
S2: task rows in `workers[]` with the task id in `key`, plus a `kind` key
S3: task rows in `workers[]` with `key: null`, plus `task` and `kind` keys
```

S2 is rejected. `workers[].key` would stop always being an issue key, which changes its meaning. S3 is rejected. It changes the type of `key`. Both raise the contract number to 3, and every installed coach skill would refuse until a plugin release shipped. [ADR 0008](0008-add-coach-keys-without-a-new-contract-number.md) states the rule: "Adding a key never raises the contract number." S1 only adds keys, so `COACH_CONTRACT` stays at 2. A skill run against an older CLI finds `tasks` missing and treats it as not reported.

`watch` reports a task wait with `key` set to the task key. `ignored.leases` is also new and is not in the contract.

### Command

`dispatch --task [--allow-self] <repo> <slug> [prompt]`. This adds no command, so the command count is unchanged. `dispatch` already owns the self-repository rule, the pre-checks, the start and the rollback.

`release`, `heartbeat`, `wrap` and `worktree create`, `remove` and `finish` take a task id. `claim`, `why` and `class` refuse it with exit 64. Binding a task to an issue later, and `why` explaining a task, are out of scope.

### A task that wrote nothing

A task is removed without `--discard` and without a merge proof when all of these hold:

- the worktree has no uncommitted change and no stash entry made on the task branch, on a branch the worktree checked out, or on a detached HEAD (the stash list is shared by the base clone);
- the task branch is absent, or has no commits of its own (the existing `hasOwnCommits` rule, read locally);
- every other branch that the worktree checked out has all its commits on a remote branch.

A task that committed must have pushed. It needs no merge proof, because there is no pull request to look for. `wrap` never discards.

### Branch record

A task writes no branch record. The record exists to keep an issue out of `ready` while its branch exists, and a task has no issue. A pushed task branch shows in `branches --unknown` after `sync`, like any branch pushed by hand.

### Tracker rule in the prompt

Every task prompt ends with a rule: there is no issue, and the worker must not write to the issue tracker unless the coach approves that one write. The coordinator cannot enforce it, because the `gh` calls of the worker are outside the CLI. The rule is text in the prompt and nothing more.

## Compromise

**Option B (rejected).** Tasks in `state/tasks.db` would be fully safe for an older CLI, which would never read a task row. But it needs a second lease file and routing by key kind. A key-kind branch is needed anyway, because `joinWorkers` and `expire` see task keys. It also doubles back-up and migration work at any schema bump.

**Option C (rejected).** Schema version 3 makes an older CLI refuse at once. But the live `claims.db` needs a manual migration, because the tool never alters it, and every older checkout stops for all work, issues included. The new columns repeat what the key says.

**Branch record.** A new `task` disposition was rejected. It changes branch-entry validation and the purpose of the record. Writing `keep` from the coordinator was rejected, because `keep` is a human decision.

**Wrote nothing.** "No commits since dispatch" was rejected. The reflog and the claim time cannot tell one worker from another, because the base clone is shared, and [ADR 0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md) rejected the same idea. "Tip equals the start commit" was rejected. It needs a stored start commit, which is a schema change.

**Prompt.** Adding the rule to the default prompt only was rejected. A task started with a custom prompt would carry no rule.

## Left for workspace #58 (configurable short names)

- `repoShortName` in `lib/config.mjs` is the one place that resolves the short name for worktree names and for the parsing of `short#N` and task ids. Workspace #58 changes its body.
- The two `shortNameMap` copies in `lib/graph.mjs` and `lib/ready.mjs` keep the GitHub repository name. They resolve issue text, and workspace #58 decided that issue text never uses a custom short name.
- The name parsers in `lib/worktree-path.mjs` (loaded by the installed hook) and `lib/status.mjs` still rebuild the name from the repository name. Task names never match them. Workspace #58 must design how the hook reads a custom short name.
- `target()` has no config. Workspace #58 must pass it in.
- The workspace #58 check that refuses a short-name change while a worker holds the repository must include task leases.

## Consequences

- A task is dispatched only after the main checkout runs this version. Until then, an older CLI stops `status`, `watch` and `expire` while a task lease is active.
- The coach skill can read `tasks[]` at contract 2. A skill that does not read it does not list tasks in `status`.
- Two active tasks with the same repository and slug are refused, so two triage passes cannot run on one repository.
- A task started late in the local evening carries the next UTC date.
