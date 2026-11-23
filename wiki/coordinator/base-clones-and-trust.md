---
type: reference
title: 'Commands: base clones and trust'
description: 'The clone command, which makes or updates the base clones, and the trust command, which writes Claude Code trust entries.'
tags: [command-reference]
status: stable
---
# Commands: base clones and trust

This page is part of the [gvt-fleet command reference](../coordinator.md).

## gvt-fleet clone

```
gvt-fleet clone [<owner/repo>]
```

Makes the base clone of each enabled repo under `repos/<owner>/<name>`.

- The URL is HTTPS: `https://github.com/<owner>/<name>.git`. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails at once.
- The branch is the `defaultBranch` of the config entry, else the one the last `sync` stored. If neither is known, that repo fails with "run gvt-fleet sync first".
- A new clone is made in a temporary folder `repos/<owner>/.<name>.tmp-<pid>` and renamed when the clone succeeds.
- A clone adds `/.claude/worktrees/` to `.git/info/exclude`. This is done on every run.
- A worktree lives inside its base clone, at `.claude/worktrees/<name>`. ESLint 8 with an eslintrc config merges every `.eslintrc*` it finds up the directory tree, unless one of them sets `root: true`. In a worktree it then also loads the base clone's `.eslintrc*`. The base clone has no `node_modules`, so the shared configs that file extends can't be found, and `npm run lint` fails before it lints anything (`ESLint couldn't find the config "…" to extend from`). The error names the base clone's path, not the worktree's. The gvt-dev pre-commit hook runs the lint command, so a worker can't commit in that worktree. The fix belongs in the managed repository: add `root: true` to its root `.eslintrc*`, as one managed repository did. This happens on any OS. `clone` doesn't check for it.
- A clone that exists is skipped when it is not a git repository, has a dirty working tree, or is on a branch other than the default. A clean clone on the default branch is fetched and fast-forwarded to `origin/<default>`. Other than that, it is not changed. If the fast-forward is not possible, the result is `failed`.
- Each repo prints one result: `cloned`, `updated`, `up-to-date`, `skipped` or `failed`.
- `<owner/repo>` limits the run to one enabled repo.
- Side effects: files under `repos/`, and a `git fetch` from GitHub. No GitHub write.
- Exit codes: 0, 1 when any clone was skipped or failed, 2 for an invalid config, 64 when the repo is not an enabled repo of the config.

## gvt-fleet trust

```
gvt-fleet trust <path>
```

Writes a Claude trust entry for a folder in `~/.claude.json`.

- The key is the real path with forward slashes and an uppercase drive letter.
- A folder that is already trusted is not written again.
- The folder must be below the workspace root (the folder that holds `config/`, `state/` and `repos/`). The root itself and any folder outside it are refused with exit 2.
- Before the first write of a run, it copies `~/.claude.json` to `state/claude.json.bak`.
- After a write, it waits 3 seconds and reads the file again, because Claude Code can overwrite the file. It writes again up to 3 more times if the entry is missing. If it is still missing, the result is `failed`.
- Side effects: it rewrites `~/.claude.json` (keeping the key order) and writes the backup. When `~/.claude.json` is a symbolic link, the change is written through the link to its target.
- Exit codes: 0 for `written` or `already-trusted`, 1 when it failed or the folder does not exist, 2 when the path is refused, 64 for a wrong argument.
