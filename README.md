# claude-code-plugin-gvt-fleet

The **`gvt-fleet` plugin** for Claude Code. It provides one skill, `/gvt-fleet:coach`, the coach's entry point for the gvt-fleet multi-repo coordinator.

The skill reads issues from the managed repositories through the coordinator. It shows the workers that need the coach, the Now issues, the untriaged issues of each repository, and how many Next issues each repository has. While workers run, or wait between their turns with their claim held, it keeps a watch on them, so a worker that starts to wait reaches the coach as an event. It offers a triage pass over the repositories the coach picks. It lists the issues of one class, or moves an issue to another class, when the coach asks. It dispatches an issue to a worker on request, or starts a task worker, a worker with no issue, in a repository the coach names. Before each dispatch, it looks for the links that triage left between the issue and the issues of the running workers or of the other issues named for dispatch: `Relates to` lines, "plan with" or "plan as one change" notes, and a shared parent issue. For a linked group, it dispatches nothing until the coach gives the whole group to one worker or writes an ownership list. The list names the owner of each file, of each part of a shared file, and of each shared item such as the decision record, and goes into the prompt of each worker of the group with a version number. The coach sends a later version to the running workers, and it replaces every earlier one. When the coach gives no prompt for an issue, the dispatch passes a composed prompt for one integration branch per worker: the worker opens a side pull request into its worktree branch for each piece of work, polls it in a background command, and reports each ready one at the end of its last message, which the watch shows. The user merges each side pull request. The worker's poll wakes it at the merge, and when the user tells the coach that a side pull request merged, the skill also sends the worker a message. When the issue is done, the worker runs the retro and opens a side pull request with the proposals the user approves, then waits. When the coach asks, the worker does a finish turn: it merges `main`, re-checks the acceptance criteria, lists the follow-ups, checks that the retro is done and opens one final pull request into `main`, which the coach merges. A prompt the coach gives is passed as it is. The overview lists task workers with the issue workers. It wraps up a worker or a task that has finished; a task needs no merged pull request. After every wrap, it reports each branch or worktree that the worker left, and deletes none. After a wrap that passed, it offers to check which of the worker's branches are still on the remote, to file each follow-up that the finish turn listed as an issue, with the coach's yes for each one, and, when the merge landed in the workspace's own repository, to pull the main checkout.

The plugin is distributed through the [`claude-code-gvt-marketplace`](https://github.com/GenvidTechnologies/claude-code-gvt-marketplace) catalog (marketplace name `gvt-plugins`).

## Requirements

- The skill runs only in a session started at the root of a gvt-fleet workspace. It runs the coordinator CLI that the plugin ships, in its `cli/` folder, on the workspace in `${CLAUDE_PROJECT_DIR}`.
- The plugin depends on the `gvt-dev` plugin. Install `gvt-dev` first.

## Install

```text
/plugin marketplace add https://github.com/GenvidTechnologies/claude-code-gvt-marketplace.git
/plugin install gvt-fleet@gvt-plugins
```

Enable the plugin at user scope.

## Load for development

Clone this repository and start Claude Code with the plugin folder:

```text
claude --plugin-dir <clone>/plugin
```

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) for the layout, the conventions and the validation command.

## License

MIT-0. See [`LICENSE`](LICENSE).
