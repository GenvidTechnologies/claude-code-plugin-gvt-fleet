# Command reference pages

One page per command group. The entry page is [gvt-fleet command reference](../coordinator.md): usage, global flags, exit codes, where state lives, the workflows, recovery and safety.

* [Commands: reading](reading.md) - The read commands: check-config, sync, ready and why.
* [Commands: claims](claims.md) - The claim commands: claim, release, heartbeat and expire.
* [Commands: classes and iterations](classes.md) - The class command, which puts an issue in the Now, Next or Later class through the project Iteration field, and the iteration commands, which plan iterations and start the next one.
* [Commands: branches](branches.md) - The branch commands: branches lists the branches that no issue owns, and branch set records what to do with one.
* [Commands: base clones and trust](base-clones-and-trust.md) - The clone command, which makes or updates the base clones, and the trust command, which writes Claude Code trust entries.
* [Commands: session state](session-state.md) - The install-hooks command, which registers the session hooks and the status line at user scope.
* [Commands: worktrees](worktrees.md) - The worktree commands: worktree create, worktree remove, worktree finish and wrap.
* [Commands: workers](workers.md) - The live worker rule and the worker commands: dispatch, status and watch.
* [The coach skill contract](coach-skill-contract.md) - The JSON keys that the coach skill reads from the CLI, the contract number, and when each key is present.
* [Moving from the gvt-loop names](moving-from-gvt-loop-names.md) - The steps to move a machine from the gvt-loop names to the gvt-fleet names.
* [Moving the CLI into the plugin](moving-the-cli-into-the-plugin.md) - The release and machine steps that move the hooks, the status line and the coach skill to the CLI copy that the gvt-fleet plugin ships.
