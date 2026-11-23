process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { findLossyJson } from '../plugin/cli/lib/json-scan.mjs';
import { planSettings } from '../plugin/cli/lib/user-settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A synchronous loop ignores the node:test timeout, so each call runs in a child
// process that is killed after ten seconds. Run alone, the five calls took 0.4 to 0.6 s
// together (2026-11-06); the margin keeps a slow process start under load from failing the test.
test('R46: findLossyJson returns on text that is not valid JSON', { timeout: 60000 }, () => {
  const mod = pathToFileURL(path.join(here, '..', 'plugin', 'cli', 'lib', 'json-scan.mjs')).href;
  const script = `import(${JSON.stringify(mod)}).then((m) => { const r = m.findLossyJson(process.argv[1]); process.exit(r === null || typeof r === 'object' ? 0 : 3); });`;
  for (const text of ['{"a":"x', '{"a":', '[', '{', '"']) {
    const r = spawnSync(process.execPath, ['-e', script, text], { timeout: 10000 });
    assert.equal(r.error, undefined, `${text}: ${r.error?.message}`);
    assert.equal(r.status, 0, text);
  }
});

test('R46: findLossyJson passes numbers that survive a rewrite unchanged', () => {
  for (const n of ['1.0', '1e2', '0.1', '100', '-5', '0', '0.0', '1E+2', '-1.5e-3', '9007199254740991']) {
    assert.equal(findLossyJson(`{"n":${n}}`), null, n);
  }
  assert.equal(findLossyJson('[1.0, 2, {"a": [0.5]}]'), null);
});

test('R46: findLossyJson flags a number that would change when rewritten', () => {
  for (const n of ['12345678901234567890', '1e400', '-0', '-0.0', '0.30000000000000001']) {
    const r = findLossyJson(`{"n":${n}}`);
    assert.deepEqual(r, { kind: 'number', token: n, line: 1 }, n);
  }
});

test('R46: findLossyJson reports the 1-based line of the token', () => {
  assert.deepEqual(findLossyJson('{\n  "a": 1,\n  "b": 12345678901234567890\n}'), { kind: 'number', token: '12345678901234567890', line: 3 });
  assert.deepEqual(findLossyJson('{\n  "a": 1,\n\n  "a": 2\n}'), { kind: 'duplicate-key', token: 'a', line: 4 });
});

test('R46: findLossyJson flags a duplicate key in one object', () => {
  assert.deepEqual(findLossyJson('{"k":1,"k":2}'), { kind: 'duplicate-key', token: 'k', line: 1 });
  assert.deepEqual(findLossyJson('{"o":{"x":1,"y":2,"x":3}}'), { kind: 'duplicate-key', token: 'x', line: 1 });
});

test('R46: findLossyJson treats a key written with a unicode escape as the same key', () => {
  // The escape is built at run time: the edit tools would decode a typed escape into the plain letter.
  const text = '{"a":1,"' + String.fromCharCode(92) + 'u0061":2}';
  assert.ok(text.includes('u0061'));
  assert.deepEqual(findLossyJson(text), { kind: 'duplicate-key', token: 'a', line: 1 });
});

test('R46: findLossyJson accepts the same key in sibling and nested objects', () => {
  assert.equal(findLossyJson('{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}]}'), null);
  assert.equal(findLossyJson('{"k":{"k":{"k":1}}}'), null);
});

test('R46: findLossyJson passes strings that contain braces, quotes or number-like text', () => {
  assert.equal(findLossyJson('{"a":"{\\"k\\":1,\\"k\\":2} 12345678901234567890","b":[true,false,null]}'), null);
});

test('R46: findLossyJson passes planSettings output for a real input', () => {
  const input = JSON.parse(readFileSync(path.join(here, 'fixtures', 'user-settings.json'), 'utf8'));
  const { next } = planSettings(input, { workspace: 'C:/work/fleet' });
  assert.equal(findLossyJson(JSON.stringify(next, null, 2) + '\n'), null);
});
