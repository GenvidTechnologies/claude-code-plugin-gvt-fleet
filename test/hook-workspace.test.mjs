process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './helpers/run-script.mjs';
import { workspaceCandidates } from '../plugin/cli/lib/worktree-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'plugin', 'cli', 'bin', 'gvt-fleet-hook.mjs');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-hook-ws-'));
const fwd = (p) => p.split(path.sep).join('/');

function makeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'repos.json'), JSON.stringify({ version: 1, repos: [{ repo: 'acme/app' }] }));
  return dir;
}

const worktreeOf = (ws, name = 'app-1') => {
  const wt = path.join(ws, 'repos', 'acme', 'app', '.claude', 'worktrees', name);
  fs.mkdirSync(wt, { recursive: true });
  return wt;
};

const payload = (cwd) => ({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd, source: 'startup' });

/** Runs the hook as the plugin's hooks.json does: no --workspace. */
const runPluginHook = (p, args = []) => runScript(HOOK, args, { input: JSON.stringify(p) });

const recordsIn = (stateDir, worktree = 'app-1') => {
  const f = path.join(stateDir, 'workers', 'acme', 'app', `${worktree}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
};

test('R208: workspaceCandidates lists each <W> above repos/<o>/<r>/.claude/worktrees/<n>, innermost first', () => {
  assert.deepEqual(workspaceCandidates('C:\\work\\fleet\\repos\\acme\\app\\.claude\\worktrees\\app-1'), ['C:/work/fleet']);
  assert.deepEqual(workspaceCandidates('c:/work/fleet/repos/acme/app/.claude/worktrees/app-1/src/x'), ['C:/work/fleet']);
  const nested = 'C:/w/repos/acme/fleet/.claude/worktrees/fleet-2/repos/acme/app/.claude/worktrees/app-1';
  assert.deepEqual(workspaceCandidates(nested), ['C:/w/repos/acme/fleet/.claude/worktrees/fleet-2', 'C:/w']);
  assert.deepEqual(workspaceCandidates('/home/someone/fleet/repos/acme/app/.claude/worktrees/app-1'), ['/home/someone/fleet']);
});

test('R208: workspaceCandidates is empty for a base clone, a workspace root, a dot segment or no string', () => {
  assert.deepEqual(workspaceCandidates('C:/work/fleet/repos/acme/app'), []);
  assert.deepEqual(workspaceCandidates('C:/work/fleet/repos/acme/app/.claude/worktrees'), []);
  assert.deepEqual(workspaceCandidates('C:/work/fleet'), []);
  assert.deepEqual(workspaceCandidates('C:/work/fleet/repos/acme/app/.claude/worktrees/app-1/../../x'), []);
  assert.deepEqual(workspaceCandidates(''), []);
  assert.deepEqual(workspaceCandidates(undefined), []);
});

test('R208: without --workspace the hook records a worktree session under <W>/state', async () => {
  const ws = makeWorkspace(tmp());
  const wt = worktreeOf(ws);
  const r = await runPluginHook(payload(fwd(wt)));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 0);
  const recs = recordsIn(path.join(ws, 'state'));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].event, 'SessionStart');
  assert.equal(recs[0].repo, 'acme/app');
  assert.equal(recs[0].issue, 'acme/app#1');
});

test('R208: without --workspace the hook writes nothing when <W>/config/repos.json is missing', async () => {
  const ws = tmp();
  const wt = worktreeOf(ws);
  const r = await runPluginHook(payload(fwd(wt)));
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(ws, 'state')), false);
  assert.deepEqual(fs.readdirSync(ws), ['repos']);
});

test('R208: without --workspace the hook ignores a session outside the worktree shape', async () => {
  const ws = makeWorkspace(tmp());
  fs.mkdirSync(path.join(ws, 'repos', 'acme', 'app'), { recursive: true });
  for (const cwd of [ws, path.join(ws, 'repos', 'acme', 'app')]) {
    const r = await runPluginHook(payload(fwd(cwd)));
    assert.equal(r.code, 0);
  }
  assert.equal(fs.existsSync(path.join(ws, 'state')), false);
});

test('R208: without --workspace the innermost workspace that holds a config gets the record', async () => {
  const outer = makeWorkspace(tmp());
  const inner = makeWorkspace(path.join(outer, 'repos', 'acme', 'fleet', '.claude', 'worktrees', 'fleet-2'));
  const wt = worktreeOf(inner, 'app-3');
  const r = await runPluginHook(payload(fwd(wt)));
  assert.equal(r.code, 0);
  assert.equal(recordsIn(path.join(inner, 'state'), 'app-3').length, 1);
  assert.equal(fs.existsSync(path.join(outer, 'state')), false);
});

test('R208: without --workspace an inner candidate with no config falls through to the outer workspace', async () => {
  const outer = makeWorkspace(tmp());
  const inner = path.join(outer, 'repos', 'acme', 'fleet', '.claude', 'worktrees', 'fleet-2');
  const wt = worktreeOf(inner, 'app-4');
  const r = await runPluginHook(payload(fwd(wt)));
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(inner, 'state')), false);
  // In the outer workspace the session is a worktree of acme/fleet, named fleet-2.
  const f = path.join(outer, 'state', 'workers', 'acme', 'fleet', 'fleet-2.jsonl');
  assert.ok(fs.existsSync(f), 'the outer workspace records the session');
});

test('R208: --state-dir without --workspace sends the record to that folder', async () => {
  const ws = makeWorkspace(tmp());
  const wt = worktreeOf(ws);
  const stateDir = path.join(tmp(), 'elsewhere');
  const r = await runPluginHook(payload(fwd(wt)), ['--state-dir', stateDir]);
  assert.equal(r.code, 0);
  assert.equal(recordsIn(stateDir).length, 1);
  assert.equal(fs.existsSync(path.join(ws, 'state')), false);
});
