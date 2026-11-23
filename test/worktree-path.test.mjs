process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseWorktreeCwd, resolveWorkspace } from '../lib/worktree-path.mjs';
import { names } from '../lib/worktrees.mjs';

const WS = 'C:/work/fleet';

test('R26: a hook payload whose cwd is a worktree root is in scope', () => {
  const r = parseWorktreeCwd('C:\\work\\fleet\\repos\\acme\\widgets\\.claude\\worktrees\\widgets-12', WS);
  assert.deepEqual(r, {
    owner: 'acme',
    repoName: 'widgets',
    worktree: 'widgets-12',
    repo: 'acme/widgets',
    issue: 'acme/widgets#12',
    worktreeRoot: 'C:/work/fleet/repos/acme/widgets/.claude/worktrees/widgets-12',
  });
});

test('R26: a cwd below a worktree root is in scope with the same worktree name', () => {
  const root = parseWorktreeCwd('C:/work/fleet/repos/acme/widgets/.claude/worktrees/widgets-12', WS);
  const sub = parseWorktreeCwd('C:\\work\\fleet\\repos\\acme\\widgets\\.claude\\worktrees\\widgets-12\\src\\lib\\', WS);
  assert.ok(sub);
  assert.equal(sub.worktree, root.worktree);
  assert.equal(sub.issue, root.issue);
  assert.equal(sub.worktreeRoot, root.worktreeRoot);
});

test('R27: the matcher accepts backslashes and either drive-letter case', () => {
  const tail = 'repos\\o\\n\\.claude\\worktrees\\n-1';
  for (const cwd of [
    `C:\\work\\fleet\\${tail}`,
    `c:\\work\\fleet\\${tail}`,
    `C:/work/fleet/${tail.replace(/\\/g, '/')}`,
    `c:/work/fleet/${tail.replace(/\\/g, '/')}`,
  ]) {
    for (const ws of ['C:\\work\\fleet', 'c:/work/fleet/']) {
      const r = parseWorktreeCwd(cwd, ws);
      assert.ok(r, `${cwd} with ${ws}`);
      assert.equal(r.worktreeRoot, 'C:/work/fleet/repos/o/n/.claude/worktrees/n-1');
    }
  }
});

test('R27: the matcher rejects the workspace root, a base clone, a path outside repos and a sibling checkout', () => {
  for (const cwd of [
    'C:\\work\\fleet',
    'C:\\work\\fleet\\repos\\probe\\sandbox',
    'C:\\temp\\x',
    'C:\\work\\webapp\\.claude\\worktrees\\webapp-1',
    'C:\\work\\fleet-2\\repos\\o\\n\\.claude\\worktrees\\n-1',
  ]) {
    assert.equal(parseWorktreeCwd(cwd, WS), null, cwd);
  }
  assert.equal(parseWorktreeCwd(undefined, WS), null);
  assert.equal(parseWorktreeCwd('', WS), null);
  assert.equal(parseWorktreeCwd('C:/x', ''), null);
});

test('R30: the issue key is derived from a <name>-<N> worktree name and agrees with names()', () => {
  for (const [repo, n] of [['acme/construct3-chef', 7], ['example-org/fleet-home', 42], ['o/x.y', 3]]) {
    const [owner, repoName] = repo.split('/');
    const base = path.join(WS, 'repos', owner, repoName);
    const { path: wt, name } = names(repo, n, { base });
    const r = parseWorktreeCwd(wt, WS);
    assert.ok(r, wt);
    assert.equal(r.worktree, name);
    assert.equal(r.issue, `${repo}#${n}`);
  }
  // the dot in the repo name is literal
  assert.equal(parseWorktreeCwd(`${WS}/repos/o/x.y/.claude/worktrees/xzy-3`, WS).issue, null);
});

test('R30: a worktree name that is not <name>-<N> records issue null', () => {
  for (const wt of ['scratch', 'widgets-', 'widgets-0', 'widgets-01', 'widgets-1a', 'other-5']) {
    const r = parseWorktreeCwd(`${WS}/repos/acme/widgets/.claude/worktrees/${wt}`, WS);
    assert.ok(r, wt);
    assert.equal(r.worktree, wt);
    assert.equal(r.issue, null, wt);
  }
});

test('R50: parseWorktreeCwd rejects . and .. segments anywhere in the cwd', () => {
  for (const cwd of [
    `${WS}/repos/../../.claude/worktrees/x`,
    `${WS}/repos/./../.claude/worktrees/..`,
    `${WS}/repos/o/r/.claude/worktrees/r-1/../../..`,
  ]) {
    assert.equal(parseWorktreeCwd(cwd, WS), null, cwd);
  }
  // positive control: a three-dot segment is not traversal and still parses
  assert.notEqual(parseWorktreeCwd(`${WS}/repos/o/r/.claude/worktrees/r-1/...`, WS), null);
});

test('OQ2: resolveWorkspace takes flags first and otherwise the script location', () => {
  const a = resolveWorkspace({ argv: ['--workspace', 'C:/w', '--state-dir', 'C:/s'], scriptPath: 'C:/z/bin/h.mjs' });
  assert.equal(a.workspace, path.resolve('C:/w'));
  assert.equal(a.stateDir, path.resolve('C:/s'));
  const b = resolveWorkspace({ argv: [], scriptPath: 'C:/z/bin/h.mjs' });
  assert.equal(b.workspace, path.resolve('C:/z'));
  assert.equal(b.stateDir, path.join(path.resolve('C:/z'), 'state'));
});
