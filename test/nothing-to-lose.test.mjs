process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNothingToLose, readIssueRefs } from '../lib/nothing-to-lose.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';
import { crossRef, github, serverError } from './helpers/fake-github.mjs';

const KEY = 'acme/app#1';
const MERGED_AT = '2026-11-02T00:00:00Z';
const TIP = 'b'.repeat(40);
const closed = (prs = []) => ({ state: 'closed', prs });
const merged = (number) => ({ number, state: 'merged', mergedAt: MERGED_AT });
const prAt = (number, sha, over = {}) => ({ number, state: 'closed', merged_at: MERGED_AT, head: { sha, ref: `b${number}` }, base: { ref: 'main' }, ...over });

// ---- decideNothingToLose: the pure rule ----

test('R194: a closed issue whose cross-referencing pull requests merged and whose branches hold nothing is proven', () => {
  const r = decideNothingToLose({
    key: KEY,
    refs: closed([merged(428), merged(439)]),
    branches: [
      { branch: 'worktree-app-1', tip: 'a'.repeat(40), ownCommits: false, lookup: null },
      { branch: 'fix-b', tip: TIP, ownCommits: true, lookup: { prs: [prAt(464, TIP)] } },
    ],
  });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.proofs.map((p) => [p.branch, p.pr.number]), [[null, 428], [null, 439], ['fix-b', 464]]);
  assert.deepEqual([...r.proven].sort(), ['fix-b', 'worktree-app-1']);
});

test('R194: an open issue refuses and reads no branch', () => {
  const r = decideNothingToLose({ key: KEY, refs: { state: 'open', prs: [] }, branches: [{ branch: 'x', tip: TIP, ownCommits: true, lookup: null }] });
  assert.deepEqual(r.problems, [`${KEY} is open`]);
  assert.deepEqual(r.proofs, []);
});

test('R194: a failed read of the issue refuses and names the issue', () => {
  const r = decideNothingToLose({ key: KEY, refs: { error: new Error('HTTP 500') }, branches: [] });
  assert.deepEqual(r.problems, [`cannot read ${KEY} and the pull requests that refer to it: HTTP 500`]);
});

test('R194: an open or unmerged cross-referencing pull request refuses', () => {
  const r = decideNothingToLose({ key: KEY, refs: closed([merged(1), { number: 2, state: 'open', mergedAt: null }, { number: 3, state: 'closed', mergedAt: null }]), branches: [] });
  assert.deepEqual(r.problems, [
    `pull request #2 refers to ${KEY} and is open`,
    `pull request #3 refers to ${KEY} and is closed without merge`,
  ]);
});

test('R194: a branch with commits of its own needs a merged pull request whose head is its tip', () => {
  const r = decideNothingToLose({
    key: KEY,
    refs: closed(),
    branches: [
      { branch: 'open-pr', tip: TIP, ownCommits: true, lookup: { prs: [prAt(5, TIP, { merged_at: null, state: 'open' })] } },
      { branch: 'other-head', tip: TIP, ownCommits: true, lookup: { prs: [prAt(6, 'c'.repeat(40))] } },
      { branch: 'failed', tip: TIP, ownCommits: true, lookup: { error: new Error('HTTP 502') } },
    ],
  });
  assert.deepEqual(r.problems, [
    `open-pr has commits of its own and its tip ${TIP.slice(0, 7)} is the head of no merged pull request`,
    `other-head has commits of its own and its tip ${TIP.slice(0, 7)} is the head of no merged pull request`,
    `cannot look up the pull requests of failed at ${TIP.slice(0, 7)}: HTTP 502`,
  ]);
  assert.equal(r.proven.size, 0);
});

test('R194: a pull request that refers to the issue and proves a branch is listed once, with its branch', () => {
  const r = decideNothingToLose({ key: KEY, refs: closed([merged(7)]), branches: [{ branch: 'fix', tip: TIP, ownCommits: true, lookup: { prs: [prAt(7, TIP)] } }] });
  assert.deepEqual(r.proofs.map((p) => [p.branch, p.pr.number]), [['fix', 7]]);
});

// ---- readIssueRefs: the live reader ----

test('R194: readIssueRefs keeps only pull requests of the same repository and reads no timeline for an open issue', async () => {
  const hub = github({
    issues: { 1: { labels: [], assignees: [], state: 'closed' }, 2: { labels: [], assignees: [] } },
    timeline: {
      1: [
        crossRef(428, { mergedAt: MERGED_AT }),
        crossRef(336, { state: 'open', pr: false }),
        crossRef(9, { state: 'open', repo: 'other/repo' }),
        crossRef(440, { state: 'open' }),
        { event: 'labeled' },
        crossRef(441, { state: 'closed' }),
      ],
    },
  });
  const r = await readIssueRefs(hub.gh, 'acme/app', 1);
  assert.deepEqual(r, {
    state: 'closed',
    prs: [
      { number: 428, state: 'merged', mergedAt: MERGED_AT },
      { number: 440, state: 'open', mergedAt: null },
      { number: 441, state: 'closed', mergedAt: null },
    ],
  });
  const before = hub.gh.calls.length;
  assert.deepEqual(await readIssueRefs(hub.gh, 'acme/app', 2), { state: 'open', prs: [] });
  assert.deepEqual(hub.gh.calls.slice(before).map((c) => c.key), ['GET repos/acme/app/issues/2']);
});

test('R194: readIssueRefs reads every page of the timeline', async () => {
  const filler = Array.from({ length: 100 }, () => ({ event: 'commented' }));
  const hub = github({ issues: { 1: { labels: [], assignees: [], state: 'closed' } }, timeline: { 1: [...filler, crossRef(12, { state: 'open' })] } });
  const r = await readIssueRefs(hub.gh, 'acme/app', 1);
  assert.deepEqual(r.prs, [{ number: 12, state: 'open', mergedAt: null }]);
  assert.deepEqual(hub.gh.calls.map((c) => c.key), [
    'GET repos/acme/app/issues/1',
    'GET repos/acme/app/issues/1/timeline?per_page=100&page=1',
    'GET repos/acme/app/issues/1/timeline?per_page=100&page=2',
  ]);
});

test('R194: readIssueRefs returns the error of a failed call', async () => {
  const gh = createFakeGh({
    'GET repos/acme/app/issues/1': () => ({ data: { number: 1, state: 'closed' } }),
    'GET repos/acme/app/issues/1/timeline?per_page=100&page=1': () => {
      throw serverError();
    },
  });
  const r = await readIssueRefs(gh, 'acme/app', 1);
  assert.match(r.error.message, /HTTP 500/);
});
