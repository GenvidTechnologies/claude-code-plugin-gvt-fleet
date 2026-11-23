process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { worktreeCreateCommand } from '../plugin/cli/lib/commands.mjs';
import {
  createFindHolders,
  createWorktree,
  finishWorktree,
  names,
  removeWorktree,
} from '../plugin/cli/lib/worktrees.mjs';
import { sequence } from './fakes/fake-claude.mjs';
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
  PULLS_KEY,
  addWorktree,
  rmFully,
  setup,
} from './helpers/worktree-sandbox.mjs';
import {
  branchExists,
  droppedDirs,
  rmCalls,
  createArgs,
} from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const worktreeList = (s) => g(s.base, 'worktree', 'list', '--porcelain');

test('R22: names is the single builder of name, path and branch', () => {
  assert.deepEqual(names('acme/app', 7, { base: 'B' }), { name: 'app-7', branch: 'worktree-app-7', path: path.join('B', '.claude', 'worktrees', 'app-7') });
  assert.deepEqual(names('app', 7), { name: 'app-7', branch: 'worktree-app-7' });
});

test('R22: create runs claude --bg -w <repo>-<issue> -n <repo>-<issue> with cwd at the base clone', async (t) => {
  const s = await setup(t);
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'created', r.reason);
  const starts = s.fake.calls.filter((c) => c.op === 'startBg');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].argv, ['--bg', '-w', 'app-1', '-n', 'app-1']);
  assert.equal(starts[0].cwd, s.base);
  // Trust was written for the base clone before the session started.
  const projects = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects;
  assert.equal(Object.values(projects).filter((p) => p.hasTrustDialogAccepted === true).length, 1);
});

test('R22: create records session id and worktree path on the claim', async (t) => {
  const s = await setup(t);
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'created', r.reason);
  const session = s.fake.sessions[0];
  const row = s.claims.getLease('L1');
  assert.equal(row.sessionId, session.sessionId);
  assert.equal(row.shortId, session.sessionId.slice(0, 8));
  assert.equal(row.worktreePath, s.wt);
  assert.equal(row.branch, BRANCH);
  assert.equal(row.wtState, 'created');
});

test('R22: create re-run with a live session is a no-op and a folder with no session is not overwritten', async (t) => {
  const s = await setup(t);
  assert.equal((await createWorktree(s.deps, createArgs(s))).status, 'created');
  assert.equal((await createWorktree(s.deps, createArgs(s))).status, 'noop');
  assert.equal(s.fake.calls.filter((c) => c.op === 'startBg').length, 1);

  const other = await setup(t);
  fs.mkdirSync(other.wt, { recursive: true });
  fs.writeFileSync(path.join(other.wt, 'mine.txt'), 'keep', 'utf8');
  const r = await createWorktree(other.deps, createArgs(other));
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /not overwritten/);
  assert.equal(other.fake.calls.filter((c) => c.op === 'startBg').length, 0);
  assert.equal(fs.readFileSync(path.join(other.wt, 'mine.txt'), 'utf8'), 'keep');
});

test('R22: create refuses when the claim is not held', async (t) => {
  const s = await setup(t, { lease: { state: 'claiming' } });
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'refused');
  assert.equal(s.fake.calls.length, 0);
});

test('R106: worktree create writes no branch record entry and exits 0', async (t) => {
  const s = await setup(t);
  const configFile = path.join(s.root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const ctx = {
    configFile, stateDir: s.stateDir, json: false, repoRoot: s.ws, paths: { workspace: s.ws, claudeJson: s.claudeJson },
    clock: { now: () => NOW, sleep: async () => {} }, claude: s.fake, cloneUrlOf: () => fwd(s.sandbox.origin),
    out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} },
  };
  const code = await worktreeCreateCommand(ctx, ['app#1']);
  assert.equal(code, 0, err.join(' | '));
  assert.match(out.join(' | '), /\(session [0-9a-f]{8}\)/, 'the text output names the session short id');
  assert.equal(fs.existsSync(path.join(path.dirname(configFile), 'branches.json')), false, 'no branch record file was written');
  assert.equal(fs.existsSync(path.join(s.stateDir, 'branches.lock')), false);
  assert.equal(await worktreeCreateCommand(ctx, []), 64);
});

test('R23: remove refuses an unpushed branch without --discard', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /--discard/);
  assert.ok(r.problems.some((p) => /^worktree-app-1 has 1 commit\(s\) not pushed to any remote branch/.test(p)), r.problems.join('; '));
  assert.deepEqual(s.fake.calls.filter((c) => c.op === 'rm' || c.op === 'stop'), []);
  assert.equal(await branchExists(s), true);
  assert.ok(fs.existsSync(path.join(s.wt, 'work.txt')));
  assert.equal(s.claims.getLease('L1').wtState, 'created');
});

test('R23: remove refuses a dirty tree and a stash made on the branch', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { push: true });
  fs.writeFileSync(path.join(s.wt, 'README.md'), 'changed\n', 'utf8');
  const dirty = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(dirty.status, 'refused');
  assert.ok(dirty.problems.some((p) => /uncommitted/.test(p)));
  await g(s.wt, 'stash', 'push', '-m', 'wip');
  const stashed = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(stashed.status, 'refused');
  assert.ok(stashed.problems.some((p) => /stash/.test(p)), stashed.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
});

test('R23: remove proceeds when the branch is pushed', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(s.fake.calls.filter((c) => c.op === 'stop' || c.op === 'rm').map((c) => `${c.op} ${c.id}`), ['stop abcd1234', 'rm abcd1234']);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').wtState, 'removed');
});

test('R23: remove proceeds for an unpushed branch whose pull request is merged', async (t) => {
  let head = '';
  const s = await setup(t, {
    makeScript: (x) => ({ rm: rmFully(x) }),
    ghScript: { [PULLS_KEY]: () => ({ data: [{ merged_at: '2026-11-02T00:00:00Z', head: { sha: head } }] }) },
  });
  await addWorktree(s, { commit: true });
  head = await g(s.wt, 'rev-parse', 'HEAD');
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
});

test('R23: remove --discard is recorded on the claim and uses the value the first rm reported', async (t) => {
  const seen = [];
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: sequence(
        () => {
          seen.push(x.claims.getLease('L1').discardHead);
          return { code: 1, stdout: 'unpushed commits; rerun with --discard-unpushed 1234abc@wt-9\n', stderr: '' };
        },
        async () => rmFully(x)(),
      ),
    }),
  });
  await addWorktree(s, { commit: true });
  const head = await g(s.wt, 'rev-parse', 'HEAD');
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos'), discard: true });
  assert.deepEqual(seen, [head], 'the commit the consent was given at is on the claim while rm runs');
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.usedDiscard, true);
  assert.equal(rmCalls(s).length, 2);
  assert.equal(rmCalls(s)[1].discardUnpushed, '1234abc@wt-9');
  assert.equal(s.claims.getLease('L1').discardHead, null, 'a finished removal leaves no consent behind');
  assert.equal(s.claims.getLease('L1').wtState, 'removed');
});

test('R24: EBUSY half-failure is detected and reported with the folder path', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: () => {
        halfRemoveWorktree(x.base, x.wt);
        return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
      },
    }),
  });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'half-removed');
  assert.equal(r.folder, s.wt);
  assert.deepEqual(s.holderCalls, [s.wt]);
  assert.deepEqual(r.holders, [{ process: 'Code.exe', pid: 42 }]);
  assert.equal(r.hint, `close them, then gvt-fleet worktree finish ${KEY}`);
  assert.equal(s.claims.getLease('L1').wtState, 'half-removed');
  assert.deepEqual(fs.readdirSync(s.wt), ['.git']);
});

test('R24: half-failure is detected from the folder and git alone when the output says nothing', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: () => {
        halfRemoveWorktree(x.base, x.wt);
        return { code: 1, stdout: '', stderr: 'remove failed\n' };
      },
    }),
  });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'half-removed');
  assert.doesNotMatch(r.output, /kept|EBUSY/);
});

test('R24: rm output reporting kept or EBUSY is half-removed even while git still lists the worktree', async (t) => {
  const s = await setup(t, { makeScript: () => ({ rm: { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' } }) });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  // Nothing changed on disk or in git: the folder is intact and still registered.
  assert.ok(fs.existsSync(path.join(s.wt, 'README.md')));
  assert.ok((await worktreeList(s)).includes('app-1'));
  assert.equal(r.status, 'half-removed');
  assert.equal(r.folder, s.wt);
  assert.equal(s.claims.getLease('L1').wtState, 'half-removed');
});

test('R24: finish deletes a folder holding only .git, reruns rm, prunes and deletes the branch', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  s.claims.immediate(() => s.claims.updateLease('L1', { wtState: 'half-removed' }));
  assert.equal(droppedDirs(s).length, 1);
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(s.wt), false);
  assert.deepEqual(rmCalls(s).map((c) => c.id), ['abcd1234']);
  assert.equal((await worktreeList(s)).includes('app-1'), false);
  assert.deepEqual(droppedDirs(s), []);
  assert.equal(await branchExists(s), false);
  assert.deepEqual(r.steps, { folder: 'deleted', rm: 'done', prune: 'done', branch: 'deleted' });
  assert.equal(s.claims.getLease('L1').wtState, 'removed');
});

test('R24: finish refuses when the folder holds more than .git', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  fs.writeFileSync(path.join(s.wt, 'precious.txt'), 'mine', 'utf8');
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.extra, ['precious.txt']);
  assert.equal(fs.readFileSync(path.join(s.wt, 'precious.txt'), 'utf8'), 'mine');
  assert.equal(rmCalls(s).length, 0);
  assert.equal(droppedDirs(s).length, 1);
  assert.equal(await branchExists(s), true);
});

test('R24: finish ends removed when the folder, branch and session are already gone and several dropped dirs remain', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  const { dropped } = halfRemoveWorktree(s.base, s.wt);
  fs.mkdirSync(`${dropped}2`);
  fs.mkdirSync(`${dropped}3`);
  fs.rmSync(s.wt, { recursive: true, force: true });
  // The dropped admin dir still counts the branch as checked out, so `branch -D` would refuse.
  await g(s.base, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  s.fake.sessions.length = 0;
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.steps, { folder: 'skipped', rm: 'skipped', prune: 'done', branch: 'skipped' });
  assert.deepEqual(droppedDirs(s), []);
  assert.equal(rmCalls(s).length, 0);
  // A second run has nothing left to do.
  const again = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(again.status, 'removed');
  assert.deepEqual(again.steps, { folder: 'skipped', rm: 'skipped', prune: 'skipped', branch: 'skipped' });
});

test('R24: finish deletes an empty folder that has no .git and ends removed', async (t) => {
  const s = await setup(t);
  fs.mkdirSync(s.wt, { recursive: true });
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.steps.folder, 'deleted');
  assert.equal(fs.existsSync(s.wt), false);
});

test('R24: finish keeps a branch that has unmerged commits unless discard consent is recorded', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { commit: true, state: 'done' });
  const tip = await g(s.wt, 'rev-parse', 'HEAD');
  halfRemoveWorktree(s.base, s.wt);
  const kept = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(kept.status, 'branch-kept');
  assert.equal(await branchExists(s), true);
  s.claims.immediate(() => s.claims.updateLease('L1', { discardHead: tip }));
  const done = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(done.status, 'removed', done.reason);
  assert.equal(await branchExists(s), false);
});

test('N14: a branch-kept reason names the squash-merged and pruned cases, not unmerged commits', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { commit: true, state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  const kept = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(kept.status, 'branch-kept');
  assert.doesNotMatch(kept.reason, /commits that are not merged/);
  assert.match(kept.reason, /squash-merged branch/);
  assert.match(kept.reason, /remote-tracking branch was pruned/);
});

test('R25: remove re-run on a lock error retries then succeeds', async (t) => {
  const lock = { code: 1, stdout: '', stderr: 'A Claude Code lock names a process that is still running\n' };
  const s = await setup(t, { makeScript: (x) => ({ rm: sequence(lock, lock, rmFully(x)) }) });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.attempts, 3);
  assert.equal(rmCalls(s).length, 3);
  assert.deepEqual(s.sleeps, [2000, 2000]);
});

test('R25: remove gives up after five lock errors and reports refused', async (t) => {
  const lock = { code: 1, stdout: '', stderr: 'A Claude Code lock names a process that is still running\n' };
  const s = await setup(t, { makeScript: () => ({ rm: sequence(lock) }) });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: path.join(s.ws, 'repos') });
  assert.equal(r.status, 'refused');
  assert.equal(rmCalls(s).length, 5);
  assert.equal(s.sleeps.length, 4);
  assert.equal(s.claims.getLease('L1').wtState, 'created');
});

test('R24: holders come from handle64 when it resolves, else from the Code.exe and GitExtensions.exe processes', async () => {
  const handleOut = 'Nthandle v5.0\n\nCode.exe           pid: 4321   type: File          1C: C:\\x\\app-1\nexplorer.exe       pid: 99     type: File          2C: C:\\x\\app-1\n';
  const tasklist = '"System","4","Services","0","1 K"\n"Code.exe","111","Console","1","9 K"\n"GitExtensions.exe","222","Console","1","9 K"\n"notepad.exe","333","Console","1","9 K"\n';
  const calls = [];
  const run = async (argv) => {
    calls.push(argv[0]);
    return { code: 0, stdout: /handle64/.test(argv[0]) ? handleOut : tasklist, stderr: '' };
  };
  const viaHandle = await createFindHolders({ run, resolve: (n) => `C:/tools/${n}.exe` })('C:/x/app-1');
  assert.equal(viaHandle.source, 'handle64');
  assert.deepEqual(viaHandle.holders, [{ process: 'Code.exe', pid: 4321 }, { process: 'explorer.exe', pid: 99 }]);

  const fallback = await createFindHolders({
    run,
    resolve: (n) => {
      if (n === 'handle64') throw new Error('executable not found: handle64');
      return `C:/Windows/System32/${n}.exe`;
    },
  })('C:/x/app-1');
  assert.equal(fallback.source, 'tasklist');
  assert.deepEqual(fallback.holders, [{ process: 'Code.exe', pid: 111 }, { process: 'GitExtensions.exe', pid: 222 }]);
});
