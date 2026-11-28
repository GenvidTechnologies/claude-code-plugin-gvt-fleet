process.env.GVT_FLEET_FAKE_ONLY = '1';

// A Claude Code lock whose pid was reused does not stop the removal of a worktree whose session is not live (#126 outcome 1),
// the hints of wrap match the state (#126 outcome 3), and a claude rm refusal that offers --discard-unpushed is a refusal,
// not a half-removal (#142).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fwd, g } from './helpers/git-sandbox.mjs';
import { BRANCH, OK } from './helpers/worktree-sandbox.mjs';
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

const LOCK_REASON = 'claude session app-1 (pid 42864)';
const LOCK_OUT = { code: 1, stdout: '', stderr: 'A Claude Code lock on the worktree names a process that is still running (pid 42864)\n' };

/** The git porcelain block of the worktree, or undefined. */
async function blockOf(s) {
  const out = await g(s.base, 'worktree', 'list', '--porcelain');
  return out.split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/)).find((ls) => ls[0]?.startsWith('worktree ') && fwd(ls[0].slice(9)).toLowerCase() === fwd(s.wt).toLowerCase());
}
const isLocked = async (s) => Boolean((await blockOf(s))?.some((l) => l.startsWith('locked')));

/** A `claude rm` that refuses while git keeps the entry locked, and removes the worktree, the branch and the session once it is not. */
const rmUnlessLocked = (x) => async () => {
  if (await isLocked(x)) return LOCK_OUT;
  await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
  await g(x.base, 'branch', '-D', BRANCH);
  x.fake.sessions.length = 0;
  return OK;
};

/** A merged worker (closing pull request at the tip) whose git entry carries the lock of an older pid. */
async function lockedWorker(t, { makeScript = (x) => ({ rm: rmUnlessLocked(x) }), state = 'done' } = {}) {
  const s = await wrapSetup(t, { makeScript, state });
  closingAtTip(s);
  await g(s.base, 'worktree', 'lock', '--reason', LOCK_REASON, fwd(s.wt));
  return s;
}

test('R220: wrap removes a stale lock that names a reused pid once the session is not live, and ends wrapped', async (t) => {
  const s = await lockedWorker(t);
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(rmCalls(s).length, 6, 'five lock retries, then one claude rm after the unlock');
  assert.ok((r.notes ?? []).some((n) => /stale/.test(n) && n.includes(LOCK_REASON)), JSON.stringify(r.notes));
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R220: wrap keeps the lock of a session that is still live after claude stop, and removes nothing', async (t) => {
  const s = await lockedWorker(t, { state: 'working', makeScript: (x) => ({ rm: rmUnlessLocked(x), stop: OK }) });
  const r = await runWrap(s);
  assert.notEqual(r.status, 'wrapped');
  assert.equal(await isLocked(s), true, 'the lock is kept');
  assert.equal(rmCalls(s).length, 5, 'only the lock retries');
  assert.equal(fs.existsSync(path.join(s.wt, 'work.txt')), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R220: a claude rm refusal that names unpushed commits and offers --discard-unpushed is refused, not half-removed, and its hint asks to close nothing', async (t) => {
  const refusal = [
    'kept abcd1234 — its worktree is still at "somewhere"',
    '  1 unpushed commit on "worktree-app-1": 1234abc "add work.txt". It exists on no remote, so deleting the worktree would lose it.',
    "  push it and run 'claude rm abcd1234' again, or discard the worktree and its commits: claude rm abcd1234 --discard-unpushed 1234abc@wt-9",
    '',
  ].join('\n');
  const s = await wrapSetup(t, { state: 'done', makeScript: () => ({ rm: { code: 1, stdout: '', stderr: refusal } }) });
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'refused', r.reason);
  assert.equal(r.steps.worktree, 'refused');
  assert.match(r.reason, /1 unpushed commit on "worktree-app-1"/);
  assert.doesNotMatch(r.hint, /close them/);
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R221: a half-removed wrap with no likely holder found does not ask to close holders', async (t) => {
  const busy = { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
  const s = await wrapSetup(t, { state: 'done', makeScript: () => ({ rm: busy }) });
  closingAtTip(s);
  s.deps.findHolders = async () => ({ source: 'tasklist', holders: [] });
  const r = await runWrap(s);
  assert.equal(r.status, 'half-removed', r.reason);
  assert.deepEqual(r.holders, []);
  assert.doesNotMatch(r.hint, /close them/);
  assert.match(r.hint, /no program was found/);
  assert.match(r.hint, /gvt-fleet wrap acme\/app#1 again/);
});

test('R221: a half-removed wrap with a likely holder asks to close it', async (t) => {
  const busy = { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
  const s = await wrapSetup(t, { state: 'done', makeScript: () => ({ rm: busy }) });
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'half-removed', r.reason);
  assert.equal(r.holders.length, 1);
  assert.match(r.hint, /close them/);
});

test('R221: a wrap refused at the worktree step after the proof passed suggests no merge, push or --discard', async (t) => {
  const s = await wrapSetup(t, { state: 'done', makeScript: () => ({ rm: { code: 1, stdout: '', stderr: 'something else went wrong\n' } }) });
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'refused', r.reason);
  assert.equal(r.steps.proof, 'proven');
  assert.equal(r.steps.worktree, 'refused');
  assert.doesNotMatch(r.hint, /merge the pull request|push the work|--discard/);
  assert.match(r.hint, /gvt-fleet wrap acme\/app#1 again/);
});

test('R221: a wrap refused because the worktree path is a junction suggests no merge, push or --discard', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  const target = path.join(s.root, 'elsewhere');
  fs.mkdirSync(target);
  fs.mkdirSync(path.dirname(s.wt), { recursive: true });
  fs.symlinkSync(target, s.wt, 'junction');
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /link or junction/);
  assert.doesNotMatch(r.hint, /merge the pull request|push the work|--discard/);
});
