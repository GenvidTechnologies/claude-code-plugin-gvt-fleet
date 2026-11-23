---
type: decision-context
title: 'Ship the coach skill in the gvt-fleet plugin from its own public repository'
description: 'Ship the coach skill in the gvt-fleet plugin from its own public repository (amended by 0019)'
tags: [decisions]
status: stable
---
# 0006. Ship the coach skill in the gvt-fleet plugin from its own public repository

- **Status:** accepted
- **Date:** 2026-11-05
- **Issue:** workspace #22 (sub-issue of workspace #7); CLI rename in workspace #28
- **Amended by:** [0019](0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md), which ships the CLI inside the plugin: it replaces the "Scope" bullet (the CLI stays in this workspace) and the "How the skill finds the CLI" bullet

## Context

[ADR 0002](0002-ship-gvt-loop-as-separate-plugin.md) decided that the coordinator ships as a separate plugin, `gvt-loop`, that depends on `gvt-dev`. It put the CLI, the SQLite cache, an MCP server, the team-pane mod, the `/coach` and `/dispatch` skills and the session hooks in that plugin. It did not decide where the plugin source lives.

[ADR 0003](0003-register-session-hooks-at-user-scope.md) registers the session hooks at user scope until the plugin exists.

The CLI is now built and runs from this workspace. The coach skill is the next part to ship. The earlier plan was one plugin, `gvt-loop`, that holds the CLI, the SQLite cache and claims, an MCP server, the team-pane mod and its launcher config, the `/coach` and `/dispatch` skills and the session hooks. This record replaces that plan.

## Decision

The whole system is named `gvt-fleet`. The coach skill ships as the plugin `gvt-fleet`, from the public repository `GenvidTechnologies/claude-code-plugin-gvt-fleet`. This settles the open question in ADR 0002.

- **Name.** The plugin and the CLI share one name, `gvt-fleet`. The skill keeps the name `coach`, so its command is `/gvt-fleet:coach`. The CLI is renamed from `gvt-loop` to `gvt-fleet` in workspace issue #28, before the v0.1.0 release of the plugin. Until then the CLI file is `bin/gvt-loop.mjs`. The skill will call `bin/gvt-fleet.mjs`.
- **Scope.** The CLI (`bin/`, `lib/`) stays in this workspace. This narrows what ADR 0002 put in the plugin. The plugin ships skills now. It will ship the team-pane mod and the session hooks later.
- **How the skill finds the CLI.** The skill runs `node "${CLAUDE_PROJECT_DIR}/bin/<cli>.mjs" --json ...`, where `<cli>` is `gvt-loop` until workspace #28 and `gvt-fleet` after. It therefore works only in a session started at the root of this workspace. Its preflight is `check-config --json`, and the skill refuses to run when the preflight does not pass.
- **No MCP server, no `/dispatch` skill.** The skill calls the CLI directly. There is no separate `/dispatch` skill.
- **Dependency.** The plugin declares a bare `"gvt-dev"` dependency. It resolves in the plugin's own marketplace, `gvt-plugins`. This is the second of the two options in the consequences of ADR 0002. That option also asks for a minimum `gvt-dev` version check in the coordinator's base-refresh plugin check (`wiki/design.md`), which is designed but not built. The skill itself calls no `gvt-dev` skill or script. The CLI that the skill runs does use `gvt-dev`: `sync` imports the issue-reference grammar from the installed `gvt-dev` (`lib/plugin-path.mjs`). That dependency belongs to the workspace, not to the plugin, and its minimum version is still open.
- **Scope of enablement.** The plugin is enabled at user scope. `disable-model-invocation: true` in the skill keeps its cost out of other sessions.
- **Contract.** The skill is pinned to `coach.contract: 1`. The number is `COACH_CONTRACT` in `lib/dispatch.mjs` and is documented in "The coach skill contract" in `wiki/coordinator/coach-skill-contract.md`. When the number differs, the skill refuses to run.

## Compromise

The repository, the name and the scope were set as decisions at planning on 2026-11-05 (workspace issue #22). The name was revised the same day. This section states the plan they replace, the names considered and the costs they bring.

**The earlier plan, replaced.** One `gvt-loop` plugin that holds everything listed under "In `gvt-loop` (coach side)" in ADR 0002. This record changes that plan as follows:

- The CLI, the cache and the claims stay in the workspace.
- The MCP server and the `/dispatch` skill are dropped.
- The plugin ships skills only, and the skill calls the CLI.
- The team-pane mod, its launcher config and the session hooks come to the plugin later.

**Names considered.**

- `gvt-coach` was the first choice on this day. It is replaced: the plugin and the CLI (`gvt-loop`) would then have two names, and readers would have to map one to the other.
- `gvt-team` and `gvt-crew` were rejected as too human.
- `gvt-fleet` is chosen. One name covers the plugin and the CLI. `coach` stays as the role and as the skill name.

`gvt-loop` remains in history (ADRs 0002 and 0003, the git log) and `gvt-coach` only in the git log. `gvt-loop` also stays in the live docs wherever it means today's CLI, its file names or its commands, until workspace #28 renames them.

**Costs of the chosen option.**

- The skill runs only in a session started at the workspace root. It cannot run from another directory.
- The plugin ships from another repository. Nothing in that repository can see a change to the CLI. The contract number is the only signal of drift.
- A public repository must not carry machine paths or private names. A leak guard in that repository blocks machine paths, the user's login, and the names of the private organization and its project.
- The CLI rename in workspace #28 touches the file names, the help text, the docs and the tests. Until it lands, the skill and the CLI have different names.

## Consequences

- ADR 0003 still binds under the new name. When the plugin ships its `hooks.json`, `install-hooks` must remove the hook entries from user settings. Otherwise each event is recorded twice.
- When a key that the skill reads is removed, renamed, or changes type or meaning, the contract number goes up in the same commit that changes `lib/dispatch.mjs`, `test/coach-contract.test.mjs` and `wiki/coordinator/coach-skill-contract.md`. The plugin repository must then pin the new number.
- Two repositories are released and kept compatible: this workspace and `claude-code-plugin-gvt-fleet`. `gvt-fleet` also depends on `gvt-dev`, through `gvt-plugins`.
- The wording of ADR 0002 about the `gvt-loop` plugin is superseded in part by this record: the plugin that ships is `gvt-fleet`. ADR 0002 and ADR 0003 keep their text and carry no status note.
