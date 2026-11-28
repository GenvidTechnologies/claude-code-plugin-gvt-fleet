process.env.GVT_FLEET_FAKE_ONLY = '1';

// wrap and worktree remove finish a registered worktree whose session is gone (#143, #126 outcome 2):
// with a submodule checked out, with a stale lock, and never with work left or a link inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finishWorktree, removeWorktree } from '../plugin/cli/lib/worktrees.mjs';
import { fwd, g } from './helpers/git-sandbox.mjs';
import { BRANCH, KEY, REPOS, addWorktree } from './helpers/worktree-sandbox.mjs';
import { addSubmoduleToOrigin, commitInSubmodule, initSubmodule } from './helpers/submodule-sandbox.mjs';
import {
  branchExists,
  closingAtTip,
  rmCalls,
  runWrap,
  wrapSetup,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

/** True while git in the base clone lists the worktree folder. */
async function listed(s) {
  const out = await g(s.base, 'worktree', 'list', '--porcelain');
  return out.split(/\r?\n/).some((l) => l.startsWith('worktree ') && fwd(l.slice(9)).toLowerCase() === fwd(s.wt).toLowerCase());
}

/**
 * A worktree of an issue whose final pull request merged at its tip (pushed with an upstream, a closing pull request),
 * with no session listed. `submodule` checks out the submodule `sub` in the worktree; `lock` locks the git entry with
 * that reason. `before(s)` runs after the commit and before the push.
 */
async function orphan(t, { submodule = false, lock = null, before = async () => {} } = {}) {
  const s = await wrapSetup(t, { worktree: false });
  if (submodule) await addSubmoduleToOrigin(s);
  await addWorktree(s, { commit: true });
  if (submodule) await initSubmodule(s.wt);
  await before(s);
  await g(s.wt, 'push', '-u', 'origin', BRANCH);
  s.tip = await g(s.wt, 'rev-parse', 'HEAD');
  closingAtTip(s);
  if (lock) await g(s.base, 'worktree', 'lock', '--reason', lock, fwd(s.wt));
  s.fake.sessions.length = 0; // the session is gone
  return s;
}

/** Nothing was deleted: the folder, its git entry and the branch are there, and the claim is held. */
async function assertNothingDeleted(s) {
  assert.equal(fs.existsSync(path.join(s.wt, 'work.txt')), true, 'the folder is kept');
  assert.equal(await listed(s), true, 'git still lists the worktree');
  assert.equal(await branchExists(s), true, 'the branch is kept');
  assert.equal(s.claims.getLease('L1').state, 'held', 'the claim is kept');
}

test('R219: wrap of a merged issue with a submodule checked out and no session ends wrapped', async (t) => {
  const s = await orphan(t, { submodule: true });
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(fs.existsSync(s.wt), false, 'the folder is gone');
  assert.equal(await listed(s), false);
  assert.equal(await branchExists(s), false);
  assert.equal(rmCalls(s).length, 0, 'no claude rm without a session');
});

test('R219: wrap of a merged issue with a submodule, no session and the git entry locked initializing ends wrapped and unlists the worktree', async (t) => {
  const s = await orphan(t, { submodule: true, lock: 'initializing' });
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(await listed(s), false, 'git no longer lists the worktree');
  assert.equal(await branchExists(s), false, `${BRANCH} is gone`);
  assert.ok((r.notes ?? []).some((n) => /lock/.test(n) && /initializing/.test(n)), JSON.stringify(r.notes));
});

test('R219: wrap of a merged issue with no submodule, no session and a Claude Code lock with a reused pid ends wrapped', async (t) => {
  const s = await orphan(t, { lock: 'claude session app-1 (pid 42864)' });
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await listed(s), false);
  assert.equal(await branchExists(s), false);
});

test('R219: wrap with a submodule and no session refuses an uncommitted change, and deletes nothing', async (t) => {
  const s = await orphan(t, { submodule: true, lock: 'initializing' });
  fs.writeFileSync(path.join(s.wt, 'work.txt'), 'changed\n', 'utf8');
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes('the working tree has uncommitted changes'), r.problems.join('; '));
  await assertNothingDeleted(s);
});

test('R219: wrap with no session refuses a submodule commit that is on no remote branch of the submodule, and deletes nothing', async (t) => {
  const s = await orphan(t, { submodule: true, before: (x) => commitInSubmodule(x.wt) });
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /^submodule sub has 1 commit\(s\) on no remote branch/.test(p)), r.problems.join('; '));
  await assertNothingDeleted(s);
});

test('R219: wrap with no session refuses a stash entry in a submodule, and deletes nothing', async (t) => {
  const s = await orphan(t, { submodule: true });
  fs.writeFileSync(path.join(s.wt, 'sub', 'README.md'), 'stashed\n', 'utf8');
  await g(path.join(s.wt, 'sub'), 'stash', 'push', '-m', 'sub stash');
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /^submodule sub has 1 stash entr/.test(p)), r.problems.join('; '));
  await assertNothingDeleted(s);
});

test('R219: wrap with no session refuses a worktree folder that holds a junction, and deletes nothing', async (t) => {
  const s = await orphan(t);
  const target = path.join(s.root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n', 'utf8');
  // An untracked junction would fail the clean-tree check first, so it is ignored through info/exclude.
  fs.appendFileSync(path.join(s.base, '.git', 'info', 'exclude'), '/linked\n');
  fs.symlinkSync(target, path.join(s.wt, 'linked'), 'junction');
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /linked is a link or junction/);
  await assertNothingDeleted(s);
  assert.equal(fs.existsSync(path.join(target, 'keep.txt')), true, 'the junction target is untouched');
});

test('R219: worktree remove of a pushed worktree with no session removes it with git', async (t) => {
  const s = await orphan(t, { lock: 'claude session app-1 (pid 16192)' });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), defaultBranch: 'main', stateDir: s.stateDir });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await listed(s), false);
  assert.equal(rmCalls(s).length, 0);
});

test('R219: worktree finish unlocks a locked entry of a missing folder before it prunes, and deletes the branch', async (t) => {
  const s = await orphan(t, { lock: 'initializing' });
  fs.rmSync(s.wt, { recursive: true, force: true });
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), stateDir: s.stateDir, provenTip: s.tip, noDiscard: true });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(await listed(s), false);
  assert.equal(await branchExists(s), false);
});

test('R219: wrap of a merged issue whose folder is gone and whose entry is locked initializing ends wrapped', async (t) => {
  const s = await orphan(t, { lock: 'initializing' });
  fs.rmSync(s.wt, { recursive: true, force: true });
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(await listed(s), false);
  assert.equal(await branchExists(s), false);
});
