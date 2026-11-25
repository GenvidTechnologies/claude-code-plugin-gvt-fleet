---
type: convention
title: 'Issue Triage Conventions'
description: 'Project conventions that /gvt-dev:triage-issues reads: types, priorities, class, road block, labels, required fields, splitting, duplicates, dependencies and mutation recipes.'
tags: [triage]
status: stable
---
# Issue Triage Conventions

> Project conventions consumed by `/gvt-dev:triage-issues`. The skill copies this
> file to the contract path `.gvt-agent.json` resolves for `docs/issue-triage.md`; edit it for your tracker. The companion **access
> mechanics** (fetch queries, label names) live in the `bugTracker` block of
> `.gvt-agent.json` — see the skill's SKILL.md for that block.
>
> This is the **flat-label variant** — for repos using a simple category-label set
> (e.g. GitHub's defaults: `bug`, `enhancement`, `documentation`, `duplicate`,
> `question`, `wontfix`) with **no** `type:`/`priority/`/`area:` scheme. If your repo
> uses a structured taxonomy, copy `issue-triage.template.md` instead.
>
> The example commands below assume **GitHub Issues via the `gh` CLI**. Replace
> them with your tracker's equivalents; the section headings must stay the same —
> the skill and analyst locate guidance by heading.

## Types

A single category label per issue, drawn from the existing flat set:

- `bug` — incorrect behavior in shipped functionality.
- `enhancement` — a new feature or improvement request.
- `documentation` — a docs-only gap or fix.
- `question` — a request for information or clarification (doubles as the
  needs-info signal — see Required fields).

Set exactly one category label. Add new categories only if the repo already uses
them — never invent a taxonomy the repo doesn't have.

## Priorities

**This repo has no priority labels.** Don't invent a `priority/*` scheme. When
ordering work, rank by recency and observable impact in discussion rather than a
label — a triaged issue carries no priority field. (If the repo later adopts
priority labels, switch to the structured template.)

## Class

Each open issue has a class: Now, Next or Later. Two places store it, and a
triage pass sets both:

- **The Iteration field of the `gvt-plugins` project** (organization project 1).
  The gvt-fleet coordinator derives the class from it: the current iteration is
  Now, the first iteration that starts after today is Next, and every other
  iteration is Later. So is an item with no iteration, and an issue that is not
  in the project. The coach overview reads only this class. Only the
  coordinator's `class` command writes it. The coordinator no longer reads or
  writes the labels `class:now` and `class:next` (its ADR 0015).
- **The Class field of the `gvt-plugins` project.** It is a single-select field
  with the options Now, Next, Later and Done. The coach overview does not read
  it, and the coordinator does not write it.

The two stores are not linked. When only one is set, they can disagree, and the
coach overview shows the Iteration class. Observed in the triage of #25: the
brief asked for "the project Class", and only the Class field was set. Both
stores said Later, so nothing was lost. A Next class set that way would not
have reached the overview.

Next can be set only when the project has a next iteration. Without one,
`class` refuses `next`. Observed in the triage of #29: project 1 had a current
iteration and no next one.

Propose a class for each triaged issue. The proposal defaults to Later. Set it
only with the coach's approval, through the recipes "Set coordinator class" and
"Set project Class".

For Later on an issue that is not in the project, run only "Set project Class".
`class later` does not add the issue to the project, and an issue with no
iteration is already Later. Done in the triage of #39 and #40.

## Road block

Each open issue has a road block: the value of the single-select `Road block`
field of the `gvt-plugins` project. A road block is a larger goal of the
project, bigger than one iteration, with a "done when". The project README
lists them. `Standalone` marks a bug or small improvement that serves no larger
goal. The gvt-fleet workspace groups the issues into road blocks with its
`groom-road-blocks` skill, and a new issue gets its road block at triage.

Propose a road block for each triaged issue that stays open, from the options
of the field. Set it only with the coach's approval, through the recipe "Set
road block". An issue that the triage closes (folded into another issue, or a
duplicate) gets none. Done in the triage of #56, #57 and #58: #58 got its road
block, and #56 and #57 were folded into #37.

When the issue already has a road block, report it, and propose a change only
when it is wrong. The `groom-road-blocks` skill of the workspace can set the
road block before it starts a triage of the issue.

"Set road block" adds the issue to the project when it is not in it. The new
item has no iteration, so its class stays Later. Write no Class field for it:
the item is already Later. Done in the triage of #56, #57, #58 and #75.

## Labels

- category — exactly one of `bug` / `enhancement` / `documentation` / `question`.
- `duplicate` — set on non-canonical members of a duplicate cluster.
- `question` — also used to flag missing info (see Required fields); cleared when
  supplied.
- `wontfix` — set only with explicit approval when an issue is closed as out of scope.
- `triaged` — set **last**, by the skill, when triage is complete.
- No class label. The coordinator keeps the class in the project Iteration
  field (see Class). The labels `class:now` and `class:next` are no longer read
  or written; do not set them.

The triager sets the category label. Reporters may suggest one.

## Required fields

Every triaged issue should have enough to act on: for a `bug`, a reproduction
(steps or a failing case) plus expected vs. actual behavior and the build/version;
for an `enhancement`, a clear statement of the desired outcome and motivation.
Missing the essentials → add the **`question`** label and comment exactly what is
needed. (This repo has no dedicated `needs-info` label; `question` serves that
role — match the `needsInfoLabel` in the `bugTracker` block to it.)

An acceptance row that a background worker cannot check ends with
`(interactive)`. Examples: a row that needs an interactive Claude Code session,
or a row that needs the user present. A worker that cannot check such a row
reports it as not verified in the pull request and leaves its box unticked. The
issue then closes with that row open, so the pull request names who checks it.
Observed on #8: the row "A Monitor line starts a new turn in an interactive
coach session" went to a background worker, and the issue closed on merge with
the row unchecked.

An issue names the file it changes and quotes the sentence to change. It does
not give a line number. A line number goes stale when another change lands in
the file while the issue is open. Observed on #15: the body cited
`SKILL.md:296`, and one merged pull request later the sentence was at line 375.

An issue names the repository that owns each part it changes. The coordinator
owns its default prompts and its result keys. The skill owns only the arguments
it passes and the keys it reads. Observed in triage on #34: the body put "the
dispatch prompt guidance" in this repository, and it called the coordinator's
default "the default dispatch prompt". The skill passes no prompt by default,
so the change needed either a CLI change or a prompt that the skill composes.
The coach chose the composed prompt (#37).

An issue about what a worker was told at dispatch says where the wording came
from: the skill (`plugin/skills/coach/SKILL.md`), the coordinator's default
prompt, or a prompt the coach wrote by hand. When the coach gives no prompt,
the skill passes its composed prompt ("The composed prompt" in
`plugin/skills/coach/SKILL.md`, since #37). Wording that neither the composed
prompt nor the default holds came from the coach. Such an issue changes the
composed prompt. Observed in the triage of #51 and #52: both asked to change
"the dispatch prompt" for a side-branch step that only a hand-written prompt
held, and both were folded into #37.

An issue that changes a path or a command form lists every file that names
the old form or describes it, not only the lines it rewrites. Search the whole
repository for the old path, and read the prose around each hit. Observed in
triage on #58: the body replaced the coordinator's path in the command lines of
`plugin/skills/coach/SKILL.md`, and left out the skill's opening sentence and
first Preflight row, the Requirements of `README.md`, and the Layout and
Purpose of `CLAUDE.md`. All of them describe the CLI as a file in the
workspace.

An issue that renumbers a decision record lists every file that cites it by
number. Search the tracked files for the number, and list the issues that cite
it. Observed in triage on #82: the body named only #25, while
`plugin/skills/coach/SKILL.md`, `CLAUDE.md` and `wiki/index.md` also cite
record 0001 by number.

An issue that moves files with their tests into another layout lists each test
that names the source's root folders, not only the imports: path literals,
include lists, default scan paths and recorded file names. It also checks the
moved tests against the files already in this repository, such as its wiki
schema. Observed in triage on #82: the body said to change the imports of the
tests. About six imported tests name `bin/`, `lib/` or `config/` at the
repository root, scan `bin lib test` by default, or list a test file that is
not copied, so they would have failed or read less. The imported wiki test
also refuses the record titles that this repository's `wiki/schema.md`
prescribes.

An issue that moves or renames a file that a gvt-dev skill reads names the
`.gvt-agent.json` `paths` key the skill finds it by, and that key's default.
Observed in triage on #33: the body said to repoint the `paths` keys that name
`docs/`, but the only key was `plugin_root`. gvt-dev 5.0.0 finds the triage
contract through `paths['docs/issue-triage.md']` and the decision records
through `paths['docs/decisions/']`, so the move must add both keys.

An acceptance row that limits the paths a file may name says which
repository's paths it means. A file in this repository can name a path in
another repository, such as the workspace's command reference. Observed on
#33: the row said that `plugin/skills/coach/SKILL.md` "names no path outside
`plugin/`", while that file already named the workspace's
`wiki/coordinator/coach-skill-contract.md`. The worker read the row as
covering this repository's paths only, and said so in the pull request.

An issue that has the skill write an issue reference into text, such as a
prompt or a pull request body, says which form the text needs. The skill
accepts `owner/name#N` and `short#N`, and a closing keyword such as
`Fixes <ref>` needs `owner/name#N`, because the short name holds no owner.
Observed on #37: the body asked for `Fixes <owner/name#N>` in the composed
prompt and did not say what to do when the coach types `short#N`. The skill now
looks the full reference up in the `ready` output, and asks the coach when no
entry or more than one matches.

An acceptance row that pledges one failing case per rule checks that each rule
can fail on its own. A rule that another rule covers has no failing case of its
own, and the row says so. Observed in triage on #75: every reserved token of
the dispatch prompt rules starts with `-`, so the token rule never fails alone,
and the empty-prompt rule cannot fail once the prompt holds `Fixes <ref>`.

A reason that states a fact about the environment, such as what a tool needs or
what a CI runner has, is checked before the issue is triaged. Observed in
triage on #75: the body said that `commands.validate` already needs `node` for
`claude`. `claude` can be a native executable that needs no `node`, and CI
does not run `claude`.

An acceptance row that pledges a test total counts tests as the runner does,
the `# tests` and `# pass` lines of a TAP run, not the `test(` calls in the
source. A `test(` call inside a loop runs once for each item. Observed on #82:
the tag held 838 `test(` calls and 840 tests at run time, because one call sits
in a loop of three.

An issue that asks for "one commit" that does something says which pull
request holds that commit. A worker's side pull requests and its final pull
request are squash-merged, so the default branch gets one commit for the whole
issue, and the commit survives only in the side pull request's history.
Observed on #82: "one commit copies the files" held on the side branch, and the
squash merge into the integration branch joined it with the commit that
adapted the copy.

An issue that changes the gvt-fleet CLI names the CLI's paths in this
repository: `plugin/cli/bin/`, `plugin/cli/lib/`, `test/` and the command
reference under `wiki/`. Until the CLI source is in this repository, the CLI
in the workspace is frozen, and the issue is blocked by the issue that imports
the source (#82). Write that wait as a `Blocked by` line: the reference check
reads a wait stated in prose as no blocker. Observed in triage on #89: the body
named the workspace's `lib/dispatch.mjs` and had no `Blocked by` line, so the
reference check read it as ready.

An issue that removes a guard quotes the purpose that the guard's source gives,
such as a decision record or the command reference, and says why that purpose
no longer holds. A case that the issue cites from a record or from the
workspace's notes keeps the facts of its source. Mark a claim with no source as
an observation. Observed in triage on #89: the body said that the refusal
"protects nothing" and did not cite the purpose that the workspace's decision
record gives ("so that the coordinator does not start a worker here by
accident"). It also told a recorded case as a checkout behind its default
branch, while the source says the checkout had been left on another branch.

An issue that has a command report how far a checkout is behind its remote
says how the remote state is read, or states the outcome that a row checks. A
merge on GitHub does not move a checkout's `origin/<default>` until that
checkout fetches, so a count made from local refs can read 0 right after the
merge. Observed in triage on #89: the row "with the checkout up to date reports
none" could not fail correctly until the body required the count to be right
immediately after the merge.

The open CLI issues of the workspace repository have copies in this
repository since 2026-11-23: #101 to #148, except the pull request #104. Each
copy ends "Recreated on 2026-11-23 from the coordinator workspace's tracker".
An issue that cites a workspace issue cites its copy here as a bare `#N`. Find
the copy by its title: on 2026-11-23 the workspace had not yet published which
copy belongs to which issue. An issue that waits in prose for a workspace step
is checked at triage, because the step can run before the triage does.
Observed in triage on #99: the body was filed at 21:40 to wait for the copies,
and the copies were made at 22:04. Workspace #81 became #119, and workspace #82
became #120.

An issue that rewrites references to workspace issues lists the CLI code as
well as the wiki. The `HELP` table in `plugin/cli/bin/gvt-fleet.mjs` prints such
references, and comments in `plugin/cli/lib/` cite them as bare numbers.
Observed in triage on #99: #86 rewrote the wiki pages only, and the `wrap` entry
of the `HELP` table still ended "(#82)", which in this repository names the
issue that imported the CLI. Such an issue also lists the comments in `test/`
and `.github/`, which came with the import. Observed in triage on #149: 18
comment lines in `test/` and 3 lines in `.github/` cited workspace issues as
bare numbers, and no issue's scope held them.

A count from the analyst's report is counted again in the file before it goes
into an issue body. Observed in triage on #98: the report counted two bare
`#82` in record 0023, and the record holds three.

An issue that sizes its work by a regex count says how many of the hits are
defects, after reading each hit. A count of matches is not a count of defects.
A table that maps old numbers to new ones applies only to the hits that read
as references of the old kind. Observed in triage on #149: a scan for bare
`#N` counted 157 hits in the imported pages and code, and 15 of them were
unqualified workspace references. The others already read "workspace #N", or
named this repository's own #2, #58 and #82. Applied to every bare `#58`, the
body's mapping table would also have rewritten this repository's own #58.

An issue that changes a rule that `wiki/schema.md` or `CLAUDE.md` states
quotes that rule, and names the open issues that apply it. A reason that the
issue gives for the change is checked against its source before triage.
Observed in triage on #149: the body proposed to write "workspace issue 81"
instead of "workspace #81", and did not name the "Issue references" rule of
`wiki/schema.md`, nor #98 and #99, which apply that rule. Its reason was that
GitHub links the `#81` in "workspace #81". GitHub does not autolink `#N` in a
repository file: its HTML rendering of record 0014 had no link there. The
coach dropped the proposal.

An issue that explains why a script misbehaves names the shell or tool, and
its version, under which the behaviour was seen. A reading that maps a tool's
exit codes to outcomes is checked against the tool's documentation or a probe.
Observed in triage on #155: the body said that `cd ""` succeeds, which holds
under bash 5.2.37. Under bash 5.3.15 it fails with `cd: null directory`. The
body also read the exit code 123 of GNU xargs as "no hit", while xargs returns
123 whenever any grep run exits 1 to 125, a file that grep cannot read
included.

An issue that raises `GVT_DEV_MIN_VERSION` names every place that states the
minimum or depends on it: the constant and its comment in
`plugin/cli/lib/plugin-path.mjs`, the `GVT_DEV_REF` pin in
`.github/workflows/ci.yml`, the R206 tests in `test/plugin-path.test.mjs`, the
pages of the command reference and `CLAUDE.md`. Find the texts with a search
for the current value in both forms: as written (`4.45.0`) and as a regex
literal in a test, with each dot escaped by a backslash. A `git grep -F` of the
written form misses the regex form. Read each hit: some tests use the value
only as a sample. The issue also names the `plugin/CHANGELOG.md` entry with its
**Consumers** note, and says whether the contract number changes. Observed in
triage on #158: the body named only the constant, while four command reference
pages, `CLAUDE.md`, seven R206 tests and the CI pin also state or depend on it.
Four of those tests hold the value only in its regex form, and the search
proposed in triage missed them.

An issue body cites an issue of another repository as `owner/name#N`
everywhere, in prose as well as on a dependency line. GitHub links a bare `#N`
in an issue body to this repository's issue `#N`. The reference grammar
reports nothing for a bare `#N` in a prose sentence, so its check of a draft
does not show the defect: read the draft for each bare `#N`. Observed in
triage on #158: the analyst's draft wrote `#895` in a bullet for
GenvidTechnologies/claude-code-plugin-gvt-dev#895. A probe of the grammar on
that bullet returned no reference.

## Splitting

Split when one issue bundles unrelated concerns, or when a single piece of work
spans parts that ship independently. Prefer **sub-issues** (a task-list of
checkboxes referencing new issues) when the parent is a tracking umbrella; prefer
**separate issues** when the parts share no parent. Keep the original as the
canonical/umbrella and move each split-out concern's detail into its own issue.

When new issues refer to each other, file first the one whose body has no
number to fill in. The others can then carry its number, and no issue needs an
edit after it is filed. Observed in the triage of #29: the split issue #30
named its workspace blocker in prose, so it went first, and the workspace
issue was filed with #30 already in its body.

## Duplicates

Policy: **link, do not auto-close.** For a duplicate cluster, choose the canonical
(usually the oldest with the best detail), add `duplicate` to the others, and
comment `Duplicate of #<canonical>` on each. Close a duplicate only with explicit
per-item approval.

### Fold into an open issue

Fold an issue into an open issue when it adds a step or a case to the work that
the open issue already plans, and the step cannot ship on its own. The open
issue takes the scope. The folded issue is closed. A fold differs from a
duplicate: the folded issue asks for something that the open issue does not
yet hold.

A fold takes the coach's approval, and runs in this order:

1. Edit the body of the open issue: add each step to its proposed change, say
   where it comes from (the folded issue's number and what was observed), and
   add an acceptance row for each step. Read the open issue's other steps
   against each new step, and propose a fix for any step that conflicts with
   it. Observed in the triage of #63: its step kept the worker's branch in
   step with `origin`, and #37's finish turn rebased that branch onto `main`
   after #37's own dispatch prompt had pushed it. A rebase of a pushed branch
   needs a force-push, so the coach changed the rebase to a merge of `main`.
2. Rewrite the body of the folded issue so that it stays readable after it is
   closed: private names in prose, and a first line that says it was folded
   into the open issue in triage on that date.
3. Add the category label.
4. Post a comment through the "Fold" recipe.
5. Close the folded issue as not planned.
6. Stamp it `triaged`.

The folded issue gets no road block and no class. Done in the triage of #51
and #52, and of #56 and #57: each pair was folded into #37, because the
wording it asked to change came from a prompt the coach wrote by hand, and
#37 adds the composed dispatch prompt. #63 was folded into #37 for the same
reason: the finish turn it asked to change came from a prompt the coach wrote
by hand.

When the folded issue reports the same events as the open issue, from another
worker's side, add its account to the Evidence of the open issue and name its
side. When the two accounts differ, keep both, say where they differ, and say
that only the transcripts can show which is exact. Do not pick one. Done in the
triage of #65, folded into #62: #65 reported line-level additions after the
version 3 message that #62 says ended the churn.

## Dependencies

Express a dependency with a comment on the blocked issue: `Blocked by #<id>`
(optionally `Blocks #<id>` on the other). For umbrellas, list dependencies as a
GitHub task-list under a `Depends on` heading.

An issue can leave a part of its work to another open issue. When an
acceptance row of the issue needs that part, the body says whether the issue
takes the part or waits for the other issue. Read each acceptance row against
each part that the body leaves to another issue. Observed on #38: the body said
that #22 adds the `checkedOutBranch` part of the leftover-branch check. The row
"reports each branch or worktree of the worker that is left" needs that part,
and so does the interactive row, because a worker can leave its side branch
checked out. The worker took the part, and left the choice to close #22 to the
coach.

An issue that waits for a release of another managed repository, not only for
an issue there, writes the wait as a line that starts with `Deferred until` and
names no issue, for example "Deferred until gvt-dev tags the release that ships
`possibleGates`". gvt-fleet reads a `Blocked by` line on a closed issue of a
managed repository as cleared, whether or not the release exists. A trigger
line that names no issue never fires, so gvt-fleet keeps the issue out of
`ready` until the line is removed. Keep the `Blocked by` line for the issue
too. Do not write "Not before": the gvt-dev grammar of v6.2.0 does not read it
as a trigger. The line says when to remove it. No check removes it, so the
issue stays out of `ready` until someone edits the body. Observed in triage on
#158: GenvidTechnologies/claude-code-plugin-gvt-dev#895 had closed, and the
newest gvt-dev tag was still v6.2.0, which does not ship the key the issue
reads.

## Mutation recipes

The exact commands the triage skill runs to apply **approved** changes. `{id}`,
`{type}`, `{otherTypes}`, `{canonical}`, `{other}`, `{title}`, `{tmpfile}`,
`{triagedLabel}`, `{needsInfoLabel}`, `{closeReason}`, and `{roadBlock}` are substituted by the skill. (There are
no `{p}`/`{a}` substitutions — this repo has no priority or area labels.)

When a recipe's set would be empty, omit its --remove-label flag.

{otherTypes} is the set of category labels, written out in full, with the label being added removed.

- Set category: `gh issue edit {id} --add-label "{type}" --remove-label "{otherTypes}"`
- Check a body before any write that posts it (Edit body, Comment, Create split issue): `grep -n -i -E '<pattern>' {tmpfile}`, where `<pattern>` is the `always` pattern of `.github/scripts/leak-guard.sh`. When the write also sets a title (Edit body with a new title, Create split issue), check the title too: `printf '%s\n' "{title}" | grep -n -i -E '<pattern>'`. Any output blocks the write. The leak guard reads only tracked files, so it never sees an issue title or body. Observed in the triage of #40: the body as filed named the private workspace issue and pull request, and the rewrite named them in prose. Observed in the triage of #45: the title as filed named the private workspace repository too, and the new title names the decision record only as the coordinator's. From a worktree-isolated session, read the pattern and run the grep from a script file written with the Write tool, run as `bash <literal path>`. A one-line command that read `.github/scripts/leak-guard.sh` and printed `$?` was refused as "names git in a form too complex to verify". Observed in the triage of #155.
- Edit body (language fix / fill missing info): `gh issue edit {id} --body-file {tmpfile}` — the skill writes the approved new body to `{tmpfile}` first
- Comment: `gh issue comment {id} --body-file {tmpfile}` — the skill writes the comment text to `{tmpfile}` first
- Flag missing info: `gh issue edit {id} --add-label {needsInfoLabel}` (i.e. `question`; pair with a Comment saying what's missing)
- Clear missing-info flag: `gh issue edit {id} --remove-label {needsInfoLabel}`
- Mark duplicate: `gh issue edit {id} --add-label duplicate` then `gh issue comment {id} --body "Duplicate of #{canonical}"`
- Close duplicate (only with approval): `gh issue close {id} --reason "not planned" --comment "Duplicate of #{canonical}"`
- Fold (only with approval): `gh issue comment {id} --body-file {tmpfile}`, then `gh issue close {id} --reason "not planned"`. The comment opens with `Folded into #{canonical} in triage on <date>.`, then says where the wording or the gap came from and which step of #{canonical} now holds it, and names any option of the folded issue that is not carried forward. Edit the body of #{canonical} first (see "Fold into an open issue" under Duplicates).
- Close as completed or not planned (only with approval): `gh issue close {id} --reason "{closeReason}"` — post the reason first through the Comment recipe; `{closeReason}` is `completed` or `not planned`
- Create split issue: `gh issue create --title "{title}" --body-file {tmpfile} --label "{type}"` — the skill writes the drafted split body to `{tmpfile}` first
- Link dependency: `gh issue comment {id} --body "Blocked by #{other}"`
- Set coordinator class: `node bin/gvt-fleet.mjs --json class {ref} {class}`, run at the root of the gvt-fleet workspace. `{ref}` is the issue's `owner/name#{id}`, and `{class}` is `now`, `next` or `later` in lowercase. For `now` or `next` the command adds the issue to the project when it is not in it, and puts its item in the current or the next iteration. For `later` it clears a Now or Next value; it does not add an issue to the project. It reads the value back, and writes the coordinator's cache when the readback agrees and `sync` has read the project. A result with `status` `noop` means that the issue already had the class. A result with `status` `refused` and exit 1 is a closed issue, a project with no Iteration field, or `now` or `next` when the project has no current or no next iteration.
- Set project Class, in three steps:
  1. Add the issue to the project: `gh project item-add 1 --owner GenvidTechnologies --url {url} --format json --jq .id`. The output is `{itemId}`. For an issue that is already in the project, read `{itemId}` from the `projectItems` of the issue instead: `gh api graphql -f query='query{repository(owner:"GenvidTechnologies",name:"claude-code-plugin-gvt-fleet"){issue(number:{id}){projectItems(first:5){nodes{id project{number}}}}}}'`, and take the `id` of the node whose `project.number` is 1. Run "Set coordinator class" first: for `now` or `next` it adds the issue to the project. Checked in the triage of #29.
  2. Look up the ids: `gh api graphql -f query='query{organization(login:"GenvidTechnologies"){projectV2(number:1){id field(name:"Class"){... on ProjectV2SingleSelectField{id options{id name}}}}}}'`. `{projectId}` is `projectV2.id`, `{fieldId}` is `field.id`, and `{optionId}` is the `id` of the option whose `name` is the class. Look the ids up on each run: rebuilding the options of the field gives new option ids.
  3. Set the field: `gh project item-edit --project-id {projectId} --id {itemId} --field-id {fieldId} --single-select-option-id {optionId}`. The command prints nothing on success.
- Read back the project Class: `gh api graphql -f query='query{repository(owner:"GenvidTechnologies",name:"claude-code-plugin-gvt-fleet"){issue(number:{id}){projectItems(first:5){nodes{project{title} fieldValueByName(name:"Class"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}'`
- Set road block: `node .claude/skills/groom-road-blocks/scripts/set.mjs --dir <work dir> --project GenvidTechnologies/1 "GenvidTechnologies/claude-code-plugin-gvt-fleet#{id}={roadBlock}"`, run at the root of the gvt-fleet workspace. `<work dir>` is a scratch folder for the script's files. `{roadBlock}` is the full name of an option of the `Road block` field, for example `G11 gvt-fleet coach covers the coordinator`. The script adds the issue to the project when it is not in it, sets the value, and reads it back. It prints `OK <option>` per issue, and exits 1 on `MISMATCH` or on a name that is not an option. Used in the triage of #58. From a worktree-isolated session, run it in the PowerShell tool as `Set-Location <workspace root>; node .claude/skills/groom-road-blocks/scripts/set.mjs …`, and read `$LASTEXITCODE`. That form ran in the triage of #62. The Bash form `cd <workspace root> && node …` was not tried there.
- Stamp triaged: `gh issue edit {id} --add-label {triagedLabel}`

Read the labels back after this edit: confirm the issue now carries exactly the intended labels before it is stamped triaged (use the tracker's read-one query, or the native issue view).
