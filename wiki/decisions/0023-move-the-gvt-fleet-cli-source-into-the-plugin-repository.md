---
type: decision-context
title: 'Move the gvt-fleet CLI source into the plugin repository'
description: 'The CLI source, its tests, CI and reference docs move to the public gvt-fleet plugin repository, which ships them from plugin/cli/ with no bundle step; this repository keeps the fleet workspace.'
tags: [decisions]
status: stable
---
# 0023. Move the gvt-fleet CLI source into the plugin repository

- **Status:** accepted
- **Date:** 2026-11-22
- **Issue:** #201 (move the gvt-fleet CLI source to the public plugin repository)
- **Supersedes:** the "Source" bullet of [0019](0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md) and its rejected variant "move the source to the plugin repository", and "The release copy" and steps 1 and 2 of "The cutover" in [0021](0021-find-the-workspace-and-switch-the-hooks-to-the-plugin.md)

## Context

ADR 0019 ships the CLI inside the `gvt-fleet` plugin and keeps its source here. ADR 0021 builds the plugin's copy with `scripts/bundle-plugin.mjs` from a tag of this repository. That serves any fleet at run time, but only someone with access to this repository can change, test or release the CLI, because this repository is private. A fleet for another project, such as gvt-plugins, could run the CLI and not maintain it.

ADR 0019 rejected moving the source for its cost: "the CI, the wiki, 18 ADRs and the issue tracker would move or split, while several branches are open here". These facts bear on the choice again. All were checked on 2026-11-22 against `611ce98` unless the text says otherwise.

- **Visibility.** This repository is private. `GenvidTechnologies/claude-code-plugin-gvt-fleet` and `GenvidTechnologies/claude-code-plugin-gvt-dev` are public (read with `gh api repos/<repo> --jq .visibility`). A public plugin repository can clone gvt-dev in CI without a secret, as this repository's CI does today.
- **What a plugin install contains.** The marketplace entry of `gvt-fleet` is a `git-subdir` source with `path: plugin`, at `ref: v0.4.0`. Only the `plugin/` folder of the plugin repository is installed. A folder at the repository root, such as `test/`, does not ship.
- **The plugin repository today.** It holds `plugin/` (the skills and the changelog), a `wiki/` with one decision record (`0001-run-the-triage-pass-in-the-coach-session.md`, dated 2026-11-06), and one workflow, `leak-guard.yml`. Its tags are `v0.1.0` to `v0.4.0`. It has 18 open issues.
- **The plugin's leak guard.** `.github/scripts/leak-guard.sh` fails on any tracked file that names a machine path (the `repos` or `Users` folder of drive C), the user's login, the private organization or its project, except its own two files. Against that pattern, this repository has:
  - 0 lines in `bin/`, `lib/` and `scripts/`;
  - 2 lines in `test/`, both in `test/fixtures/user-settings.json` (a path in the profile folder of the generic user `someone`). The `R203` scan allows the generic user; the leak guard refuses any path in the `Users` folder of drive C;
  - 3 lines in `.github/scripts/private-names.mjs`, which defines the refused names and so matches itself;
  - in the wiki pages that move (below), 50 lines in 25 files: 30 lines in 19 of the 22 files of `wiki/decisions/` (this record not counted), 3 in 2 of the 12 files of `wiki/coordinator/`, 11 in `wiki/acceptance/gvt-loop-coordinator-phase1.md`, 3 in `wiki/design.md`, 2 in `wiki/coordinator.md` and 1 in `wiki/configuration.md` (`grep -c`, which counts lines);
  - 15 lines in `CLAUDE.md`, and 35 lines in `config/`.
- **The history.** At `4dca291`, the commit before the #141 scrub (`0a21352`, pull request #151), the same pattern matches 87 lines in 19 files of `bin/`, `lib/` and `test/`. So a public repository that carried this history would publish those names. `main` has 101 commits.
- **Issue transfer.** GitHub's page "Transferring an issue to another repository" (read on 2026-11-22) says: "You can only transfer issues between repositories owned by the same user or organization account." It also says: "A private repository issue cannot be transferred to a public repository." Both rules apply here: the owners differ, and this repository is private.
- **The issues.** This repository has 57 open issues. Most are about the CLI. A few are about this workspace: its project skills (`groom-road-blocks`, `coach-wrap`), its `CLAUDE.md`, and the switch of the coach machine (#178).
- **ADR numbers in the code.** `bin/`, `lib/`, `test/` and `scripts/` cite an ADR by number 22 times (`ADR 00NN`). `CLAUDE.md` and the issues cite them too.
- **Where the move stands.** #157 merged the code of ADR 0021. GenvidTechnologies/claude-code-plugin-gvt-fleet#58 plans the first release that ships `cli/`, through a tag here and the bundle script. #178 switches the coach machine after that release. Neither has started: this repository has no tags, and the installed plugin is 0.4.0, with no `cli/` (#178, read on 2026-11-20).
- **Open branches.** Apart from this issue's branch, the remote holds the integration branch and one side branch of #198, which changes the `coach-wrap` project skill only, and the branch of a triage task of 2026-11-13.
- **The project skills.** The scripts of `coach-wrap` and the commands in both `SKILL.md` files run `bin/gvt-fleet.mjs` of this checkout (`path.join(root, 'bin', 'gvt-fleet.mjs')`, and `node bin/gvt-fleet.mjs` in the text).

## Decision

**The CLI's source moves to `GenvidTechnologies/claude-code-plugin-gvt-fleet`, in one repository with the coach skill. The plugin ships it from `plugin/cli/` with no bundle step. The coordinator reference and the decision records move with it, scrubbed of private names. This repository keeps the fleet's workspace.**

### One repository

The CLI lives in the plugin repository, not in a second public repository that the plugin bundles from.

- `bin/` and `lib/` move to `plugin/cli/bin/` and `plugin/cli/lib/`. These are the paths that the bundle step writes today, so ADR 0021 holds without change: `install-hooks` finds plugin mode from `cli/bin/gvt-fleet-hook.mjs` and `hooks/hooks.json` in the install folder, the launcher runs `cli/bin/gvt-fleet-statusline.mjs`, and the skill runs `${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs`.
- `test/` and `scripts/ci-shard.mjs` with `scripts/shard-times.json` move to the root of the plugin repository, outside `plugin/`, so they do not ship. The imports of the tests and their helpers point into `plugin/cli/`.
- `plugin/hooks/hooks.json` is a committed file. A test checks that its events and matcher equal the event table of `plugin/cli/lib/user-settings.mjs`, which is the check that the bundle script makes today.
- The CI (`.github/workflows/ci.yml`, its three shards and the gvt-dev clone at `GVT_DEV_REF`) moves with the tests. `.github/scripts/private-names.mjs` and its `R203` tests move too, and the leak guard excludes the scan's file as it excludes its own. The plugin's `commands.validate` gains the test suite.
- `scripts/bundle-plugin.mjs`, its `R211` tests, `cli/SOURCE.json` and the `gvt-fleet-v<version>` tags go away. A plugin release is one tag of one repository, `v<version>`, as today.

### What moves and what stays

| Moves to the plugin repository | Stays here |
|---|---|
| `bin/`, `lib/` (as `plugin/cli/`), `test/`, `scripts/ci-shard.mjs`, `scripts/shard-times.json`, `.github/workflows/ci.yml`, `.github/scripts/private-names.mjs` | `config/`, `state/`, `repos/`, `probes/` |
| `wiki/coordinator.md`, `wiki/coordinator/`, `wiki/design.md`, `wiki/configuration.md`, `wiki/acceptance/` | `.claude/skills/` (`groom-road-blocks`, `coach-wrap`) |
| `wiki/decisions/0001` to `0023` | this repository's `wiki/issue-triage.md`, rewritten for the workspace's own issues |
| the rules of `CLAUDE.md` on developing the CLI: tests, test conventions, parallel branches, docs follow behaviour, code style, the Windows rules | the rules of `CLAUDE.md` on running this fleet: the coach machine, the live cache, project field writes, the wrap hand steps |

- **The decision records keep their numbers.** The code, `CLAUDE.md` and the issues cite them by number. The plugin repository's own record 0001 takes the next free number after the moved records, and says that it was 0001 there. Its one citation by number, GenvidTechnologies/claude-code-plugin-gvt-fleet#25, is updated.
- **The scrub happens here, before the copy.** Each moving file passes the plugin's leak guard before it leaves: the 25 wiki files and the fixture listed in the Context, this record (whose Context describes the leak guard's pattern), and the developer rules taken from `CLAUDE.md`. A citation of a private issue, such as an issue of a managed repository of the private organization, becomes a description without the private reference ("a managed repository"), as #141 did in the code. The diff is reviewed here, where the private names may appear. A leak caught in a public pull request is already public.
- **`probes/` stays.** It is frozen evidence and holds private paths. A moved document that cites a probe names it as evidence held by the fleet that made the decision.
- **The public repository starts from a copy with no history.** The import is one commit that names the source commit here. The full history stays in this repository.

### The cutover order

Each step is an issue in the repository where it runs (the plan is in the Consequences). The hooks and the status line of the coach machine keep running a working copy throughout: this checkout's `bin/` until step 4, the plugin's copy after it.

1. **Prepare (here).** Scrub the moving files and fix the fixture, so that the leak guard passes on them. Tag the result `cli-source-moved` on `main`. From the tag on, everything that moves is frozen here: no change to `bin/`, `lib/`, `test/`, `scripts/`, `.github/` or the moving wiki pages merges here. A lesson about developing the CLI waits for step 2 and goes to the plugin repository's `CLAUDE.md`.
2. **Import (plugin repository).** One commit copies the files of the tag into the layout above, with the tests' imports and the CI paths changed to match. The plugin's validate and CI pass. The plugin's record 0001 is renumbered.
3. **Run the skill on the copy and release (plugin repository).** The coach skill runs `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet.mjs" --workspace "${CLAUDE_PROJECT_DIR}"`. The release bumps the minor version.
4. **Switch the machine (here, #178).** Unchanged: wrap every worker, update the plugin, run the plugin's `install-hooks`, restart the sessions.
5. **Remove the source (here).** Check that nothing changed under the frozen paths since the tag: `git diff --stat cli-source-moved origin/main -- bin lib test scripts .github wiki/coordinator.md wiki/coordinator wiki/decisions wiki/design.md wiki/configuration.md wiki/acceptance` prints nothing. Delete the moved files and the CI, point the `coach-wrap` and `groom-road-blocks` scripts and texts at the plugin's copy, and trim `CLAUDE.md` and the wiki to the workspace. The wiki index links the plugin repository for the reference and the decisions.
6. **Recreate the issues (both repositories).** After step 2, each open CLI issue here is recreated in the plugin repository, with its text scrubbed of private names, its relations rewritten, and its project fields (Road block, Iteration) set on the new item. The issue here is closed as not planned with a link to its copy. The workspace's own issues stay here.

Steps 5 and 6 can run in either order. Going back before step 5 is the "Going back" of `wiki/coordinator/moving-the-cli-into-the-plugin.md`, because this checkout still has its `bin/`.

**Branches open at the time.** A CLI branch merges here before the tag of step 1, so the import carries it. A branch that cannot finish in time is moved after step 2 as a patch: `git diff <tag>...<branch> -- bin lib test`, applied in the plugin repository with the paths rewritten (`bin/` and `lib/` to `plugin/cli/`). A live worker on such a branch is wrapped and dispatched again on the issue's copy. A branch that changes only this workspace, such as #198's, is not affected.

### What replaces GenvidTechnologies/claude-code-plugin-gvt-fleet#58 and #178

- **#58 is rewritten as step 3.** It keeps the skill's new command lines, the text changes and the release. Its tag and bundle steps go, and it is blocked by the import issue of step 2.
- **#178 stays as it is.** It is step 4. The plugin's copy keeps the `cli/` layout, so its steps and its acceptance criteria still hold. It stays blocked by #58.

## Compromise

- **Two repositories: a public CLI repository that the plugin bundles from.** It keeps the CLI's tests and CI apart from the skill, and the CLI could be used without the plugin. But every CLI change needs two releases (the CLI tag, then the plugin release that bundles it), the bundle step and its tag stay, and the skill and the CLI still drift between two repositories. No consumer of the CLI outside the plugin exists (ADR 0019, option 4). One repository puts the skill, the CLI and the coach contract test in one pull request: `test/coach-contract.test.mjs` can read the shipped `SKILL.md`, which today "nothing there can catch" (`CLAUDE.md`, "Docs follow behaviour"). The two-repository layout stays possible later: `plugin/cli/` can move out without a change to the skill's command line.
- **Keep the source here (ADR 0019 as it is).** It needs no work. Every cost in the Context stays: only someone with access to this repository can fix, test or release the CLI.
- **Move the history too.** It keeps `git blame` across the move. It would publish the 87 lines of private names that `4dca291` holds, unless the history is rewritten, and a rewritten history no longer matches the one that the issues and pull requests here cite. The history stays readable here for anyone with access.
- **Renumber the moved decision records after the plugin's 0001**, which is the older repository's numbering. It would change 22 citations in the code and every citation in the issues and `CLAUDE.md`, against one citation of the plugin's record.
- **Scrub in the plugin repository, after the copy.** It is one step fewer here, but the first public commit would hold the private names.
- **Transfer the issues instead of recreating them.** GitHub refuses it for both reasons in the Context. Recreating them loses their comments and their history here, so each copy links the issue here, which stays readable to those with access.
- **Costs of the chosen option.** The scrub of the docs takes real work: 50 lines in 25 wiki files, and the developer rules of `CLAUDE.md`, which cite private issues as their evidence. Recreating most of the 57 open issues, with their relations and project fields, is the larger part. During the freeze, from step 1 to step 5, a CLI fix cannot merge here; it waits for step 2 and goes to the plugin repository. A CLI change reaches the coach machine only through a plugin release, as ADR 0019 already accepted. The public repository holds every CLI issue and decision, so a lesson that cites a private repository must be written without its name.

## Consequences

- Anyone with access to the public plugin repository can fix, test and release the CLI. A second fleet needs only its own workspace: its `config/`, `state/` and `repos/`.
- The skill and the CLI change in one pull request and ship in one release. The contract number still guards a CLI run by hand from a worktree against a released skill.
- `CLAUDE.md` here shrinks to running the fleet. The plugin repository's `CLAUDE.md` gains the developer rules, scrubbed. A worker on a CLI issue works in a worktree of the plugin repository, under `repos/GenvidTechnologies/claude-code-plugin-gvt-fleet/` in this workspace, which is already a managed repository.
- `gvt-fleet dispatch` refuses an issue in this workspace's own repository unless `--allow-self` is given, so that the coordinator does not start a worker here by accident. After step 5 this repository holds no CLI code, and the CLI issues live in the plugin repository, which the guard does not cover. Whether the guard should change is a follow-up, not part of this decision.
- The description of road block G20 in the gvt-plugins project says that the CLI ships as the workspace repository's #35 decides. Step 6 updates it to name this record.
- The migration plan, one issue per step, in the cutover order:
  1. Prepare: scrub the moving files and fix the fixture, then tag `cli-source-moved`: #210.
  2. Import the CLI source, tests, CI and docs: GenvidTechnologies/claude-code-plugin-gvt-fleet#82.
  3. Run the coach skill on the copy and release: GenvidTechnologies/claude-code-plugin-gvt-fleet#58, rewritten on 2026-11-22.
  4. Switch the coach machine: #178.
  5. Remove the moved source and docs from this repository: #211.
  6. Recreate the open CLI issues in the plugin repository: #212, filed here, where the issues are read and closed.

  The public issues (#82 and #58) cite this record by its title, not its number, and name no private repository. So #82 cannot carry a `Blocked by` line for #210; it states the dependency in prose. The edge is on #210 instead, as `Blocks GenvidTechnologies/claude-code-plugin-gvt-fleet#82`, which `gvt-fleet ready` reads as a blocker of #82 (`lib/graph.mjs`).
