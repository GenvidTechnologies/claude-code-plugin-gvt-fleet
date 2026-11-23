// A full command context for the dispatch and status tests: real git (origin, base clone, workspace),
// a config file, a state dir, and fakes at the gh and claude boundary. Everything lives under one real temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { taskKey } from '../../plugin/cli/lib/worker-key.mjs';
import { createFakeClaude } from '../fakes/fake-claude.mjs';
import { github } from './fake-github.mjs';
import { cloneOrigin, fwd, g, makeOrigin, makeTempDir } from './git-sandbox.mjs';

export const SELF_REMOTE = 'git@github.com:example-org/fleet-home.git';
export const NOW = new Date('2026-11-03T12:00:00.000Z');

/** Insert one lease row for a task key into an open ClaimsDb. `state` defaults to `held`, with an expiry in the future. */
export function seedTaskLease(claims, { repo, slug, date, n, state = 'held', expiresAt = '2099-01-01T00:00:00.000Z' }) {
  const key = taskKey(repo, { slug, date, n });
  claims.immediate(() =>
    claims.putLease({
      leaseId: `T-${slug}-${date}-${n}`,
      key,
      state,
      claimedAt: '2026-11-08T07:00:00.000Z',
      heartbeatAt: '2026-11-08T07:00:00.000Z',
      expiresAt,
      assigneePreexisting: null,
      labelAdded: null,
      sessionId: null,
      shortId: null,
      worktreePath: null,
    }),
  );
  return key;
}

/**
 * Build the sandbox. Options:
 * - `t`: test context; its `after` hook removes the folder. Without it, call `cleanup()`.
 * - `remote`: workspace `origin` URL; `null` leaves the workspace without a remote.
 * - `issues`, `failDelete`, `labelExists`, `extraAssignee`: passed to `github()`; default is issue 1 (any repo), labeled `triaged` and unassigned.
 * - `claudeScript`: passed to `createFakeClaude` (default `{ track: true }`).
 * Returns {root, ws, base, origin, sandbox, claudeJson, stateDir, configFile, github, gh, fake, clock, out, err, ctx, cleanup}.
 */
export async function dispatchSandbox({ t, remote = SELF_REMOTE, issues = { 1: { labels: ['triaged'], assignees: [] } }, failDelete = false, labelExists = true, extraAssignee = null, claudeScript = { track: true } } = {}) {
  const root = makeTempDir(t, 'gvt-fleet-dispatch-');
  const sandbox = await makeOrigin(path.join(root, 'o'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  await g(ws, 'init', '--initial-branch=main');
  if (remote !== null) await g(ws, 'remote', 'add', 'origin', remote);
  const base = path.join(ws, 'repos', 'acme', 'app');
  await cloneOrigin(sandbox, base);
  const claudeJson = path.join(root, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }), 'utf8');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const repos = [
    { repo: 'acme/app', defaultBranch: 'main' },
    { repo: 'example-org/fleet-home', defaultBranch: 'main' },
  ];
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos }), 'utf8');
  const gh = github({ issues, labelExists, failDelete, extraAssignee });
  const fake = createFakeClaude(claudeScript);
  const clock = { now: () => NOW, sleep: async () => {} };
  const out = [];
  const err = [];
  const ctx = {
    configFile,
    stateDir,
    json: false,
    repoRoot: ws,
    paths: { workspace: ws, claudeJson },
    gh: gh.gh,
    claude: fake,
    clock,
    cloneUrlOf: () => fwd(sandbox.origin),
    findHolders: async () => ({ source: 'stub', holders: [] }),
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    log: { append: () => {} },
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { root, ws, base, origin: sandbox.origin, sandbox, claudeJson, stateDir, configFile, github: gh, gh: gh.gh, fake, clock, out, err, ctx, cleanup };
}
