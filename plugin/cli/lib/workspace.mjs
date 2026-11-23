// Finds the workspace that a CLI run works on (ADR 0021).
//
// A workspace is a folder that holds config/repos.json. The CLI no longer takes it from its own
// location alone, so that one copy of the CLI (the one the gvt-fleet plugin ships) can serve any
// workspace.
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = path.join('config', 'repos.json');

/** True when `dir` holds config/repos.json as a file. */
export function isWorkspace(dir) {
  try {
    return fs.statSync(path.join(dir, CONFIG)).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns { workspace, rule } or null when no workspace is found. The first rule that matches wins:
 * 1. `flag`, the value of --workspace, used as given ('flag');
 * 2. `cliRoot`, the folder above the CLI's own bin/, when it is a workspace ('cli');
 * 3. the outermost folder at or above `cwd` that is a workspace ('cwd'). Outermost, because a base
 *    clone or worktree of the workspace's own repository holds a config/repos.json too.
 */
export function findWorkspace({ flag = null, cliRoot = null, cwd = process.cwd(), test = isWorkspace } = {}) {
  if (typeof flag === 'string' && flag !== '') return { workspace: path.resolve(flag), rule: 'flag' };
  if (typeof cliRoot === 'string' && cliRoot !== '' && test(cliRoot)) return { workspace: path.resolve(cliRoot), rule: 'cli' };
  let found = null;
  let dir = path.resolve(cwd);
  for (;;) {
    if (test(dir)) found = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found === null ? null : { workspace: found, rule: 'cwd' };
}
