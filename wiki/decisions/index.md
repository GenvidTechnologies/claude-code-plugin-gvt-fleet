# Decision Records

The decision records of this plugin and of the gvt-fleet CLI that it ships, in MADR-lite format. Each record is a wiki page (`type: decision-context`). `.gvt-agent.json` points `paths['docs/decisions/']` at this folder, so `/gvt-dev:create-adr` writes new records here. Do not hand-number files. The [wiki index](../index.md) links this list.

**Template:** the MADR-lite template is bundled in the `gvt-dev` plugin at `plugin/docs/decision-record.template.md`. `gvt-dev:tech-writer` fills it.

**Numbers and titles:** each record opens with frontmatter. Its body heading `# NNNN. Title` keeps the number, and its frontmatter `title` is the same text without the `NNNN. ` prefix.

**Retroactive records:** a record may be backfilled retroactively. Its number reflects chronological *decision* order, not authorship order. Such a record distinguishes **Originally decided** (derived from git history) from **Recorded** (when the file was written), so readers don't mistake the write date for the decision date.

**Issue references:** records 0001 to 0023 were written in the private repository of the fleet workspace, where the CLI was developed until 0023 moved it here (#82). They keep their numbers. In those records, "workspace #N" and "the workspace repository's #N" cite an issue of that repository, a bare `#N` cites an issue of this repository, and "this repository" and "here" mean the workspace repository, unless the text names another one. The names of the private organization and its repositories were replaced by descriptions before the move. Record 0024 was this plugin's 0001 before the import; it and later records cite issues of this repository.

## Records

- [0001](0001-coordinator-cache-computed-readiness.md) - Coordinator keeps a raw issue cache and computes the graph and ready set per command
- [0002](0002-ship-gvt-loop-as-separate-plugin.md) - Ship gvt-loop as a separate plugin that depends on gvt-dev
- [0003](0003-register-session-hooks-at-user-scope.md) - Register the session hooks at user scope until the gvt-loop plugin exists
- [0004](0004-shared-session-liveness-rule.md) - Share one session liveness rule across status, dispatch, expire and observe
- [0005](0005-prove-the-merge-at-wrap-up-and-record-the-pushed-branch.md) - Prove the merge at wrap-up and record the pushed branch (amended by 0011)
- [0006](0006-ship-the-coach-skill-in-the-gvt-fleet-plugin.md) - Ship the coach skill in the gvt-fleet plugin from its own public repository (amended by 0019)
- [0007](0007-resolve-idle-prompt-detail-in-the-reader.md) - Resolve the idle prompt detail in the reader
- [0008](0008-add-coach-keys-without-a-new-contract-number.md) - Add coach keys without a new contract number
- [0009](0009-notify-the-coach-from-a-watch-command.md) - Notify the coach from a watch command
- [0010](0010-store-the-issue-class-as-github-labels.md) - Store the issue class as GitHub labels
- [0011](0011-prove-the-issues-work-and-wrap-up-in-one-command.md) - Prove the issue's work and wrap up in one command
- [0012](0012-run-task-workers-without-an-issue.md) - Run task workers without an issue
- [0013](0013-retry-a-busy-worktree-removal-in-place.md) - Retry a busy worktree removal in place
- [0014](0014-judge-nothing-to-lose-by-any-remote-and-read-closing-prs-live.md) - Judge nothing to lose by any remote branch and read closing pull requests live
- [0015](0015-derive-the-class-from-the-project-iteration-field.md) - Derive the class from the project Iteration field
- [0016](0016-wrap-on-a-nothing-to-lose-proof-when-no-pull-request-closes-the-issue.md) - Wrap on a nothing-to-lose proof when no pull request closes the issue
- [0017](0017-show-an-askuserquestion-wait-from-a-pretooluse-record.md) - Show an AskUserQuestion wait from a PreToolUse record
- [0018](0018-find-a-class-item-from-the-project-side-when-the-issue-side-misses-it.md) - Find a class item from the project side when the issue side misses it
- [0019](0019-ship-the-gvt-fleet-cli-inside-the-gvt-fleet-plugin.md) - Ship the gvt-fleet CLI inside the gvt-fleet plugin (source part superseded by 0023)
- [0020](0020-require-an-installed-gvt-dev-of-a-minimum-version-for-the-grammar.md) - Require an installed gvt-dev of a minimum version for the grammar
- [0021](0021-find-the-workspace-and-switch-the-hooks-to-the-plugin.md) - Find the workspace and switch the hooks to the plugin (release copy superseded by 0023)
- [0022](0022-record-the-now-iteration-so-a-project-can-promote-more-than-once-a-day.md) - Record the Now iteration so a project can promote more than once a day
- [0023](0023-move-the-gvt-fleet-cli-source-into-the-plugin-repository.md) - Move the gvt-fleet CLI source into the plugin repository
- [0024](0024-run-the-triage-pass-in-the-coach-session.md) - Run the triage pass in the coach session (was 0001 of this plugin): the coach skill runs the triage pass in the coach session, one repository at a time from its base clone, with a wrong-repository guard, no file writes and the coach approving each change.
