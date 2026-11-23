process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureClone } from '../lib/clones.mjs';
import {
  git, g, fwd, makeTempDir, makeOrigin, pushCommit, addNestedWorktree,
} from './helpers/git-sandbox.mjs';

async function setup(t) {
  const root = makeTempDir(t, 'gvt-fleet-clones-');
  const sandbox = await makeOrigin(root);
  const reposDir = path.join(root, 'repos');
  const ctx = { git, reposDir, repo: 'o/n', defaultBranch: 'main', url: fwd(sandbox.origin) };
  return { root, sandbox, reposDir, ctx, dir: path.join(reposDir, 'o', 'n') };
}

async function snapshot(dir) {
  return {
    head: await g(dir, 'rev-parse', 'HEAD'),
    porcelain: await g(dir, 'status', '--porcelain'),
    originRef: await g(dir, 'rev-parse', 'refs/remotes/origin/main'),
  };
}

test('R20: first run clones on default branch', async (t) => {
  const s = await setup(t);
  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'cloned');
  assert.equal(await g(s.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(await g(s.dir, 'rev-parse', 'HEAD'), await g(s.sandbox.work, 'rev-parse', 'HEAD'));
  const exclude = fs.readFileSync(path.join(s.dir, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split(/\r?\n/).includes('/.claude/worktrees/'));
  assert.deepEqual(fs.readdirSync(path.dirname(s.dir)).filter((n) => n.includes('.tmp-')), []);
});

test('R20: re-run fetches and fast-forwards', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  const newSha = await pushCommit(s.sandbox, 'second.txt', 'two\n');
  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'updated');
  assert.equal(await g(s.dir, 'rev-parse', 'HEAD'), newSha);
  assert.ok(fs.existsSync(path.join(s.dir, 'second.txt')));
  const again = await ensureClone(s.ctx);
  assert.equal(again.status, 'up-to-date');
  const exclude = fs.readFileSync(path.join(s.dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/).filter((l) => l === '/.claude/worktrees/').length, 1, 'exclude line added once');
});

test('R20: dirty base clone is reported and unchanged', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  fs.writeFileSync(path.join(s.dir, 'scratch.txt'), 'dirty\n', 'utf8');
  await pushCommit(s.sandbox, 'second.txt', 'two\n');
  const before = await snapshot(s.dir);
  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /dirty/);
  assert.deepEqual(await snapshot(s.dir), before, 'HEAD, status and origin ref identical: no fetch ran');
  assert.ok(before.porcelain.includes('scratch.txt'));
});

test('R20: base clone off default branch is reported and unchanged', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  await g(s.dir, 'checkout', '-b', 'topic');
  await pushCommit(s.sandbox, 'second.txt', 'two\n');
  const before = await snapshot(s.dir);
  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /topic/);
  assert.deepEqual(await snapshot(s.dir), before, 'HEAD, status and origin ref identical: no fetch ran');
  assert.equal(await g(s.dir, 'symbolic-ref', '--short', 'HEAD'), 'topic');
});

test('R25: interrupted clone temp dir is cleaned and the clone completes', async (t) => {
  const s = await setup(t);
  const parent = path.dirname(s.dir);
  const leftover = path.join(parent, '.n.tmp-99999');
  fs.mkdirSync(path.join(leftover, 'half'), { recursive: true });
  fs.writeFileSync(path.join(leftover, 'half', 'file'), 'partial', 'utf8');
  const unrelated = path.join(parent, '.other.tmp-1');
  fs.mkdirSync(unrelated);
  const notOurs = path.join(parent, '.n.tmp-other');
  fs.mkdirSync(notOurs);

  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'cloned');
  assert.deepEqual(res.cleaned, ['.n.tmp-99999']);
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(unrelated), true, 'another repo temp folder is not touched');
  assert.equal(fs.existsSync(notOurs), true, 'a folder not named .<name>.tmp-<digits> survives');
  assert.equal(await g(s.dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('R25: clone cleanup keeps a temp folder whose pid is alive', async (t) => {
  const s = await setup(t);
  const parent = path.dirname(s.dir);
  const live = path.join(parent, '.n.tmp-77777');
  const dead = path.join(parent, '.n.tmp-88888');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(dead, { recursive: true });
  const res = await ensureClone({ ...s.ctx, pid: 4242, isPidAlive: (pid) => pid === 77777 });
  assert.equal(res.status, 'cloned');
  assert.deepEqual(res.cleaned, ['.n.tmp-88888']);
  assert.equal(fs.existsSync(live), true, 'a folder owned by a live process is kept');
  assert.equal(fs.existsSync(dead), false);
});

test('R20: exclude file is rewritten with LF endings', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  const exclude = path.join(s.dir, '.git', 'info', 'exclude');
  fs.writeFileSync(exclude, '# header\r\n*.log\r\n', 'utf8');
  await ensureClone(s.ctx);
  const text = fs.readFileSync(exclude, 'utf8');
  assert.equal(text, '# header\n*.log\n/.claude/worktrees/\n');
  assert.equal(text.includes('\r'), false);
});

test('R20: nested worktree under .claude/worktrees keeps the base clone clean only with the exclude line', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  await addNestedWorktree(s.dir, 'wt1');
  assert.equal(await g(s.dir, 'status', '--porcelain'), '', 'clean with the exclude line');
  const exclude = path.join(s.dir, '.git', 'info', 'exclude');
  const text = fs.readFileSync(exclude, 'utf8');
  fs.writeFileSync(exclude, text.replace('/.claude/worktrees/\n', ''), 'utf8');
  assert.match(await g(s.dir, 'status', '--porcelain'), /\.claude\//, 'dirty without it');
});

test('R20: non-fast-forward re-run is reported and the clone is unchanged', async (t) => {
  const s = await setup(t);
  await ensureClone(s.ctx);
  await g(s.dir, 'config', 'user.name', 'Local');
  await g(s.dir, 'config', 'user.email', 'local@example.invalid');
  fs.writeFileSync(path.join(s.dir, 'local.txt'), 'local\n', 'utf8');
  await g(s.dir, 'add', 'local.txt');
  await g(s.dir, 'commit', '-m', 'local only');
  await pushCommit(s.sandbox, 'remote.txt', 'remote\n');
  const headBefore = await g(s.dir, 'rev-parse', 'HEAD');

  const res = await ensureClone(s.ctx);
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /not a fast-forward/);
  assert.equal(await g(s.dir, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(await g(s.dir, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(s.dir, 'remote.txt')), false);
});

test('R20: a failed clone leaves no temp folder and no target folder', async (t) => {
  const s = await setup(t);
  const res = await ensureClone({ ...s.ctx, url: fwd(path.join(s.root, 'missing.git')) });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /clone failed/);
  assert.equal(fs.existsSync(s.dir), false);
  assert.deepEqual(fs.readdirSync(path.dirname(s.dir)), []);
});

test('R20: every git call runs with GIT_TERMINAL_PROMPT=0', async (t) => {
  const s = await setup(t);
  const envs = [];
  const spy = {
    run: (args, opts) => {
      envs.push(opts?.env);
      return git.run(args, opts);
    },
    out: (args, opts) => {
      envs.push(opts?.env);
      return git.out(args, opts);
    },
  };
  await ensureClone({ ...s.ctx, git: spy });
  await ensureClone({ ...s.ctx, git: spy });
  assert.ok(envs.length >= 6, `expected clone plus re-run calls, saw ${envs.length}`);
  for (const env of envs) assert.equal(env?.GIT_TERMINAL_PROMPT, '0');
});
