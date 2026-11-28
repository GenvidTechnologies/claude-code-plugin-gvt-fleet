process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { wrapCommand } from '../plugin/cli/lib/commands.mjs';
import { removeWorktree } from '../plugin/cli/lib/worktrees.mjs';
import { sequence } from './fakes/fake-claude.mjs';
import {
  commitFile,
  g,
  halfRemoveWorktree,
  pushCommit,
} from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  OK,
  REPOS,
} from './helpers/worktree-sandbox.mjs';
import {
  MERGED_AT,
  CONFIG,
  prOf,
  branchExists,
  claudeWrites,
  rmCalls,
  issueLabels,
  rmKeepBranch,
  wrapSetup,
  runWrap,
  commandCtx,
  provenFollowUp,
  closingArgs,
  closingAtTip,
} from './helpers/wrap-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

test('R118: wrap proves the merge, removes the worktree, deletes the branch and releases the claim', async (t) => {
  const s = await wrapSetup(t);
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'gone', claim: 'released' });
  assert.equal(r.pushedBranch, BRANCH);
  assert.deepEqual(r.proofs, [{ branch: BRANCH, pr: { number: 12, state: 'merged', mergedAt: MERGED_AT, headSha: s.tip } }]);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  const lease = s.claims.getLease('L1');
  assert.equal(lease.state, 'released');
  assert.equal(lease.wtState, 'wrapped');
  assert.deepEqual(issueLabels(s), []);
  assert.deepEqual(s.hub.state.issues[1].assignees, []);
  assert.deepEqual(s.fake.calls.filter((c) => c.op === 'stop' || c.op === 'rm').map((c) => `${c.op} ${c.id}`), ['stop abcd1234', 'rm abcd1234']);
});

test('R118: wrap releases the claim only after the worktree and the branch are gone', async (t) => {
  const trace = [];
  const s = await provenFollowUp(t, (x) => ({
    rm: async () => {
      trace.push(['rm', x.hub.gh.writes().length, x.claims.getLease('L1').state]);
      return rmKeepBranch(x)();
    },
  }));
  const realGit = s.deps.git;
  s.deps.git = {
    ...realGit,
    run: (args, opts) => {
      if (args[0] === 'branch' && /^-[dD]$/.test(args[1])) trace.push([`branch ${args[1]}`, s.hub.gh.writes().length, s.claims.getLease('L1').state]);
      return realGit.run(args, opts);
    },
  };
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(trace, [['rm', 0, 'held'], ['branch -D', 0, 'held']]);
  assert.ok(s.hub.gh.writes().length >= 2, 'the label and the assignee were removed after both steps');
  assert.equal(s.claims.getLease('L1').state, 'released');

  // A branch that is kept withholds the release: no GitHub write, the claim stays held.
  const kept = await wrapSetup(t, { commit: false, push: null, makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  kept.pulls.byNumber['9'] = prOf(9, 'a'.repeat(40), 'feature-z');
  await pushCommit(kept.sandbox, 'next.txt', 'n\n');
  await g(kept.base, 'fetch', 'origin');
  await g(kept.wt, 'reset', '--hard', 'origin/main');
  const k = await runWrap(kept, closingArgs);
  assert.equal(k.status, 'branch-kept');
  assert.equal(k.steps.claim, 'not-run');
  assert.deepEqual(kept.hub.gh.writes(), []);
  assert.equal(kept.claims.getLease('L1').state, 'held');
});

test('R119: wrap refuses unpushed or unproven work with the problems remove --require-merged reports and changes nothing', async (t) => {
  const s = await wrapSetup(t, { push: null });
  const snapshot = async () => ({
    lease: s.claims.getLease('L1'),
    tip: await g(s.base, 'rev-parse', `refs/heads/${BRANCH}`),
    list: await g(s.base, 'worktree', 'list', '--porcelain'),
    entries: fs.readdirSync(s.wt).sort(),
    sessions: JSON.stringify(s.fake.sessions),
  });
  const before = await snapshot();
  const removal = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), requireMerged: true, closingPrs: [], defaultBranch: 'main' });
  assert.equal(removal.status, 'refused');
  assert.ok(removal.problems.length > 0);
  assert.deepEqual(await snapshot(), before, 'the reference refusal changes nothing either');
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, removal.problems);
  assert.deepEqual(r.steps, { proof: 'refused', worktree: 'not-run', branch: 'not-run', claim: 'not-run' });
  assert.match(r.hint, new RegExp(`gvt-fleet worktree remove ${KEY} --discard.*gvt-fleet release ${KEY}`));
  assert.deepEqual(s.hub.gh.writes(), []);
  assert.deepEqual(claudeWrites(s), []);
  assert.deepEqual(await snapshot(), before);
});

test('R119: wrap passes no discard value to claude rm for a commit that the merge proof does not cover', async (t) => {
  // The value names 1234abc, not the proven tip, so the proven-tip consent of decision record 0026 does not apply.
  const refusal = 'unpushed commits; run again with --discard-unpushed 1234abc@wt-9\n';
  const s = await wrapSetup(t, { makeScript: () => ({ rm: { code: 1, stdout: '', stderr: refusal } }) });
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'refused', branch: 'not-run', claim: 'not-run' });
  assert.match(r.reason, /claude rm refused/);
  assert.equal(rmCalls(s).length, 1, 'no second rm with a discard value');
  assert.ok(rmCalls(s).every((c) => !('discardUnpushed' in c)));
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.equal(s.claims.getLease('L1').discardHead, null);
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R127: wrap deletes worktree-app-1 with -D when its tip is the head of a merged pull request and on a remote branch', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D');
  assert.equal(r.pushedBranch, 'feature-z');
  assert.equal(await branchExists(s), false);
});

test('R127: wrap keeps the branch when its tip is on no remote branch', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  await g(s.base, 'push', 'origin', '--delete', 'feature-z');
  await g(s.base, 'fetch', '--prune', 'origin');
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'branch-kept');
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'kept', claim: 'not-run' });
  assert.equal(r.branchFlag, '-d');
  assert.match(r.reason, /-D was not used: no remote-tracking branch contains /);
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R127: wrap keeps the branch when only a pull request of another branch proved the merge', async (t) => {
  const s = await wrapSetup(t, { commit: false, push: null, makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  // The branch sits at the new tip of origin/main, which the base clone has not merged into its own main.
  await pushCommit(s.sandbox, 'next.txt', 'n\n');
  await g(s.base, 'fetch', 'origin');
  await g(s.wt, 'reset', '--hard', 'origin/main');
  s.pulls.byNumber['9'] = prOf(9, 'a'.repeat(40), 'feature-z');
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'branch-kept');
  assert.equal(r.steps.proof, 'proven');
  assert.equal(r.branchFlag, '-d');
  assert.match(r.reason, /-D was not used: only a pull request of another branch proved the merge/);
  assert.equal(await branchExists(s), true);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R127: wrap uses -d when the branch moved after the check', async (t) => {
  const s = await provenFollowUp(t, (x) => ({
    rm: async () => {
      // A late commit on the issue branch, after the proof was taken.
      await g(x.wt, 'switch', BRANCH);
      await commitFile(x.wt, 'late.txt', 'late\n');
      return rmKeepBranch(x)();
    },
  }));
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'branch-kept');
  assert.equal(r.branchFlag, '-d');
  assert.match(r.reason, /-D was not used: worktree-app-1 moved from [0-9a-f]{7} to [0-9a-f]{7} after the check/);
  assert.equal(await branchExists(s), true);
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R128: wrap after branch-kept continues at the branch step and then releases', async (t) => {
  const s = await provenFollowUp(t, (x) => ({ rm: rmKeepBranch(x) }));
  await g(s.base, 'push', 'origin', '--delete', 'feature-z');
  await g(s.base, 'fetch', '--prune', 'origin');
  const first = await runWrap(s, closingArgs);
  assert.equal(first.status, 'branch-kept');
  const claudeBefore = claudeWrites(s).length;
  // The work reaches a remote branch; the rerun sees the leftover branch only.
  await g(s.base, 'push', 'origin', `${BRANCH}:feature-z`);
  const r = await runWrap(s, closingArgs);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'gone', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D');
  assert.equal(await branchExists(s), false);
  assert.equal(claudeWrites(s).length, claudeBefore, 'the rerun called neither stop nor rm');
  assert.equal(s.claims.getLease('L1').state, 'released');
  assert.equal(s.claims.getLease('L1').wtState, 'wrapped');
});

test('R128: wrap stops at half-removed with the holders and the next step, and a rerun finishes and releases', async (t) => {
  const halfFail = (x) => () => {
    halfRemoveWorktree(x.base, x.wt);
    return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
  };
  const s = await wrapSetup(t, {
    makeScript: (x) => ({
      rm: sequence(halfFail(x), () => {
        x.fake.sessions.length = 0;
        return OK;
      }),
    }),
  });
  closingAtTip(s);
  const first = await runWrap(s);
  assert.equal(first.status, 'half-removed');
  assert.deepEqual(first.steps, { proof: 'proven', worktree: 'half-removed', branch: 'not-run', claim: 'not-run' });
  assert.deepEqual(first.holders, [{ process: 'Code.exe', pid: 42 }]);
  assert.equal(first.holderSource, 'stub');
  assert.match(first.hint, new RegExp(`close them, then run gvt-fleet wrap ${KEY} again`));
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.equal(s.claims.getLease('L1').wtState, 'half-removed');
  assert.deepEqual(s.hub.gh.writes(), []);

  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D');
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R128: wrap stops at held when the leftover folder is busy', async (t) => {
  const s = await wrapSetup(t, {
    state: 'done',
    makeScript: (x) => ({
      rm: () => {
        x.fake.sessions.length = 0;
        return OK;
      },
    }),
  });
  closingAtTip(s);
  halfRemoveWorktree(s.base, s.wt);
  // A process whose current folder is the leftover folder keeps Windows from deleting it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: s.wt, stdio: 'ignore' });
  let held;
  try {
    await once(child, 'spawn');
    held = await runWrap(s);
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  }
  assert.equal(held.status, 'held');
  assert.deepEqual(held.steps, { proof: 'proven', worktree: 'held', branch: 'not-run', claim: 'not-run' });
  assert.deepEqual(held.holders, [{ process: 'Code.exe', pid: 42 }]);
  assert.match(held.hint, new RegExp(`close them, then run gvt-fleet wrap ${KEY} again`));
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);
  assert.equal(await branchExists(s), true);

  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(r.steps.claim, 'released');
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
});

test('R172: wrap retries a transient EBUSY with no holder and ends wrapped in one call', async (t) => {
  const s = await wrapSetup(t, {
    makeScript: (x) => ({
      rm: sequence(
        () => {
          halfRemoveWorktree(x.base, x.wt);
          return { code: 1, stdout: '', stderr: 'worktree kept: EBUSY: resource busy or locked\n' };
        },
        () => {
          x.fake.sessions.length = 0;
          return OK;
        },
      ),
    }),
  });
  s.deps.findHolders = async () => ({ source: 'stub', holders: [] });
  closingAtTip(s);
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.deepEqual(s.sleeps, [2000]);
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R128: wrap after a failed release retries only the release', async (t) => {
  const s = await wrapSetup(t, { failDelete: true });
  closingAtTip(s);
  const first = await runWrap(s);
  assert.equal(first.status, 'failed');
  assert.deepEqual(first.steps, { proof: 'proven', worktree: 'removed', branch: 'gone', claim: 'failed' });
  assert.match(first.hint, new RegExp(`gvt-fleet wrap ${KEY} again.*only the release`));
  assert.equal(s.claims.getLease('L1').state, 'releasing');
  assert.equal(s.claims.getLease('L1').wtState, 'wrapped');

  const claudeBefore = claudeWrites(s).length;
  const again = s.newHub();
  s.deps.gh = again.gh;
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.steps, { proof: 'earlier', worktree: 'gone', branch: 'gone', claim: 'released' });
  assert.equal(claudeWrites(s).length, claudeBefore, 'the rerun called neither stop nor rm');
  assert.ok(again.gh.calls.every((c) => c.path.includes('/issues/1')), `only the release called GitHub: ${again.gh.calls.map((c) => c.key).join(', ')}`);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R128: wrap after full success reports wrapped with nothing true and exits 0', async (t) => {
  const s = await wrapSetup(t);
  closingAtTip(s);
  const first = await runWrap(s);
  assert.equal(first.status, 'wrapped', first.reason);
  assert.equal(first.nothing, undefined);
  const claudeBefore = claudeWrites(s).length;
  const again = s.newHub();
  s.deps.gh = again.gh;
  const r = await runWrap(s);
  assert.equal(r.status, 'wrapped');
  assert.equal(r.nothing, true);
  assert.deepEqual(r.steps, { proof: 'earlier', worktree: 'gone', branch: 'gone', claim: 'released-earlier' });
  assert.deepEqual(again.gh.calls, [], 'no GitHub call');
  assert.equal(claudeWrites(s).length, claudeBefore, 'the rerun called neither stop nor rm');
  assert.equal(s.claims.getLease('L1').state, 'released');

  // The command reports the same rerun as success: exit code 0.
  const cmdDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-wrap-cmd-'));
  t.after(() => fs.rmSync(cmdDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configFile = path.join(cmdDir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...CONFIG, repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const ctx = commandCtx(s, { configFile, out, err });
  ctx.gh = s.newHub().gh;
  assert.equal(await wrapCommand(ctx, [KEY]), 0, err.join('\n'));
  assert.match(out.join('\n'), /wrapped/);
});
