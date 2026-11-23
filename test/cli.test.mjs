process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { branchesCommand, readyCommand, syncCommand, whyCommand } from '../plugin/cli/lib/commands.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli', 'bin', 'gvt-fleet.mjs');
const REPO = 'acme/app';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-cli-'));

const issueRow = (number, over = {}) => ({
  key: `${REPO}#${number}`, repo: REPO, number, state: 'open', title: `Issue ${number}`, body: '', updatedAt: '2026-11-03T09:00:00Z',
  labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], closingPrs: [], managed: true, ...over,
});

/** A temp config and state dir with the given issues in the cache. */
async function setup(issues) {
  const dir = tmp();
  const configFile = path.join(dir, 'repos.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO }] }));
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  cache.transaction(() => {
    for (const row of issues) cache.upsertIssue(row);
  });
  cache.close();
  const out = [];
  const err = [];
  const ctx = {
    json: false,
    configFile,
    stateDir,
    log: { append() {} },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    clock: { now: () => NOW, sleep: async () => {} },
  };
  return { ctx, out, err, configFile, stateDir };
}

function cli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, GVT_FLEET_FAKE_ONLY: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const blockedPair = () => [
  issueRow(1, { labels: [], blockedBy: [`${REPO}#2`] }),
  issueRow(2, { blocking: [`${REPO}#1`] }),
];

test('R14: why prints every reason with its detail for a not-ready issue', async () => {
  const s = await setup(blockedPair());
  assert.equal(await whyCommand(s.ctx, [`${REPO}#1`]), 0, s.err.join('\n'));
  const text = s.out.join('\n');
  assert.match(text, /^acme\/app#1: not ready/);
  assert.match(text, /not-triaged: missing label triaged/);
  assert.match(text, /blocked-by: acme\/app#2 \(native-dependency\)/);
  assert.match(text, /edge acme\/app#2 -> acme\/app#1 \[native-dependency/);
  assert.deepEqual(s.err, []);
});

test('R14: why accepts a short name and prints ready for a ready issue', async () => {
  const s = await setup(blockedPair());
  assert.equal(await whyCommand(s.ctx, ['app#2']), 0, s.err.join('\n'));
  assert.equal(s.out.join('\n'), 'acme/app#2: ready Issue 2\n  class: later');
});

test('R143: why prints the class on its own line and why --json carries class and conflict; class labels are not read', async () => {
  const s = await setup([
    issueRow(1, { labels: ['triaged'] }),
    issueRow(2, { labels: ['triaged', 'class:now'] }),
    issueRow(3, { labels: ['triaged', 'class:now', 'class:next'] }),
  ]);
  const config = JSON.parse(fs.readFileSync(s.ctx.configFile, 'utf8'));
  config.repos[0].project = 'acme/7';
  fs.writeFileSync(s.ctx.configFile, JSON.stringify(config));
  const cache = await openCacheDb(path.join(s.ctx.stateDir, 'cache.db'));
  cache.replaceProject('acme/7', {
    projectId: 'P',
    fieldId: 'F',
    iterations: [{ id: 'i_now', title: 'Goal A', startDate: '2026-11-01', duration: 365 }],
    items: [{ key: `${REPO}#3`, itemId: 'I3', iterationId: 'i_now' }],
  });
  cache.close();
  const human = async (n) => {
    s.out.length = 0;
    assert.equal(await whyCommand(s.ctx, [`${REPO}#${n}`]), 0, s.err.join('\n'));
    return [...s.out];
  };
  assert.deepEqual(await human(1), [`${REPO}#1: ready Issue 1`, '  class: later']);
  assert.deepEqual(await human(2), [`${REPO}#2: ready Issue 2`, '  class: later']);
  assert.deepEqual(await human(3), [`${REPO}#3: ready Issue 3`, '  class: now (iteration Goal A)']);
  s.ctx.json = true;
  const json = async (n) => {
    s.out.length = 0;
    assert.equal(await whyCommand(s.ctx, [`${REPO}#${n}`]), 0, s.err.join('\n'));
    return JSON.parse(s.out.join('\n'));
  };
  const [j1, j2, j3] = [await json(1), await json(2), await json(3)];
  assert.deepEqual([j1.class, j1.conflict], ['later', false]);
  assert.deepEqual([j2.class, j2.conflict], ['later', false]);
  assert.deepEqual([j3.class, j3.conflict, j3.iteration], ['now', false, { id: 'i_now', title: 'Goal A' }]);
});

test('R14: why --json prints the ready entry', async () => {
  const s = await setup(blockedPair());
  s.ctx.json = true;
  assert.equal(await whyCommand(s.ctx, [`${REPO}#2`]), 0, s.err.join('\n'));
  const body = JSON.parse(s.out.join('\n'));
  assert.equal(body.key, `${REPO}#2`);
  assert.equal(body.ready, true);
  assert.deepEqual(body.reasons, []);
  assert.deepEqual(body.edges, []);
  s.out.length = 0;
  assert.equal(await whyCommand(s.ctx, [`${REPO}#1`]), 0);
  const blocked = JSON.parse(s.out.join('\n'));
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.reasons.map((r) => r.code), ['not-triaged', 'blocked-by']);
  assert.equal(blocked.edges.length, 1);
  assert.equal(blocked.edges[0].from, `${REPO}#2`);
});

test('R14: why on an issue missing from the cache exits 1 and suggests sync', async () => {
  const s = await setup(blockedPair());
  assert.equal(await whyCommand(s.ctx, [`${REPO}#99`]), 1);
  assert.deepEqual(s.out, []);
  assert.match(s.err.join('\n'), /acme\/app#99 is not in the cache; run gvt-fleet sync/);
});

test('R14: why exits 64 for a bad ref, an unknown repo and a wrong argument count', async () => {
  const s = await setup(blockedPair());
  assert.equal(await whyCommand(s.ctx, ['nonsense']), 64);
  assert.equal(await whyCommand(s.ctx, ['other/repo#1']), 64);
  assert.equal(await whyCommand(s.ctx, []), 64);
  assert.equal(await whyCommand(s.ctx, [`${REPO}#1`, 'extra']), 64);
  assert.deepEqual(s.out, []);
  assert.equal(s.err.length, 4);
});

// Issue 1 is untriaged and also blocked; issue 3 is untriaged only; issue 2 is ready; issue 4 is closed and untriaged; issue 5 is unmanaged and untriaged.
const untriagedSet = () => [
  issueRow(1, { labels: [], blockedBy: [`${REPO}#2`] }),
  issueRow(2, { blocking: [`${REPO}#1`] }),
  issueRow(3, { labels: [] }),
  issueRow(4, { labels: [], state: 'closed' }),
  issueRow(5, { labels: [], managed: false }),
];
const expectedUntriaged = [{ repo: REPO, count: 2, keys: [`${REPO}#1`, `${REPO}#3`], onlyReason: 1 }];

test('R126: ready --json and ready --all --json both carry untriaged, from every open managed issue', async () => {
  const s = await setup(untriagedSet());
  s.ctx.json = true;
  assert.equal(await readyCommand(s.ctx, []), 0, s.err.join('\n'));
  const plain = JSON.parse(s.out.join('\n'));
  assert.deepEqual(plain.untriaged, expectedUntriaged);
  assert.deepEqual(plain.ready.map((e) => e.key), [`${REPO}#2`]);
  s.out.length = 0;
  assert.equal(await readyCommand(s.ctx, ['--all']), 0, s.err.join('\n'));
  const all = JSON.parse(s.out.join('\n'));
  assert.deepEqual(all.untriaged, expectedUntriaged);
  assert.ok(Array.isArray(all.issues));
});

test('R126: the untriaged summary is the same with and without --all', async () => {
  const s = await setup(untriagedSet());
  s.ctx.json = true;
  await readyCommand(s.ctx, []);
  const plain = JSON.parse(s.out.join('\n'));
  assert.ok(!plain.ready.some((e) => e.key === `${REPO}#3`), 'the untriaged issue is not in the plain list');
  s.out.length = 0;
  await readyCommand(s.ctx, ['--all']);
  const all = JSON.parse(s.out.join('\n'));
  assert.deepEqual(all.untriaged, plain.untriaged);
  s.ctx.json = false;
  s.out.length = 0;
  await readyCommand(s.ctx, []);
  const humanPlain = s.out.filter((l) => l.startsWith('untriaged '));
  s.out.length = 0;
  await readyCommand(s.ctx, ['--all']);
  assert.deepEqual(s.out.filter((l) => l.startsWith('untriaged ')), humanPlain);
});

test('R126: ready prints one untriaged line per repository after the list, and none when nothing is untriaged', async () => {
  const s = await setup(untriagedSet());
  assert.equal(await readyCommand(s.ctx, []), 0, s.err.join('\n'));
  assert.deepEqual(s.out, [`${REPO}#2 Issue 2`, `untriaged ${REPO}: 2 issues, 1 with no other reason`]);

  const clean = await setup([issueRow(1), issueRow(2, { labels: [], state: 'closed' })]);
  assert.equal(await readyCommand(clean.ctx, []), 0, clean.err.join('\n'));
  assert.deepEqual(clean.out, [`${REPO}#1 Issue 1`]);
});

test('NF-cli: every subcommand prints its own help with --help', () => {
  const top = cli(['--help']);
  assert.equal(top.code, 0);
  const block = top.out.split('Commands:\n')[1].split('\n\n')[0];
  const names = block.split('\n').map((l) => l.slice(2, 20).trim());
  assert.equal(names.length, 24);
  for (const name of names) {
    const h = cli([...name.split(' '), '--help']);
    assert.equal(h.code, 0, `${name}: ${h.err}`);
    assert.ok(h.out.startsWith(`Usage: gvt-fleet ${name}`), `${name}: usage line is "${h.out.split('\n')[0]}"`);
    assert.match(h.out, /Exit codes:/);
    assert.equal(h.err, '');
  }
  const viaHelp = cli(['help', 'worktree', 'finish']);
  assert.equal(viaHelp.code, 0);
  assert.ok(viaHelp.out.startsWith('Usage: gvt-fleet worktree finish'));
});

function exit2Line(name) {
  const h = cli([...name.split(' '), '--help']);
  const lines = h.out.split('\n').filter((l) => /^ {2}2 {3}/.test(l));
  assert.equal(lines.length, 1, `${name}: exit-2 lines ${JSON.stringify(lines)}`);
  return lines[0];
}

test('N13: each command help lists only the exit-2 causes that command has', () => {
  assert.match(exit2Line('trust'), /trust path/);
  assert.doesNotMatch(exit2Line('trust'), /settings file/);
  assert.match(exit2Line('install-hooks'), /settings file/);
  assert.doesNotMatch(exit2Line('install-hooks'), /trust path/);
  assert.match(exit2Line('dispatch'), /claim account/);
  for (const name of ['dispatch', 'claim', 'sync', 'worktree create']) {
    assert.doesNotMatch(exit2Line(name), /trust path|settings file/, name);
  }
  assert.match(exit2Line('worktree finish'), /invalid configuration/);
});

test('NF-cli: gvt-fleet without a command prints the usage on stderr, not stdout, and exits 64', () => {
  const r = cli([]);
  assert.equal(r.code, 64);
  assert.equal(r.out, '');
  assert.match(r.err, /^Usage: gvt-fleet /);
});

test('NF-cli: an unknown command writes only to stderr and exits 64', () => {
  const r = cli(['frobnicate']);
  assert.equal(r.code, 64);
  assert.equal(r.out, '');
  assert.match(r.err, /unknown command: frobnicate/);
});

test('NF-cli: an unknown argument to ready, sync, branches or check-config exits 64 with a usage line', async () => {
  const s = await setup([]);
  for (const [fn, name] of [[readyCommand, 'ready'], [syncCommand, 'sync'], [branchesCommand, 'branches']]) {
    s.err.length = 0;
    assert.equal(await fn(s.ctx, ['--bogus']), 64, name);
    assert.deepEqual(s.out, [], name);
    assert.match(s.err.join('\n'), new RegExp(`^usage: gvt-fleet ${name}`), name);
  }
  const r = cli(['check-config', 'extra', '--workspace', tmp(), '--config', s.configFile]);
  assert.equal(r.code, 64);
  assert.equal(r.out, '');
  assert.match(r.err, /usage: gvt-fleet check-config/);
});

/** A temp workspace: a copy of bin/ and lib/ as the top level of its own git repository, with an optional origin. */
function coachWorkspace(origin) {
  const ws = tmp();
  const root = path.resolve(path.dirname(BIN), '..');
  fs.cpSync(path.join(root, 'bin'), path.join(ws, 'bin'), { recursive: true });
  fs.cpSync(path.join(root, 'lib'), path.join(ws, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'config'));
  fs.writeFileSync(path.join(ws, 'config', 'repos.json'), JSON.stringify({ version: 1, repos: [{ repo: REPO }] }));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q']);
  if (origin) git(['remote', 'add', 'origin', origin]);
  return ws;
}

function checkConfigJson(ws) {
  const r = spawnSync(process.execPath, [path.join(ws, 'bin', 'gvt-fleet.mjs'), 'check-config', '--json'], {
    cwd: ws, encoding: 'utf8', env: { ...process.env, GVT_FLEET_FAKE_ONLY: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('R110: check-config --json names the contract number and the workspace repository from origin', () => {
  const ws = coachWorkspace('https://github.com/acme/ws.git');
  assert.deepEqual(checkConfigJson(ws).coach, { contract: 2, workspaceRepo: 'acme/ws' });
});

test('R110: check-config --json gives a null workspaceRepo when the workspace has no origin', () => {
  const ws = coachWorkspace(null);
  const out = checkConfigJson(ws);
  assert.deepEqual(out.coach, { contract: 2, workspaceRepo: null });
  assert.ok(Array.isArray(out.repos) && out.branches, 'existing keys stay');
});

test('NF-cli: ready --json on an empty state dir prints valid JSON on stdout and the notice on stderr', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, repos: [{ repo: REPO }] }));
  const r = cli(['ready', '--json', '--workspace', dir, '--config', configFile, '--state-dir', path.join(dir, 'state')]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ready: [], untriaged: [], now: [], next: [] });
  assert.match(r.err, /the cache is empty; run gvt-fleet sync/);
  assert.doesNotMatch(r.err, /ExperimentalWarning/);
});

test('NF-cli: why --json on a bad config prints nothing on stdout and exits 2', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'repos.json');
  fs.writeFileSync(configFile, '{ not json');
  const r = cli(['why', `${REPO}#1`, '--json', '--workspace', dir, '--config', configFile, '--state-dir', path.join(dir, 'state')]);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.notEqual(r.err, '');
});
