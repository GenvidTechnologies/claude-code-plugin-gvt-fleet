process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideProof, prSummary } from '../plugin/cli/lib/merge-proof.mjs';

const TIP = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'worktree-demo-1';

const pr = (number, { sha = TIP, merged = true, state = merged ? 'closed' : 'open', ref = 'feat/x', base = 'main', mergedAt = '2026-11-01T00:00:00Z' } = {}) => ({
  number,
  state,
  merged_at: merged ? mergedAt : null,
  head: { sha, ref },
  base: { ref: base },
});

const facts = (over = {}) => ({
  requireMerged: true,
  tip: TIP,
  headIsTip: true,
  ownCommits: true,
  branch: BRANCH,
  key: 'o/r#1',
  repo: 'o/r',
  issueRemote: BRANCH,
  hasUpstream: false,
  l1: { prs: [] },
  l2: [],
  closingPrs: [],
  defaultBranch: 'main',
  ...over,
});

test('R129: decideProof requires a merged pull request whose head is the tip when the issue branch has commits of its own', () => {
  // Facts without `detached` and a merged l1 at the tip prove, whatever HEAD is.
  const det = decideProof(facts({ headIsTip: false, l1: { prs: [pr(4, { ref: BRANCH })] } }));
  assert.deepEqual(det.problems, []);
  assert.equal(det.proofs[0].pr.number, 4);

  // Satisfied by a merged pull request found by head branch.
  const viaL1 = decideProof(facts({ l1: { prs: [pr(5, { ref: BRANCH })] } }));
  assert.deepEqual(viaL1.problems, []);
  assert.deepEqual(viaL1.proofs, [{ branch: BRANCH, pr: { number: 5, state: 'merged', mergedAt: '2026-11-01T00:00:00Z', headSha: TIP } }]);
  assert.equal(viaL1.provenTip, TIP);
  assert.equal(viaL1.pr.number, 5);

  // Satisfied by a closing pull request of another branch whose head is the tip.
  const viaL2 = decideProof(facts({ l2: [{ number: 9, pr: pr(9, { ref: 'feat/other-name' }) }], closingPrs: [{ number: 9 }] }));
  assert.deepEqual(viaL2.problems, []);
  assert.deepEqual(viaL2.proofs.map((p) => p.branch), ['feat/other-name']);
  assert.equal(viaL2.provenTip, TIP);

  // Rule 6: a merged pull request whose head is not the tip does not satisfy.
  const wrongHead = decideProof(facts({ l1: { prs: [pr(6, { sha: OTHER, ref: BRANCH })] }, l2: [{ number: 9, pr: pr(9, { sha: OTHER }) }], closingPrs: [{ number: 9 }] }));
  assert.deepEqual(wrongHead.problems, [`pull request #6 (merged) from ${BRANCH} is not merged at HEAD ${TIP.slice(0, 7)}`]);
  assert.deepEqual(wrongHead.proofs, []);
  assert.equal(wrongHead.provenTip, null);

  // The wording when HEAD is not the tip, and when no pull request exists.
  const away = decideProof(facts({ headIsTip: false, l1: { prs: [pr(6, { sha: OTHER })] } }));
  assert.deepEqual(away.problems, [`pull request #6 (merged) from ${BRANCH} is not merged at the tip of ${BRANCH} ${TIP.slice(0, 7)}`]);
  assert.deepEqual(decideProof(facts()).problems, [`no pull request from ${BRANCH}`]);
});

test('R129: decideProof uses merged closing pull requests when the issue branch has no commits of its own, and gives no proven tip', () => {
  const merged = decideProof(facts({ ownCommits: false, l1: { prs: [] }, l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a' }) }, { number: 4, pr: pr(4, { sha: OTHER, ref: 'feat/b' }) }], closingPrs: [{ number: 3 }, { number: 4 }] }));
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.proofs.map((p) => [p.branch, p.pr.number]), [['feat/a', 3], ['feat/b', 4]]);
  assert.equal(merged.provenTip, null);

  // No issue branch at all: the same rule, and no pushed branch.
  const absent = decideProof(facts({ tip: null, ownCommits: false, issueRemote: null, l1: null, l2: [{ number: 3, pr: pr(3, { ref: 'feat/a' }) }], closingPrs: [{ number: 3 }] }));
  assert.deepEqual(absent.problems, []);
  assert.equal(absent.provenTip, null);
  assert.equal(absent.pushedBranch, null);

  // Nothing merged: the problem, with the sync hint only when the cache holds no closing pull request.
  const noCache = decideProof(facts({ ownCommits: false }));
  assert.deepEqual(noCache.problems, [`${BRANCH} has no commits of its own and no closing pull request of o/r#1 is merged; run gvt-fleet sync`]);
  const cached = decideProof(facts({ ownCommits: false, l2: [{ number: 3, pr: pr(3, { merged: false }) }], closingPrs: [{ number: 3 }] }));
  assert.ok(cached.problems.includes(`${BRANCH} has no commits of its own and no closing pull request of o/r#1 is merged`));

  // Pushed branch: the upstream name wins; else the proving pull request's branch in the same repo; else the local name.
  const l1Pr = pr(5, { ref: 'feat/renamed' });
  assert.equal(decideProof(facts({ hasUpstream: true, issueRemote: 'up/name', l1: { prs: [l1Pr] } })).pushedBranch, 'up/name');
  assert.equal(decideProof(facts({ l2: [{ number: 9, pr: { ...pr(9, { ref: 'feat/renamed' }), head: { sha: TIP, ref: 'feat/renamed', repo: { full_name: 'O/R' } } } }] })).pushedBranch, 'feat/renamed');
  assert.equal(decideProof(facts({ l2: [{ number: 9, pr: { ...pr(9, { ref: 'feat/fork' }), head: { sha: TIP, ref: 'feat/fork', repo: { full_name: 'fork/r' } } } }] })).pushedBranch, BRANCH);

  // prSummary reports a merged pull request as merged, and keeps the state otherwise.
  assert.deepEqual(prSummary(pr(7)), { number: 7, state: 'merged', mergedAt: '2026-11-01T00:00:00Z', headSha: TIP });
  assert.deepEqual(prSummary(pr(8, { merged: false })), { number: 8, state: 'open', mergedAt: null, headSha: TIP });
});

test('R129: decideProof refuses on an open or unreadable closing pull request', () => {
  // Rule 3: an open closing pull request is a problem even when the tip is proven by another pull request.
  const open = decideProof(facts({ l1: { prs: [pr(5, { ref: BRANCH })] }, l2: [{ number: 8, pr: pr(8, { merged: false, ref: 'feat/open' }) }], closingPrs: [{ number: 8 }] }));
  assert.deepEqual(open.problems, ['closing pull request #8 from feat/open is open']);

  // Rule 2: a failed closing pull request lookup.
  const l2Fail = decideProof(facts({ ownCommits: false, l2: [{ number: 8, error: new Error('boom') }], closingPrs: [{ number: 8 }] }));
  assert.deepEqual(l2Fail.problems, ['cannot look up closing pull request #8: boom']);
  assert.deepEqual(l2Fail.proofs, []);

  // Rule 2: a failed lookup by head branch keeps today's text.
  const l1Fail = decideProof(facts({ l1: { error: new Error('offline') } }));
  assert.deepEqual(l1Fail.problems, [`cannot look up pull requests from ${BRANCH}: offline`]);
  assert.equal(l1Fail.provenTip, null);

  // A failure beside a proof does not erase the failure.
  const both = decideProof(facts({ l1: { prs: [pr(5, { ref: BRANCH })] }, l2: [{ number: 8, error: 'nope' }], closingPrs: [{ number: 8 }] }));
  assert.deepEqual(both.problems, ['cannot look up closing pull request #8: nope']);
});

test('R178: decideProof adds the rule-2 problem for a failed live read of the closing pull requests', () => {
  const failed = decideProof(facts({ ownCommits: false, closingRead: { error: new Error('graphql down') } }));
  assert.deepEqual(failed.problems, ['cannot read the closing pull requests of o/r#1: graphql down']);
  assert.deepEqual(failed.proofs, []);
  // The failure also holds when the issue branch has commits of its own.
  const own = decideProof(facts({ closingRead: { error: 'offline' } }));
  assert.deepEqual(own.problems, ['cannot read the closing pull requests of o/r#1: offline']);
});

test('R178: decideProof drops the sync hint only when a live read of the closing pull requests ran', () => {
  const hint = `${BRANCH} has no commits of its own and no closing pull request of o/r#1 is merged`;
  const live = decideProof(facts({ ownCommits: false, closingRead: { prs: [] } }));
  assert.deepEqual(live.problems, [hint]);
  const cached = decideProof(facts({ ownCommits: false }));
  assert.deepEqual(cached.problems, [`${hint}; run gvt-fleet sync`]);
});

test('R181: decideProof counts a merged pull request at the tip only when it merged into the default branch', () => {
  const release = decideProof(facts({ l1: { prs: [pr(5, { ref: BRANCH, base: 'release' })] } }));
  assert.deepEqual(release.problems, [`pull request #5 from ${BRANCH} is merged into release, not into the default branch main`]);
  assert.deepEqual(release.proofs, []);
  assert.equal(release.provenTip, null);

  // A closing pull request of another branch at the tip follows the same rule.
  const viaL2 = decideProof(facts({ l2: [{ number: 9, pr: pr(9, { ref: 'feat/other-name', base: 'release' }) }], closingPrs: [{ number: 9 }] }));
  assert.deepEqual(viaL2.problems, ['pull request #9 from feat/other-name is merged into release, not into the default branch main']);
  assert.deepEqual(viaL2.proofs, []);

  // A pull request into the default branch beside it still proves the work.
  const both = decideProof(facts({ l1: { prs: [pr(5, { ref: BRANCH, base: 'release' }), pr(6, { ref: BRANCH })] } }));
  assert.deepEqual(both.problems, []);
  assert.equal(both.proofs[0].pr.number, 6);
  assert.equal(both.provenTip, TIP);

  // A pull request with no base in its answer is not on the default branch.
  const noBase = decideProof(facts({ l1: { prs: [{ ...pr(5, { ref: BRANCH }), base: undefined }] } }));
  assert.deepEqual(noBase.problems, [`pull request #5 from ${BRANCH} is merged into an unknown branch, not into the default branch main`]);
});

test('R181: decideProof counts a merged closing pull request of another branch only when it merged into the default branch', () => {
  const release = decideProof(facts({ ownCommits: false, l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a', base: 'release' }) }], closingPrs: [{ number: 3 }] }));
  assert.deepEqual(release.problems, ['closing pull request #3 from feat/a is merged into release, not into the default branch main']);
  assert.deepEqual(release.proofs, []);

  const mixed = decideProof(facts({ ownCommits: false, l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a', base: 'release' }) }, { number: 4, pr: pr(4, { sha: OTHER, ref: 'feat/b' }) }], closingPrs: [{ number: 3 }, { number: 4 }] }));
  assert.deepEqual(mixed.problems, []);
  assert.deepEqual(mixed.proofs.map((p) => p.pr.number), [4]);
});

test('R181: decideProof proves nothing when the default branch is unknown', () => {
  const unknown = 'the default branch of o/r is unknown, so no pull request can prove the merge; run gvt-fleet sync';
  const own = decideProof(facts({ defaultBranch: undefined, l1: { prs: [pr(5, { ref: BRANCH })] } }));
  assert.ok(own.problems.includes(unknown), own.problems.join('; '));
  assert.deepEqual(own.proofs, []);
  assert.equal(own.provenTip, null);

  const closing = decideProof(facts({ defaultBranch: null, ownCommits: false, l2: [{ number: 3, pr: pr(3, { ref: 'feat/a' }) }], closingPrs: [{ number: 3 }] }));
  assert.ok(closing.problems.includes(unknown), closing.problems.join('; '));
  assert.deepEqual(closing.proofs, []);

  // Without requireMerged no rule runs, the base rule included.
  assert.deepEqual(decideProof(facts({ requireMerged: false, defaultBranch: undefined })).problems, []);
});

test('R182: decideProof with notBefore counts a closing pull request of another branch only when it merged at or after that time', () => {
  const at = '2026-11-01T00:00:00Z';
  const old = decideProof(facts({ ownCommits: false, notBefore: '2026-11-02T00:00:00.000Z', l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a', mergedAt: at }) }], closingPrs: [{ number: 3 }] }));
  assert.deepEqual(old.problems, [`closing pull request #3 from feat/a was merged at ${at}, before the claim at 2026-11-02T00:00:00.000Z`]);
  assert.deepEqual(old.proofs, []);

  // Merged at the claim time, or after it, proves.
  for (const notBefore of [at, '2026-10-31T00:00:00.000Z']) {
    const ok = decideProof(facts({ ownCommits: false, notBefore, l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a', mergedAt: at }) }], closingPrs: [{ number: 3 }] }));
    assert.deepEqual(ok.problems, [], notBefore);
    assert.deepEqual(ok.proofs.map((p) => p.pr.number), [3]);
  }

  // An older one beside a newer one: the newer one is the proof.
  const mixed = decideProof(facts({
    ownCommits: false, notBefore: '2026-11-02T00:00:00.000Z',
    l2: [{ number: 3, pr: pr(3, { sha: OTHER, ref: 'feat/a', mergedAt: at }) }, { number: 4, pr: pr(4, { sha: OTHER, ref: 'feat/b', mergedAt: '2026-11-03T00:00:00Z' }) }],
    closingPrs: [{ number: 3 }, { number: 4 }],
  }));
  assert.deepEqual(mixed.problems, []);
  assert.deepEqual(mixed.proofs.map((p) => p.pr.number), [4]);
});

test('R204: under requireClosing a merged pull request at the tip proves the work only when it closes the issue', () => {
  const partOf = pr(12, { ref: BRANCH });
  // Without requireClosing (worktree remove --require-merged), the pull request found by head branch proves the work.
  assert.deepEqual(decideProof(facts({ l1: { prs: [partOf] } })).problems, []);

  // With requireClosing (wrap), the same pull request does not, and the problem names it.
  const refused = decideProof(facts({ requireClosing: true, l1: { prs: [partOf] }, closingRead: { prs: [] } }));
  assert.deepEqual(refused.proofs, []);
  assert.equal(refused.provenTip, null);
  assert.deepEqual(refused.problems, [`pull request #12 from ${BRANCH} is merged at HEAD aaaaaaa but is not a closing pull request of o/r#1; the work is proven by the merged pull request that closes o/r#1`]);

  // A cached closing list without it suggests a sync, in case the closing keyword came after the last one.
  const cached = decideProof(facts({ requireClosing: true, l1: { prs: [partOf] }, l2: [{ number: 9, pr: pr(9, { sha: OTHER, ref: 'feat/other' }) }], closingPrs: [{ number: 9 }] }));
  assert.match(cached.problems.join('; '), /is not a closing pull request of o\/r#1; .*; if it closes o\/r#1, run gvt-fleet sync$/);

  // The same pull request listed as closing proves the work.
  const closing = decideProof(facts({ requireClosing: true, l1: { prs: [partOf] }, l2: [{ number: 12, pr: partOf }], closingPrs: [{ number: 12 }] }));
  assert.deepEqual(closing.problems, []);
  assert.deepEqual(closing.proofs.map((p) => p.pr.number), [12]);
  assert.equal(closing.provenTip, TIP);

  // Rule 7 still names one merged into another branch.
  const intoRelease = decideProof(facts({ requireClosing: true, l1: { prs: [pr(12, { ref: BRANCH, base: 'release' })] } }));
  assert.deepEqual(intoRelease.problems, [`pull request #12 from ${BRANCH} is merged into release, not into the default branch main`]);
});

test('R204: requireClosing leaves rule 5 unchanged for a branch with no commits of its own', () => {
  const merged = decideProof(facts({ requireClosing: true, ownCommits: false, l2: [{ number: 9, pr: pr(9, { sha: OTHER, ref: 'feat/other' }) }], closingPrs: [{ number: 9 }] }));
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.proofs.map((p) => p.pr.number), [9]);
});
