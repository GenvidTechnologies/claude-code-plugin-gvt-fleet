process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cloneCommand, trustCommand } from '../lib/commands.mjs';
import { createLog } from '../lib/log.mjs';
import { fwd, g, makeOrigin, makeTempDir } from './helpers/git-sandbox.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

function makeCtx(t, { repos = [{ repo: 'o/n', enabled: true, defaultBranch: 'main' }] } = {}) {
  const root = makeTempDir(t, 'gvt-fleet-cli-');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  const configFile = path.join(root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos }), 'utf8');
  const claudeJson = path.join(root, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }, null, 2) + '\n', 'utf8');
  const stateDir = path.join(root, 'state');
  const outs = [];
  const errs = [];
  const ctx = {
    root, repoRoot: workspace, configFile, stateDir, json: false,
    log: createLog(stateDir),
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    paths: { workspace, claudeJson },
    clock: { now: () => new Date(), sleep: async () => {} },
  };
  return { ctx, outs, errs, workspace, claudeJson, root };
}

test('R20: clone command clones the enabled repo from the injected url and exits 0', async (t) => {
  const s = makeCtx(t);
  const sandbox = await makeOrigin(makeTempDir(t, 'gvt-fleet-origin-'));
  s.ctx.cloneUrlOf = () => fwd(sandbox.origin);
  const code = await cloneCommand(s.ctx, []);
  assert.equal(code, 0);
  assert.deepEqual(s.outs, ['o/n: cloned']);
  assert.equal(await g(path.join(s.workspace, 'repos', 'o', 'n'), 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('R20: clone command rejects a repo that is not in the config with exit 64', async (t) => {
  const s = makeCtx(t);
  assert.equal(await cloneCommand(s.ctx, ['x/y']), 64);
  assert.equal(fs.existsSync(path.join(s.workspace, 'repos')), false);
});

test('R20: clone command exits non-zero and still reports when the default branch is unknown', async (t) => {
  const s = makeCtx(t, { repos: [{ repo: 'o/n', enabled: true }] });
  s.ctx.json = true;
  const code = await cloneCommand(s.ctx, []);
  assert.equal(code, 1);
  const parsed = JSON.parse(s.outs.join(''));
  assert.equal(parsed[0].status, 'failed');
  assert.match(s.errs.join('\n'), /default branch unknown/);
});

test('R21: trust command refuses a path outside the workspace with exit 2 and writes nothing', async (t) => {
  const s = makeCtx(t);
  const outside = path.join(s.root, 'elsewhere');
  fs.mkdirSync(outside);
  const before = fs.readFileSync(s.claudeJson, 'utf8');
  assert.equal(await trustCommand(s.ctx, [outside]), 2);
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), before);
});

test('R21: trust command writes the entry for a path inside the workspace and exits 0', async (t) => {
  const s = makeCtx(t);
  const inside = path.join(s.workspace, 'repos', 'o', 'n');
  fs.mkdirSync(inside, { recursive: true });
  assert.equal(await trustCommand(s.ctx, [inside]), 0);
  const projects = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects;
  const keys = Object.keys(projects);
  assert.equal(keys.length, 1);
  assert.equal(projects[keys[0]].hasTrustDialogAccepted, true);
});
