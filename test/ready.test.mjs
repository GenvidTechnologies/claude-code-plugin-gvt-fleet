process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRefsGrammar } from '../plugin/cli/lib/plugin-path.mjs';
import { buildGraph } from '../plugin/cli/lib/graph.mjs';
import { computeReady, explain, untriagedSummary } from '../plugin/cli/lib/ready.mjs';

const { extract } = await loadRefsGrammar();

const A = 'GenvidTechnologies/construct3-chef';
const M = 'GenvidTechnologies/mcp-utils';
const config = { claimAccount: 'someone', repos: [{ repo: A }, { repo: M }] };
const NOW = '2026-11-03T12:00:00Z';

function row(number, over = {}) {
  return { key: `${A}#${number}`, repo: A, number, state: 'open', labels: ['triaged'], title: `Issue ${number}`, body: '', comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], assignees: [], closingPrs: [], ...over };
}

function ready(rows, extra = {}) {
  const graph = buildGraph(rows, { extract, config });
  const entries = computeReady({ issues: rows, graph, claims: [], branchRecord: {}, config, now: NOW, extract, ...extra });
  return { graph, entries, byKey: (n) => entries.find((e) => e.key === `${A}#${n}`) };
}
const codes = (entry) => entry.reasons.map((r) => r.code);

const managedRow = (number, over = {}) => row(number, { managed: true, ...over });
const summaryOf = (rows) => untriagedSummary(ready(rows).entries, rows);

test('R125: an untriaged issue counts whatever its other reasons are, and onlyReason counts only the sole-reason ones', () => {
  const rows = [
    managedRow(1, { labels: [] }),
    managedRow(2, { labels: [], blockedBy: [`${A}#3`] }),
    managedRow(3),
  ];
  assert.deepEqual(codes(ready(rows).byKey(2)), ['not-triaged', 'blocked-by']);
  assert.deepEqual(summaryOf(rows), [{ repo: A, count: 2, keys: [`${A}#1`, `${A}#2`], onlyReason: 1 }]);
});

test('R125: closed and unmanaged issues are not counted', () => {
  const rows = [
    managedRow(1, { labels: [], state: 'closed' }),
    managedRow(2, { labels: [], managed: false }),
    row(3, { labels: [] }),
    managedRow(4, { labels: [] }),
  ];
  assert.deepEqual(summaryOf(rows), [{ repo: A, count: 1, keys: [`${A}#4`], onlyReason: 1 }]);
});

test('R125: a repository with no untriaged issue has no entry, and repos follow row order', () => {
  const rows = [
    managedRow(1, { repo: M, key: `${M}#1`, labels: [] }),
    managedRow(2),
    managedRow(3, { labels: [] }),
  ];
  assert.deepEqual(summaryOf(rows).map((u) => u.repo), [M, A]);
  assert.deepEqual(summaryOf([managedRow(1), managedRow(2, { repo: M, key: `${M}#2` })]), []);
});

test('R125: no untriaged issue gives an empty array', () => {
  assert.deepEqual(untriagedSummary([], []), []);
  assert.deepEqual(summaryOf([managedRow(1)]), []);
});

test('R14: issue meeting every condition is ready', () => {
  const { byKey } = ready([row(1)]);
  assert.deepEqual(byKey(1), { key: `${A}#1`, ready: true, reasons: [] });
});

test('R14: closed issue has the closed reason', () => {
  const e = ready([row(1, { state: 'CLOSED' })]).byKey(1);
  assert.equal(e.ready, false);
  assert.deepEqual(codes(e), ['closed']);
});

test('R14: issue without the triaged label has the not-triaged reason', () => {
  const e = ready([row(1, { labels: [] })]).byKey(1);
  assert.deepEqual(codes(e), ['not-triaged']);
});

test('R14: the per-repo triaged label from the config is the one checked', () => {
  const cfg = { claimAccount: 'someone', repos: [{ repo: A, triagedLabel: 'ready-for-work' }] };
  const rows = [row(1), row(2, { labels: ['ready-for-work'] })];
  const graph = buildGraph(rows, { extract, config: cfg });
  const out = computeReady({ issues: rows, graph, config: cfg, now: NOW });
  assert.deepEqual(out.map((e) => e.ready), [false, true]);
});

test('R14: open blocker gives blocked-by with the blocker key and edge source', () => {
  const rows = [row(1, { body: 'Blocked by #2' }), row(2)];
  const e = ready(rows).byKey(1);
  assert.deepEqual(codes(e), ['blocked-by']);
  assert.ok(e.reasons[0].detail.includes(`${A}#2`), e.reasons[0].detail);
  assert.ok(e.reasons[0].detail.includes('body-ref'), e.reasons[0].detail);
  const native = ready([row(1, { blockedBy: [`${A}#2`] }), row(2, { blocking: [`${A}#1`] })]).byKey(1);
  assert.ok(native.reasons[0].detail.includes('native-dependency'), native.reasons[0].detail);
});

test('R14: closed blocker is cleared', () => {
  const rows = [row(1, { body: 'Blocked by #2' }), row(2, { state: 'closed' })];
  const e = ready(rows).byKey(1);
  assert.equal(e.ready, true);
  assert.deepEqual(e.reasons, []);
});

test('R14: blocked label with no named blocker says blocked (label, blocker not named)', () => {
  const e = ready([row(1, { labels: ['triaged', 'blocked'] })]).byKey(1);
  assert.deepEqual(e.reasons, [{ code: 'blocked-label', detail: 'blocked (label, blocker not named)' }]);
});

test('R14: unresolvable blocker ref gives blocked-unresolved', () => {
  const e = ready([row(1, { body: '## Blocked by\n\nSomething later.\n' })]).byKey(1);
  assert.ok(codes(e).includes('blocked-unresolved'), JSON.stringify(e));
  assert.equal(e.ready, false);
});

test('R14: members of a dependency cycle have the cycle reason', () => {
  const rows = [row(1, { body: 'Blocked by #2' }), row(2, { body: 'Blocked by #1' }), row(3)];
  const r = ready(rows);
  assert.ok(codes(r.byKey(1)).includes('cycle'));
  assert.ok(codes(r.byKey(2)).includes('cycle'));
  assert.equal(r.byKey(3).ready, true);
  assert.ok(r.byKey(1).reasons.find((x) => x.code === 'cycle').detail.includes(`${A}#2`));
});

test('R14: issue with an open native sub-issue is an umbrella', () => {
  const r = ready([row(1, { subIssues: [`${A}#2`] }), row(2, { parent: `${A}#1` })]);
  assert.ok(codes(r.byKey(1)).includes('umbrella'));
  assert.equal(codes(r.byKey(2)).includes('umbrella'), false);
  const done = ready([row(1, { subIssues: [`${A}#2`] }), row(2, { parent: `${A}#1`, state: 'closed' })]);
  assert.equal(codes(done.byKey(1)).includes('umbrella'), false);
});

test('R14: epic title prefix makes an umbrella', () => {
  const e = ready([row(1, { title: 'epic: restructure the importer' })]).byKey(1);
  assert.deepEqual(codes(e), ['umbrella']);
});

test('R14: self-declared banner makes an umbrella', () => {
  const e = ready([row(1, { body: 'Do not plan this issue.\n\nSee the children.' })]).byKey(1);
  assert.deepEqual(codes(e), ['umbrella']);
});

test('R14: open checklist child makes an umbrella', () => {
  const r = ready([row(1, { body: '- [ ] #2' }), row(2)]);
  assert.ok(codes(r.byKey(1)).includes('umbrella'));
});

test('R14: unfired deferral trigger is deferred', () => {
  const text = ready([row(1, { body: 'Deferred until the cache is warm in production.' })]).byKey(1);
  assert.deepEqual(codes(text), ['deferred']);
  const open = ready([row(1, { body: 'Deferred until #2 ships' }), row(2)]).byKey(1);
  assert.ok(codes(open).includes('deferred'));
});

test('R14: deferral trigger naming a closed issue has fired', () => {
  const e = ready([row(1, { body: 'Deferred until #2 ships' }), row(2, { state: 'closed' })]).byKey(1);
  assert.equal(codes(e).includes('deferred'), false);
  assert.equal(e.ready, true);
});

test('R14: live local lease gives claimed and an expired or released lease does not', () => {
  const live = { key: `${A}#1`, state: 'held', expiresAt: '2026-11-03T13:00:00Z' };
  assert.deepEqual(codes(ready([row(1)], { claims: [live] }).byKey(1)), ['claimed']);
  const expired = { ...live, expiresAt: '2026-11-03T11:00:00Z' };
  assert.equal(ready([row(1)], { claims: [expired] }).byKey(1).ready, true);
  const released = { ...live, state: 'released' };
  assert.equal(ready([row(1)], { claims: [released] }).byKey(1).ready, true);
});

test('R14: in-progress label without a local lease is annotated hand claim', () => {
  const e = ready([row(1, { labels: ['triaged', 'in-progress'] })]).byKey(1);
  assert.deepEqual(e.reasons, [{ code: 'in-progress-label', detail: 'hand claim' }]);
});

test('R14: in-progress label with a local lease is not annotated hand claim', () => {
  const live = { key: `${A}#1`, state: 'held', expiresAt: '2026-11-03T13:00:00Z' };
  const e = ready([row(1, { labels: ['triaged', 'in-progress'] })], { claims: [live] }).byKey(1);
  assert.deepEqual(codes(e), ['claimed', 'in-progress-label']);
  assert.notEqual(e.reasons[1].detail, 'hand claim');
});

test('R14: assignee other than the claim account is assigned-to-other', () => {
  const other = ready([row(1, { assignees: ['someone-else'] })]).byKey(1);
  assert.deepEqual(codes(other), ['assigned-to-other']);
  const ours = ready([row(1, { assignees: ['someone'] })]).byKey(1);
  assert.equal(ours.ready, true);
  const both = ready([row(1, { assignees: [{ login: 'someone' }, { login: 'someone-else' }] })]).byKey(1);
  assert.deepEqual(codes(both), ['assigned-to-other']);
});

test('R14: open or merged closing PR gives closing-pr and a closed unmerged PR does not', () => {
  const open = ready([row(1, { closingPrs: [{ number: 5, state: 'OPEN' }] })]).byKey(1);
  assert.deepEqual(codes(open), ['closing-pr']);
  const merged = ready([row(1, { closingPrs: [{ number: 5, state: 'MERGED' }] })]).byKey(1);
  assert.deepEqual(codes(merged), ['closing-pr']);
  const closed = ready([row(1, { closingPrs: [{ number: 5, state: 'CLOSED' }] })]).byKey(1);
  assert.equal(closed.ready, true);
});

test('R14: recorded issue branch on the remote gives existing-branch with repo:branch', () => {
  const branchRecord = {
    version: 1,
    repos: { [A]: { 'feat/one': { disposition: 'issue', issue: `${A}#1`, decided: '2026-11-03', by: 'x' } } },
    remoteHeads: { [A]: ['main', 'feat/one'] },
  };
  const e = ready([row(1), row(2)], { branchRecord });
  assert.deepEqual(e.byKey(1).reasons, [{ code: 'existing-branch', detail: `${A}:feat/one` }]);
  assert.equal(e.byKey(2).ready, true);
});

test('R14: recorded issue branch gone from the remote does not block', () => {
  const branchRecord = {
    version: 1,
    repos: { [A]: { 'feat/one': { disposition: 'issue', issue: `${A}#1`, decided: '2026-11-03', by: 'x' } } },
    remoteHeads: { [A]: ['main'] },
  };
  assert.equal(ready([row(1)], { branchRecord }).byKey(1).ready, true);
});

test('R15: issue failing three conditions lists all three reasons', () => {
  const rows = [
    row(1, { labels: ['in-progress'], assignees: ['someone-else'], closingPrs: [{ number: 9, state: 'MERGED' }] }),
  ];
  const e = ready(rows).byKey(1);
  assert.deepEqual(codes(e).sort(), ['assigned-to-other', 'closing-pr', 'in-progress-label', 'not-triaged']);
  const three = ready([row(1, { assignees: ['someone-else'], closingPrs: [{ number: 9, state: 'OPEN' }], labels: ['triaged', 'blocked'] })]).byKey(1);
  assert.deepEqual(codes(three).sort(), ['assigned-to-other', 'blocked-label', 'closing-pr']);
});

test('R15: explain lists each reason and the edges that point at the issue', () => {
  const r = ready([row(1, { body: 'Blocked by #2' }), row(2)]);
  const lines = explain(r.byKey(1), r.graph);
  assert.ok(lines.some((l) => l.includes('blocked-by')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('edge') && l.includes(`${A}#2`) && l.includes('Blocked by #2')), lines.join('\n'));
});
