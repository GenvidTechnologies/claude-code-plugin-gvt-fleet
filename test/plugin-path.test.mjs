process.env.GVT_FLEET_FAKE_ONLY = '1';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GVT_DEV_MIN_VERSION,
  GvtDevError,
  checkGvtDev,
  compareVersions,
  gvtDevRoot,
  loadRefsGrammar,
  refsGrammarPath,
} from '../plugin/cli/lib/plugin-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('R10: grammar is imported from the installed plugin, not copied', async () => {
  const { extract } = await loadRefsGrammar();
  assert.equal(typeof extract, 'function');
  const rel = path.relative(repoRoot, refsGrammarPath());
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `grammar path is inside the repo: ${rel}`);
  const result = extract({ body: 'Blocked by #12' });
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].relation, 'blocked-by');
  assert.equal(result.refs[0].target.number, 12);
});

test('R10: GVT_DEV_ROOT overrides the installed_plugins.json lookup', () => {
  const root = gvtDevRoot({ env: { GVT_DEV_ROOT: '/x/y' }, readFile: () => assert.fail('read') });
  assert.equal(root, '/x/y');
});

test('R10: installPath comes from the user-scope entry of gvt-dev@gvt-plugins', () => {
  const json = JSON.stringify({
    plugins: {
      'gvt-dev@gvt-plugins': [
        { scope: 'project', installPath: '/p' },
        { scope: 'user', installPath: '/u' },
      ],
    },
  });
  assert.equal(gvtDevRoot({ env: {}, homedir: '/h', readFile: () => json }), '/u');
});

test('R10: a missing installed_plugins.json error names the file', () => {
  assert.throws(
    () => gvtDevRoot({ env: {}, homedir: '/h', readFile: () => { throw new Error('ENOENT'); } }),
    /installed_plugins\.json/,
  );
});

// R206: a shipped CLI states its gvt-dev requirement (#142, ADR 0020).

const BIN = path.join(repoRoot, 'plugin', 'cli', 'bin', 'gvt-fleet.mjs');
const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-gvtdev-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI with a minimal config, a fresh state folder and GVT_DEV_ROOT set to `gvtDev`. */
function cliWith(gvtDev, args) {
  const dir = tmp();
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, repos: [{ repo: 'acme/app' }] })}\n`);
  return spawnSync(process.execPath, [BIN, '--workspace', dir, '--config', configFile, '--state-dir', path.join(dir, 'state'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, GVT_FLEET_FAKE_ONLY: '1', GVT_DEV_ROOT: gvtDev },
  });
}

/** A fake gvt-dev plugin folder: a manifest with `version`, and a grammar module with `grammar` as its source. */
function fakeGvtDev({ version, grammar = 'export function extract() { return { refs: [] }; }\n' }) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  if (version !== undefined) fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'gvt-dev', version })}\n`);
  const lib = path.join(root, 'skills', 'triage-issues', 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  if (grammar !== null) fs.writeFileSync(path.join(lib, 'refs-grammar.mjs'), grammar);
  return root;
}

/** readFile for checkGvtDev: installed_plugins.json names /g, whose manifest has `version`. */
const installedAt = (version) => (file) => {
  if (file.endsWith('installed_plugins.json')) {
    return JSON.stringify({ plugins: { 'gvt-dev@gvt-plugins': [{ scope: 'user', installPath: '/g', version }] } });
  }
  if (file === path.join('/g', '.claude-plugin', 'plugin.json')) return JSON.stringify({ name: 'gvt-dev', version });
  throw new Error(`ENOENT: ${file}`);
};

test('R206: the minimum gvt-dev version is the first release that ships the grammar', () => {
  assert.equal(GVT_DEV_MIN_VERSION, '4.45.0');
});

test('R206: compareVersions orders the x.y.z core and returns null for anything else', () => {
  assert.equal(compareVersions('4.45.0', '4.45.0'), 0);
  assert.ok(compareVersions('4.44.9', '4.45.0') < 0);
  assert.ok(compareVersions('4.100.0', '4.45.0') > 0);
  assert.ok(compareVersions('5.0.0', '4.99.99') > 0);
  assert.equal(compareVersions('5.1.0-rc.1', '5.1.0'), 0);
  assert.equal(compareVersions('unknown', '4.45.0'), null);
  assert.equal(compareVersions(undefined, '4.45.0'), null);
});

test('R206: an install at the minimum version or later passes the check', () => {
  assert.deepEqual(checkGvtDev({ env: {}, homedir: '/h', readFile: installedAt('4.45.0') }), { root: '/g', version: '4.45.0' });
  assert.deepEqual(checkGvtDev({ env: {}, homedir: '/h', readFile: installedAt('5.1.0') }), { root: '/g', version: '5.1.0' });
});

test('R206: an install older than the minimum fails with the found and the needed version', () => {
  assert.throws(
    () => checkGvtDev({ env: {}, homedir: '/h', readFile: installedAt('4.44.0') }),
    (err) => {
      assert.ok(err instanceof GvtDevError);
      assert.match(err.message, /needs the gvt-dev plugin, version 4\.45\.0 or later/);
      assert.match(err.message, /found gvt-dev 4\.44\.0 at /);
      assert.match(err.message, /install or update gvt-dev@gvt-plugins with \/plugin, or set GVT_DEV_ROOT/);
      return true;
    },
  );
});

test('R206: no gvt-dev install fails with what to install', () => {
  const json = JSON.stringify({ plugins: { 'other@market': [{ scope: 'user', installPath: '/o' }] } });
  assert.throws(
    () => checkGvtDev({ env: {}, homedir: '/h', readFile: () => json }),
    (err) => {
      assert.ok(err instanceof GvtDevError);
      assert.match(err.message, /version 4\.45\.0 or later/);
      assert.match(err.message, /has no install of gvt-dev@gvt-plugins/);
      assert.match(err.message, /install or update gvt-dev@gvt-plugins with \/plugin/);
      return true;
    },
  );
});

test('R206: a manifest with no readable x.y.z version fails and names the manifest', () => {
  /** installed_plugins.json names /g; its manifest read is `manifest()`. */
  const withManifest = (manifest) => (file) => (file.endsWith('installed_plugins.json') ? installedAt('5.1.0')(file) : manifest());
  const unreadable = () => {
    throw new Error('ENOENT');
  };
  for (const readFile of [withManifest(unreadable), withManifest(() => JSON.stringify({ name: 'gvt-dev' }))]) {
    assert.throws(
      () => checkGvtDev({ env: {}, homedir: '/h', readFile }),
      (err) => err instanceof GvtDevError && err.message.includes(path.join('/g', '.claude-plugin', 'plugin.json')),
    );
  }
});

test('R206: GVT_DEV_ROOT is checked against its own manifest, not exempt', async () => {
  const old = fakeGvtDev({ version: '4.44.0' });
  await assert.rejects(loadRefsGrammar({ env: { GVT_DEV_ROOT: old } }), (err) => {
    assert.ok(err instanceof GvtDevError);
    assert.match(err.message, /found gvt-dev 4\.44\.0 at /);
    return true;
  });
  const ok = fakeGvtDev({ version: '4.45.0' });
  const mod = await loadRefsGrammar({ env: { GVT_DEV_ROOT: ok } });
  assert.deepEqual(mod.extract({ body: '' }), { refs: [] });
});

test('R206: a grammar file that is missing or has no extract fails with the gvt-dev version', async () => {
  const missing = fakeGvtDev({ version: '5.1.0', grammar: null });
  await assert.rejects(loadRefsGrammar({ env: { GVT_DEV_ROOT: missing } }), (err) => {
    assert.ok(err instanceof GvtDevError);
    assert.match(err.message, /cannot load the grammar of gvt-dev 5\.1\.0 from /);
    return true;
  });
  const noExtract = fakeGvtDev({ version: '5.1.0', grammar: 'export const other = 1;\n' });
  await assert.rejects(loadRefsGrammar({ env: { GVT_DEV_ROOT: noExtract } }), (err) => {
    assert.ok(err instanceof GvtDevError);
    assert.match(err.message, /the grammar of gvt-dev 5\.1\.0 at .* has no extract function/);
    return true;
  });
});

test('R206: sync, ready and why print the gvt-dev requirement without a stack and exit 1', () => {
  const old = fakeGvtDev({ version: '4.44.0' });
  for (const args of [['sync'], ['ready'], ['why', 'acme/app#1']]) {
    const r = cliWith(old, args);
    assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /^gvt-fleet: this command needs the gvt-dev plugin, version 4\.45\.0 or later/m, args[0]);
    assert.match(r.stderr, /found gvt-dev 4\.44\.0 at /, args[0]);
    assert.doesNotMatch(r.stderr, /^\s+at /m, args[0]);
  }
});

test('R206: a command that does not read references runs with a gvt-dev older than the minimum', () => {
  const old = fakeGvtDev({ version: '4.44.0' });
  for (const args of [['check-config'], ['branches']]) {
    const r = cliWith(old, args);
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /gvt-dev/, args[0]);
  }
});

test('R206: the help names the gvt-dev requirement for the commands that load the grammar only', () => {
  const help = (args) => spawnSync(process.execPath, [BIN, ...args, '--help'], { encoding: 'utf8' }).stdout;
  for (const name of ['sync', 'ready', 'why', 'claim']) {
    assert.match(help([name]), /^Needs the gvt-dev plugin, version 4\.45\.0 or later, for the issue-reference grammar/m, name);
  }
  assert.match(help(['dispatch']), /^The issue form needs the gvt-dev plugin, version 4\.45\.0 or later/m);
  for (const name of ['check-config', 'branches', 'release', 'wrap']) assert.doesNotMatch(help([name]), /gvt-dev/, name);
  assert.match(help([]), /sync, ready, why, claim and dispatch <ref> need the gvt-dev plugin, version 4\.45\.0 or later/);
});
