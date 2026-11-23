process.env.GVT_FLEET_FAKE_ONLY = '1';

// wrap's nothing-to-lose proof (#103): the work merged through pull requests that do not close the issue.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapCommand } from '../plugin/cli/lib/commands.mjs';
import { readIssueRefs } from '../plugin/cli/lib/nothing-to-lose.mjs';
import { readClosingPrs } from '../plugin/cli/lib/sync.mjs';
import { removeWorktree } from '../plugin/cli/lib/worktrees.mjs';
import { commitFile, fwd, g } from './helpers/git-sandbox.mjs';
import { LABEL, crossRef } from './helpers/fake-github.mjs';
import { BRANCH, KEY, REPOS } from './helpers/worktree-sandbox.mjs';
import {
  CONFIG,
  MERGED_AT,
  branchExists,
  commandCtx,
  prOf,
  rmKeepBranch,
  runWrap,
  wrapSetup,
} from './helpers/wrap-shared.mjs';

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const TIMELINE = 'GET repos/acme/app/issues/1/timeline?per_page=100&page=1';
const ISSUE_GET = 'GET repos/acme/app/issues/1';
const refsArgs = (s) => ({ readIssueRefs: () => readIssueRefs(s.deps.gh, 'acme/app', 1) });
const keys = (s) => s.hub.gh.calls.map((c) => c.key);

/**
 * The shape of game-backend#353, a real issue of a managed repository under a generic name: the issue branch has no commits of its own; the worker merged its work
 * from `fix-a` (pushed, PR #444) and `fix-b` (checked out, squash-merged as PR #464, not on any remote branch); PR #439
 * refers to the issue and is merged; none of them closes it. `issueState` and `refs` set the issue and its timeline.
 */
async function playfabShape(t, { issueState = 'closed', refs = [crossRef(439, { mergedAt: MERGED_AT })], fixB = 'merged', makeScript } = {}) {
  const s = await wrapSetup(t, { commit: false, push: null, makeScript: makeScript ?? ((x) => ({ rm: rmKeepBranch(x) })) });
  await g(s.wt, 'switch', '-c', 'fix-a', 'main');
  await commitFile(s.wt, 'a.txt', 'a\n');
  await g(s.wt, 'push', '-u', 'origin', 'fix-a');
  s.tipA = await g(s.wt, 'rev-parse', 'HEAD');
  await g(s.wt, 'switch', '-c', 'fix-b', 'main');
  await commitFile(s.wt, 'b.txt', 'b\n');
  s.tipB = await g(s.wt, 'rev-parse', 'HEAD');
  s.pulls.byCommit = { [s.tipA]: [prOf(444, s.tipA, 'fix-a')] };
  if (fixB === 'merged') s.pulls.byCommit[s.tipB] = [prOf(464, s.tipB, 'fix-b')];
  if (fixB === 'open') s.pulls.byCommit[s.tipB] = [prOf(464, s.tipB, 'fix-b', { state: 'open', merged_at: null })];
  s.hub = s.newHub({ issues: { 1: { labels: [LABEL], assignees: ['me'], state: issueState } }, timeline: { 1: refs } });
  s.deps.gh = s.hub.gh;
  return s;
}

test('R195: wrap accepts the game-backend#353 shape: issue closed, referring pull requests merged, every branch tip merged', async (t) => {
  const s = await playfabShape(t);
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'wrapped', `${r.reason}`);
  assert.deepEqual(r.steps, { proof: 'proven', worktree: 'removed', branch: 'deleted', claim: 'released' });
  assert.equal(r.branchFlag, '-D', 'the issue branch tip is on origin/main, so the proof consents to -D');
  assert.deepEqual(r.proofs.map((p) => [p.branch, p.pr.number]).sort((a, b) => a[1] - b[1]), [[null, 439], ['fix-a', 444], ['fix-b', 464]]);
  assert.deepEqual(r.otherBranches.map((b) => b.branch), ['fix-a']);
  assert.deepEqual(r.checkedOutBranch && { branch: r.checkedOutBranch.branch, tip: r.checkedOutBranch.tip }, { branch: 'fix-b', tip: s.tipB });
  assert.equal(fs.existsSync(s.wt), false);
  assert.equal(await branchExists(s), false);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R195: without the issue reader, the same shape is refused as before (the merge proof alone)', async (t) => {
  const s = await playfabShape(t);
  const r = await runWrap(s);
  assert.equal(r.status, 'refused');
  assert.equal(r.steps.proof, 'refused');
  assert.match(r.reason, /worktree-app-1 has no commits of its own and no closing pull request of acme\/app#1 is merged/);
  assert.doesNotMatch(r.reason, /nothing-to-lose/);
  assert.ok(!keys(s).includes(ISSUE_GET), 'no issue read without the reader');
});

test('R195: wrap refuses while the issue is open, and reads no timeline', async (t) => {
  const s = await playfabShape(t, { issueState: 'open' });
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes('no nothing-to-lose proof: acme/app#1 is open'), r.problems.join('\n'));
  assert.ok(!keys(s).includes(TIMELINE));
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.equal(fs.existsSync(s.wt), true);
});

test('R195: wrap refuses when a pull request that refers to the issue is open or closed without merge', async (t) => {
  const s = await playfabShape(t, { refs: [crossRef(439, { mergedAt: MERGED_AT }), crossRef(470, { state: 'open' }), crossRef(471, { state: 'closed' })] });
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes('no nothing-to-lose proof: pull request #470 refers to acme/app#1 and is open'), r.problems.join('\n'));
  assert.ok(r.problems.includes('no nothing-to-lose proof: pull request #471 refers to acme/app#1 and is closed without merge'), r.problems.join('\n'));
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R195: a pull request of another repository that refers to the issue does not block the wrap', async (t) => {
  const s = await playfabShape(t, { refs: [crossRef(439, { mergedAt: MERGED_AT }), crossRef(5, { state: 'open', repo: 'acme/other' })] });
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'wrapped', `${r.reason}`);
});

test('R195: wrap refuses when the checked-out branch has commits in no merged pull request', async (t) => {
  const s = await playfabShape(t, { fixB: 'open' });
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  const short = s.tipB.slice(0, 7);
  assert.ok(r.problems.includes(`no nothing-to-lose proof: fix-b has commits of its own and its tip ${short} is the head of no merged pull request`), r.problems.join('\n'));
  assert.equal(s.claims.getLease('L1').state, 'held');
});

test('R195: wrap refuses when a worked branch has commits in no merged pull request, even when it is pushed', async (t) => {
  const s = await playfabShape(t);
  s.pulls.byCommit[s.tipA] = [];
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes(`no nothing-to-lose proof: fix-a has commits of its own and its tip ${s.tipA.slice(0, 7)} is the head of no merged pull request`), r.problems.join('\n'));
});

test('R195: wrap refuses on untracked files and does not ask for the nothing-to-lose proof', async (t) => {
  const s = await playfabShape(t);
  fs.writeFileSync(`${s.wt}/left.txt`, 'left\n');
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.includes('the working tree has uncommitted changes'), r.problems.join('\n'));
  assert.ok(!keys(s).includes(ISSUE_GET), 'no issue read while work is left in the folder');
});

test('R195: wrap of a leftover branch (no worktree) accepts a closed issue whose referring pull requests merged', async (t) => {
  const s = await wrapSetup(t, { commit: false, push: null, makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  // Class C: the worktree and session are gone, the issue branch is left at main.
  await g(s.base, 'worktree', 'remove', '--force', fwd(s.wt));
  s.fake.sessions.length = 0;
  s.hub = s.newHub({ issues: { 1: { labels: [LABEL], assignees: ['me'], state: 'closed' } }, timeline: { 1: [crossRef(439, { mergedAt: MERGED_AT })] } });
  s.deps.gh = s.hub.gh;
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'wrapped', `${r.reason}`);
  assert.deepEqual(r.proofs.map((p) => p.pr.number), [439]);
  assert.equal(await branchExists(s), false);
});

test('R195: the wrap command reads the issue and its timeline, and ends wrapped on the game-backend#353 shape', async (t) => {
  const s = await playfabShape(t);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-ntl-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...CONFIG, repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const code = await wrapCommand(commandCtx(s, { configFile, out, err }), [KEY]);
  assert.equal(code, 0, err.join('\n'));
  assert.match(out.join('\n'), /wrapped/);
  assert.ok(keys(s).includes(ISSUE_GET));
  assert.ok(keys(s).includes(TIMELINE));
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R195: wrap with nothing left on disk accepts a closed issue whose referring pull requests merged', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  s.hub = s.newHub({ issues: { 1: { labels: [LABEL], assignees: ['me'], state: 'closed' } }, timeline: { 1: [crossRef(439, { mergedAt: MERGED_AT })] } });
  s.deps.gh = s.hub.gh;
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'wrapped', `${r.reason}`);
  assert.equal(r.steps.proof, 'proven');
  assert.deepEqual(r.proofs.map((p) => p.pr.number), [439]);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R195: wrap with nothing left on disk refuses an open issue and names both proofs', async (t) => {
  const s = await wrapSetup(t, { worktree: false });
  const r = await runWrap(s, refsArgs(s));
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [
    `${BRANCH} has no commits of its own and no closing pull request of acme/app#1 is merged; run gvt-fleet sync`,
    'no nothing-to-lose proof: acme/app#1 is open',
  ]);
});

// ---- #128: a merged pull request at the tip that does not close the issue ----

const closingRead = (s) => ({ readClosingPrs: () => readClosingPrs(s.deps.gh, 'acme/app', 1) });
const liveClosing = (number) => ({ number, state: 'MERGED', headRefName: BRANCH, repository: { nameWithOwner: 'acme/app' } });

/**
 * The case of #128: the issue branch has a commit of its own, pushed with an upstream, and PR #12 from it, at its tip, was
 * squash-merged into main with `Part of #1` (no closing keyword). `closing` is what the live read of the closing pull
 * requests returns, `issueState` the state of the issue, `refs` its timeline.
 */
async function partOfShape(t, { closing = [], issueState = 'open', refs = [] } = {}) {
  const s = await wrapSetup(t, { makeScript: (x) => ({ rm: rmKeepBranch(x) }) });
  s.pulls.byHead[BRANCH] = [prOf(12, s.tip, BRANCH)];
  s.pulls.byNumber['12'] = prOf(12, s.tip, BRANCH);
  s.hub = s.newHub({ issues: { 1: { labels: [LABEL], assignees: ['me'], state: issueState } }, closing, timeline: { 1: refs } });
  s.deps.gh = s.hub.gh;
  return s;
}

test('R205: wrap keeps the worktree, the session and the claim of an open issue whose only merged pull request does not close it', async (t) => {
  const s = await partOfShape(t);
  const r = await runWrap(s, { ...closingRead(s), ...refsArgs(s) });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.steps, { proof: 'refused', worktree: 'not-run', branch: 'not-run', claim: 'not-run' });
  assert.deepEqual(r.problems, [
    `pull request #12 from ${BRANCH} is merged at HEAD ${s.tip.slice(0, 7)} but is not a closing pull request of acme/app#1; the work is proven by the merged pull request that closes acme/app#1`,
    'no nothing-to-lose proof: acme/app#1 is open',
  ]);
  assert.deepEqual(r.proofs, []);
  assert.equal(fs.existsSync(s.wt), true);
  assert.equal(await branchExists(s), true);
  assert.equal(s.fake.sessions.length, 1, 'the session is kept');
  assert.deepEqual(s.fake.calls.filter((c) => c.op === 'stop' || c.op === 'rm'), []);
  assert.equal(s.claims.getLease('L1').state, 'held');
  assert.deepEqual(s.hub.gh.writes(), []);
});

test('R205: wrap still wraps the same branch once the live read lists its merged pull request as closing the issue', async (t) => {
  const s = await partOfShape(t, { closing: [liveClosing(12)] });
  const r = await runWrap(s, { ...closingRead(s), ...refsArgs(s) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.deepEqual(r.proofs.map((p) => [p.branch, p.pr.number]), [[BRANCH, 12]]);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R205: wrap of a closed issue whose merged pull requests do not close it passes on the nothing-to-lose proof', async (t) => {
  const s = await partOfShape(t, { issueState: 'closed', refs: [crossRef(12, { mergedAt: MERGED_AT })] });
  const r = await runWrap(s, { ...closingRead(s), ...refsArgs(s) });
  assert.equal(r.status, 'wrapped', r.reason);
  assert.equal(s.claims.getLease('L1').state, 'released');
});

test('R205: worktree remove --require-merged still takes a merged pull request at the tip that does not close the issue', async (t) => {
  // `requireClosing` is a wrap rule: removing the worktree keeps the claim, so the issue is not released.
  const s = await partOfShape(t);
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), requireMerged: true, defaultBranch: 'main', ...closingRead(s) });
  assert.notEqual(r.status, 'refused', r.reason);
  assert.equal(r.proofs[0].pr.number, 12);
  assert.equal(s.fake.calls.filter((c) => c.op === 'rm').length, 1);
  assert.equal(s.claims.getLease('L1').state, 'held');
});
