process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, g } from './helpers/git-sandbox.mjs';

// The scan lists the names it refuses, so it lives outside the scanned paths (#141).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'private-names.mjs');

function scan(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function repoWith(t, files) {
  const dir = makeTempDir(t, 'gvt-fleet-names-');
  await g(dir, 'init', '-q');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  await g(dir, 'add', '-A');
  return dir;
}

test('R203: the tracked code and tests of this repository name no private name or machine path', () => {
  const r = scan([]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /private-names: [1-9][0-9]* files scanned, 0 matches/);
});

test('R203: the scan reports each leak as file:line and exits 1, and passes a clean tree', async (t) => {
  // Built at run time, so that this file itself passes the scan.
  const drive = 'D:' + String.fromCharCode(92) + 'repos' + String.fromCharCode(92) + 'x';
  const org = ['genvid', 'holdings'].join('-');
  const dir = await repoWith(t, {
    'bin/clean.mjs': 'export const a = 1;\n',
    'lib/a.mjs': `// fine\nconst p = '${drive}';\n`,
    'test/b.test.mjs': `const r = '${org.toUpperCase()}/app';\n`,
    'wiki/c.md': `${org} stays private here\n`,
  });
  const r = scan(['--root', dir]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^lib\/a\.mjs:2: machine path$/m);
  assert.match(r.out, /^test\/b\.test\.mjs:1: private org$/m);
  assert.doesNotMatch(r.out, /wiki\/c\.md/);
  assert.doesNotMatch(r.out, /bin\/clean\.mjs/);
  assert.match(r.out, /3 files scanned, 2 matches/);

  const clean = await repoWith(t, { 'lib/a.mjs': `const p = 'C:/work/fleet';\n` });
  const c = scan(['--root', clean]);
  assert.equal(c.code, 0, c.out + c.err);
});

test('R203: the scan exits 2 when it lists no file, so an empty scan is not a pass', async (t) => {
  const dir = await repoWith(t, { 'docs/a.md': 'x\n' });
  const r = scan(['--root', dir]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /no tracked file/);
});
