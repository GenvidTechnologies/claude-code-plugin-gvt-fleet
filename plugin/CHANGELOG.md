# Changelog

All notable changes to the `gvt-fleet` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The watch reports a worker whose session shows `done` after its turn.** The agents list can show a background session `done` between its turns, while the worker waits for the coach with a side pull request ready for review. `watch` skipped such a worker, and `status` dropped its last message. Now `status` keeps the `detail` and `since` of the last hook record for a session that is not live, and `watch` prints one `needs-you` line with the reason `agents:done` for a worker whose session shows `done` while its claim or task lease is held, with the last message as `detail`. The skill counts such a worker as running, so the watch keeps running until the worker is wrapped or released, and it shows the last message of each wrap-up candidate (#178).
  - **Consumers:** the contract number does not change. `reason` takes the new value `agents:done`, and no key changes type.

### Changed

- **The coach skill runs the CLI that the plugin ships.** Every command line of the skill, the pre-approved ones in `allowed-tools` included, now runs `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs" --workspace "${CLAUDE_PROJECT_DIR}" --json …` instead of the workspace's own `bin/gvt-fleet.mjs`. A folder that is not a gvt-fleet workspace now fails the preflight with exit 2 (`config/repos.json` cannot be read), and the skill says that the coach did not start Claude Code at the root of a workspace. The preflight messages for a missing `coach` key or another contract number now point at the plugin, not at the workspace (#58).
  - **Consumers:** the contract number does not change, and the skill needs no workspace copy of the CLI. If the hooks and status line still run from `~/.claude/settings.json`, run `install-hooks` from the plugin's CLI once after the update: `node "<install folder>/cli/bin/gvt-fleet.mjs" --workspace "<workspace>" install-hooks`, where `<install folder>` is the `installPath` of `gvt-fleet@gvt-plugins` in `~/.claude/plugins/installed_plugins.json`. Until it runs, the plugin hook and the user-settings hook both run, and each event is recorded twice (`wiki/coordinator/moving-the-cli-into-the-plugin.md`).

## [0.6.0] - 2026-11-23

### Added

- **The gvt-fleet CLI ships in the plugin.** `plugin/cli/bin/` and `plugin/cli/lib/` hold the CLI, copied from the workspace repository at the tag `cli-source-moved`, and `plugin/hooks/hooks.json` runs its session hook (`cli/bin/gvt-fleet-hook.mjs`) for `SessionStart`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` and `PreToolUse` on `AskUserQuestion`. The CLI's tests, CI and command reference moved into this repository with it (#82). **Consumers:** an installed plugin with `cli/` and `hooks/hooks.json` runs the hooks itself, so the hook entries that `gvt-fleet install-hooks` wrote to `~/.claude/settings.json` would record each event twice. Run `install-hooks` once after the update: in plugin mode it removes those entries and points the status line at a launcher in the plugin data folder (`wiki/coordinator/session-state.md`). The skill's command lines and the release steps are #58.

## [0.5.0] - 2026-11-22

### Added

- **Checks after `wrap`.** After every `wrap` result, the skill reports what the worker left: the worktree, the issue branch, the checked-out branch that is still in the base clone (`checkedOutBranch` with `kept` true), the other branches the worktree checked out (`otherBranches`), and the remote branches, which `wrap` never deletes. It deletes none of them, and says how to prove a side branch merged before deleting it by hand. After `wrapped`, it offers to check which of the worker's branches are still on the remote (`git ls-remote`), to file each follow-up that the finish turn listed as an issue (`gh issue create`, with the coach's yes for each one), and, when the merge landed in the workspace's own repository, to pull the main checkout (`git pull --ff-only`, only when it is on the default branch). The follow-ups come from the worker's last message, which the skill reads from `status` before `wrap` ends the session. None of these commands is pre-approved. Two new rules say that the skill files no follow-up and pulls nothing without the coach's yes for that write, and deletes no branch or worktree.
  - **Consumers:** the contract number does not change. The skill also reads `checkedOutBranch` from the `wrap` result; with a CLI that does not report it, the skill says nothing about the checked-out branch.
- **Linked issues are settled before dispatch.** Before each `dispatch`, the skill reads the issue and the issues of the running workers and of the other issues the coach has named for dispatch, with `gh issue view`. It finds the links that readiness does not settle: `Relates to` lines, "plan with" or "plan as one change" notes in bodies and comments, and a shared parent issue. It shows each linked group, and dispatches nothing in it until the coach gives the whole group to one worker, whose final pull request closes every issue of the group, or an ownership list. The list names the owner of each file, of each line range or section of a shared file, of the decision record (which worker writes it, not its number) and of each shared phrase, and carries a version number. The composed prompt of each worker of the group carries the list and says that a later numbered version replaces every earlier one, relays from other workers included. A later version reaches a running worker through the coach, in the worker's session, as the finish turn does. A new rule says that the skill never chooses an owner or sends a list by itself.
  - **Consumers:** the contract number does not change. The check reads no coordinator key. It needs a `gh` whose `issue view --json` has the `parent` field to find siblings; with an older `gh`, the skill says that siblings were not checked.

### Changed

- **`dispatch` passes a composed prompt for one integration branch per worker.** When the coach gives no prompt, the skill no longer leaves the coordinator's default prompt in place. It passes its own prompt, which tells the worker: push the worktree branch to `origin` before the first side pull request; do each piece of work, the retro included, on a side branch with a pull request into the worktree branch and no closing keyword; stack a side branch on one that is not merged yet, and say so in the body; report a ready side pull request at the end of its own last message, with the number, and send no message to another session; never merge a side pull request, because the user's merge is the approval; fast-forward the local worktree branch after each merge; and wait for the coach before the finish turn. The finish turn merges `origin/main`, re-checks each acceptance criterion, lists the follow-ups, checks that every side branch is merged, opens the final pull request into `main` with the closing keyword and a list of the side pull requests, and ends with the worktree branch checked out, up to date with `origin`, clean, and at the head of that pull request. A prompt the coach gives is passed as it is. The `task` mode is unchanged. The watch section says how a ready side pull request reaches the coach, and a new rule says that the skill never merges a side pull request, nor a final pull request by itself.
  - **Consumers:** the contract number does not change. The change reads no new coordinator key and needs no newer workspace CLI.

## [0.4.0] - 2026-11-16

### Changed

- **The class comes from the project Iteration field, not from labels.** The skill now says that the coordinator derives the class from the Iteration field of the repository's GitHub project: the current iteration is Now, the first one that starts after today is Next, and every other issue is Later. `class` puts the issue's project item in an iteration, or clears it for `later`, instead of writing labels. The skill reports its new refusals (a project with no Iteration field, and `now` or `next` when the project has no current or no next iteration) and its new exit 2 (a repository with no `project`). It says that the change shows without a `sync` only when the coordinator wrote its cache. The overview no longer marks Now entries that carry both class labels, and the skill no longer reads `now[].conflict`, which is always `false`.
  - **Consumers:** the contract number does not change. The skill matches a workspace CLI that reads the class from the project Iteration field.

## [0.3.0] - 2026-11-12

### Added

- **Class list and class change on request.** The coach can ask for the issues of one class (`ready --class <now|next|later>`, pre-approved because it only reads). The coach can also ask to move an issue to another class. The skill then runs `class <ref> <class>`, which writes labels on GitHub, so it always asks for permission. Afterwards the skill runs `ready` again and shows the change without a `sync`.
  - **Consumers:** both need a workspace CLI that has `ready --class` and the `class` command. With an older CLI the skill shows the CLI's error.
- **Watch on the running workers.** While a worker runs, the skill keeps one `gvt-fleet watch --minutes 25` running under the Monitor tool, so a worker that starts to wait reaches the coach as an event, with its `key`, `reason` and `detail`. The overview starts the watch, and so does a `dispatch` that exits 0. At each `watch-end` line the skill runs `status`, which extends the leases, and starts the next run from the line's `cursor`. When Monitor ends a run early, the skill shows `status` and starts a new run. The watch stops when no worker is running, or when the coach asks. `watch` is pre-approved, because it changes no lease and makes no GitHub call.
  - **Consumers:** the watch needs a workspace CLI that has the `watch` command. With an older CLI the command exits 64 and the skill starts no watch. These are added keys, so the coach contract stays at 2.
- **Task mode.** `task <repo> <slug> [prompt]` starts a task worker, a worker in a managed repository's base clone with no issue, through `dispatch --task`. The rules of `dispatch` apply: only when the coach names the repository and the slug, one at a time, the same prompt checks, and `--allow-self` only on a clear yes for the workspace's own repository. The overview lists the `tasks` rows of `status` in the same groups as the issue workers, marked as tasks, and a finished task is a wrap-up candidate. `wrap <task id>` wraps a task with no merge proof; dropping a task's work still needs the coach's words. The contract table adds `dispatch` `key` and the `tasks[]` `state`, `reason` and `lease.state` keys.
  - **Consumers:** the task mode needs a workspace CLI that has `dispatch --task` and reports `tasks` in `status --json`. With an older CLI the task dispatch exits 64 and the overview says task workers are not reported. These are added keys, so the coach contract stays at 2.

### Changed

- **The overview shows Now, Untriaged and Next instead of the whole ready list.** Step 3 shows each Now issue (ready or not, with its reason codes, marked when it carries both class labels), the untriaged summary, and one count line for each repository with Next issues. It still says how many issues are ready.
  - **Consumers:** the groups need a workspace CLI whose `ready --json` reports `now` and `next`. With an older CLI the overview says the groups are not reported and shows the ready list as before. These are added keys, so the coach contract stays at 2.

## [0.2.0] - 2026-11-08

### Added

- **Untriaged summary in the coach overview.** Step 3 of the overview now shows, for each repository, how many open issues are untriaged and how many the triaged label alone would make ready.
  - **Consumers:** the summary needs a workspace CLI whose `ready --json` reports `untriaged`. With an older CLI the overview says "not reported" and offers no triage pass. The coach contract stays at 1.
- **Triage pass.** The coach can name repositories from the summary. For each one, in turn, the skill runs `gvt-dev:triage-issues` in the repository's base clone. It checks the repository with `gh repo view`, tells the triage skill to put `--repo <owner/name>` on every `gh` command, runs it only in interactive mode, waits for the coach's approval of every tracker change, and writes no file in the base clone. Afterwards it runs `sync` and `ready` and reports how many of the picked issues became ready.

### Changed

- **The skill now needs coach contract 2.** The preflight accepts `coach.contract: 2` only. In contract 2, the merge gate proves the issue's own work, not the branch that is checked out in the worktree, and `worktree remove` reports every proving pull request in `proofs`.
  - **Consumers:** update the workspace CLI to a version that reports contract 2 together with this plugin. A CLI on contract 1 stops the skill at the preflight, and so does a plugin on contract 1 against a contract-2 CLI.
- **`wrap <ref>` runs one `gvt-fleet wrap` call.** It replaces the sequence `worktree remove --require-merged`, `worktree finish`, `release`. The skill shows `steps`, and for each status it shows the coordinator's `hint` and offers the rerun that `wrap` supports. A rerun after a full wrap now exits 0 with `wrapped` and `nothing: true`, not 1, and the skill reports "nothing left to do". The skill also shows `otherBranches`, the pushed branches that `wrap` does not delete. The skill no longer runs `worktree finish`.
- **The safety rules stay.** The skill never commits `config/branches.json`. It offers `worktree remove --discard` only after the coach says the work should be dropped. It offers `release` after that drop, or to keep a branch that `wrap` kept when the coach chooses to keep it. It never runs a command only because `hint` names it.

## [0.1.0] - 2026-11-05

### Added

- **`/gvt-fleet:coach` skill.** The coach's entry point for the gvt-fleet multi-repo coordinator. It reads issues, shows the workers that need the coach and the ready issues, dispatches an issue on request, and wraps up a finished worker.
  - **Consumers:** it runs only in a session started at the root of a gvt-fleet workspace, and it needs the `gvt-dev` plugin.
  - New invocable skill → version bump at release.
