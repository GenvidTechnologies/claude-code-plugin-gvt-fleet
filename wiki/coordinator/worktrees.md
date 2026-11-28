---
type: reference
title: 'Commands: worktrees'
description: 'The worktree commands: worktree create, worktree remove, worktree finish and wrap.'
tags: [command-reference]
status: stable
---
# Commands: worktrees

This page is part of the [gvt-fleet command reference](../coordinator.md).

A worktree is named `<short>-<N>`. For example, issue `webapp#12` gives the worktree `webapp-12` and the branch `worktree-webapp-12`. The folder is `repos/<owner>/<name>/.claude/worktrees/<short>-<N>`. Each Claude session has the same name. A task worker (see [Task worker](workers.md#task-worker)) has the worktree `<short>.<slug>.<YYYYMMDD>.<n>` and the branch `worktree-<short>.<slug>.<YYYYMMDD>.<n>`.

Each of the three commands looks at the real state first (the session list from `claude agents`, the folder, git's worktree list, the branch). It then does only the steps that are still needed. The claim row only records intent.

## gvt-fleet worktree create

```
gvt-fleet worktree create <ref> [prompt]
```

Creates the worktree of a claimed issue and starts a background Claude session in it. `<ref>` can also be a task id. The lease of a task is held from the start, so step 1 finds it. The folder, branch and session name are those of the task (see [gvt-fleet dispatch](workers.md#gvt-fleet-dispatch)). Use this form to adopt the session of a task after a confirm failure. For a task, the prompt is built as `dispatch --task` builds it: the given prompt, or the default task prompt, followed by the tracker rule (see [Task worker](workers.md#task-worker)). A task prompt that starts with `-` is a usage error (exit 64), as for `dispatch --task`.

1. It needs a held claim that has not expired. Without one it refuses and tells you to run `claim` (or `expire`, then `claim`).
2. If `claude agents` lists a [worker session](workers.md#live-workers) for this worktree, live or dead, it prints `noop` with the same fields. An interactive session with the same name does not match. The only write is to fill in the session id, short id, path and branch on the claim when the claim lost them.
3. If the folder exists but no such worker session is listed, it refuses and does not overwrite the folder.
4. It makes the base clone and the trust entry if they are missing (the same steps as `clone` and `trust`).
5. It runs `claude --bg -w <name> -n <name> [prompt]` in the base clone. Then it looks for the worker session in `claude agents` with the same match, up to 5 times, one second apart. It does not use the id that `claude --bg` printed, because its format is not fixed.
6. It stores the session id, short id, worktree path and branch on the claim.

- It prints the worktree path and the short id of the session. Use the short id with `claude attach`.
- The default branch must be known (config entry or last `sync`).
- Limits on the prompt. The `claude` program is resolved to an absolute path before it starts. If it resolves to a `.cmd` or `.bat` shim, every argument must match `[\w./:@#=-]`. A prompt with a space or any other character is rejected. On this machine `claude` resolves to `claude.exe`, so the limit does not apply here. This was not changed.
- The prompt is the last argument, with no `--` before it. A prompt that starts with `-` would be read by `claude` as an option. Do not start a prompt with `-`.
- Side effects: a base clone and a trust entry (if missing), a background Claude session, a worktree and a branch in the base clone, and the claim row. It writes nothing to `config/branches.json`: `worktree remove` records the branch. No GitHub write.
- Exit codes: 0 for created or noop, 1 when refused or failed (a refused trust path counts as refused, unlike `trust`, which exits 2), 2 for an invalid config, 64 for wrong arguments.

## gvt-fleet worktree remove

```
gvt-fleet worktree remove <ref | task id> [--discard | --require-merged]
```

Removes the worktree, its Claude session and its branch.

**Task id.** With a task id, plain `worktree remove` removes a task that wrote nothing (see **Task worker** in [gvt-fleet wrap](#gvt-fleet-wrap)) without `--discard`. A task that committed is checked as `wrap` checks it: every commit must be on a remote branch, or at the head of a merged pull request (as for an issue in plain mode). `--require-merged` with a task id exits 64, because a task has no issue and may have no pull request. An issue worktree is checked by the rule in **Safety check**, whatever upstream its branch has.

**Safety check.** Before it removes anything, it checks that no work would be lost:

- the working tree is clean;
- there is no stash made on the checked-out branch, on the issue branch, on another branch listed below, or on a detached HEAD;
- the checked-out branch, or a detached HEAD: every commit is on some remote-tracking branch (`git rev-list <HEAD> --not --remotes` is empty), whatever the upstream of the branch is (none, its own name, or the default branch). Otherwise the tip must be the head of a merged pull request (a lookup through `gh`);
- the issue branch `worktree-<name>`, when it is not the checked-out branch: its commits are on a remote branch, or its tip is the head of a merged pull request;
- the other local branches that the worktree checked out, found in the HEAD reflog of the worktree (the default branch and branches checked out in another worktree are skipped): their commits are on a remote branch. A merged pull request does not waive this. A pushed one is listed in `otherBranches` (`[{branch, tip}]`) and is not deleted.

When the issue branch itself is checked out, the pull request is looked up by the name of the branch on the remote (`branch.<b>.merge` without `refs/heads/`), and the lookup asks for up to 100 pull requests. That name can differ from the local `worktree-<name>` branch. When the checked-out branch is not the issue branch, or HEAD is detached, the pull request is looked up by commit (`GET repos/{repo}/commits/{sha}/pulls`), and only a merged pull request whose head is the tip counts. A pull request found by commit waives only HEAD. It never waives the tip of the issue branch, which needs its own merged pull request (looked up by name) or a merged closing pull request. GitHub answers HTTP 422 "No commit found" when it does not know the commit. The command reads that as "no such pull request", not as a failed lookup. The lookup is the excuse for commits that look unpushed after a squash merge. Without `--require-merged` it runs only when something is unpushed. With `--require-merged` it is the proof, see below.

When the rule fails, the problem reads `<branch> has N commit(s) not pushed to any remote branch and no merged pull request`, or `HEAD is detached with N commit(s) not on any remote branch and no merged pull request`. When the lookup by commit fails, the problem adds `, and the pull request lookup by commit <sha7> failed: <message>`.

The check reads the HEAD of the worktree itself, so a detached HEAD counts. A detached HEAD still has an issue branch, and that branch is checked. A commit that was cherry-picked onto another merged branch and never pushed is still refused (follow-up: workspace #81). If a check fails, or cannot be read, the command refuses, exits 1 and lists the problems. It also refuses a folder that is a link or junction, and a folder that git no longer lists and that holds anything other than a lone `.git` file. In that unlisted case a `.git` directory, or any other entry, counts as extra.

**Steps.**

1. If the worktree has a [live worker](workers.md#live-workers), it runs `claude stop`, and then the safety check again. A session in the `failed` state is not live, so it gets no `claude stop`. A live session can commit between the first check and the stop. If the second check fails, the session stays stopped, nothing is removed, and the command refuses.
2. It records the branch (see **Branch record** below).
3. It runs `claude rm`. If `claude rm` fails because the lock of the stopped session is still held, it retries up to 5 times, 2 seconds apart. That lock retry is separate from the busy-folder retry in step 4, and it is not counted in `removalAttempts`.
4. It looks at the state again. If the folder is still on disk and is not registered, or `claude rm` failed with `kept` or `EBUSY`, the state is half-removed. The command then looks for likely holders (`handle64` when it is on the PATH, else the `Code.exe` and `GitExtensions.exe` processes from `tasklist`).
   - **Busy-folder retry.** When the `claude rm` output names `EBUSY` or `EPERM` and the lookup finds no likely holder (a lookup that fails also finds none), the command waits and tries again, up to 3 removal attempts in all. It waits 2 seconds, then 5 seconds. Before each retry it reads the state again and takes the step that is still open. If git still lists the worktree, it runs `claude rm` again. If git no longer lists it and the folder holds at most a `.git` file, it deletes the folder as `worktree finish` does, removes the Claude session if `claude agents` still lists it, and runs `git worktree prune` after the folder delete, or when a worktree entry is left. A folder with no `.git` entry that git marks `prunable` (a failed delete can take the `.git` file first) counts as not listed; when it is empty, it is the leftover. If the session runs again, or `claude agents` cannot be read, the retry stops. In any other state the retry stops too. A half-removed state whose `claude rm` output names neither `EBUSY` nor `EPERM` does not retry.
   - When a likely holder is found, the command does not wait, because waiting does not help. The `tasklist` fallback names any running `Code.exe` or `GitExtensions.exe` whatever folder it has open, so with VS Code open no retry happens and the result is reported at once.
   - If the attempts run out, or no retry applies, the result is `half-removed`. The command prints the folder, the output of `claude rm`, the likely holders and the next command. It exits 1. See [Recovery](../coordinator.md#recovery).
   - The safety check, the merge proof and the `claude stop` run once, before the first attempt. Between two attempts the command only waits and reads the state. It changes nothing in the worktree.
   - `removalAttempts` is the number of removal attempts, 1 to 3. It is on the `removed`, `branch-kept` and `half-removed` results. The key `attempts` keeps its meaning: the number of `claude rm` calls.
5. Otherwise the folder and session are gone. `claude rm deletes only the branch checked out in the worktree`, and only when its tip is on a remote-tracking ref. It checks only that branch for unpushed commits. A branch that is not checked out is neither deleted nor checked, so when a follow-up branch was checked out, `worktree-<name>` is still there. If the issue branch is still there, the command deletes it with `git branch -d`. `git branch -d` deletes only a branch that is merged into its upstream, or into the base clone's HEAD when it has no upstream, so a squash-merged branch, or one whose remote-tracking branch was pruned, is kept as well. If `git branch -d` refuses, the result is `branch-kept`: the worktree and session are gone, the reason names the branch and the git error, and the command exits 1. Run `worktree finish <ref>` to retry the branch step.
6. If no session, folder, worktree or branch is left, it prints `removed` and exits 0. The only change it makes is to drop the coordinator's own `worktree-<name>` entry for the issue from the branch record, if there is one, and to delete the hook file (see **Hook file** below).

**Hook file.** When the result is `removed` or `branch-kept`, the command deletes the worker hook file `state/workers/<owner>/<name>/<worktree>.jsonl`. It does this after `claude rm` has succeeded, or at once when there was nothing left to remove. Then `status` no longer lists the worker, and prints `workers: 0` when it was the only one. The command keeps the file when the result is `refused`, `half-removed` or `failed`. The path is built by the same function that the hook script writes with. A file that is already missing is not an error. A file that cannot be deleted is reported in `notes`, and the result does not change.

**Branch record.** Once the safety check has passed, and before `claude rm`, the command records the issue branch in `config/branches.json` as `{disposition: issue, issue: <key>, by: coordinator}`. The name is the remote name of the issue branch `worktree-<name>` (from its `branch.<b>.merge`, or from the head of the pull request that proved the work), which can differ from the local name. A follow-up branch that is checked out is never recorded. The open issue then stays not ready (`existing-branch`) while that branch exists.

- It does not record in a `--discard` run that skipped a failed check.
- It first runs `git ls-remote --heads origin refs/heads/<b>` in the base clone, with a time limit of 20 seconds. When the limit passes, the command kills the whole process tree of `git` (on Windows with `taskkill /T`, so a helper process that holds the output open cannot make it wait), treats the step as failed (the step's result code is 124, with `timed out after <N> ms`) and goes on. Every external command that is started with a time limit, such as the holder lookups, ends the same way. When the branch is gone (for example merged and deleted by GitHub), it records nothing, so a merged branch that GitHub deleted keeps no entry.
- When `ls-remote` fails or times out, it records the entry and adds a warning.
- It never overwrites an entry that is not `by: coordinator`. The check runs under the lock of the record file, on the entry read there, so an entry that a person sets at the same moment is not overwritten.
- It drops the coordinator's own `worktree-<name>` entry for the same issue. When the pushed branch has the same name as `worktree-<name>`, that entry is kept and is the one recorded; but when `ls-remote` shows that branch gone from the remote, the entry is dropped too, so a merged branch that GitHub deleted keeps no entry in either case.
- A detached HEAD records the issue branch, like any other checkout. Nothing is recorded only when the issue branch is absent; the coordinator's own `worktree-<name>` entry for the issue is still dropped.
- A failed write of the record is a warning. The removal goes on.
- The result carries `branchRecord: {recorded, dropped, warning?}`. `recorded` and `dropped` are branch names or null. `recorded` is null when the entry already held the same values. The `worktree-remove` log event carries `branchRecord: {recorded}`.
- When an entry was recorded or dropped, stderr prints `<key>: config/branches.json changed; commit it`.

**`--discard`.**

- It skips the safety check for this run. It overrides uncommitted changes, stashes on the branch, a branch with no upstream, and unpushed commits.
- It lets the command retry `claude rm` with `--discard-unpushed <value>`, where `<value>` is the `<commit>@<worktree-id>` that the first `claude rm` reported.
- After that, the branch is deleted with `git branch -D`, but only while the branch is still at the commit the run was given at.
- The consent applies to one run. The command stores the HEAD commit it was given at (`discard_head` on the claim). The consent lapses on a refused run, on any run without `--discard`, and when the branch has moved since. A later plain `remove` therefore runs the full safety check.
- `--discard` does not remove a worktree that is a link or junction.

**`--require-merged`.**

- It adds one check to the safety check: the tip of the issue branch `worktree-<name>` must be the head of a merged pull request. This holds even when the branch is pushed, and whatever branch is checked out. The check runs again after `claude stop`, like the others.
- The proof is looked up live, in two places: by the remote name of the issue branch, and among the closing pull requests of the issue, from the cache or from the live read described below (one GitHub call for each). A merged pull request of another branch does not satisfy it.
- While any closing pull request is open, the command refuses.
- When the issue branch has no commits of its own (its tip is on the default branch of the remote), there is nothing to push. A merged closing pull request is required instead, and every merged closing pull request is listed in `proofs`.
- In both cases a pull request counts only when it merged into the default branch of the repository (its `base.ref`). A pull request merged into a release or integration branch leaves the work off the default branch, so it proves nothing. The default branch comes from the config entry, else from the last sync. When neither knows it, no pull request proves the work. The unpushed checks above are not changed by this rule: there, a merged pull request into any branch shows that the commits are kept on GitHub.
- If the check fails, the command refuses and exits 1. A `problems` entry says why, and the reason ends with `; merge the pull request first`:
  - `pull request #<n> (<state>) from <branch> is not merged at HEAD <sha7>` (or `at the tip of worktree-<name> <sha7>` when another branch is checked out);
  - `no pull request from <branch>`;
  - `cannot look up pull requests from <branch>: <error>`;
  - `cannot look up closing pull request #<n>: <error>`;
  - `closing pull request #<n> from <branch> is open`;
  - `pull request #<n> from <branch> is merged into <base>, not into the default branch <default>` (a pull request at the tip; `<base>` reads `an unknown branch` when GitHub gave none);
  - `closing pull request #<n> from <branch> is merged into <base>, not into the default branch <default>` (when the issue branch has no commits of its own);
  - `the default branch of <repo> is unknown, so no pull request can prove the merge; run gvt-fleet sync`;
  - `cannot read the closing pull requests of <key>: <message>` (the live read described below failed, so the work stays unproven);
  - `worktree-<name> has no commits of its own and no closing pull request of <key> is merged` (it ends with `; run gvt-fleet sync` only when the cache held no closing pull request for the issue and no live read ran, which is the case for a caller with no live reader. After a live read that found none, it has no suffix).
- When the cache holds no closing pull request for the issue (the row is missing, or a full sync added it again without them) and nothing else proved the work, the check reads the closing pull requests live from GitHub. It makes one GraphQL call, which reads the first 10, and looks up each one by number, as it does for a cached one. This happens for `wrap` and for `worktree remove <issue> --require-merged`, not for a task. No live read happens when the cache lists a closing pull request, or when the merged pull request of the issue branch already proved the work.
- A detached HEAD does not refuse by itself and does not skip the pull request lookups. The issue branch is proven by its own merged pull request or by a merged closing pull request. A merged pull request of the checked-out branch, or of another branch, never proves an issue branch that has commits of its own. Without the flag, the squash-merge excuse for an unpushed issue branch looks up pull requests under its remote name, or under the local name (`worktree-<name>`) when it has none.
- It cannot be combined with `--discard`. The command prints a usage error and exits 64 before any git or GitHub call.
- When nothing is left to remove, the result is `removed` with `nothing: true`, and no pull request check runs, because there is no work left to protect.
- `pushedBranch` is the name of the issue branch on the remote: its upstream (`branch.<b>.merge`), else the head of the proving pull request when that pull request is in the same repository, else the local name. The results `refused`, `half-removed`, `branch-kept` and `removed` carry it, and so does `failed` when `claude agents` cannot be read (there it is null). It is set whenever the issue branch exists, also for a plain remove of a pushed branch and for a detached HEAD. It is null on the paths that end before the check (that `failed` result, a folder that is a link or junction, nothing left to remove).
- `pr` (`{number, state, mergedAt, headSha}`) is the proving pull request, or else the most relevant one found. It is present on the same results. It is null when no pull request lookup ran or none was found, and always null on that `failed` result.
- `proofs` (`[{branch, pr}]`) lists the merged pull requests that proved the work under `--require-merged`. It is `[]` when none did, without the flag, and on that `failed` result.
- `otherBranches` (`[{branch, tip}]`) lists the pushed branches that the worktree checked out besides the issue branch. They are not deleted.
- `checkedOutBranch` (`{branch, tip, kept}`) reports the branch checked out in the worktree when it is not the issue branch (or the task branch). `kept` is true when the branch is still in the base clone after the removal, false when it is gone, and null when the removal did not run. The key is null when HEAD is the issue branch or the task branch, and when HEAD is detached. It is absent when the command made no check (nothing was left to remove, or an early failure). The coordinator does not delete that branch itself. `claude rm` may delete it, and `kept` reports what happened (follow-up: workspace #82).
- The `worktree-remove` log event has two more fields: `requireMerged` and `pr` (the pull request number, or null).

- Side effects: stops and removes a Claude session, deletes the worktree folder, the local branch and the hook file, writes the claim row, and may change `config/branches.json` (commit it). It does not delete any remote branch and makes no GitHub write. The pull request lookup is a read.
- Exit codes: 0 for removed, 1 for refused, half-removed, branch-kept or failed, 2 for an invalid config, 64 for wrong arguments.

## gvt-fleet worktree finish

```
gvt-fleet worktree finish <ref | task id>
```

Completes a removal that stopped half-way. It takes a task id as well as a ref. The task branch is `worktree-<name>`, and the steps are the same.

- It looks at what is left (folder, git worktree entry, branch, session). It does only the steps that are still needed. In order: delete the folder, run `claude rm`, run `git worktree prune`, delete the branch.
- It refuses while the worktree has a [live worker](workers.md#live-workers). A worker session in the `failed` state does not block it. Run `worktree remove` first.
- It refuses when the path is a link or junction, or when git still lists the folder as a registered worktree (use `worktree remove`).
- It deletes the folder only when the folder is empty or holds a lone `.git` file. It deletes nothing else.
- If the folder is held open (`EBUSY`, `EPERM`, `ENOTEMPTY` or `EACCES`), it reports `held`, the likely holders and the next command.
- Only `EBUSY` and `EPERM` retry. When the folder delete fails with one of them and the lookup finds no likely holder (a lookup that fails also finds none), the command waits and deletes the folder again, up to 3 attempts in all. It waits 2 seconds, then 5 seconds. Before each retry it reads the state again. If git lists the worktree again, the session runs, or the folder holds more than a `.git` file, the result is `refused` and nothing is deleted. An empty folder whose `.git` file the failed delete already took, and that git marks `prunable`, is still the leftover. `ENOTEMPTY` and `EACCES`, or a likely holder, give `held` at once. The `tasklist` fallback names any running `Code.exe` or `GitExtensions.exe` whatever folder it has open, so with VS Code open no retry happens. Between attempts the command only waits and reads the state.
- `removalAttempts` is the number of removal attempts, 1 to 3. It is on the `removed`, `branch-kept` and `held` results, and on the `refused` result of a state that changed during a wait.
- It deletes the branch with `git branch -d`. It uses `-D` only while the branch is still at the commit a `--discard` run was given at. The `--discard-unpushed` retry of `claude rm` follows the same rule. `git branch -d` deletes only a branch that is merged into its upstream, or into the base clone's HEAD when it has no upstream, so a squash-merged branch, or one whose remote-tracking branch was pruned, is kept as well. If the branch has moved, or `git branch -d` refuses it, the branch stays and the result is `branch-kept` with the reason.
- When the result is `removed`, it deletes the worker hook file `state/workers/<owner>/<name>/<worktree>.jsonl`, as `worktree remove` does. It keeps the file for every other result. A file that cannot be deleted is reported in `notes`, and the result does not change.
- Each step is skipped when it is already done, so the command can run again.
- Side effects: deletes the folder, the local branch and the hook file, may run `claude rm` and `git worktree prune`, writes the claim row. No GitHub write.
- Exit codes: 0 for removed, 1 when a step is refused, held or failed, or when the branch is kept, 2 for an invalid config, 64 for wrong arguments.

## gvt-fleet wrap

```
gvt-fleet wrap <ref | task id>
```

Wraps up one finished worker in one command. It takes one ref or task id and no flags. For a task id, see **Task worker** below. It never discards work: a flag, or any other number of arguments, exits 64 before any git or GitHub call.

**Steps.** Each step starts only when the step before it has passed.

1. **Proof.** It proves the merge with the same gate as `worktree remove --require-merged` (see that section). The tip of the issue branch `worktree-<name>` must be the head of a merged pull request, and no closing pull request may be open. Unlike that gate, when the issue branch has commits of its own, `wrap` counts a merged pull request at its tip only when it is a closing pull request of the issue: listed in the cache, or found by the one live read when the cache lists none. A pull request that merged with `Part of #<n>` and no closing keyword does not prove the work (workspace #128). The problem is then `pull request #<n> from <branch> is merged at <commit> but is not a closing pull request of <ref>; the work is proven by the merged pull request that closes <ref>`. When the cache listed other closing pull requests, so that no live read ran, it ends with `; if it closes <ref>, run gvt-fleet sync`. The worktree, the session and the claim are kept. A closed issue can still pass on the nothing-to-lose proof below. When the issue branch is already gone, the merged closing pull requests of the issue are the proof. They come from the cache, or from one live read when the cache holds none (see `worktree remove` `--require-merged`). As there, each must have merged into the default branch. Here each must also have merged at or after the time of the claim (`claimedAt` of the active claim, else of the latest released one, else of the newest claim row). Otherwise the problem is `closing pull request #<n> from <branch> was merged at <time>, before the claim at <time>`: a pull request that closed the issue before it was reopened and claimed again does not prove the new claim. A run that finds the `wrapped` marker of an earlier run and nothing on disk skips the proof (`steps.proof` is `earlier`). When this gate refuses, the nothing-to-lose proof below is tried before `wrap` refuses.
2. **Worktree.** It removes the worktree and the Claude session, as `worktree remove` does (including the `claude stop` of a live worker, the branch record and the hook file). When an earlier removal stopped half-way, it finishes it, as `worktree finish` does. On that path, and when only the branch or nothing is left, `wrap` itself updates the branch record once the proof has passed and before it deletes anything, with the same rules as `worktree remove`: it drops the coordinator's own `worktree-<name>` entry for the issue and records the branch the work was pushed under while that branch is on the remote. With the issue branch gone, it only drops the entry. When nothing is left on disk (no folder, git entry, session or branch), `wrap` deletes the worker hook file `state/workers/<owner>/<name>/<worktree>.jsonl` itself, once the proof passed, was `earlier`, or was not required (a task), so that `status` drops the worker (#147). A refused proof keeps the file, as on the other paths. A file that cannot be deleted is reported in `notes`, and the result does not change. Both paths carry the busy-folder retry (see `worktree remove` step 4 and `worktree finish`), so a transient `EBUSY` or `EPERM` no longer needs a rerun by hand. A folder that a program still holds after the attempts ends the run with `half-removed` or `held`.
3. **Branch.** It deletes the issue branch `worktree-<name>`.
4. **Claim.** It releases the claim, as `release` does. This happens only after the proof passed and the worktree and the branch are gone.

**Nothing-to-lose proof.** A worker can merge its work through pull requests that do not close the issue, for example one whose work spans several pull requests with no closing keyword. The gate above then refuses. Before it refuses, `wrap` (for an issue, never for a task) tries a second proof (ADR 0016). It passes when all of these hold:

- the issue is closed;
- every pull request of the same repository that refers to the issue is merged. "Refers to" means a `cross-referenced` event in the issue's timeline, so a closing keyword and a plain `#<n>` in a title, body or commit both count. A pull request in another repository does not count;
- every branch the worktree holds has no commits of its own (its tip is on the default branch of origin, read locally with no fetch), or its tip is the head of a merged pull request (looked up by commit). The branches are the issue branch, the checked-out branch or a detached HEAD, and the other branches the worktree checked out. A pushed branch whose commits are in no merged pull request fails this condition. The base of the pull request is not checked;
- there are no uncommitted or untracked files and no stash entries on those branches. When any is found, the proof is not tried and makes no GitHub call.

It reads the issue (`GET repos/{repo}/issues/{n}`) and, only when the issue is closed, its timeline (100 events a page, up to 20 pages; a longer timeline leaves the work unproven). The branch lookups come last. The time of the claim is not checked: a closed issue with nothing left to lose is the proof, whenever its pull requests merged. When it passes, `steps.proof` is `proven`, `proofs` lists the merged pull requests that refer to the issue (with `branch` null) and the one at each branch tip, and `otherBranches` lists every other branch the worktree checked out, pushed or not. The issue branch counts as proven, so the `-D` rule below can apply to it. When it fails, its reasons are added to `problems`, each starting with `no nothing-to-lose proof:`, for example `no nothing-to-lose proof: <ref> is open`. A failed read of the issue or its timeline leaves the work unproven. `worktree remove --require-merged` does not use this proof.

**The `-D` rule.** The branch step uses `git branch -D` only when all three conditions hold:

- a merged pull request has the branch tip as its head, or the nothing-to-lose proof passed for the branch;
- the tip did not move since the check;
- a remote-tracking branch contains the tip. The refs are not fetched first, so the local copy of the remote-tracking refs decides.

Otherwise it uses `git branch -d`. When `git branch -d` refuses, the result is `branch-kept`: the worktree is gone, the claim is **not** released, and `hint` says to push or merge the branch (or delete it by hand) and run `wrap` again. When a merged pull request proved the tip but no remote-tracking branch contains it, `hint` names that pull request (`#<n>`), says its commits are merged, and says to delete the branch with `git branch -D <branch>` in the base clone and run `wrap` again (or `release` to keep the branch). The command claude rm deletes only the branch checked out in the worktree, so when a follow-up branch was checked out, `worktree-<name>` is left for this step. `branchFlag` (`-d` or `-D`) says which flag deleted the branch. It is absent when the branch was already gone.

**Rerun.** Every run reads the disk first and starts at the step that is still open. A rerun is safe after `refused`, `half-removed`, `held`, `branch-kept`, `failed`, and after a failed release (the rerun retries only the release). A rerun after full success prints `wrapped` with `nothing: true`, makes no GitHub call and exits 0. A ref with no claim and nothing left on disk is `refused`.

The `wrapped` marker sits on the claim row that `wrap` released. The marker is read from the active claim, else from the latest released one. A later claim of the same issue that fails leaves a `failed` row. A rerun of `wrap` reads the marker from the earlier row and releases the failed row, which then becomes the latest released row. So the marker moves to that row once it is released, and a third run still skips the proof. A `failed` row itself never carries the marker: `claim` reuses a failed row, and the marker would let the new claim skip its proof.

**Result.** `status` is one of `wrapped`, `refused`, `half-removed`, `held`, `branch-kept` and `failed`. The other keys:

- `steps`: `{proof, worktree, branch, claim}`. `proof` is `proven`, `earlier`, `not-required`, `refused` or `not-run`. `worktree` is `removed`, `gone`, `half-removed`, `held`, `refused`, `failed` or `not-run`. `branch` is `deleted`, `gone`, `kept` or `not-run`. `claim` is `released`, `released-earlier`, `failed` or `not-run`.
- `removalAttempts`: the number of removal attempts, 1 to 3. It is on the `half-removed` and `held` results. The wait between attempts is 2 seconds, then 5 seconds.
- `branchFlag`: see above.
- `noRemote`: `true` on `branch-kept` when the merge proof held but no remote-tracking branch contains the tip. It selects the hint that names the pull request. It is absent otherwise.
- `pushedBranch`, `pr`, `proofs`, `otherBranches`, `checkedOutBranch`: as for `worktree remove`. `checkedOutBranch` is always present on a `wrap` result: it is null when no worktree was there to check. `wrap` does not delete the checked-out branch itself when it is not the issue or task branch; `claude rm` may.
- `problems`: the reasons the proof failed (`refused`). `reason`: the text for any status except `wrapped`. `holders`: the likely holders on `half-removed` and `held`.
- `hint`: the next command, for every status except `wrapped`. When the work is not merged or not pushed, it names `worktree remove <ref> --discard` followed by `release <ref>` as the way to drop it.
- `branchRecord`: `{recorded, dropped, warning?}`, as for `worktree remove`. For an issue it is present on every run whose proof passed (or was `earlier`) and that reached the record step: on a live worktree, just before `claude rm`; otherwise before anything is deleted. It is absent on a refused proof, for a task, and when the live-worktree path ended before `claude rm`. When an entry was recorded or dropped, stderr prints `<key>: config/branches.json changed; commit it`.
- `nothing`: `true` on a `wrapped` run that found nothing to do.
- `notes`: present when a step left a remark, for example a hook file that could not be deleted.

**Task worker.** A task may have no pull request, so `wrap <task id>` needs no merge proof: `steps.proof` is `not-required` on every outcome, including a refusal or an early exit. The safety checks stay, and `wrap` never discards. It releases the task lease with no GitHub call and writes nothing to `config/branches.json`.

- A task that wrote nothing is removed: its worktree and its empty branch are deleted. A task wrote nothing when all of these hold:
  - there are no uncommitted changes and no stash entries made on the task branch, on a branch the worktree checked out, or on a detached HEAD (the stash list is shared by the base clone, so other stash entries do not count);
  - the task branch `worktree-<name>` is absent, or has no commits of its own (its tip is an ancestor of `origin/<default branch>`, read locally with no fetch; a ref that cannot be read counts as having commits);
  - every other branch the worktree checked out has all its commits on a remote branch.
- A task that committed must have every commit on a remote branch, or at the head of a merged pull request. It needs no pull request and no merge. The result is `wrapped`, the local branch is deleted, and the remote branch and any pull request stay. The local branch is deleted with `git branch -D` when it was the branch checked out in the worktree, its tip is still the one the check read, and a remote-tracking branch contains that tip (`git branch -r --contains <tip>`), whatever the upstream of the branch is. This covers a task branch pushed under another name with no upstream, which `git branch -d` would keep after a squash merge. Otherwise `git branch -d` is used, and a branch it keeps gives `branch-kept`, with the reason why `-D` was not used. The pushed task branch shows in `branches --unknown` after `sync`, like any branch pushed by hand. Decide it with `branch set`.
- A task with unpushed commits or uncommitted changes is `refused`, with `problems`. The lease stays held. The `hint` names `gvt-fleet worktree remove <task id> --discard`, which you run only on the coach's words, and then `gvt-fleet release <task id>`.

**Side branches after `wrap`.** `wrap` does not delete the branches listed in `otherBranches`, such as the side branches of a worker whose side pull requests merged into its issue branch. To delete one by hand, first prove that its work is in the default branch: the merge commit of its side pull request must be an ancestor of the head of the merged final pull request (`git merge-base --is-ancestor <side merge commit> <final head>`, exit 0). A content diff of the side branch against the default branch is not that proof. Later pull requests change the same lines, so the diff shows lines that are only on the side branch while every commit of the side branch is merged. Observed 2026-11-18 on an issue of a managed repository: such a diff showed 19 lines only on each of its two side branches, and the ancestor check passed for both. Run the check and the delete as two separate commands, so that a failed check stops the delete.

`worktree remove`, `worktree finish` and `release` stay for the cases `wrap` refuses, for example dropping work with `worktree remove --discard`.

- Side effects: stops and removes a Claude session, deletes the worktree folder, the local branch and the hook file (only once the proof passed, was `earlier` or was not required), releases the claim, and may change `config/branches.json` (commit it). It deletes no remote branch. The only GitHub write is the release (the label and assignee the claim added). The pull request lookups are reads.
- Exit codes: 0 for `wrapped`, 1 for `refused`, `half-removed`, `held`, `branch-kept` or `failed`, 2 for an invalid config, 64 for wrong arguments.
