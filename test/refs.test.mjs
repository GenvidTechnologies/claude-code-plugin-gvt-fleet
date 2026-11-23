process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRefsGrammar } from '../plugin/cli/lib/plugin-path.mjs';
import { resolveRef, resolveAll } from '../plugin/cli/lib/refs.mjs';

const ownRepo = 'GenvidTechnologies/construct3-chef';
const shortNames = {
  'construct3-chef': 'GenvidTechnologies/construct3-chef',
  'mcp-utils': 'GenvidTechnologies/mcp-utils',
  webapp: 'example-org/webapp',
};
const ctx = { ownRepo, shortNames };

async function refsOf(body) {
  const { extract } = await loadRefsGrammar();
  return extract({ number: 999, body }, { repo: ownRepo }).refs;
}

test('R11: #N resolves to the own repo', async () => {
  const refs = await refsOf('Blocked by #12');
  assert.deepEqual(resolveRef(refs[0], ctx), { key: `${ownRepo}#12`, via: 'own-repo' });
});

test('R11: owner/name#N maps to the config case and an unconfigured repo keeps its case', async () => {
  const refs = await refsOf('Blocked by genvidtechnologies/MCP-Utils#7\nBlocked by Other-Org/Thing#3');
  const out = resolveAll(refs, ctx);
  assert.deepEqual(out.resolved.map((r) => r.key), ['GenvidTechnologies/mcp-utils#7', 'Other-Org/Thing#3']);
  assert.equal(out.unresolved.length, 0);
});

test('R11: a name #N ref with a known short name resolves through the config', async () => {
  const refs = await refsOf('Blocked by mcp-utils #7');
  assert.equal(refs[0].unresolvable, 'repo-ambiguous');
  assert.deepEqual(resolveRef(refs[0], ctx), { key: 'GenvidTechnologies/mcp-utils#7', via: 'short-name' });
});

test('R11: a name #N ref with an unknown word resolves to the own repo', async () => {
  const refs = await refsOf('Blocked by nosuchrepo #7');
  assert.equal(refs[0].unresolvable, 'repo-ambiguous');
  assert.deepEqual(resolveRef(refs[0], ctx), { key: `${ownRepo}#7`, via: 'inferred-own-repo' });
  const out = resolveAll(refs, ctx);
  assert.deepEqual(out.resolved.map((r) => [r.key, r.via]), [[`${ownRepo}#7`, 'inferred-own-repo']]);
  assert.equal(out.unresolved.length, 0);
});

test('R11: a line with no name #N candidate stays unresolved', () => {
  const r = resolveRef({ unresolvable: 'repo-ambiguous', target: null, line: 'Blocked by something' }, ctx);
  assert.deepEqual(r, { unresolved: 'repo-ambiguous: no name #N on the line' });
});

test('R11: any other unresolvable reason is passed through', () => {
  assert.deepEqual(resolveRef({ unresolvable: 'prose', target: null, line: 'x' }, ctx), { unresolved: 'prose' });
  assert.deepEqual(resolveRef({ unresolvable: 'heading-detached', target: null, line: 'x' }, ctx), {
    unresolved: 'heading-detached',
  });
});
