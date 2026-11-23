process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { releaseCommand, statusCommand, worktreeRemoveCommand } from '../lib/commands.mjs';
import { workerFile } from '../lib/hook-state.mjs';
import { finishWorktree, removeWorktree } from '../lib/worktrees.mjs';
import {
  fwd,
  g,
  git,
  halfRemoveWorktree,
} from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  OK,
  PULLS_KEY,
  REPOS,
  SESSION_ID,
  addWorktree,
  rmFully,
  setup,
} from './helpers/worktree-sandbox.mjs';
import {
  rmCalls,
  MERGED_AT,
  requireMergedSetup,
  removeMerged,
  REMOTE_NAME,
  recordSetup,
  readRecord,
  OWN_ENTRY,
  removeRecording,
  pushedUnderOtherName,
} from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// ---- the worker's hook file goes with the worktree ----

/** Write the worker's hook file at the path the hook script writes to (the same `workerFile` builder). */
function writeHookFile(s) {
  const file = workerFile(s.stateDir, { owner: 'acme', repoName: 'app', worktree: 'app-1' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ v: 1, event: 'Stop', session_id: SESSION_ID })}\n`, 'utf8');
  return file;
}
const withState = (s) => ({ claims: s.claims, key: KEY, reposDir: REPOS(s), stateDir: s.stateDir });

test('R104: worktree remove deletes the hook file when it reports removed, also when nothing was left to remove, and when the branch is kept', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  const file = writeHookFile(s);
  const r = await removeWorktree(s.deps, withState(s));
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(file), false, 'removed deletes the file');

  const empty = await setup(t);
  const emptyFile = writeHookFile(empty);
  const nothing = await removeWorktree(empty.deps, withState(empty));
  assert.equal(nothing.status, 'removed');
  assert.equal(nothing.nothing, true);
  assert.equal(fs.existsSync(emptyFile), false, 'nothing to remove deletes the file');

  let head = '';
  const kept = await setup(t, {
    makeScript: (x) => ({
      rm: async () => {
        await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
        x.fake.sessions.length = 0;
        return OK;
      },
    }),
    ghScript: { [PULLS_KEY]: () => ({ data: [{ merged_at: '2026-11-02T00:00:00Z', head: { sha: head } }] }) },
  });
  await addWorktree(kept, { commit: true });
  head = await g(kept.wt, 'rev-parse', 'HEAD');
  const keptFile = writeHookFile(kept);
  const bk = await removeWorktree(kept.deps, withState(kept));
  assert.equal(bk.status, 'branch-kept');
  assert.equal(fs.existsSync(keptFile), false, 'branch-kept deletes the file');
});

test('R104: worktree remove keeps the hook file when it refuses and when it reports half-removed', async (t) => {
  const refused = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(refused, { commit: true });
  const refusedFile = writeHookFile(refused);
  const r = await removeWorktree(refused.deps, withState(refused));
  assert.equal(r.status, 'refused');
  assert.equal(fs.existsSync(refusedFile), true, 'refused keeps the file');

  const half = await setup(t, { makeScript: () => ({ rm: { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' } }) });
  await addWorktree(half, { push: true });
  const halfFile = writeHookFile(half);
  const h = await removeWorktree(half.deps, withState(half));
  assert.equal(h.status, 'half-removed');
  assert.equal(fs.existsSync(halfFile), true, 'half-removed keeps the file');
});

test('R104: worktree finish deletes the hook file when it reports removed', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  const file = writeHookFile(s);
  const r = await finishWorktree(s.deps, withState(s));
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(file), false);
});

test('R104: worktree finish keeps the hook file when it refuses', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  fs.writeFileSync(path.join(s.wt, 'precious.txt'), 'mine', 'utf8');
  const file = writeHookFile(s);
  const r = await finishWorktree(s.deps, withState(s));
  assert.equal(r.status, 'refused');
  assert.equal(fs.existsSync(file), true);
});

test('R104: after worktree remove and release, status prints workers: 0 and no row for the worker', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  const file = writeHookFile(s);
  const configFile = path.join(s.root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const ctx = {
    configFile, stateDir: s.stateDir, json: false, repoRoot: s.ws, paths: { workspace: s.ws, claudeJson: s.claudeJson },
    clock: { now: () => NOW, sleep: async () => {} }, claude: s.fake, gh: s.gh,
    out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} },
  };
  assert.equal(await worktreeRemoveCommand(ctx, ['app#1']), 0, err.join(' | '));
  assert.equal(fs.existsSync(file), false);
  // The release step, through the real command: the lease leaves the held state.
  assert.equal(await releaseCommand(ctx, [KEY]), 0, err.join(' | '));
  assert.equal(s.claims.getLease('L1').state, 'released');
  out.length = 0;
  assert.equal(await statusCommand(ctx, []), 0, err.join(' | '));
  assert.deepEqual(out, ['workers: 0']);
});

// ---- review fixes: edge cases of the pushed-branch record and the result keys ----

/** A pushed worktree (upstream named like the local branch) with the record set up. */
async function pushedUnderOwnName(t, repos) {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  recordSetup(s, repos);
  return s;
}

test('R105: remove records the entry and returns a warning when git ls-remote fails', async (t) => {
  const s = await pushedUnderOtherName(t);
  // Only the base clone's URL is broken: the safety check reads local refs, so it still passes.
  await g(s.base, 'remote', 'set-url', 'origin', fwd(path.join(s.root, 'no-such-origin')));
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.branchRecord.recorded, REMOTE_NAME);
  assert.match(r.branchRecord.warning, /cannot read the remote branches \(git ls-remote: [^]*\); feature-y is recorded without checking/);
  assert.deepEqual(readRecord(s), { [REMOTE_NAME]: OWN_ENTRY });
});

test('R105: remove keeps the entry when the remote branch name equals the local name, and drops nothing', async (t) => {
  const s = await pushedUnderOwnName(t, { 'acme/app': { [BRANCH]: OWN_ENTRY } });
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: null });
  assert.deepEqual(readRecord(s), { [BRANCH]: OWN_ENTRY });

  const fresh = await pushedUnderOwnName(t);
  const r2 = await removeRecording(fresh);
  assert.deepEqual(r2.branchRecord, { recorded: BRANCH, dropped: null });
  assert.deepEqual(readRecord(fresh), { [BRANCH]: OWN_ENTRY });
});

test('R105: remove does not overwrite an entry a person wrote after git ls-remote returned', async (t) => {
  const s = await pushedUnderOtherName(t);
  const mine = { disposition: 'keep', decided: '2026-10-01', by: 'me' };
  // The person's `branch set` lands as git ls-remote returns, before the coordinator reads the record.
  // The read-then-write window under the lock has no seam: the `onlyIf` unit tests (R112) cover it.
  s.deps.git = {
    ...git,
    run: async (args, opts) => {
      const res = await git.run(args, opts);
      if (args[0] === 'ls-remote') fs.writeFileSync(s.recordFile, JSON.stringify({ version: 1, repos: { 'acme/app': { [REMOTE_NAME]: mine } } }), 'utf8');
      return res;
    },
  };
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: null });
  assert.deepEqual(readRecord(s), { [REMOTE_NAME]: mine });
});

test('R105: remove drops the kept same-name entry when the pushed branch is gone from the remote', async (t) => {
  const s = await pushedUnderOwnName(t, { 'acme/app': { [BRANCH]: OWN_ENTRY } });
  // Deleted on the origin only: the base clone still has its tracking ref, so the safety check passes.
  await g(s.sandbox.origin, 'branch', '-D', BRANCH);
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: BRANCH });
  assert.deepEqual(readRecord(s), {});
});

test('R105: a half-removed result carries pushedBranch and pr, and so does the failed agents-error result', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: () => {
        halfRemoveWorktree(x.base, x.wt);
        return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
      },
    }),
  });
  await addWorktree(s, { commit: true, push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.equal(r.pushedBranch, BRANCH);
  assert.equal(r.pr, null);

  const broken = await setup(t);
  broken.deps.claude = Object.assign(Object.create(broken.fake), { agents: async () => { throw new Error('agents unavailable'); } });
  const f = JSON.parse(JSON.stringify(await removeWorktree(broken.deps, { claims: broken.claims, key: KEY, reposDir: REPOS(broken) })));
  assert.equal(f.status, 'failed');
  assert.equal(f.pushedBranch, null);
  assert.equal(f.pr, null);
});

test('R105: a plain remove of a pushed branch reports the remote branch name and makes no GitHub call', async (t) => {
  const s = await pushedUnderOtherName(t);
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.pushedBranch, REMOTE_NAME);
  assert.equal(r.pr, null);
  assert.deepEqual(s.gh.calls, []);
});

test('R105: pushedBranch and pr are present as null on a result from an early path', async (t) => {
  // A session is listed but there is no folder and no branch: the check returns early ("nothing to protect").
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: async () => {
        x.fake.sessions.length = 0;
        return OK;
      },
    }),
  });
  s.fake.sessions.push({ id: 'abcd1234', sessionId: SESSION_ID, name: 'app-1', cwd: s.wt, kind: 'background', state: 'working' });
  const r = await removeWorktree(s.deps, withState(s));
  assert.equal(r.status, 'removed', r.reason);
  const seen = JSON.parse(JSON.stringify(r));
  assert.equal(seen.pushedBranch, null);
  assert.equal(seen.pr, null);

  const empty = await setup(t);
  const nothing = JSON.parse(JSON.stringify(await removeWorktree(empty.deps, withState(empty))));
  assert.equal(nothing.pushedBranch, null);
  assert.equal(nothing.pr, null);
});

test('R107: remove --require-merged on a detached HEAD whose commits are on a remote branch proves the issue branch by its own merged pull request', async (t) => {
  const s = await requireMergedSetup(t, (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }));
  await g(s.wt, 'checkout', '--detach');
  const r = await removeMerged(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.ok(s.gh.calls.some((c) => c.key === PULLS_KEY), 'the issue branch was looked up by its remote name');
  assert.equal(r.proofs[0].pr.number, 12);
  assert.equal(rmCalls(s).length, 1);
});

test('R107: remove on a detached HEAD without --require-merged records the issue branch', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  await g(s.wt, 'checkout', '--detach');
  recordSetup(s, { 'acme/app': { [BRANCH]: OWN_ENTRY } });
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.branchRecord.recorded, null);
  assert.deepEqual(readRecord(s), { [BRANCH]: OWN_ENTRY });
});

test('R104: a hook file that cannot be deleted leaves the result removed and adds a note', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  // A non-empty folder at the hook file's path: rmSync without recursive throws.
  const file = workerFile(s.stateDir, { owner: 'acme', repoName: 'app', worktree: 'app-1' });
  fs.mkdirSync(path.join(file, 'inner'), { recursive: true });
  const r = await removeWorktree(s.deps, withState(s));
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^hook file .+ was not deleted: /);
  assert.equal(fs.existsSync(file), true);
});
