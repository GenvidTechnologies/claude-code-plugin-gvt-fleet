// Decides whether a hook payload's cwd is inside a worktree that this workspace manages.
//
// This code runs in every Claude Code session on the machine, so it must stay pure: node built-ins
// only, no I/O, no config reads. It must also agree with names() in ./worktrees.mjs, the only
// builder of a worktree path: <workspace>/repos/<owner>/<repoName>/.claude/worktrees/<repoName>-<N>.
import path from 'node:path';

const split = (p) => p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Forward slashes, uppercase drive letter, no trailing slash. */
function normalizeKey(real) {
  const key = real.replace(/\\/g, '/').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
  return key.replace(/\/+$/, '');
}

/**
 * Returns null when `cwd` is not at or below a worktree root under `<workspace>/repos/`.
 * Otherwise returns { owner, repoName, worktree, repo, issue, worktreeRoot }. `issue` is
 * `owner/repoName#N` when the worktree is named `<repoName>-<N>`, else null.
 */
export function parseWorktreeCwd(cwd, workspace) {
  if (typeof cwd !== 'string' || cwd === '' || typeof workspace !== 'string' || workspace === '') return null;
  const c = split(cwd);
  // A '.' or '..' segment can climb out of the managed tree when the path is joined later.
  if (c.some((s) => s === '.' || s === '..')) return null;
  const w = split(workspace);
  if (w.length === 0) return null;
  const head = [...w, 'repos'];
  if (c.length < head.length + 5) return null;
  for (let i = 0; i < head.length; i++) {
    if (c[i].toLowerCase() !== head[i].toLowerCase()) return null;
  }
  const [owner, repoName, dot, wts, worktree] = c.slice(head.length, head.length + 5);
  if (dot.toLowerCase() !== '.claude' || wts.toLowerCase() !== 'worktrees') return null;
  const m = new RegExp(`^${escapeRegExp(repoName)}-([1-9][0-9]*)$`, 'i').exec(worktree);
  const repo = `${owner}/${repoName}`;
  const rootParts = c.slice(0, head.length + 5);
  // A leading separator in cwd (a POSIX-style path) is kept by joining with '/'.
  const lead = /^[\\/]/.test(cwd) ? '/' : '';
  return {
    owner,
    repoName,
    worktree,
    repo,
    issue: m ? `${repo}#${m[1]}` : null,
    worktreeRoot: normalizeKey(lead + rootParts.join('/')),
  };
}

/**
 * The workspaces that `cwd` could be a worktree of, innermost first (ADR 0021): each `<W>` such that
 * `cwd` is at or below `<W>/repos/<owner>/<repo>/.claude/worktrees/<name>`. Pure: the caller checks
 * that a candidate holds config/repos.json. Returns [] for a path with a '.' or '..' segment.
 */
export function workspaceCandidates(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  const c = split(cwd);
  if (c.some((s) => s === '.' || s === '..')) return [];
  const lead = /^[\\/]/.test(cwd) ? '/' : '';
  const out = [];
  for (let i = c.length - 6; i >= 1; i -= 1) {
    if (c[i].toLowerCase() !== 'repos') continue;
    if (c[i + 3].toLowerCase() !== '.claude' || c[i + 4].toLowerCase() !== 'worktrees') continue;
    out.push(normalizeKey(lead + c.slice(0, i).join('/')));
  }
  return out;
}

/** Finds the workspace and state folder from the hook's argv, else from the script location. No I/O. */
export function resolveWorkspace({ argv = [], scriptPath }) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null;
  };
  const given = flag('--workspace');
  const workspace = given ? path.resolve(given) : path.resolve(path.dirname(scriptPath), '..');
  const stateGiven = flag('--state-dir');
  const stateDir = stateGiven ? path.resolve(stateGiven) : path.join(workspace, 'state');
  return { workspace, stateDir };
}
