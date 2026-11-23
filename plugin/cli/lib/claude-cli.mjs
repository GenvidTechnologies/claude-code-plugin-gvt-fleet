// Wrapper over the `claude` CLI's background-session commands.

/** The argv (after `claude`) that starts a background session in a new worktree. */
export function bgArgv({ name, prompt, model, permissionMode }) {
  const argv = ['--bg', '-w', name, '-n', name];
  if (model) argv.push('--model', model);
  if (permissionMode) argv.push('--permission-mode', permissionMode);
  if (prompt !== undefined && prompt !== null && prompt !== '') argv.push(prompt);
  return argv;
}

/** Time limit of one `claude agents` call, in ms. One call measured about 0.5 to 1.1 s. */
export const AGENTS_TIMEOUT_MS = 30000;

export function createClaude({ run, agentsTimeoutMs = AGENTS_TIMEOUT_MS }) {
  async function ok(argv, opts) {
    const res = await run(['claude', ...argv], opts);
    if (res.code !== 0) {
      throw new Error(`claude ${argv[0]} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res;
  }

  return {
    /** Start a background session in a new worktree. Returns {stdout}. */
    async startBg({ cwd, name, prompt, model, permissionMode }) {
      const res = await ok(bgArgv({ name, prompt, model, permissionMode }), { cwd });
      // The printed format is not pinned. `id` is a hint (the first 8-hex token); callers confirm by name in `agents`.
      return { stdout: res.stdout, id: /\b([0-9a-f]{8})\b/.exec(res.stdout)?.[1] ?? null };
    },
    /**
     * List sessions: array of {id, cwd, kind, sessionId, name, state, ...}.
     * A call that passes the time limit (`agentsTimeoutMs`) throws like any other failure.
     */
    async agents({ all = false } = {}) {
      const res = await ok(['agents', '--json', ...(all ? ['--all'] : [])], { timeoutMs: agentsTimeoutMs });
      const list = JSON.parse(res.stdout);
      if (!Array.isArray(list)) throw new Error('claude agents --json: expected a JSON array');
      return list;
    },
    async stop(id) {
      return ok(['stop', id]);
    },
    /**
     * Remove a session and its worktree. The two options take the value that a
     * previous `claude rm <id>` reported (`<commit>@<worktree-id>` and `<worktree-id>`).
     * A non-zero exit is returned, not thrown, so callers can read the reported values.
     */
    async rm(id, { forceRemoveWorktree, discardUnpushed } = {}) {
      const argv = ['rm', id];
      if (discardUnpushed) argv.push('--discard-unpushed', discardUnpushed);
      if (forceRemoveWorktree) argv.push('--force-remove-worktree', forceRemoveWorktree);
      return run(['claude', ...argv], {});
    },
  };
}
