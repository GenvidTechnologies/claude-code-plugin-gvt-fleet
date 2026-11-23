process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRefsGrammar } from '../lib/plugin-path.mjs';
import { buildGraph, isUmbrella } from '../lib/graph.mjs';

const { extract } = await loadRefsGrammar();

const A = 'GenvidTechnologies/construct3-chef';
const M = 'GenvidTechnologies/mcp-utils';
const config = { repos: [{ repo: A }, { repo: M }] };

function row(repo, number, over = {}) {
  return { key: `${repo}#${number}`, repo, number, state: 'open', labels: [], body: '', comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], ...over };
}
const build = (rows) => buildGraph(rows, { extract, config });
const find = (g, from, to, source) => g.edges.find((e) => e.from === from && e.to === to && (!source || e.source === source));

test('R9: each edge carries one of native-dependency, sub-issue, body-ref, label', () => {
  const g = build([
    row(A, 1, { blockedBy: [`${A}#2`] }),
    row(A, 2, { blocking: [`${A}#1`] }),
    row(A, 3, { subIssues: [`${A}#4`] }),
    row(A, 4, { parent: `${A}#3` }),
    row(A, 5, { body: 'Blocked by #2' }),
    row(A, 6, { labels: ['blocked'] }),
  ]);
  assert.ok(find(g, `${A}#2`, `${A}#1`, 'native-dependency'));
  assert.ok(find(g, `${A}#4`, `${A}#3`, 'sub-issue'));
  assert.ok(find(g, `${A}#2`, `${A}#5`, 'body-ref'));
  assert.ok(find(g, null, `${A}#6`, 'label'));
  const allowed = new Set(['native-dependency', 'sub-issue', 'body-ref', 'label']);
  assert.ok(g.edges.length >= 4);
  for (const e of g.edges) assert.ok(allowed.has(e.source), e.source);
  assert.deepEqual(g.warnings, []);
});

test('R9: a label edge is not emitted when a named blocker edge exists', () => {
  const g = build([row(A, 1, { labels: ['blocked'], body: 'Blocked by #2' }), row(A, 2)]);
  assert.equal(g.edges.filter((e) => e.source === 'label').length, 0);
  assert.ok(find(g, `${A}#2`, `${A}#1`, 'body-ref'));
});

test('R9: a native mismatch is reported as a warning', () => {
  const g = build([row(A, 1, { blockedBy: [`${A}#2`] }), row(A, 2)]);
  assert.ok(find(g, `${A}#2`, `${A}#1`, 'native-dependency'));
  assert.equal(g.warnings.filter((w) => w.kind === 'native-mismatch').length, 1);
});

test('R10: extract body ref becomes a body-ref edge and a retracted ref yields none', () => {
  const live = build([row(A, 1, { body: 'Blocked by #3' }), row(A, 3)]);
  const edge = find(live, `${A}#3`, `${A}#1`);
  assert.equal(edge.source, 'body-ref');
  assert.equal(edge.relation, 'blocked-by');
  assert.equal(edge.line, 'Blocked by #3');
  const retracted = build([
    row(A, 1, { body: 'Blocked by #3', comments: [{ body: '#3 no longer applies', createdAt: '2026-01-01' }] }),
    row(A, 3),
  ]);
  assert.equal(retracted.edges.length, 0);
  assert.equal(retracted.unresolved.length, 0);
});

test('R10: a blocks ref points from this issue to the target', () => {
  const g = build([row(A, 1, { body: 'Blocks #2' }), row(A, 2)]);
  assert.ok(find(g, `${A}#1`, `${A}#2`, 'body-ref'));
  assert.equal(g.edges[0].relation, 'blocks');
});

test('R11: #N resolves to own repo and name #N resolves by config short name', () => {
  const g = build([
    row(M, 9, { body: 'Blocked by #4\nBlocked by construct3-chef #7' }),
    row(A, 4),
    row(A, 7),
  ]);
  assert.ok(find(g, `${M}#4`, `${M}#9`, 'body-ref'), 'own repo');
  assert.ok(find(g, `${A}#7`, `${M}#9`, 'body-ref'), 'short name');
  assert.equal(g.unresolved.length, 0);
});

test('R12: cycle is reported with its members and does not throw', () => {
  const rows = [
    row(A, 1, { body: 'Blocked by #2' }),
    row(A, 2, { body: 'Blocked by #3' }),
    row(A, 3, { body: 'Blocked by #1' }),
    row(A, 4, { body: 'Blocked by #1' }),
  ];
  const g = build(rows);
  assert.deepEqual(g.cycles, [[`${A}#1`, `${A}#2`, `${A}#3`]]);
  assert.doesNotThrow(() => buildGraph([null, { key: 5 }, ...rows, row(A, 9, { body: null, comments: 'x' })], { extract, config }));
  assert.doesNotThrow(() => buildGraph(undefined, {}));
});

test('R12: unresolvable blocker ref is reported and marks the issue blocked-unresolved', () => {
  const g = build([row(A, 1, { body: '## Blocked by\n\n- some text\n' })]);
  assert.equal(g.unresolved.length, 1);
  assert.equal(g.unresolved[0].key, `${A}#1`);
  assert.equal(g.unresolved[0].reason, 'heading-detached');
  assert.equal(g.unresolved[0].line, '## Blocked by');
  assert.equal(g.edges.length, 0);
});

test('R12: ambiguous word #N with an unknown word blocks as own repo and warns', () => {
  const body = 'Depends on: Settle #270 and #271 before the matching #267 slices.';
  const g = build([row(A, 263, { body })]);
  // #270 follows the word "Settle", so it is the ambiguous ref: it resolves to the own repo.
  for (const n of [270, 271, 267]) {
    assert.equal(g.edges.filter((e) => e.from === `${A}#${n}` && e.to === `${A}#263` && e.source === 'body-ref').length, 1, `#${n}`);
  }
  assert.equal(g.unresolved.filter((u) => u.key === `${A}#263`).length, 0);
  const w = g.warnings.filter((x) => x.kind === 'ambiguous-ref' && x.key === `${A}#270`);
  assert.equal(w.length, 1);
  assert.equal(w[0].inferred, true);
});

test('R13: parent with an open sub-issue is umbrella, not ready', () => {
  const g = build([
    row(A, 10, { subIssues: [`${A}#11`, `${A}#12`] }),
    row(A, 11, { parent: `${A}#10` }),
    row(A, 12, { parent: `${A}#10`, state: 'closed' }),
    row(A, 20, { subIssues: [`${A}#21`] }),
    row(A, 21, { parent: `${A}#20`, state: 'closed' }),
  ]);
  assert.ok(find(g, `${A}#11`, `${A}#10`, 'sub-issue'));
  assert.equal(isUmbrella(g, `${A}#10`), true);
  assert.equal(isUmbrella(g, `${A}#20`), false);
  assert.equal(isUmbrella(g, `${A}#11`), false);
});

test('R10: a real deferral ref goes to deferrals and adds no edge', () => {
  const g = build([row(A, 1, { body: 'Deferred until #7 ships.' }), row(A, 7)]);
  assert.deepEqual(g.deferrals.map((d) => [d.from, d.to]), [[`${A}#7`, `${A}#1`]]);
  assert.equal(g.edges.filter((e) => e.to === `${A}#1`).length, 0);
});
