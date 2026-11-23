---
type: decision-context
title: 'Ship the gvt-fleet CLI inside the gvt-fleet plugin'
description: 'Ship the gvt-fleet CLI inside the gvt-fleet plugin'
tags: [decisions]
status: stable
---
# 0019. Ship the gvt-fleet CLI inside the gvt-fleet plugin

- **Status:** accepted; the "Source" bullet and the rejected variant "move the source to the plugin repository" are superseded by [0023](0023-move-the-gvt-fleet-cli-source-into-the-plugin-repository.md)
- **Date:** 2026-11-16
- **Issue:** workspace #35 (where the CLI lives and how the plugin finds it)
- **Amends:** [0006](0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md), its "Scope" and "How the skill finds the CLI" bullets

## Context

[ADR 0002](0002-ship-gvt-loop-as-separate-plugin.md) put the CLI in the plugin. [ADR 0006](0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md) narrowed that: "The CLI (`bin/`, `lib/`) stays in this workspace". Its only stated reason is the context line "The CLI is now built and runs from this workspace".

The layout has four costs.

- **One fleet per copy of the code.** `bin/gvt-fleet.mjs` takes its workspace from its own location: `repoRoot` is derived from `import.meta.url`, and `state/` defaults under it. A second fleet needs a second clone of the code. This is the root of GenvidTechnologies/claude-code-plugin-gvt-fleet#2.
- **The hooks run a working tree.** `install-hooks` writes `node "<W>/bin/gvt-fleet-hook.mjs" --workspace "<W>"` and a status line `node "<W>/bin/gvt-fleet-statusline.mjs" ...` (`planSettings` in `lib/user-settings.mjs`), where `<W>` is the workspace. A broken file under `bin/` reaches every session on the machine at once. The "Safety rules" in `CLAUDE.md` say so, and the cutover in workspace #28 needed a separate worktree.
- **Drift between two repositories.** The coach skill ships from `GenvidTechnologies/claude-code-plugin-gvt-fleet`, which cannot see a change to the CLI. The contract number is the only signal.
- **The skill runs only from the workspace root.** It calls `${CLAUDE_PROJECT_DIR}/bin/gvt-fleet.mjs`.

Workspace issue #35 weighed five options:

1. Keep the CLI in the workspace.
2. Publish an npm package.
3. Ship the CLI inside the `gvt-fleet` plugin.
4. Publish an npm package that the plugin pins. This is the pattern of the gvt-construct3 plugin, which runs `npx -y @genvidtech/construct3-chef@2.1.0`.
5. Keep thin local entry points on a published library.

These facts bear on the choice. All were checked on 2026-11-16 unless the text says otherwise.

- The CLI has no `package.json` and no third-party dependency. Every non-relative import in `bin/` and `lib/` is a `node:*` built-in. `node:sqlite` is imported dynamically (`lib/cache-db.mjs`, `lib/claims-db.mjs`) and is experimental in Node 24.
- `lib/plugin-path.mjs` imports the issue-reference grammar from the installed gvt-dev plugin, found through `installed_plugins.json` or `GVT_DEV_ROOT`. The grammar is not published on npm. The `gvt-fleet` plugin already declares a `gvt-dev` dependency (ADR 0006).
- A text search for private names and machine paths (the private organization, its project, the user's name, the machine's checkout folder) finds one line in `bin/`: a help example that named the private organization's project, in the `iteration` help in `bin/gvt-fleet.mjs`. It finds one line in `lib/`: a comment in `lib/trust.mjs`. Under `test/` it finds 121 occurrences in 19 of 74 files, mostly in fixtures. The plugin repository has a leak guard that blocks machine paths and these private names. Since then, workspace #141 (merged on 2026-11-17 by workspace pull request #151) replaced these names in `bin/`, `lib/` and `test/` with generic ones. The scan `.github/scripts/private-names.mjs` runs as the `R203` tests, so a new private name now fails the suite and CI.
- The Claude Code plugins reference (read on 2026-11-16) says that a plugin hook command can name `${CLAUDE_PLUGIN_ROOT}`, and that hook processes receive `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR`. `${CLAUDE_PLUGIN_ROOT}` is the folder of the installed version and changes on each update. `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) is kept across updates. The manifest has no status-line field, so a plugin cannot ship a `statusLine`. Skill content can name `${CLAUDE_PLUGIN_ROOT}`. The Bash tool's environment does not carry it.
- The hook already ignores a session whose folder is not `<W>/repos/<owner>/<repo>/.claude/worktrees/<name>`, given the workspace `<W>` (`parseWorktreeCwd` in `lib/worktree-path.mjs`).

## Decision

**The CLI ships inside the `gvt-fleet` plugin. Its source stays in this repository.** This is option 3.

- **Source.** `bin/`, `lib/`, `test/`, the CI and the design docs stay here. The tests are not shipped. They are scrubbed anyway (workspace #141).
- **Release.** A `gvt-fleet` plugin release copies `bin/` and `lib/` from a tagged commit of this repository into a folder of its own in the plugin. The folder is not the plugin's top-level `bin/`, which Claude Code puts on the Bash tool's PATH. The skill and the CLI ship in one release, so the skill always runs the CLI it was released with. The release records the source commit. The `R203` tests keep `bin/` and `lib/` free of private names here, and the plugin's leak guard checks each release as well.
- **Workspace.** The workspace is the data: `config/`, `state/` and `repos/`. The CLI takes its workspace as an input and not from its own location. How it finds the workspace (a flag, the session's project folder, a search upward for `config/repos.json`) is settled by the implementation issue. One copy of the CLI serves any number of workspaces.
- **Skill.** The coach skill runs `node "${CLAUDE_PLUGIN_ROOT}/<folder>/bin/gvt-fleet.mjs" --workspace <the folder the coach started in> ...`, where `<folder>` is the plugin folder that holds the copy.
- **Hooks.** The plugin ships the session hooks in its `hooks/hooks.json`, naming `${CLAUDE_PLUGIN_ROOT}`. The hook works out the workspace from the session folder (the part before `/repos/<owner>/<repo>/.claude/worktrees/<name>`). It checks that this folder is a fleet workspace before it writes. `install-hooks` removes its hook entries from user settings. ADR 0003 and ADR 0006 already require this when the plugin ships `hooks.json`.
- **Status line.** A plugin cannot ship a status line, so `install-hooks` keeps writing the `statusLine` entry. The entry must name a path that a plugin update does not move. One form is a small launcher in `${CLAUDE_PLUGIN_DATA}` that finds the current plugin root. The implementation issue settles the form.
- **gvt-dev grammar.** Unchanged. `lib/plugin-path.mjs` finds the installed gvt-dev, which the plugin declares as a dependency.
- **Contract number.** It stays. It still guards a mismatch during development: a worktree CLI run by hand against a released skill. A released skill and its bundled CLI always agree.

## Compromise

- **Option 1, keep the CLI in the workspace.** It needs no work, and every cost in the Context stays. #2 could still be solved by keying hook entries per workspace. Each fleet would still need its own copy of the code, and the hooks would still run a working tree.
- **Option 2, an npm package.** The hooks would run a released version. The skill and the CLI would still ship from two repositories, so drift remains. A public package needs Node's experimental `node:sqlite` in a public `engines` story. The gvt-dev grammar is not on npm, so the package would still need an installed Claude Code plugin at run time. The main gain of npm, use outside Claude Code, does not hold. It also adds a second registry and a second release pipeline to keep.
- **Option 4, an npm package pinned by the plugin.** It has the same run-time properties as the chosen option, plus use outside Claude Code. The price is two releases per change (npm, then the pin bump) and the npm costs of option 2. No consumer outside Claude Code exists. The option stays open: the bundled CLI can move to a pinned package later without changing the skill's contract.
- **Option 5, local entry points on a published library.** The hook paths stay stable. The workspace gets a `package.json`, `node_modules` and an install step. The entry points are still a working tree. The library is still a public npm package, with the costs of option 2. Drift between the skill and the library remains.
- **Rejected variant of option 3: move the source to the plugin repository.** It gives one repository. The test scrub is no longer in the way (workspace #141), but the CI, the wiki, 18 ADRs and the issue tracker would move or split, while several branches are open here. Bundling at release keeps development where it is.
- **Costs of the chosen option.** A CLI fix reaches the coach and the hooks only through a plugin release, not on merge to `main`. Today a merge is live at once, which is the working-tree cost. A pre-release can be tried with `claude --plugin-dir`. The status-line path needs a stable launcher.

## Consequences

- One CLI serves many workspaces. Item 1 of GenvidTechnologies/claude-code-plugin-gvt-fleet#2 becomes "the plugin hook derives the workspace from the session folder", instead of one user-settings hook entry per workspace. Items 2 (usage limits in one machine-level file) and 4 (overlap check) are unchanged.
- The hooks and the CLI run a released version. Editing `bin/` in this checkout no longer changes what every session runs. The cutover pattern ("Moving from the gvt-loop names", `wiki/coordinator/moving-from-gvt-loop-names.md`) is needed once more, for the move itself.
- The plugin release (`gvt-dev:release-plugin`) gains a step: copy `bin/` and `lib/` from a tagged commit of this repository, and record that commit.
- This record moves no code. The work is a follow-up implementation issue: the CLI takes its workspace as input; the release copy; the plugin `hooks.json` and the removal of user hook entries by `install-hooks`; the stable status-line launcher; the skill's command line; and the docs (`CLAUDE.md` Purpose and Safety rules, `wiki/coordinator/`). Until it lands, the scope of ADR 0006 holds in practice.
- The scrub that workspace #35 leaves open for every option that moves the code is done: workspace #141 made `bin/`, `lib/` and `test/` generic, and the `R203` tests keep them so.
