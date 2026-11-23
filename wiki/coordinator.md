---
type: reference
title: 'gvt-fleet command reference'
description: 'Entry page of the gvt-fleet command reference: usage, global flags, exit codes, where state lives, the workflows, recovery and safety, with links to one page per command group.'
tags: [command-reference]
status: stable
---
# gvt-fleet command reference

`gvt-fleet` is the coordinator for a multi-repo coach. It reads issues from many GitHub repositories, computes which issues are ready, claims them, and manages one worktree per issue.

This page and the command pages it links to describe the commands as they behave now. The same text, in shorter form, is printed by `gvt-fleet <command> --help`. For the design, see [the design](design.md). For the config files, see [Local config](configuration.md).

## Contents

- [Usage, global flags, finding the workspace, exit codes, the gvt-dev requirement and state](#usage)
- [Commands: reading](coordinator/reading.md)
- [Commands: claims](coordinator/claims.md)
- [Commands: classes and iterations](coordinator/classes.md)
- [Commands: branches](coordinator/branches.md)
- [Commands: base clones and trust](coordinator/base-clones-and-trust.md)
- [Commands: session state](coordinator/session-state.md)
- [Commands: worktrees](coordinator/worktrees.md)
- [Commands: workers](coordinator/workers.md)
- [Branch-record workflow](#branch-record-workflow)
- [Consumer workflow](#consumer-workflow)
- [The coach skill contract](coordinator/coach-skill-contract.md)
- [Recovery](#recovery)
- [Moving from the gvt-loop names](coordinator/moving-from-gvt-loop-names.md)
- [Moving the CLI into the plugin](coordinator/moving-the-cli-into-the-plugin.md)
- [Safety](#safety)

## Usage

```
gvt-fleet [--json] [--config <file>] [--state-dir <dir>] <command> [args]
gvt-fleet <command> --help
gvt-fleet --help
```

Run it from Git Bash at the workspace root: `node bin/gvt-fleet.mjs ...`. From anywhere else, see [Finding the workspace](#finding-the-workspace). A bare `gvt-fleet` prints the usage on stderr and exits 64. A command with two words (`branch set`, `worktree create`) is written with a space.

### Global flags

The global flags may come before or after the command.

| Flag | Meaning |
|---|---|
| `--json` | Print the result as JSON on stdout. Errors and warnings still go to stderr. |
| `--workspace <dir>` | The workspace: the folder that holds `config/`, `state/` and `repos/`. The default is found as [Finding the workspace](#finding-the-workspace) says. |
| `--config <file>` | The config file. The default is `config/repos.json` in the workspace. The branch record is always `branches.json` in the same folder. |
| `--state-dir <dir>` | The state folder. The default is `state/` in the workspace. |
| `--help`, `-h` | Print the help for the command, or the command list when no command is given. |

### Finding the workspace

A workspace is a folder that holds `config/repos.json`. The CLI takes the first of these ([ADR 0021](decisions/0021-find-the-workspace-and-switch-the-hooks-to-the-plugin.md)):

1. `--workspace <dir>`, used as given.
2. The folder of the CLI itself (the folder above its `bin/`), when it is a workspace. This is a workspace checkout that runs its own copy of the CLI: the workspace's main checkout, or a worktree of the workspace repository under test. A checkout of this repository never matches, because `plugin/cli/` has no `config/` beside it.
3. The outermost folder at or above the current folder that is a workspace. Outermost, because a base clone or a worktree of the workspace's own repository holds a `config/repos.json` of its own, and a command run from there means the workspace that manages it.

When none matches, the CLI prints `no workspace` with the folders it tried and `pass --workspace <dir>` on stderr, and exits 64. `--help` needs no workspace.

The copy of the CLI that the `gvt-fleet` plugin ships has no `config/` beside it, so rule 2 never matches it: give it `--workspace`, or run it from inside the workspace.

An issue reference `<ref>` is `owner/name#N` or `short#N`. The short name is the part of the repo name after the `/`. The repo must be in the config.

A task id `<task id>` names a task: a worker in a managed repository with no issue. It is `owner/name@<slug>.<YYYYMMDD>.<n>` (for example `acme/app@triage.20261108.1`) or, with the short name, `short@<slug>.<YYYYMMDD>.<n>` (`app@triage.20261108.1`). The task form of `dispatch` starts a task. Its lease is in `state/claims.db` only: a task has no label and no assignee on GitHub. Only `release`, `heartbeat`, `worktree create`, `worktree remove`, `worktree finish` and `wrap` take a task id. `claim`, `why` and `class` refuse one with exit 64.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | The command ran and failed, or refused. |
| 2 | For most commands, an invalid configuration. Exceptions: `sync` also exits 2 for an invalid overlay entry. `branch set` also exits 2 for a bad argument or record. `claim` and `dispatch` also exit 2 when `claimAccount` is not set. `trust` exits 2 only for a refused trust path, and `install-hooks` only for a refused settings file. These two read no config. Each command's section lists its own codes. |
| 64 | Wrong arguments, or an unknown command or reference. |
| 75 | `sync` stopped at the rate limit. Run it again later. |

Every command that reads the config checks `config/repos.json` and `config/branches.json` first. If one is invalid, the command prints each bad entry on stderr and exits 2 before it does anything else.

### The gvt-dev requirement

`sync`, `ready`, `why`, `claim` and the issue form of `dispatch` (`dispatch <ref>`) read issue references with the grammar of the gvt-dev plugin (`skills/triage-issues/scripts/lib/refs-grammar.mjs`). They import it from the installed plugin and never keep a copy ([ADR 0020](decisions/0020-require-an-installed-gvt-dev-of-a-minimum-version-for-the-grammar.md)). The other commands do not need gvt-dev.

- **Where.** The `gvt-dev@gvt-plugins` install in `~/.claude/plugins/installed_plugins.json`: the user-scope entry, else the first entry. The environment variable `GVT_DEV_ROOT` overrides the lookup. Set it to a gvt-dev plugin folder, the `plugin/` folder of a clone of the gvt-dev repository.
- **Version.** gvt-dev 4.45.0 or later, the first release that ships the grammar. The version is read from the plugin's own `.claude-plugin/plugin.json`, also under `GVT_DEV_ROOT`. Only the `x.y.z` core is compared, so a pre-release of 4.45.0 passes.
- **Failure.** A missing install, an unreadable or older version, or a grammar that cannot be loaded or has no `extract` function stops the command before it calls GitHub or reads an issue from the cache. It prints one line, `gvt-fleet: this command needs the gvt-dev plugin, version 4.45.0 or later, for the issue-reference grammar: <what was found>; install or update gvt-dev@gvt-plugins with /plugin, or set GVT_DEV_ROOT to a gvt-dev plugin folder`, with no stack, and exits 1.

### Where state lives

| Path | Content | Can it be deleted? |
|---|---|---|
| `state/cache.db` | The raw issue cache, the remote branch heads, and the Iteration field and item values of each configured project. Readiness is computed from it on each command (ADR 0001). | Yes. Run `sync` to rebuild it. |
| `state/claims.db` | The leases (claims) and the worktree state of each claim. | No. It is the only record of which issues and tasks this tool holds. A task lease lives only here. |
| `state/now-pointers.json` | The Now iteration of each project, as `iteration promote` recorded it, with the time it was set (ADR 0022). Created by the first `promote`. | Only with care. Without it, Now and Next follow the dates again; after a second promote on one day, that names the earlier goal until the dates catch up. A file that is not valid JSON or not version 1 stops `ready`, `why`, `class` and the `iteration` commands with exit 1. |
| `state/gvt-fleet.log.jsonl` | One JSON line per event. On the first write, an existing `state/gvt-loop.log.jsonl` is renamed to this name and one `{"event":"log-renamed","from":"gvt-loop.log.jsonl"}` line is appended. When the rename fails for a reason other than the old file being gone, the old file stays, the lines go to the new file, and a `log-rename-failed` line naming the error code is written to the new file. When the presence of either file cannot be read (an error other than a missing file), the carry-over is skipped without a record and the lines go to the new file. | Yes. |
| `state/claude.json.bak` | A copy of `~/.claude.json`, taken once before the first trust write of a run. | Yes. |
| `state/workers/<owner>/<name>/<worktree>.jsonl` | One JSON line per hook event of a worker session. The hook script writes it. Readers look only at the last 64 KB. `worktree remove` and `worktree finish` delete it when the worktree is removed. | Yes. It holds only recorded state. The next event starts a new file. |
| `state/rate-limits.json` | The latest five-hour and seven-day `rate_limits`, with when and from which session each was seen. The status-line helper writes it. | Yes. The next status-line render writes it again. |
| `state/hook-errors.jsonl` | One line per unexpected error in the hook script. | Yes. |
| `state/settings.json.bak` | The original `~/.claude/settings.json`, copied by the first `install-hooks` run that writes, when the file existed and held none of our entries (under the old or the new script names). | No. Keep it until you have checked the install. It is the way back (see [Undo install-hooks](#undo-install-hooks)). |
| `state/settings.json.absent` | One line that records that `~/.claude/settings.json` did not exist before the first `install-hooks` run that writes. It is written instead of `settings.json.bak`. | No. It tells Undo to delete the file instead of restoring a copy. |
| `state/branches.lock` | A lock file for `branch set`. | Yes, when no `branch set` runs. |
| `repos/<owner>/<name>` | The base clone of each repo. | Yes, when it has no worktrees. `clone` makes it again. |
| `repos/<owner>/<name>/.claude/worktrees/<short>-<N>` | The worktree of one issue. | Use `worktree remove`. |
| `repos/<owner>/<name>/.claude/worktrees/<short>.<name>.<YYYYMMDD>.<n>` | The worktree of one task. Here `<name>` is the task's slug. | Use `wrap` or `worktree remove`. |

`state/` and `repos/` are gitignored. The tool creates them.

`GVT_FLEET_FAKE_ONLY=1` makes the process runner refuse to start `gh` or `claude`. The tests set it. Do not set it for real use.

## Branch-record workflow

`config/branches.json` holds one decision for each remote branch that is not the default branch. The file format is in [Local config](configuration.md#configbranchesjson).

1. Run `sync`. It prints `unknown branches: N`.
2. Run `gvt-fleet branches --unknown`. Read each branch, its last commit date and any pull request hint.
3. Answer each one with `branch set`:
   - `--issue <ref>`: the branch belongs to an issue. While the branch is on the remote and the issue is open, the issue is not ready (reason `existing-branch`).
   - `--keep`: leave the branch alone.
   - `--remove`: the branch should go.
4. `branch set` changes the file in the working tree and prints `config/branches.json changed; commit it`. Commit the file yourself. The tool never commits.
5. Run `gvt-fleet branches` to read the record. A branch that has left the remote shows `gone`.

`worktree create` and `dispatch` write no entry. `worktree remove` records the branch the worker pushed (see [its section](coordinator/worktrees.md#gvt-fleet-worktree-remove)): an `issue` entry by `coordinator`, so that the open issue stays not ready (reason `existing-branch`) while that branch is on the remote. It never overwrites an entry that is not by `coordinator`. It also drops the `worktree-<name>` entry that older versions wrote at create. Commit the file after `worktree remove` prints `config/branches.json changed; commit it`.

**Removal only records (decision D3 of the phase-1 plan).** `branch set --remove` writes the decision and nothing more. In phase 1 no command deletes a remote branch. The code has no such call: the only branches the tool deletes are the local `worktree-<short>-<N>` branch of an issue and the local task branch `worktree-<short>.<slug>.<YYYYMMDD>.<n>`, in `worktree remove`, `worktree finish` and `wrap`. A task writes no branch record. A person deletes remote branches by hand.

## Consumer workflow

The coach's entry point is the skill `/gvt-fleet:coach`, from the `gvt-fleet` plugin. [The coach skill contract](coordinator/coach-skill-contract.md) lists the keys it reads. A typical coach loop for one issue:

1. `gvt-fleet sync` refreshes the cache. On exit 75, wait for the reset time it printed and run it again.
2. `gvt-fleet ready --json` gives the overview in three groups: `now` (the Now issues, each with its readiness), `untriaged` (the untriaged summary for each repo) and `next` (the count of Next issues for each repo). It also lists the ready issues. Pick one.
3. To move an issue between classes, run `gvt-fleet class <ref> now|next|later`. To plan an iteration, run `gvt-fleet iteration plan <owner/number> "<goal>"`; to start the next one, `gvt-fleet iteration promote <owner/number>` (see [Commands: classes and iterations](coordinator/classes.md#commands-classes-and-iterations)). The class does not change readiness. `claim` and `dispatch` ignore it.
4. `gvt-fleet why <ref>` shows the reasons and edges if the choice is not clear.
5. Check the repo of the issue (see Safety). `dispatch` refuses the workspace repository.
6. `gvt-fleet dispatch <ref> "<prompt>"` claims the issue, refreshes the base clone and starts the session. Note the short id. Use `claude attach <short id>` to watch it.
7. To start work that has no issue, such as a triage pass on a repository, run `gvt-fleet dispatch --task <repo> triage "<prompt>"` (see [Task worker](coordinator/workers.md#task-worker)). The prompt asks the worker to stop before each tracker write and wait for the coach's answer, so answer its questions. The coordinator cannot enforce this. When the task is done, wrap it with `gvt-fleet wrap <task id>` (see [gvt-fleet wrap](coordinator/worktrees.md#gvt-fleet-wrap)). Do not dispatch a task against the real `state/` from a checkout that predates this feature in the main checkout: an older CLI cannot read a task lease and stops.
8. Run `gvt-fleet status` at least once per `leaseMinutes` while workers run. It shows each worker and extends the held lease of every worker that is live. Run `gvt-fleet expire` from time to time to release the claims of workers that are no longer live.
9. Learn when a worker starts to need you with `gvt-fleet watch`. Start `node "${CLAUDE_PROJECT_DIR}/bin/gvt-fleet.mjs" --json watch --minutes 25` under Monitor, with a Monitor timeout above 25 minutes. Each stdout line is one notification.
   - On the `watch-end` line, start the next run with `--since <cursor>`, with the `cursor` from that line.
   - If Monitor ends the watch before `watch-end`, run `gvt-fleet status` to read the workers. Then start `watch` again.
10. When the pull request is merged, run `gvt-fleet wrap <ref>`. It proves the merge, removes the worktree, session and branch, and then releases the claim. The release ends the claim and removes the label and assignee that the claim added. Read `status` and `hint` in the result:
   - If it says `half-removed` or `held`, close the programs it names and run `gvt-fleet wrap <ref>` again.
   - If it refuses because the pull request is not merged, merge it and run the command again.
   - If it refuses because work is not pushed, push the branch. To drop the work, run `gvt-fleet worktree remove <ref> --discard`, then `gvt-fleet release <ref>`.
   - If it says `branch-kept`, the claim is still held. Push or merge the branch, or delete it by hand, then run `wrap` again. When a merged pull request proved the work but no remote-tracking branch contains the tip, the hint names that pull request and says to delete the branch with `git branch -D` (see the [`wrap` reference](coordinator/worktrees.md#gvt-fleet-wrap)).
11. Commit `config/branches.json` if it changed. `wrap` in step 10 is the command that changes it (through the removal).

Use `--json` when a program reads the output.

## Recovery

Every command can be run again after a crash. Each one reads the real state before it acts.

### Crash during claim

The lease stays `claiming` or `failed`. Run `claim <ref>` again. It reuses the lease row and starts again at the fresh read. It keeps the record of whether the assignee and the label were there before the first try, because after a crash GitHub already shows the tool's own write. If the label and assignee were written, `release` removes what the claim added at any time. `expire` does so too, for a `failed` lease that wrote to GitHub and for a `claiming` lease whose start or last heartbeat is older than the lease length. `expire` leaves a younger `claiming` lease alone, because another process may still be claiming.

### Task lease

A task lease carries no GitHub marks, so a crash leaves nothing to undo on GitHub. `release`, `wrap` and `expire` end a task lease with no GitHub call.

A CLI older than the change that added tasks cannot read a task key. While a task lease is active, `status`, `watch` and `expire` of that CLI stop with `cannot read "<key>" as owner/repo#N`. They write nothing wrong. Update the main checkout before you dispatch a task. See [ADR 0012](decisions/0012-run-task-workers-without-an-issue.md).

### Claims database version mismatch

`state/claims.db` records its schema version in `PRAGMA user_version`. This tool expects version 2. A file made by an earlier tool version has version 1. (A column was once renamed without a version bump: the workspace repository's #3.)

Every command that opens the claims database stops when the version differs, before it reads or changes `claims.db` and before any GitHub call. The config check and the cache open run first (see the next paragraph). It prints `gvt-fleet: <file>: claims database has user_version <found>, this tool expects <expected>. The file was left untouched.` and exits 1.

The tool never deletes or alters this file. Leases cannot be rebuilt from GitHub (ADR 0001). The cache database is different: a version mismatch in `state/cache.db` deletes and recreates it, and the next `sync` is a full one.

1. Read the lease rows, for example with `node -e` and `node:sqlite`, or with any SQLite client. Look for a lease that may still have marks on GitHub: a lease in the `claiming`, `held` or `releasing` state, or a `failed` lease with `label_added` set to 1 or `assignee_preexisting` set to 0.
2. If there is no such lease, move the file aside, for example to `state/claims.db.v<found>`. The next command creates a fresh database.
3. If there is such a lease, compare the `leases` columns with the current schema in `plugin/cli/lib/claims-db.mjs`.
   - If they match, set `PRAGMA user_version` to the expected value by hand. This keeps the lease rows, so `release` and `expire` can still remove the marks.
   - If they do not match (for example, a file with the pre-rename column `discard_consent` in place of `discard_head`), remove the `in-progress` label and the assignee that each such claim added from its issue by hand. Then do step 2. Moving the file aside first would leave those marks with no lease that can release them.

### Crash during clone

An interrupted clone leaves `repos/<owner>/.<name>.tmp-<pid>`. The next `clone` (or `worktree create`) deletes folders of that exact shape in the owner folder before it starts, but only when the process `<pid>` is no longer alive, so a clone in progress in another process is kept. It does not touch anything else. If the rename into place fails, `clone` reports `failed` and removes its own temp folder. The final folder `repos/<owner>/<name>` only appears by a rename after the clone has succeeded.

### Remove: lock retries

`claude rm` right after `claude stop` can fail with a lock error ("still running") while the stopped session exits. `worktree remove` retries up to 5 times, 2 seconds apart. If it still fails, run `worktree remove` again.

### Expired leases

A lease that passed its expiry is not revived by `heartbeat`. Run `gvt-fleet expire` or `gvt-fleet status`. Both extend the lease if its worker is still live (see [Live workers](coordinator/workers.md#live-workers)). `status` marks such a lease `revived`. When the worker is not live, `expire` releases the claim and `status` leaves it as it is. Then run `claim` again if you still want the issue. `worktree create` refuses an expired lease.

### Stuck leases

| State seen | What to do |
|---|---|
| `release` printed "release failed" and the state is `releasing` | Run `release <ref>` again, or `expire`. Both retry it. `claim` refuses until it is done. |
| The label or assignee is still on the issue after a failed release | Same. The tool reads the issue back and fails when a mark remains. |
| `expire` reports "cannot read claude agents" | Fix `claude agents --json --all`, then run `expire` again. Held leases are left alone meanwhile. |
| A mark was set by hand | The tool leaves it alone. Remove it by hand. |

### Half-removed worktrees

`worktree remove` reports `half-removed` when `claude rm` could not delete the folder because another program holds it (`kept` or `EBUSY`), or when the folder is on disk and not registered. When the cause is `EBUSY` or `EPERM` and no likely holder is found, the command has already tried up to 3 times before it reports this (see [`worktree remove`](coordinator/worktrees.md#gvt-fleet-worktree-remove) step 4).

1. Read the holders in the output. Close them. Typical holders are an editor or a Git GUI that has the folder open.
2. Run `gvt-fleet worktree finish <ref>`.
   `gvt-fleet wrap <ref>` does the same and then goes on: it resumes a half-removed or held worktree, deletes the branch and releases the claim.
3. If it reports `held`, a program still has the folder. Close it and run `finish` (or `wrap`) again.
4. If it reports `branch-kept`, `git branch -d` refused the branch: it deletes only a branch merged into its upstream, or into the base clone's HEAD when it has no upstream (a squash-merged branch, or one whose remote-tracking branch was pruned, is kept as well). Merge or push the work, or run `worktree remove <ref> --discard` first and then `finish` (the consent lapses if the branch moves).

**How a half-removed worktree is detected.** `probes/FINDINGS.md` in the workspace repository (frozen evidence, not edited) describes the failure as git's admin folder being renamed to `.git/worktrees/<name>.claude-dropped-<hash>` while the folder's `.git` file still points at the old name. It suggests that this makes the worktree unregistered. In a sandbox run, git still listed such a worktree. `git worktree list` alone therefore cannot show the half-removed state. `plugin/cli/lib/worktrees.mjs` counts a worktree as registered only when git lists it **and** the `gitdir:` target in the folder's `.git` file exists. This detection differs from the evidence in `probes/FINDINGS.md`. It was **not** verified against a live `claude rm`. The tests use a sandbox that renames the admin folder.

`worktree finish` also runs `git worktree prune`, which removes the leftover `.claude-dropped-*` admin folder.

### Undo install-hooks

`state/settings.json.bak` holds `~/.claude/settings.json` as it was before the first write. When `state/settings.json.absent` exists instead, the file did not exist before the first write.

1. From the workspace root in Git Bash, copy the backup back: `cp state/settings.json.bak ~/.claude/settings.json`. When `state/settings.json.absent` exists instead, delete the file: `rm ~/.claude/settings.json`. This also deletes every setting added to the file after the install; to keep those, remove our entries by hand instead, as described below.
2. Restart open sessions.

When neither record exists, `install-hooks` took no backup because the file already held our entries (under the old or the new script names). Remove the entries by hand, as described below.

The backup was taken before the first write, so the copy loses every change made to the settings file after that. To keep those changes, remove by hand the six hook entries and the `statusLine` whose commands start with `node "<path>/bin/gvt-fleet-hook.mjs"` and `node "<path>/bin/gvt-fleet-statusline.mjs"`. Entries written by the old CLI start with `node "<path>/bin/gvt-loop-hook.mjs"` and `node "<path>/bin/gvt-loop-statusline.mjs"`; remove those too. Restore the original status-line command from the part of the command after `--chain`.

## Safety

- `install-hooks` is the only command that writes `~/.claude/settings.json`. Tests inject the path and never touch the real file.
- The workspace repo can itself be in the managed set, as it was for the fleet that developed this tool. Its own branches show up in `gvt-fleet branches --unknown`, and its issues can show up in `gvt-fleet ready`. Check the repo of an issue before a live `claim`, `dispatch` or `worktree create`, so the coordinator does not claim an issue or start a worktree in its own repository by accident. `dispatch` refuses an issue in the workspace's own repository unless `--allow-self` is given.
- Never run these commands against one of the user's own checkouts outside the workspace. The coordinator works only in its own base clones under `repos/` and their worktrees.
- `trust` writes entries only for folders below the workspace root.
- `~/.claude/settings.json`, `~/.claude.json`, `config/branches.json` and a base clone's `.git/info/exclude` are written to a temporary file and renamed onto the real path. A symbolic link is followed, so the link stays a link and its target gets the change. A link to a missing file makes the write fail (exit 1). A hard link is not detected: the rename gives the path a new file, and the other names keep the old content. The rate-limit snapshot under `state/` is written the same way but does not follow a link.
- `claim`, `class`, `release`, `expire`, `dispatch` and `sync` talk to GitHub. `sync` only reads. The other five write labels (and, for `claim`, `release`, `expire` and `dispatch`, assignees) on issues. `status` makes no GitHub call.
- Remote branches are never deleted by the tool.
