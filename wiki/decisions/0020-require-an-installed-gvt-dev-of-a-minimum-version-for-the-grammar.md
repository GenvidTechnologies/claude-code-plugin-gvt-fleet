---
type: decision-context
title: 'Require an installed gvt-dev of a minimum version for the grammar'
description: 'Require an installed gvt-dev of a minimum version for the grammar'
tags: [decisions]
status: stable
---
# 0020. Require an installed gvt-dev of a minimum version for the grammar

- **Status:** accepted
- **Date:** 2026-11-18
- **Issue:** #142 (how a shipped CLI gets the gvt-dev issue-reference grammar)
- **Builds on:** [0019](0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md), its "gvt-dev grammar" bullet, and settles the minimum version that [0006](0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md) left open

## Context

`sync`, `ready`, `why`, `claim` and `dispatch` read issue references with the grammar of the gvt-dev plugin. `lib/plugin-path.mjs` finds the `gvt-dev@gvt-plugins` install in `~/.claude/plugins/installed_plugins.json`, or takes `GVT_DEV_ROOT`, and imports `skills/triage-issues/scripts/lib/refs-grammar.mjs` from it. CI clones the gvt-dev tag named by `GVT_DEV_REF` and sets `GVT_DEV_ROOT` to it.

ADR 0019 ships the CLI inside the `gvt-fleet` plugin and keeps this lookup ("Unchanged"). The plugin declares a bare `gvt-dev` dependency. Before this record, nothing stated which gvt-dev the CLI needs, and a missing or broken grammar surfaced as a stack trace from the top-level handler of `bin/gvt-fleet.mjs`.

These facts bear on the choice. All were checked on 2026-11-18.

- The grammar file first ships in gvt-dev v4.45.0. It is absent at v4.44.0, and its one commit is gvt-dev #796. Its git blob is the same at v4.45.0 and v5.1.0 (`0f9d3b5d`), and the cached copies of 4.49.0, 5.0.0 and 5.1.0 hash the same. CI ran the suite against v4.49.0 and now runs it against v5.1.0.
- The gvt-dev manifest, `.claude-plugin/plugin.json`, carries `version`, at the install path and at `plugin/` in a clone. `installed_plugins.json` also records `version` per install, but it has no counterpart under `GVT_DEV_ROOT`.
- The Claude Code plugin docs (`plugins/dependencies`, read 2026-11-18) allow a dependency object `{ "name": "gvt-dev", "version": "<semver range>" }`. For a git source, the range resolves against tags named `<plugin>--v<version>`. gvt-dev tags its releases `vX.Y.Z`, so a range today would make the install fail or fall back to the marketplace's current copy. A `--plugin-dir` copy is never checked against a range.
- The grammar is not published on npm.

Issue #142 weighed three options:

1. A declared runtime requirement: gvt-dev installed, with a minimum version that the CLI checks and names in its error.
2. A published package for the grammar, which gvt-dev and the CLI both depend on.
3. A vendored copy in this repository, with a check that it matches the gvt-dev release it came from.

## Decision

**Option 1. The CLI requires an installed gvt-dev of version 4.45.0 or later, checks it before it loads the grammar, and names the requirement in its error.**

- **Minimum.** `GVT_DEV_MIN_VERSION` in `lib/plugin-path.mjs`, set to `4.45.0`, the first release that ships the grammar. Raise it when the coordinator starts to rely on a newer grammar.
- **Version source.** The plugin's own `.claude-plugin/plugin.json`, at the root that the lookup found. So `GVT_DEV_ROOT` gets the same check as an install. Only the `x.y.z` core is compared. A version that is not `x.y.z`, or a manifest that cannot be read, fails the check.
- **Load.** `loadRefsGrammar` checks the version, imports the grammar, and checks that it exports `extract`.
- **Commands.** `sync`, `ready`, `why`, `claim` and `dispatch <ref>` load the grammar. The other commands, `dispatch --task` included, never check gvt-dev.
- **Error.** Every failure is a `GvtDevError` whose message names the minimum version, what was found, and the fix: install or update `gvt-dev@gvt-plugins` with `/plugin`, or set `GVT_DEV_ROOT`. `bin/gvt-fleet.mjs` prints that message without a stack and exits 1.
- **Override.** `GVT_DEV_ROOT` stays.
- **CI.** `GVT_DEV_REF` stays. The suite loads the grammar through `loadRefsGrammar`, so a pin below the minimum fails CI.

## Compromise

- **Option 2, a published grammar package.** It would make the grammar a versioned dependency that does not need Claude Code. It needs a new npm package and release pipeline in gvt-dev, a change of gvt-dev's own scripts to import it, and an install step for this CLI, which has no `package.json` and no third-party dependency (ADR 0019). ADR 0019 rejected npm for the CLI itself, and no consumer outside Claude Code exists. The option stays open: `loadRefsGrammar` is the one place that would change.
- **Option 3, a vendored copy.** It removes the run-time dependency. The issue names its cost: the grammar decides which issues are ready, and a stale copy changes what `ready` and `dispatch` pick with no error. The match check would need the gvt-dev release at test time anyway, which is what CI's pin already gives.
- **A version range in the plugin manifest.** It is the natural place for the requirement, but it does not work until gvt-dev publishes `gvt-dev--v<version>` tags, and it is never checked for a `--plugin-dir` copy or for `GVT_DEV_ROOT`. The CLI check holds in every case. The range can be added to the `gvt-fleet` plugin manifest once gvt-dev publishes such tags.
- **Costs of the chosen option.** The CLI still needs Claude Code's plugin layout or a gvt-dev clone at run time. The check reads the manifest's `version`, which the docs do not promise to equal the version Claude Code resolved: a release whose manifest lags its tag would be judged by the manifest. gvt-dev's release process bumps the manifest with the tag. Only the `x.y.z` core is compared, so a pre-release of the minimum, such as `4.45.0-rc.1`, passes although semver orders it before `4.45.0`. That trades strictness for a check that does not need a semver parser. There is no upper bound: a later gvt-dev that changes the grammar's shape is caught by CI on the `GVT_DEV_REF` bump, not by the check.

## Consequences

- A user without gvt-dev, or with gvt-dev older than 4.45.0, gets one line that says what to install, from the first command that needs the grammar. The other commands still run.
- The requirement is documented in "The gvt-dev requirement" in `wiki/coordinator.md`.
- The tests `R206` in `test/plugin-path.test.mjs` cover the check, the errors, `GVT_DEV_ROOT` and the CLI output.
- When a gvt-dev release changes the grammar, the `GVT_DEV_REF` bump pull request (see `CLAUDE.md`, "Run tests and validate") decides whether `GVT_DEV_MIN_VERSION` moves too.
