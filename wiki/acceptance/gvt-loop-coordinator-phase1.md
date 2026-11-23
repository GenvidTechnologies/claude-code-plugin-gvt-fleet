---
type: reference
title: 'Acceptance criteria: gvt-loop coordinator, phase 1'
description: 'The acceptance criteria pledged for phase 1 of the coordinator, with the command block of each row.'
tags: [acceptance]
status: stable
---
# Acceptance criteria: gvt-loop coordinator, phase 1

Pledged before implementation (plan approved 2026-11-03) for branch
`feat/gvt-loop-coordinator-phase1`. Tracking issue:
GenvidTechnologies/claude-code-plugin-gvt-dev#814. The commands for each
T and S row are the fenced blocks keyed by row id in "Command blocks"
below. Each T-row pledges rc=0, `# fail 0`, `# skipped 0`, and
an anchored ok-count that is a floor.

## Acceptance Criteria
- [ ] T1: R1-R3 config. ok-count ≥5. Tests: `R1: entry overrides enabled flag and label names`; `R2: bugTracker values overlay defaults and config overrides overlay bugTracker`; `R3: duplicate short name is an error naming both entries`; `R3: unknown key is an error naming the entry`; `R3: a config error stops before any gh write call`.
- [ ] T2: R4-R8 sync. ok-count ≥7. Tests: `R4: incremental sync passes since = high-water mark minus overlap`; `R4: missing or version-mismatched cache triggers full resync`; `R5: stored issue keeps labels, assignees, comments, parent, sub-issues, blockedBy, blocking and closing PRs`; `R6: blocker outside managed repos is looked up and stored`; `R7: incremental query requests OPEN and CLOSED states`; `R7: issue closed upstream updates cached state to closed`; `R8: deleting cache.db and re-syncing yields the same ready set`. Fake gh.
- [ ] T3: R9-R13 graph. ok-count ≥6. Tests: `R9: each edge carries one of native-dependency, sub-issue, body-ref, label`; `R10: extract body ref becomes a body-ref edge and a retracted ref yields none`; `R11: #N resolves to own repo and name #N resolves by config short name`; `R12: cycle is reported with its members and does not throw`; `R12: unresolvable blocker ref is reported and marks the issue blocked-unresolved`; `R13: parent with an open sub-issue is umbrella, not ready`. Real `extract`.
- [ ] T4: R14-R15 ready. ok-count ≥11. Tests: `R14: issue meeting every condition is ready`; one `R14:` test per reason: closed, not-triaged, blocked-by, blocked-label (asserts "blocked (label, blocker not named)"), claimed, in-progress-label, closing-pr, existing-branch; `R14: closed blocker is cleared`; `R15: issue failing three conditions lists all three reasons`.
- [ ] T5: R16-R19 claims. ok-count ≥7. Tests: `R16: claim adds label and assignee and records lease with heartbeat and expiry`; `R16: claim creates the in-progress label when the repo lacks it`; `R17: claim refuses when fresh state shows in-progress label or another assignee`; `R18: expired lease with no live session is released on GitHub`; `R18: label with no local lease is never removed`; `R18: release keeps a pre-existing assignee`; `R19: claim whose readback lacks the label is failed, not held`. Fake gh, fake claude.
- [ ] T6: R20-R21 clones and trust. ok-count ≥8. Tests: `R20: first run clones on default branch`; `R20: re-run fetches and fast-forwards`; `R20: dirty base clone is reported and unchanged`; `R20: base clone off default branch is reported and unchanged`; `R21: writes forward-slash uppercase-drive key and keeps existing entry keys`; `R21: refuses a path outside the workspace`; `R21: retries when the entry is missing on re-read`; `R21: no write when already trusted`. Real git, temp `.claude.json`.
- [ ] T7: R22-R24 worktrees. ok-count ≥7. Tests: `R22: create runs claude --bg -w <repo>-<issue> -n <repo>-<issue> with cwd at the base clone`; `R22: create records session id and worktree path on the claim`; `R23: remove refuses an unpushed branch without --discard`; `R23: remove proceeds when the branch is pushed`; `R24: EBUSY half-failure is detected and reported with the folder path`; `R24: finish deletes a folder holding only .git, reruns rm, prunes and deletes the branch`; `R24: finish refuses when the folder holds more than .git`. Fake claude, git-sandbox.
- [ ] T8: R25 re-run. ok-count ≥3. Tests: `R25: claim re-run after a crash between GitHub write and local commit ends held`; `R25: interrupted clone temp dir is cleaned and the clone completes`; `R25: remove re-run on a lock error retries then succeeds`.
- [ ] T9: Q6 branch record. ok-count ≥5. Tests: `Q6: remote branch not in the record is listed as unknown`; `Q6: branch set writes a sorted LF entry by atomic rename`; `Q6: recorded branch tied to an open issue makes it not ready with reason existing-branch`; `Q6: record entry for a branch gone from the remote does not block`; `Q6: invalid record entry is a config error naming the branch`.
- [ ] T10: NF boundaries, rate, Windows. ok-count ≥4. Tests: `NF-rate: sync stops at the rate reserve and keeps the last committed page's high-water mark`; `NF-rate: secondary rate limit backs off and retries`; `NF-boundary: real runner refuses gh and claude under GVT_LOOP_FAKE_ONLY`; `NF-win: executable resolution returns an absolute path with extension`.
- [ ] T11: Whole suite, no GitHub writes. Under `GVT_LOOP_FAKE_ONLY=1`: `# fail 0`, `# skipped 0`, `not ok` count 0, ok-count of prefixed tests ≥63 (5+7+6+11+7+8+7+3+5+4). Floor; review-added tests allowed. Titles are string literals with the requirement prefix, top-level `test()`, no `describe`, no skip guards.
- [ ] S1: NF: one process boundary. Block S1 prints exactly `lib/proc.mjs`; control → 1.
- [ ] S2: R10: grammar not forked. Tracked `refs-grammar*` → 0; control `FINDINGS` → 1; `lib/plugin-path.mjs` names the grammar path → ≥1.
- [ ] S3: R1: real config loads. Prints `enabled 30` (amended 2026-11-03 from `enabled 12`, then `enabled 10`, then `enabled 17`; see "Recorded decisions after the pledge").
- [ ] S4: R3: bad config stops. Prints `rc=2`; stderr count of `webapp` ≥1 (the fixture's duplicate short name, renamed in the scrub of #141).
- [ ] S5: NF: sqlite warning cannot corrupt stdout. Prints `json ok`; stderr `ExperimentalWarning` count 0; control (bare `require('node:sqlite')`) → 1.
- [ ] S6: Docs. Each of the 15 subcommands has a heading count ≥1 in `wiki/coordinator.md`; control → 1.
- [ ] S7: Design doc update. `~500 open issues` in `wiki/design.md` → 0 (baseline 1); `490` → ≥1 (baseline 0; amended 2026-11-03 from `648`, see "Recorded decisions after the pledge").
- [ ] S8: [not-yet-due] Convention key upstream. gvt-dev issues matching `inProgressLabel` ≥1 (baseline 0); control `triagedLabel` → 16.
- [ ] X1: The workspace validate command runs and exits 0 on the final tree.
- [ ] X2: Two issue drafts for GenvidTechnologies/claude-code-plugin-gvt-dev are delivered in the final report; no task files them.

## Command blocks

Copied verbatim from the design. Run them from the repo root in Git Bash,
with `TMP` set to a scratch folder and `GVT_LOOP_FAKE_ONLY=1` exported.
Block S7 still greps for `648`; that half of the row was amended to `490`
(see "Recorded decisions after the pledge"), so grep for `490`.

```bash
# T1
node --test --test-reporter=tap --test-name-pattern "^R[1-3]:" "test/*.test.mjs" > "$TMP/gl-T1.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T1.txt"
grep -c -E '^ok [0-9]+ - R[1-3]:' "$TMP/gl-T1.txt"
```

```bash
# T2
node --test --test-reporter=tap --test-name-pattern "^R[4-8]:" "test/*.test.mjs" > "$TMP/gl-T2.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T2.txt"
grep -c -E '^ok [0-9]+ - R[4-8]:' "$TMP/gl-T2.txt"
```

```bash
# T3
node --test --test-reporter=tap --test-name-pattern "^R(9|1[0-3]):" "test/*.test.mjs" > "$TMP/gl-T3.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T3.txt"
grep -c -E '^ok [0-9]+ - R(9|1[0-3]):' "$TMP/gl-T3.txt"
```

```bash
# T4
node --test --test-reporter=tap --test-name-pattern "^R1[45]:" "test/*.test.mjs" > "$TMP/gl-T4.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T4.txt"
grep -c -E '^ok [0-9]+ - R1[45]:' "$TMP/gl-T4.txt"
```

```bash
# T5
node --test --test-reporter=tap --test-name-pattern "^R1[6-9]:" "test/*.test.mjs" > "$TMP/gl-T5.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T5.txt"
grep -c -E '^ok [0-9]+ - R1[6-9]:' "$TMP/gl-T5.txt"
```

```bash
# T6
node --test --test-reporter=tap --test-name-pattern "^R2[01]:" "test/*.test.mjs" > "$TMP/gl-T6.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T6.txt"
grep -c -E '^ok [0-9]+ - R2[01]:' "$TMP/gl-T6.txt"
```

```bash
# T7
node --test --test-reporter=tap --test-name-pattern "^R2[2-4]:" "test/*.test.mjs" > "$TMP/gl-T7.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T7.txt"
grep -c -E '^ok [0-9]+ - R2[2-4]:' "$TMP/gl-T7.txt"
```

```bash
# T8
node --test --test-reporter=tap --test-name-pattern "^R25:" "test/*.test.mjs" > "$TMP/gl-T8.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T8.txt"
grep -c -E '^ok [0-9]+ - R25:' "$TMP/gl-T8.txt"
```

```bash
# T9
node --test --test-reporter=tap --test-name-pattern "^Q6:" "test/*.test.mjs" > "$TMP/gl-T9.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T9.txt"
grep -c -E '^ok [0-9]+ - Q6:' "$TMP/gl-T9.txt"
```

```bash
# T10
node --test --test-reporter=tap --test-name-pattern "^NF-" "test/*.test.mjs" > "$TMP/gl-T10.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T10.txt"
grep -c -E '^ok [0-9]+ - NF-' "$TMP/gl-T10.txt"
```

```bash
# T11
GVT_LOOP_FAKE_ONLY=1 node --test --test-reporter=tap "test/*.test.mjs" > "$TMP/gl-T11.txt" 2>&1; echo rc=$?
grep -E '^# (fail|skipped) ' "$TMP/gl-T11.txt"
grep -c '^not ok' "$TMP/gl-T11.txt"
grep -c -E '^ok [0-9]+ - (R[0-9]+|Q6|NF-[a-z]+):' "$TMP/gl-T11.txt"
```

```bash
# S1
grep -rlE "from ['\"]node:child_process['\"]" bin lib; echo rc=$?
printf '%s\n' "import { spawn } from 'node:child_process';" | grep -c -E "from ['\"]node:child_process['\"]"
```

```bash
# S2
git ls-files | grep -c 'refs-grammar'
git ls-files | grep -c 'FINDINGS'
grep -c -F 'skills/triage-issues/scripts/lib/refs-grammar.mjs' lib/plugin-path.mjs
```

```bash
# S3
node bin/gvt-loop.mjs check-config --json 2>"$TMP/gl-S3.err" > "$TMP/gl-S3.json"; echo rc=$?
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("enabled",j.repos.filter(r=>r.enabled).length)' "$TMP/gl-S3.json"
```

```bash
# S4
node bin/gvt-loop.mjs check-config --config test/fixtures/config-dup-name.json 2>"$TMP/gl-S4.err"; echo rc=$?
grep -c 'webapp' "$TMP/gl-S4.err"
```

```bash
# S5
node bin/gvt-loop.mjs ready --json --state-dir "$TMP/gl-S5-state" 2>"$TMP/gl-S5.err" > "$TMP/gl-S5.json"; echo rc=$?
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("json ok")' "$TMP/gl-S5.json"
grep -c ExperimentalWarning "$TMP/gl-S5.err"
node -e "require('node:sqlite')" 2>"$TMP/gl-S5-control.err"; grep -c ExperimentalWarning "$TMP/gl-S5-control.err"
```

```bash
# S6
for c in check-config sync ready why claim release heartbeat expire branches "branch set" clone trust "worktree create" "worktree remove" "worktree finish"; do printf '%s ' "$c"; grep -c -E "^### gvt-loop $c( |\$)" wiki/coordinator.md; done
printf '%s\n' '### gvt-loop worktree finish <ref>' | grep -c -E '^### gvt-loop worktree finish( |$)'
```

```bash
# S7
grep -c '~500 open issues' wiki/design.md
grep -c '648' wiki/design.md
```

```bash
# S8
gh issue list -R GenvidTechnologies/claude-code-plugin-gvt-dev --search "inProgressLabel" --state all --json number --jq length
gh issue list -R GenvidTechnologies/claude-code-plugin-gvt-dev --search "triagedLabel" --state all --json number --jq length
```

## Recorded decisions after the pledge

- 2026-11-03, user decision during execution: an ambiguous `word #N`
  reference (grammar `unresolvable: 'repo-ambiguous'`) whose word is not
  one of the configured short names is reported as an unresolved
  reference but does not block. Evidence: on two real issues of a managed repository, #263 and
  #115, ordinary words ("Settle #270", "into #270") produced such refs on
  `depends-on` lines, and every plain `#N` on those lines is also
  extracted as an own-repo blocker, so no real blocker is lost. Row T3's
  R12 test ("unresolvable blocker ref is reported and marks the issue
  blocked-unresolved") still applies to every other unresolvable blocker
  (for example a detached `Blocked by` heading). The row's wording is
  unchanged.
- 2026-11-03, superseding the decision above (user decision, after a
  correction): the claim "no real blocker is lost" held only for those two
  issues, #263 and #115, where each ambiguous number also appears plainly on the
  same line. On a line such as `Settle #270 and #271 before #267` the
  grammar returns #270 only as the ambiguous ref, so "warn, don't block"
  would drop #270 as a blocker. New rule: the word and number are
  recovered from the line; a word that is not a configured short name
  means the issue's own repo, so the ref resolves to `<own repo>#N` and
  blocks like any other blocker. It is still listed as a warning
  (inferred own-repo reference). Row T3's wording is unchanged.
- 2026-11-03, user decision (scope change after the pledge):
  two repositories of the private organization are
  removed from `config/repos.json` because they belong to a different
  project. The managed set is now 10 repos. Row S3 is **decayed,
  falsified by scope change**: it was true for the 12-repo scope it was
  pledged against, and is corrected from `enabled 12` to `enabled 10`.
  Evidence: `check-config --json` prints `enabled 10` after the change.
  The protected requirement (R1: the real config loads and lists every
  managed repo as enabled) is unchanged.
- 2026-11-03, user decision (second scope change): the managed set is
  every GenvidTechnologies repo already listed (7) plus 10
  repos of the private organization. Total 17.
  Row S3 is again **decayed, falsified by scope change**, corrected to
  `enabled 17`. Evidence: `check-config --json` prints `enabled 17`. The
  seven added repos exist, are not archived, use `main`, and had 0 open
  issues when added.
- 2026-11-03, user decision (third scope change): the managed set holds
  every GenvidTechnologies repo of this project, 20 in all. The 13 added
  are claude-code-gvt-marketplace, c3-domain-manager, construct3-sample,
  c3addon-genvid-push-notification, c3addon-youtube-video-plugin,
  audit-core, public-github-actions, c3addon-genvid-marketplace,
  c3addon-genvid-epic-online-services, cordova-plugin-eos,
  c3addon-genvid-datadog-rum, c3addon-genvid-simpledropshadow and
  c3addon-genvid-datadog-logs. With the 10 repos of the private organization the
  total is 30. Row S3 is again **decayed, falsified by scope change**,
  corrected to `enabled 30`. Evidence: `check-config --json` prints
  `enabled 30`. The 13 added repos exist, are not archived, use `main`,
  and had 0 open issues when added (control: claude-code-plugin-gvt-dev
  reported 370 open by the same query).
- 2026-11-03, re-measurement owed by the scope changes above: row S7's
  `648` was the open-issue count over the original 12 repos. Over the
  30 managed repos the count is **490** (open issues, pull requests
  excluded: `open_issues_count` from `gh api repos/<repo>` minus the
  open-PR count from the search API, per repo). Spot checks with
  `search/issues?q=repo:<repo>+is:issue+is:open` agreed for
  claude-code-plugin-gvt-dev (370) and one private repository (47). Row S7 is
  **decayed, falsified by scope change**, corrected from `648` to `490`.
  Its baseline is unchanged: `490` has 0 hits in `wiki/design.md`
  before the update. The protected requirement (the design doc states
  the measured size of the issue set) is unchanged.
