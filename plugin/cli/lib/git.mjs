// Thin wrapper over the process runner for local git.

export function createGit({ run }) {
  /** Run git with args. Returns {code, stdout, stderr}; does not throw on non-zero. */
  function git(args, { cwd, env, input, timeoutMs } = {}) {
    return run(['git', ...args], { cwd, env, input, timeoutMs });
  }
  /** Run git and return trimmed stdout; throws on non-zero. */
  async function out(args, opts) {
    const res = await git(args, opts);
    if (res.code !== 0) throw new Error(`git ${args[0]} failed (${res.code}): ${res.stderr.trim()}`);
    return res.stdout.trim();
  }
  return { run: git, out };
}
