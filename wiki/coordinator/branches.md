---
type: reference
title: 'Commands: branches'
description: 'The branch commands: branches lists the branches that no issue owns, and branch set records what to do with one.'
tags: [command-reference]
status: stable
---
# Commands: branches

This page is part of the [gvt-fleet command reference](../coordinator.md).

## gvt-fleet branches

```
gvt-fleet branches [--unknown]
```

Shows the branch record in `config/branches.json`.

- Without a flag: one line per recorded branch with its disposition (`issue`, `keep` or `remove`), its status (`on-remote` or `gone`), the date and who decided.
- With `--unknown`: the remote branches from the cache that are not the default branch and not in the record. Each line shows the head commit and the last commit date. A hint line names an open or merged closing pull request and the issue it closes. Hints are never written to the record.
- It reads the cache only and never calls GitHub. Run `sync` first.
- Side effects: none.
- Exit codes: 0, 2 for an invalid config, 64 for a wrong argument.

**When the record changes.** Two commands write `config/branches.json`:

- `branch set` writes an entry for the branch a person names.
- `worktree remove` records the branch the worker pushed, with `by: coordinator`, and drops the coordinator's own `worktree-<name>` entry. The rules are in the **Branch record** paragraph of [`worktree remove`](worktrees.md#gvt-fleet-worktree-remove).

`worktree create` and `dispatch` write nothing to the record.

## gvt-fleet branch set

```
gvt-fleet branch set <owner/repo> <branch> (--issue <ref> | --keep | --remove) [--allow-missing] [--by <name>]
```

Records the decision for one branch in `config/branches.json`.

| Argument | Meaning |
|---|---|
| `<owner/repo>` | The repo, as written in the config. |
| `<branch>` | The branch name. |
| `--issue <ref>` | The branch belongs to this issue. `owner/name#N`, `short#N` or `#N` (in the same repo). |
| `--keep` | Keep the branch. It belongs to no issue. |
| `--remove` | The branch is to be deleted. |
| `--allow-missing` | Accept a branch that is not in the cached remote heads. |
| `--by <name>` | Who decided. The default is `coach`. |

- Exactly one of `--issue`, `--keep` and `--remove` is required.
- A branch that is not in the cached remote heads is refused with exit 1, unless `--allow-missing` is given.
- It writes under a lock file in the state folder and prints `config/branches.json changed; commit it` on stderr.
- `--remove` only records the decision. See the [workflow section](../coordinator.md#branch-record-workflow).
- Side effects: it changes `config/branches.json` in the working tree. It does not commit. It makes no GitHub call.
- Exit codes: 0, 1 when refused (for example the branch is not on the remote), 2 for an invalid config, a bad argument or a bad record, 64 for wrong arguments.
