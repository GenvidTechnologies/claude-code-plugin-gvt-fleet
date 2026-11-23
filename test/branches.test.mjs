process.env.GVT_FLEET_FAKE_ONLY = '1';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { dropBranch, setBranch } from '../plugin/cli/lib/branches.mjs';
import { branchSetCommand, branchesCommand } from '../plugin/cli/lib/commands.mjs';
import { buildGraph } from '../plugin/cli/lib/graph.mjs';
import { computeReady } from '../plugin/cli/lib/ready.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-branches-'));
const REPO = 'acme/app';
const OTHER = 'acme/lib';
const NOW = new Date('2026-11-03T12:00:00.000Z');

const issueRow = (repo, number, over = {}) => ({
  key: `${repo}#${number}`, repo, number, state: 'open', title: `Issue ${number}`, body: '', updatedAt: '2026-11-03T09:00:00Z',
  labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], closingPrs: [], managed: true, ...over,
});

/** A temp config dir, state dir and cache. `heads` is repo -> [{name, headOid, lastCommitDate}]. */
async function setup({ heads = {}, issues = [], record, repos = [{ repo: REPO }, { repo: OTHER }] } = {}) {
  const dir = tmp();
  const configDir = path.join(dir, 'config');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'repos.json'), JSON.stringify({ version: 1, repos }));
  const recordFile = path.join(configDir, 'branches.json');
  if (record !== undefined) fs.writeFileSync(recordFile, typeof record === 'string' ? record : JSON.stringify(record));
  const cache = await openCacheDb(path.join(stateDir, 'cache.db'));
  cache.transaction(() => {
    for (const [repo, list] of Object.entries(heads)) {
      cache.replaceBranchHeads(repo, list);
      cache.setRepoState(repo, { defaultBranch: 'main' });
    }
    for (const row of issues) cache.upsertIssue(row);
  });
  cache.close();
  const outLines = [];
  const errLines = [];
  const ctx = {
    json: false,
    configFile: path.join(configDir, 'repos.json'),
    stateDir,
    log: { append() {} },
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    clock: { now: () => NOW, sleep: async () => {} },
  };
  return { dir, ctx, recordFile, stateDir, outLines, errLines };
}

const head = (name, oid = `oid-${name}`) => ({ name, headOid: oid, lastCommitDate: '2026-10-30T08:00:00Z' });

test('Q6: remote branch not in the record is listed as unknown', async () => {
  const s = await setup({
    heads: { [REPO]: [head('main'), head('feat-a'), head('feat-b')] },
    record: { version: 1, repos: { [REPO]: { 'feat-b': { disposition: 'keep', decided: '2026-11-01', by: 'coach' } } } },
  });
  s.ctx.json = true;
  assert.equal(await branchesCommand(s.ctx, ['--unknown']), 0);
  const { unknown } = JSON.parse(s.outLines.join('\n'));
  assert.deepEqual(unknown, [{ repo: REPO, branch: 'feat-a', headOid: 'oid-feat-a', lastCommitDate: '2026-10-30T08:00:00Z', hints: [] }]);
});

test('Q6: branch set writes a sorted LF entry by atomic rename', async () => {
  const s = await setup({ heads: { [REPO]: [head('main'), head('zeta'), head('alpha')] } });
  const renames = [];
  const real = fs.renameSync;
  mock.method(fs, 'renameSync', (from, to) => {
    // At rename time the temp file holds the new text and the target is still absent.
    renames.push({ from, to, tmpText: fs.readFileSync(from, 'utf8'), targetExisted: fs.existsSync(to) });
    return real(from, to);
  });
  try {
    assert.equal(await branchSetCommand(s.ctx, [REPO, 'zeta', '--keep']), 0);
    assert.equal(await branchSetCommand(s.ctx, [REPO, 'alpha', '--issue', '#7']), 0);
  } finally {
    mock.restoreAll();
  }
  assert.equal(renames.length, 2);
  assert.equal(renames[0].to, s.recordFile);
  assert.match(path.basename(renames[0].from), /\.tmp\.gvt-fleet\./);
  assert.equal(renames[0].targetExisted, false);
  assert.equal(renames[1].targetExisted, true);
  const text = fs.readFileSync(s.recordFile, 'utf8');
  assert.equal(text, renames[1].tmpText);
  assert.ok(!text.includes('\r') && text.endsWith('}\n'));
  assert.equal(
    text,
    `${JSON.stringify(
      {
        repos: {
          [REPO]: {
            alpha: { by: 'coach', decided: '2026-11-03', disposition: 'issue', issue: `${REPO}#7` },
            zeta: { by: 'coach', decided: '2026-11-03', disposition: 'keep' },
          },
        },
        version: 1,
      },
      null,
      2,
    )}\n`,
  );
  assert.deepEqual(fs.readdirSync(path.dirname(s.recordFile)).sort(), ['branches.json', 'repos.json']);
  assert.ok(!fs.existsSync(path.join(s.stateDir, 'branches.lock')));
  assert.ok(s.errLines.includes('config/branches.json changed; commit it'));
});

test('Q6: recorded branch tied to an open issue makes it not ready with reason existing-branch', async () => {
  const s = await setup({
    heads: { [REPO]: [head('main'), head('feat-a')] },
    issues: [issueRow(REPO, 7), issueRow(REPO, 8)],
  });
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--issue', `${REPO}#7`]), 0);
  const record = JSON.parse(fs.readFileSync(s.recordFile, 'utf8'));
  const cache = await openCacheDb(path.join(s.stateDir, 'cache.db'));
  try {
    const rows = cache.readIssues();
    const config = { claimAccount: 'me', repos: [{ repo: REPO }, { repo: OTHER }] };
    const graph = buildGraph(rows, { extract: () => ({ refs: [] }), config });
    const entries = computeReady({ issues: rows, graph, config, now: NOW, branchRecord: { repos: record.repos, remoteHeads: cache.remoteHeads() } });
    const seven = entries.find((e) => e.key === `${REPO}#7`);
    assert.equal(seven.ready, false);
    assert.deepEqual(seven.reasons, [{ code: 'existing-branch', detail: `${REPO}:feat-a` }]);
    assert.equal(entries.find((e) => e.key === `${REPO}#8`).ready, true);
  } finally {
    cache.close();
  }
});

test('Q6: record entry for a branch gone from the remote does not block', async () => {
  const s = await setup({
    heads: { [REPO]: [head('main')] },
    issues: [issueRow(REPO, 7)],
    record: { version: 1, repos: { [REPO]: { 'old-branch': { disposition: 'issue', issue: `${REPO}#7`, decided: '2026-11-01', by: 'coach' } } } },
  });
  s.ctx.json = true;
  assert.equal(await branchesCommand(s.ctx, []), 0);
  const { branches } = JSON.parse(s.outLines.join('\n'));
  assert.equal(branches.length, 1);
  assert.equal(branches[0].branch, 'old-branch');
  assert.equal(branches[0].status, 'gone');
  const record = JSON.parse(fs.readFileSync(s.recordFile, 'utf8'));
  const cache = await openCacheDb(path.join(s.stateDir, 'cache.db'));
  try {
    const rows = cache.readIssues();
    const config = { claimAccount: 'me', repos: [{ repo: REPO }] };
    const graph = buildGraph(rows, { extract: () => ({ refs: [] }), config });
    const [entry] = computeReady({ issues: rows, graph, config, now: NOW, branchRecord: { repos: record.repos, remoteHeads: cache.remoteHeads() } });
    assert.equal(entry.ready, true);
    assert.deepEqual(entry.reasons, []);
  } finally {
    cache.close();
  }
});

test('Q6: invalid record entry is a config error naming the branch', async () => {
  const s = await setup({
    heads: { [REPO]: [head('main'), head('feat-a')] },
    record: { version: 1, repos: { [REPO]: { 'feat-bad': { disposition: 'issue', issue: 'not-a-ref', decided: '2026-11-01', by: 'coach' } } } },
  });
  assert.equal(await branchesCommand(s.ctx, ['--unknown']), 2);
  assert.ok(s.errLines.some((l) => l.includes(`${REPO} feat-bad`) && l.includes('owner/repo#N')), s.errLines.join('\n'));
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--keep']), 2);
  assert.ok(!fs.readFileSync(s.recordFile, 'utf8').includes('feat-a'));
});

test('Q6: branch set rejects an unresolvable --issue before any write', async () => {
  const s = await setup({ heads: { [REPO]: [head('main'), head('feat-a')] } });
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--issue', 'nosuch#3']), 2);
  assert.ok(s.errLines.some((l) => l.includes('nosuch')));
  assert.ok(!fs.existsSync(s.recordFile));
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--issue', 'lib#3']), 0);
  assert.equal(JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos[REPO]['feat-a'].issue, `${OTHER}#3`);
});

test('Q6: branches --unknown shows a hint from an open or merged closing PR and never writes it', async () => {
  const pr = (number, state, headRefName, repo = REPO) => ({ number, state, headRefName, repo });
  const s = await setup({
    heads: { [REPO]: [head('main'), head('feat-open'), head('feat-closed'), head('feat-other'), head('plain')] },
    issues: [
      issueRow(REPO, 7, { closingPrs: [pr(70, 'OPEN', 'feat-open')] }),
      issueRow(REPO, 8, { closingPrs: [pr(80, 'CLOSED', 'feat-closed'), pr(81, 'OPEN', 'feat-other', OTHER)] }),
    ],
  });
  s.ctx.json = true;
  assert.equal(await branchesCommand(s.ctx, ['--unknown']), 0);
  const byBranch = Object.fromEntries(JSON.parse(s.outLines.join('\n')).unknown.map((u) => [u.branch, u.hints]));
  assert.deepEqual(byBranch['feat-open'], [{ issue: `${REPO}#7`, pr: 70, state: 'OPEN' }]);
  assert.deepEqual(byBranch['feat-closed'], []);
  assert.deepEqual(byBranch['feat-other'], []);
  assert.deepEqual(byBranch.plain, []);
  assert.ok(!fs.existsSync(s.recordFile));
  s.ctx.json = false;
  s.outLines.length = 0;
  assert.equal(await branchesCommand(s.ctx, ['--unknown']), 0);
  assert.ok(s.outLines.includes(`  hint: PR #70 (OPEN) closes ${REPO}#7`), s.outLines.join('\n'));
});

test('Q6: branch set refuses a branch missing from the remote unless --allow-missing', async () => {
  const s = await setup({ heads: { [REPO]: [head('main')] } });
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'ghost', '--remove']), 1);
  assert.ok(s.errLines.some((l) => l.includes('ghost') && l.includes('--allow-missing')));
  assert.ok(!fs.existsSync(s.recordFile));
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'ghost', '--remove', '--allow-missing']), 0);
  const entry = JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos[REPO].ghost;
  assert.deepEqual(entry, { by: 'coach', decided: '2026-11-03', disposition: 'remove' });
});

test('Q6: branch set reports a held lock and does not steal it', async () => {
  const s = await setup({ heads: { [REPO]: [head('main'), head('feat-a')] } });
  const lock = path.join(s.stateDir, 'branches.lock');
  fs.writeFileSync(lock, '4242\n');
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--keep']), 1);
  assert.ok(s.errLines.some((l) => l.includes('branches.lock') && l.includes('4242') && l.includes('stale')), s.errLines.join('\n'));
  assert.equal(fs.readFileSync(lock, 'utf8'), '4242\n');
  assert.ok(!fs.existsSync(s.recordFile));
});

test('Q6: branch set merges into the existing record and keeps other entries', async () => {
  const existing = { disposition: 'keep', decided: '2026-11-01', by: 'coach' };
  const s = await setup({
    heads: { [REPO]: [head('main'), head('feat-a'), head('feat-b')] },
    record: { version: 1, repos: { [REPO]: { 'feat-b': existing } } },
  });
  assert.equal(await branchSetCommand(s.ctx, [REPO, 'feat-a', '--keep', '--by', 'me']), 0);
  const repos = JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos;
  assert.deepEqual(repos[REPO]['feat-b'], existing);
  assert.equal(repos[REPO]['feat-a'].by, 'me');
});

const coordinatorEntry = { disposition: 'issue', issue: `${REPO}#9`, decided: '2026-11-01', by: 'coordinator' };
const personEntry = { disposition: 'keep', decided: '2026-11-01', by: 'me' };
const isCoordinatorFor = (issue) => (e) => e.by === 'coordinator' && e.issue === issue;

function dropSetup(repos) {
  const dir = tmp();
  const recordFile = path.join(dir, 'config', 'branches.json');
  const lockFile = path.join(dir, 'state', 'branches.lock');
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify({ version: 1, repos }));
  return { recordFile, lockFile };
}

test('R112: dropBranch removes a matching entry, keeps the others and writes LF with a trailing newline', () => {
  const s = dropSetup({ [REPO]: { 'worktree-a': coordinatorEntry, 'feat-b': personEntry } });
  const r = dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: isCoordinatorFor(`${REPO}#9`) });
  assert.deepEqual(r, { dropped: true, entry: coordinatorEntry });
  const text = fs.readFileSync(s.recordFile, 'utf8');
  assert.ok(text.endsWith('}\n') && !text.includes('\r'));
  assert.deepEqual(JSON.parse(text), { version: 1, repos: { [REPO]: { 'feat-b': personEntry } } });
});

test('R112: dropBranch on an absent entry returns dropped false and does not write', () => {
  const s = dropSetup({ [REPO]: { 'feat-b': personEntry } });
  const before = fs.readFileSync(s.recordFile, 'utf8').replace('"version"', '"version" ');
  fs.writeFileSync(s.recordFile, before);
  assert.deepEqual(dropBranch({ ...s, repo: REPO, branch: 'nope', matches: () => true }), { dropped: false });
  assert.deepEqual(dropBranch({ ...s, repo: OTHER, branch: 'feat-b', matches: () => true }), { dropped: false });
  assert.equal(fs.readFileSync(s.recordFile, 'utf8'), before);
});

test('R112: dropBranch releases the lock after a drop, after a no-op and after a failure', () => {
  const s = dropSetup({ [REPO]: { 'worktree-a': coordinatorEntry } });
  dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: () => true });
  assert.ok(!fs.existsSync(s.lockFile));
  dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: () => true });
  assert.ok(!fs.existsSync(s.lockFile));
  fs.writeFileSync(s.recordFile, '{ not json');
  assert.throws(() => dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: () => true }), /invalid JSON/);
  assert.ok(!fs.existsSync(s.lockFile));
});

test('R112: dropBranch leaves an entry that does not match the guard', () => {
  const s = dropSetup({ [REPO]: { 'worktree-a': coordinatorEntry, 'worktree-p': { ...personEntry, issue: undefined } } });
  const text = fs.readFileSync(s.recordFile, 'utf8');
  const r1 = dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: isCoordinatorFor(`${REPO}#10`) });
  assert.deepEqual(r1, { dropped: false });
  const r2 = dropBranch({ ...s, repo: REPO, branch: 'worktree-p', matches: isCoordinatorFor(`${REPO}#9`) });
  assert.deepEqual(r2, { dropped: false });
  assert.equal(fs.readFileSync(s.recordFile, 'utf8'), text);
});

test('R112: dropBranch reports a held lock and does not steal it', () => {
  const s = dropSetup({ [REPO]: { 'worktree-a': coordinatorEntry } });
  fs.mkdirSync(path.dirname(s.lockFile), { recursive: true });
  fs.writeFileSync(s.lockFile, '4242\n');
  assert.throws(() => dropBranch({ ...s, repo: REPO, branch: 'worktree-a', matches: () => true }), /4242/);
  assert.equal(fs.readFileSync(s.lockFile, 'utf8'), '4242\n');
});

const setConfig = { repos: [{ repo: REPO }] };
const setArgs = (s, over = {}) => ({
  ...s, repo: REPO, branch: 'feat-x', disposition: 'issue', issueArg: `${REPO}#9`, allowMissing: true, config: setConfig, cache: {}, clock: { now: () => NOW }, by: 'coordinator', ...over,
});

test('R112: setBranch with onlyIf false writes nothing, returns written false and the entry read under the lock', () => {
  const s = dropSetup({ [REPO]: { 'feat-x': personEntry } });
  const text = fs.readFileSync(s.recordFile, 'utf8');
  const seen = [];
  const r = setBranch(setArgs(s, { onlyIf: (prior) => { seen.push(prior); return prior === undefined || prior.by === 'coordinator'; } }));
  assert.deepEqual(seen, [personEntry]);
  assert.equal(r.written, false);
  assert.deepEqual(r.prior, personEntry);
  assert.equal(fs.readFileSync(s.recordFile, 'utf8'), text);
  assert.ok(!fs.existsSync(s.lockFile));
});

test('R112: setBranch with onlyIf true writes, and reports the prior entry and written true', () => {
  const s = dropSetup({ [REPO]: { 'feat-x': coordinatorEntry } });
  const r = setBranch(setArgs(s, { onlyIf: (prior) => prior.by === 'coordinator' }));
  assert.equal(r.written, true);
  assert.deepEqual(r.prior, coordinatorEntry);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.recordFile, 'utf8')).repos[REPO]['feat-x'], r.entry);
  assert.equal(r.entry.decided, '2026-11-03');
});
