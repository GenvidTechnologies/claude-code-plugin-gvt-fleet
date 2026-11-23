// The git sandbox for the worktree tests: a real origin, a base clone, a claims database with one held lease and a fake claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClaimsDb } from '../../lib/claims-db.mjs';
import { createFakeClaude } from '../fakes/fake-claude.mjs';
import { createFakeGh } from '../fakes/fake-gh.mjs';
import {
  addNestedWorktree,
  cloneOrigin,
  commitFile,
  fwd,
  g,
  git,
  makeOrigin,
  makeTempDir,
} from './git-sandbox.mjs';

export const KEY = 'acme/app#1';
export const BRANCH = 'worktree-app-1';
export const SESSION_ID = 'abcd1234-0000-4000-8000-000000000000';
export const OK = { code: 0, stdout: '', stderr: '' };
export const NOW = new Date('2026-11-03T12:00:00.000Z');
export const PULLS_KEY = 'GET repos/acme/app/pulls?head=acme%3Aworktree-app-1&state=all&per_page=100';
/** The fake-gh key of the pulls-by-commit lookup in the `acme/app` repository. */
export const COMMITS_KEY = (sha) => `GET repos/acme/app/commits/${sha}/pulls?per_page=100`;

export const REPOS = (s) => path.join(s.ws, 'repos');

/**
 * Real git: an origin, a base clone at <ws>/repos/acme/app and a claims database with one held lease.
 * The fake claude tracks sessions; `makeScript(s)` adds per-test behaviour (for example an `rm` that
 * performs the git side effect it simulates).
 */
export async function setup(t, { makeScript = () => ({}), lease = {}, ghScript = { [PULLS_KEY]: { data: [] } } } = {}) {
  const root = makeTempDir(t, 'gvt-fleet-wt-');
  const sandbox = await makeOrigin(path.join(root, 'o'));
  const ws = path.join(root, 'ws');
  const base = path.join(ws, 'repos', 'acme', 'app');
  await cloneOrigin(sandbox, base);
  const claudeJson = path.join(root, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }), 'utf8');
  // The database folder is removed together with the connection, so it is not left open on Windows.
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-wt-state-'));
  const claims = await openClaimsDb(path.join(stateDir, 'claims.db'));
  t.after(() => {
    claims.close();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  claims.immediate(() => claims.putLease({ leaseId: 'L1', key: KEY, state: 'held', claimedAt: NOW.toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', ...lease }));
  const s = { root, sandbox, ws, base, claims, stateDir, claudeJson, wt: path.join(base, '.claude', 'worktrees', 'app-1'), sleeps: [], holderCalls: [] };
  s.fake = createFakeClaude({ track: true, ...makeScript(s) });
  s.gh = createFakeGh(ghScript);
  s.deps = {
    git,
    claude: s.fake,
    gh: s.gh,
    now: () => NOW,
    sleep: async (ms) => {
      s.sleeps.push(ms);
    },
    findHolders: async (folder) => {
      s.holderCalls.push(folder);
      return { source: 'stub', holders: [{ process: 'Code.exe', pid: 42 }] };
    },
  };
  s.trust = { claudeJson, workspace: ws, stateDir, sleep: async () => {} };
  return s;
}

/** A worktree for app#1 as claude would leave it, with its session listed. */
export async function addWorktree(s, { commit = false, push = false, state = 'working' } = {}) {
  await addNestedWorktree(s.base, 'app-1', BRANCH);
  if (commit) await commitFile(s.wt, 'work.txt', 'work\n');
  if (push) await g(s.wt, 'push', '-u', 'origin', BRANCH);
  s.fake.sessions.push({ id: 'abcd1234', sessionId: SESSION_ID, name: 'app-1', cwd: s.wt, kind: 'background', state });
  s.claims.immediate(() =>
    s.claims.updateLease('L1', { sessionId: SESSION_ID, shortId: 'abcd1234', worktreePath: s.wt, branch: BRANCH, wtState: 'created' }),
  );
}

/** The `claude rm` that succeeds: it removes the worktree and its branch, then the session. */
export const rmFully = (s) => async () => {
  await g(s.base, 'worktree', 'remove', '--force', fwd(s.wt));
  await g(s.base, 'branch', '-D', BRANCH);
  s.fake.sessions.length = 0;
  return OK;
};
