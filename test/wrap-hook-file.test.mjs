process.env.GVT_FLEET_FAKE_ONLY = '1';

// wrap deletes the worker's hook file when nothing is left on disk, once the proof passed (#147).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workerFile } from '../plugin/cli/lib/hook-state.mjs';
import { wrapTask } from '../plugin/cli/lib/wrap.mjs';
import { REPOS, SESSION_ID } from './helpers/worktree-sandbox.mjs';
import {
  TASK_KEY,
  TASK_LEASE_ID,
  TASK_NAME,
  addTaskWorker,
} from './helpers/task-worktree.mjs';
import {
  CONFIG,
  clock,
  closingArgs,
  prOf,
  runWrap,
  wrapSetup,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

/** Write a hook file at the path the hook script writes to (the same `workerFile` builder). */
function writeHookFile(s, worktree = 'app-1') {
  const file = workerFile(s.stateDir, { owner: 'acme', repoName: 'app', worktree });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ v: 1, event: 'Stop', session_id: SESSION_ID })}\n`, 'utf8');
  return file;
}

test('R218: wrap of a worker with no folder, branch or claim left, whose work is proven, gives wrapped with nothing true and deletes the hook file', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.claims.immediate(() => s.claims.updateLease('L1', { state: 'released' }));
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const file = writeHookFile(s);
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.nothing, true);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'gone', claim: 'released-earlier' });
  assert.equal(fs.existsSync(file), false, 'the hook file is gone');

  // A rerun skips the proof on the wrap marker (`earlier`), and deletes a hook file written since.
  writeHookFile(s);
  const again = await runWrap(s);
  assert.equal(again.status, 'wrapped', again.reason);
  assert.equal(again.steps.proof, 'earlier');
  assert.equal(fs.existsSync(file), false, 'the hook file is gone after the rerun');
});

test('R218: wrap of a worker with no folder or branch and a claim still held, whose work is proven, releases the claim and deletes the hook file', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z');
  const file = writeHookFile(s);
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.nothing, undefined);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(s.claims.getLease('L1').state, 'released');
  assert.equal(fs.existsSync(file), false, 'the hook file is gone');
});

test('R218: wrap of a task worker with no folder or branch deletes the hook file', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  await addTaskWorker(s, { worktree: false });
  const file = writeHookFile(s, TASK_NAME);
  const r = await wrapTask(s.deps, { claims: s.claims, cache: s.cache, config: CONFIG, clock, closingPrs: [], key: TASK_KEY, reposDir: REPOS(s), defaultBranch: 'main', stateDir: s.stateDir });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'not-required', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(s.claims.getLease(TASK_LEASE_ID).state, 'released');
  assert.equal(fs.existsSync(file), false, 'the hook file is gone');
});

test('R218: wrap with nothing left on disk keeps the hook file when the proof is refused', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.pulls.byNumber['9'] = prOf(9, 'f'.repeat(40), 'feature-z', { state: 'open', merged_at: null });
  const file = writeHookFile(s);
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'refused');
  assert.equal(r.steps.proof, 'refused');
  assert.equal(fs.existsSync(file), true, 'the hook file is kept');
  assert.equal(s.claims.getLease('L1').state, 'held');
});
