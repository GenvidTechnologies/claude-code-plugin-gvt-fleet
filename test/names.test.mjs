process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = [
  'plugin/cli/bin', 'plugin/cli/lib', 'plugin/hooks', 'test', 'scripts', '.github', '.gvt-agent.json',
  'CLAUDE.md', 'README.md', 'wiki/coordinator.md', 'wiki/coordinator', 'wiki/design.md',
  'wiki/configuration.md', 'wiki/index.md', 'wiki/schema.md',
];
const OLD_ENV = /GVT_LOOP[_]/;

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
  } else {
    out.push(rel);
  }
}

test('NF-names: every entry of the include list exists', () => {
  const missing = [];
  for (const rel of INCLUDE) {
    try {
      fs.lstatSync(path.join(ROOT, rel));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `include list entries that do not exist: ${missing.join(', ')}`);
});

test('NF-names: no file in the include list uses the old fake-only variable prefix', () => {
  assert.ok(OLD_ENV.test('GVT_' + 'LOOP_FAKE_ONLY'), 'control: the pattern matches the old variable');
  const files = [];
  for (const rel of INCLUDE) walk(rel, files);
  assert.ok(files.length >= 90, `control: the walk found ${files.length} files`);
  const hits = files.filter((rel) => OLD_ENV.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(hits, []);
});

test('NF-names: bin and lib hold the old CLI name only in lib/legacy-names.mjs', () => {
  const OLD_CLI = new RegExp('gvt' + '-' + 'loop');
  assert.ok(OLD_CLI.test('gvt' + '-' + 'loop-hook.mjs'), 'control: the pattern matches the old name');
  const files = [];
  walk('plugin/cli/bin', files);
  walk('plugin/cli/lib', files);
  assert.ok(files.length >= 20, `control: the walk found ${files.length} files`);
  const hits = files.filter((rel) => OLD_CLI.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(hits, ['plugin/cli/lib/legacy-names.mjs']);
});

test('NF-names: line 1 of every test file sets the fake-only variable', () => {
  const dir = path.join(ROOT, 'test');
  const tests = fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs'));
  assert.ok(tests.length >= 30, `control: found ${tests.length} test files`);
  for (const name of tests) {
    const first = fs.readFileSync(path.join(dir, name), 'utf8').split('\n')[0].replace(/\r$/, '');
    assert.equal(first, "process.env.GVT_FLEET_FAKE_ONLY = '1';", name);
  }
});
