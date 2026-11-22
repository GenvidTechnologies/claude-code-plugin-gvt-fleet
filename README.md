# claude-code-plugin-gvt-fleet

The **`gvt-fleet` plugin** for Claude Code. It provides one skill, `/gvt-fleet:coach`, the coach's entry point for the gvt-fleet multi-repo coordinator.

The skill reads issues from the managed repositories through the coordinator. It shows the workers that need the coach, the Now issues, the untriaged issues of each repository, and how many Next issues each repository has. While workers run, it keeps a watch on them, so a worker that starts to wait reaches the coach as an event. It offers a triage pass over the repositories the coach picks. It lists the issues of one class, or moves an issue to another class, when the coach asks. It dispatches an issue to a worker on request, or starts a task worker, a worker with no issue, in a repository the coach names. When the coach gives no prompt for an issue, the dispatch passes a composed prompt for one integration branch per worker: the worker opens a side pull request into its worktree branch for each piece of work, the retro included, and reports each ready one at the end of its last message, which the watch shows. The user merges each side pull request. When the coach asks, the worker does a finish turn: it merges `main`, re-checks the acceptance criteria, lists the follow-ups and opens one final pull request into `main`, which the coach merges. A prompt the coach gives is passed as it is. The overview lists task workers with the issue workers. It wraps up a worker or a task that has finished; a task needs no merged pull request.

The plugin is distributed through the [`claude-code-gvt-marketplace`](https://github.com/GenvidTechnologies/claude-code-gvt-marketplace) catalog (marketplace name `gvt-plugins`).

## Requirements

- The skill runs only in a session started at the root of a gvt-fleet workspace. It reaches the coordinator through `${CLAUDE_PROJECT_DIR}`.
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
