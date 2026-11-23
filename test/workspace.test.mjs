process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findWorkspace, isWorkspace } from '../plugin/cli/lib/workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-ws-'));

/** Makes `dir` a workspace whose config lists `repos` (one entry per name). */
function makeWorkspace(dir, repos = ['acme/app']) {
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'repos.json'), JSON.stringify({ version: 1, repos: repos.map((repo) => ({ repo })) }));
  return dir;
}

/** A workspace W with a managed worktree inside it that holds its own config, as a worktree of the workspace repo does. */
function nested() {
  const ws = makeWorkspace(tmp(), ['acme/one', 'acme/two']);
  const wt = makeWorkspace(path.join(ws, 'repos', 'acme', 'fleet', '.claude', 'worktrees', 'fleet-7'), ['acme/one']);
  const deep = path.join(wt, 'lib');
  fs.mkdirSync(deep, { recursive: true });
  return { ws, wt, deep };
}

/** A copy of bin/ and lib/ in a folder that is not a workspace, as the plugin ships it. */
function pluginCopy() {
  const dir = tmp();
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'cli', 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'cli', 'lib'), { recursive: true });
  return path.join(dir, 'cli', 'bin', 'gvt-fleet.mjs');
}

const run = (bin, args, cwd) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GVT_FLEET_FAKE_ONLY: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('R207: isWorkspace is true only for a folder whose config/repos.json is a file', () => {
  const ws = makeWorkspace(tmp());
  assert.equal(isWorkspace(ws), true);
  const dirConfig = tmp();
  fs.mkdirSync(path.join(dirConfig, 'config', 'repos.json'), { recursive: true });
  assert.equal(isWorkspace(dirConfig), false);
  assert.equal(isWorkspace(tmp()), false);
});

test('R207: --workspace wins over the CLI folder and the current folder', () => {
  const { ws, deep } = nested();
  const other = tmp();
  assert.deepEqual(findWorkspace({ flag: other, cliRoot: ws, cwd: deep }), { workspace: path.resolve(other), rule: 'flag' });
});

test('R207: the CLI folder wins when it is a workspace, whatever the current folder', () => {
  const { ws, wt } = nested();
  const elsewhere = makeWorkspace(tmp());
  assert.deepEqual(findWorkspace({ cliRoot: wt, cwd: elsewhere }), { workspace: wt, rule: 'cli' });
  assert.deepEqual(findWorkspace({ cliRoot: ws, cwd: elsewhere }), { workspace: ws, rule: 'cli' });
});

test('R207: otherwise the outermost workspace at or above the current folder is used', () => {
  const { ws, wt, deep } = nested();
  const notWs = tmp();
  assert.deepEqual(findWorkspace({ cliRoot: notWs, cwd: deep }), { workspace: ws, rule: 'cwd' });
  assert.deepEqual(findWorkspace({ cliRoot: notWs, cwd: wt }), { workspace: ws, rule: 'cwd' });
  assert.deepEqual(findWorkspace({ cliRoot: notWs, cwd: ws }), { workspace: ws, rule: 'cwd' });
});

test('R207: no workspace found gives null', () => {
  assert.equal(findWorkspace({ cliRoot: tmp(), cwd: tmp() }), null);
});

test('R207: a CLI outside any workspace, run outside any workspace, exits 64 and names --workspace', () => {
  const bin = pluginCopy();
  const r = run(bin, ['check-config'], tmp());
  assert.equal(r.code, 64, r.err);
  assert.match(r.err, /no workspace/);
  assert.match(r.err, /--workspace <dir>/);
  assert.equal(r.out, '');
});

test('R207: --help needs no workspace', () => {
  const bin = pluginCopy();
  const r = run(bin, ['--help'], tmp());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /--workspace <dir>/);
  const c = run(bin, ['check-config', '--help'], tmp());
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /--workspace <dir>/);
});

test('R207: a CLI outside any workspace reads the outermost workspace above the current folder', () => {
  const bin = pluginCopy();
  const { deep } = nested();
  const r = run(bin, ['check-config'], deep);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^2 repos, 2 enabled/);
});

test('R207: --workspace points a CLI at a workspace from any folder', () => {
  const bin = pluginCopy();
  const ws = makeWorkspace(tmp(), ['acme/a', 'acme/b', 'acme/c']);
  const r = run(bin, ['--workspace', ws, 'check-config'], tmp());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^3 repos, 3 enabled/);
  // After the command, as a global flag may also come.
  const after = run(bin, ['check-config', '--workspace', ws], tmp());
  assert.equal(after.code, 0, after.err);
  assert.match(after.out, /^3 repos, 3 enabled/);
});

test('R207: a CLI inside a workspace still reads its own workspace from a folder inside another one', () => {
  const { ws } = nested();
  // The CLI copy is the workspace ws itself (bin/ and lib/ at its top level, as the main checkout holds them).
  fs.cpSync(path.join(ROOT, 'bin'), path.join(ws, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(ws, 'lib'), { recursive: true });
  const other = makeWorkspace(tmp(), ['acme/x', 'acme/y', 'acme/z', 'acme/w']);
  const r = run(path.join(ws, 'bin', 'gvt-fleet.mjs'), ['check-config'], other);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^2 repos, 2 enabled/);
});
