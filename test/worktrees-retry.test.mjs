process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  finishWorktree,
  findPullRequestsByCommit,
  names,
  removeWorktree,
} from '../plugin/cli/lib/worktrees.mjs';
import { GhError } from '../plugin/cli/lib/gh.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { noCommitFound, serverError } from './helpers/fake-github.mjs';
import { sequence } from './fakes/fake-claude.mjs';
import { git, halfRemoveWorktree } from './helpers/git-sandbox.mjs';
import {
  COMMITS_KEY,
  KEY,
  OK,
  REPOS,
  addWorktree,
  rmFully,
  setup,
} from './helpers/worktree-sandbox.mjs';
import { branchExists, droppedDirs, rmCalls } from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// ---- retry of a transient EBUSY or EPERM ----
// None of the `claude rm` outputs below says "still running", so the lock retry (which also sleeps 2000 ms) never
// fires: every entry of `s.sleeps` is a wait of the EBUSY retry.

const EBUSY_OUT = { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
const NO_HOLDERS = { source: 'stub', holders: [] };
const noHolders = (s) => {
  s.deps.findHolders = async (folder) => {
    s.holderCalls.push(folder);
    return NO_HOLDERS;
  };
};
const sessionGone = (x) => () => {
  x.fake.sessions.length = 0;
  return OK;
};
const halfFail = (x, out) => () => {
  halfRemoveWorktree(x.base, x.wt);
  return out;
};

test('R170: remove retries a transient EBUSY: git no longer lists the worktree, no holder, so it ends removed', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: sequence(halfFail(x, EBUSY_OUT), sessionGone(x)) }) });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(s.wt), false);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(r.removalAttempts, 2);
  assert.equal(r.attempts, 2);
  assert.equal(await branchExists(s), false, 'the branch step ran');
  assert.deepEqual(droppedDirs(s), []);
  assert.equal(s.claims.getLease('L1').wtState, 'removed');
});

test('R170: remove ends half-removed after three attempts when EBUSY lasts and no holder is found', async (t) => {
  const s = await setup(t, { makeScript: () => ({ rm: EBUSY_OUT }) });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.deepEqual(s.sleeps, [2000, 5000]);
  assert.equal(r.removalAttempts, 3);
  assert.equal(s.holderCalls.length, 3);
  assert.equal(rmCalls(s).length, 3);
  assert.deepEqual(r.holders, []);
  assert.equal(s.claims.getLease('L1').wtState, 'half-removed');
});

test('R170: remove reports half-removed at once, without a wait, when a holder is found', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: halfFail(x, EBUSY_OUT) }) });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.deepEqual(s.sleeps, []);
  assert.equal(r.removalAttempts, 1);
  assert.equal(s.holderCalls.length, 1);
  assert.deepEqual(r.holders, [{ process: 'Code.exe', pid: 42 }]);
});

test('R170: remove does not retry a half-removal whose rm output names neither EBUSY nor EPERM', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: halfFail(x, { code: 1, stdout: '', stderr: 'remove failed\n' }) }) });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.deepEqual(s.sleeps, []);
  assert.equal(r.removalAttempts, 1);
  assert.equal(s.holderCalls.length, 1);
  assert.equal(rmCalls(s).length, 1);
});

test('R170: remove retries claude rm when EBUSY leaves git listing the worktree, and ends removed when it then succeeds', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: sequence(EBUSY_OUT, rmFully(x)) }) });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(rmCalls(s).length, 2);
  assert.deepEqual(rmCalls(s).map((c) => c.id), ['abcd1234', 'abcd1234']);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(r.removalAttempts, 2);
  assert.equal(fs.existsSync(s.wt), false);
});

test('R170: between attempts remove makes no claude stop and no call other than claude rm and claude agents', async (t) => {
  const s = await setup(t, { makeScript: () => ({ rm: EBUSY_OUT }) });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.removalAttempts, 3);
  const ops = s.fake.calls.map((c) => c.op);
  const afterFirstRm = ops.slice(ops.indexOf('rm') + 1);
  assert.ok(afterFirstRm.includes('rm'), 'the retry called claude rm again');
  assert.deepEqual([...new Set(afterFirstRm)].sort(), ['agents', 'rm']);
});

test('R170: remove stops the retry and reports half-removed when git no longer lists the worktree but the folder holds other files', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: () => {
        halfRemoveWorktree(x.base, x.wt);
        fs.writeFileSync(path.join(x.wt, 'precious.txt'), 'mine', 'utf8');
        return EBUSY_OUT;
      },
    }),
  });
  noHolders(s);
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.equal(r.removalAttempts, 2);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(fs.readFileSync(path.join(s.wt, 'precious.txt'), 'utf8'), 'mine');
});

test('R170: remove retries the leftover folder when the failed delete already took its .git file', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: sequence(halfFail(x, EBUSY_OUT), sessionGone(x)) }) });
  noHolders(s);
  // A delete that fails half-way can remove the .git file and leave the empty folder; git then marks the entry prunable.
  s.deps.sleep = async (ms) => {
    s.sleeps.push(ms);
    fs.rmSync(path.join(s.wt, '.git'), { force: true });
  };
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(fs.existsSync(s.wt), false);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(r.removalAttempts, 2);
  assert.equal(await branchExists(s), false, 'the branch step ran');
  assert.deepEqual(droppedDirs(s), []);
});

test('R170: remove stops the retry when the session runs again during the wait', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: sequence(halfFail(x, EBUSY_OUT), sessionGone(x)) }) });
  noHolders(s);
  s.deps.sleep = async (ms) => {
    s.sleeps.push(ms);
    for (const e of s.fake.sessions) e.state = 'working';
  };
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'half-removed');
  assert.equal(r.removalAttempts, 1);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(rmCalls(s).length, 1, 'no second claude rm');
  assert.ok(fs.existsSync(s.wt));
  assert.match(r.notes.join('\n'), /running again/);
});

/** Run `body` while a child process holds `folder` as its current folder; the child is always ended. */
async function withHold(folder, body) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: folder, stdio: 'ignore' });
  const release = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  };
  try {
    await once(child, 'spawn');
    return await body(release);
  } finally {
    await release();
  }
}

async function leftoverSetup(t) {
  const s = await setup(t);
  await addWorktree(s, { state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  s.claims.immediate(() => s.claims.updateLease('L1', { wtState: 'half-removed' }));
  return s;
}

test('R171: finish retries a folder delete held by a process that exits during the first wait', async (t) => {
  const s = await leftoverSetup(t);
  noHolders(s);
  const r = await withHold(s.wt, async (release) => {
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      await release();
    };
    return finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  });
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(r.removalAttempts, 2);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
});

test('R171: finish deletes the leftover folder on the retry when the failed delete already took its .git file', async (t) => {
  const s = await leftoverSetup(t);
  noHolders(s);
  const r = await withHold(s.wt, async (release) => {
    s.deps.sleep = async (ms) => {
      s.sleeps.push(ms);
      fs.rmSync(path.join(s.wt, '.git'), { force: true });
      await release();
    };
    return finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  });
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(r.removalAttempts, 2);
  assert.equal(fs.existsSync(s.wt), false);
  assert.deepEqual(droppedDirs(s), []);
});

test('R171: finish ends held after three attempts when the folder stays held and no holder is found', async (t) => {
  const s = await leftoverSetup(t);
  noHolders(s);
  const r = await withHold(s.wt, () => finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) }));
  assert.equal(r.status, 'held');
  assert.deepEqual(s.sleeps, [2000, 5000]);
  assert.equal(r.removalAttempts, 3);
  assert.equal(s.holderCalls.length, 3);
  assert.deepEqual(r.holders, []);
  assert.equal(fs.existsSync(s.wt), true);
});

test('R171: finish reports held at once, without a wait, when a holder is found', async (t) => {
  const s = await leftoverSetup(t);
  const r = await withHold(s.wt, () => finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) }));
  assert.equal(r.status, 'held');
  assert.deepEqual(s.sleeps, []);
  assert.equal(r.removalAttempts, 1);
  assert.equal(s.holderCalls.length, 1);
  assert.deepEqual(r.holders, [{ process: 'Code.exe', pid: 42 }]);
});

const SHA = 'a'.repeat(40);

test('R173: findPullRequestsByCommit returns the pull requests that contain the commit', async () => {
  const prs = [{ number: 7, merged_at: '2026-11-01T00:00:00Z', head: { sha: SHA } }];
  const gh = createFakeGh({ [COMMITS_KEY(SHA)]: { data: prs } });
  assert.deepEqual(await findPullRequestsByCommit({ gh }, 'acme/app', SHA), { prs });
  assert.deepEqual(gh.calls.map((c) => c.key), [COMMITS_KEY(SHA)]);
});

test('R173: findPullRequestsByCommit returns {error} when the payload is not an array', async () => {
  const gh = createFakeGh({ [COMMITS_KEY(SHA)]: { data: { message: 'odd' } } });
  const r = await findPullRequestsByCommit({ gh }, 'acme/app', SHA);
  assert.deepEqual(Object.keys(r), ['error']);
  assert.match(r.error.message, /not an array/);
});

test('R173: findPullRequestsByCommit reports a 422 "No commit found" as noCommit with no pull requests', async () => {
  const gh = createFakeGh({
    [COMMITS_KEY(SHA)]: () => {
      throw noCommitFound(SHA);
    },
  });
  assert.deepEqual(await findPullRequestsByCommit({ gh }, 'acme/app', SHA), { prs: [], noCommit: true });
});

test('R173: findPullRequestsByCommit returns {error} for an HTTP 500 and for a 422 with other text', async () => {
  const failing = (e) =>
    createFakeGh({
      [COMMITS_KEY(SHA)]: () => {
        throw e;
      },
    });
  const e500 = serverError();
  const r500 = await findPullRequestsByCommit({ gh: failing(e500) }, 'acme/app', SHA);
  assert.deepEqual(Object.keys(r500), ['error']);
  assert.equal(r500.error, e500);
  const e422 = new GhError('gh api failed (1): gh: Validation Failed (HTTP 422)', { code: 1, stderr: 'gh: Validation Failed (HTTP 422)\n' });
  const r422 = await findPullRequestsByCommit({ gh: failing(e422) }, 'acme/app', SHA);
  assert.deepEqual(Object.keys(r422), ['error']);
  assert.equal(r422.error, e422);
});
