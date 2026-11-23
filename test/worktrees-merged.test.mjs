process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { worktreeRemoveCommand } from '../plugin/cli/lib/commands.mjs';
import {
  createFindHolders,
  createWorktree,
  finishWorktree,
  removeWorktree,
} from '../plugin/cli/lib/worktrees.mjs';
import {
  fwd,
  g,
  git,
  halfRemoveWorktree,
  makeTempDir,
  pushWithUpstream,
} from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  REPOS,
  addWorktree,
  rmFully,
  setup,
} from './helpers/worktree-sandbox.mjs';
import {
  branchExists,
  droppedDirs,
  rmCalls,
  createArgs,
  MERGED_AT,
  requireMergedSetup,
  removeMerged,
  REMOTE_NAME,
  readRecord,
  OWN_ENTRY,
  removeRecording,
  pushedUnderOtherName,
} from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

test('R107: remove --require-merged removes a pushed branch whose pull request is merged with its head at HEAD', async (t) => {
  const s = await requireMergedSetup(t, (head) => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }));
  const r = await removeMerged(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.pushedBranch, BRANCH);
  assert.deepEqual(r.pr, { number: 12, state: 'merged', mergedAt: MERGED_AT, headSha: s.head });
  assert.equal(await branchExists(s), false);
});

test('R107: remove --require-merged refuses a pushed branch whose pull request is open, and removes nothing', async (t) => {
  const s = await requireMergedSetup(t, (head) => ({ data: [{ number: 12, state: 'open', merged_at: null, head: { sha: head } }] }));
  const r = await removeMerged(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`pull request #12 (open) from ${BRANCH} is not merged at HEAD ${s.head.slice(0, 7)}`]);
  assert.equal(r.pr.number, 12);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R107: remove --require-merged refuses a pushed branch that has no pull request', async (t) => {
  const s = await requireMergedSetup(t, () => ({ data: [] }));
  const r = await removeMerged(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`no pull request from ${BRANCH}`]);
  assert.equal(r.pr, null);
  assert.equal(rmCalls(s).length, 0);
});

test('R107: remove --require-merged refuses a merged pull request whose head is not HEAD', async (t) => {
  const s = await requireMergedSetup(t, () => ({ data: [{ number: 12, state: 'closed', merged_at: MERGED_AT, head: { sha: '0'.repeat(40) } }] }));
  const r = await removeMerged(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`pull request #12 (merged) from ${BRANCH} is not merged at HEAD ${s.head.slice(0, 7)}`]);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R107: remove --require-merged refuses when the pull request lookup fails', async (t) => {
  const s = await requireMergedSetup(t, () => {
    throw new Error('gh: HTTP 502');
  });
  const r = await removeMerged(s);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.problems, [`cannot look up pull requests from ${BRANCH}: gh: HTTP 502`]);
  assert.equal(r.pr, null);
  assert.equal(rmCalls(s).length, 0);
});

test('R107: worktree remove --require-merged with --discard exits 64 before any git or gh call', async (t) => {
  const s = await requireMergedSetup(t, () => ({ data: [] }));
  const err = [];
  const ctx = { stateDir: s.stateDir, json: false, repoRoot: s.ws, gh: s.gh, claude: s.fake, out: () => {}, err: (x) => err.push(x), log: { append: () => {} } };
  const code = await worktreeRemoveCommand(ctx, ['app#1', '--discard', '--require-merged']);
  assert.equal(code, 64);
  assert.match(err.join(' | '), /--discard and --require-merged cannot be combined/);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R108: the pull request is looked up by the branch name on the remote when it differs from the local name', async (t) => {
  const remoteName = 'feature-y';
  const remoteKey = `GET repos/acme/app/pulls?head=acme%3A${remoteName}&state=all&per_page=100`;
  let head = '';
  const s = await setup(t, {
    makeScript: (x) => ({ rm: rmFully(x) }),
    ghScript: { [remoteKey]: () => ({ data: [{ number: 7, state: 'closed', merged_at: MERGED_AT, head: { sha: head }, base: { ref: 'main' } }] }) },
  });
  await addWorktree(s, { commit: true });
  await pushWithUpstream(s.wt, BRANCH, remoteName);
  head = await g(s.wt, 'rev-parse', 'HEAD');
  const r = await removeMerged(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(r.pushedBranch, remoteName);
  assert.equal(r.pr.number, 7);
  const lookups = s.gh.calls.map((c) => c.key);
  assert.ok(lookups.length > 0 && lookups.every((k) => k === remoteKey), lookups.join(' | '));
});

test('R24: finish refuses while the session is running and touches nothing', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { state: 'working' });
  halfRemoveWorktree(s.base, s.wt);
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /worktree remove/);
  assert.ok(fs.existsSync(s.wt));
  assert.equal(rmCalls(s).length, 0);
  assert.equal(droppedDirs(s).length, 1);
});

test('R76: worktree create does not adopt an interactive session that has the worktree name', async (t) => {
  const s = await setup(t);
  s.fake.sessions.push({ id: 'feed0001', sessionId: 'feed0001-0000-4000-8000-000000000000', name: 'app-1', cwd: s.base, kind: 'interactive', state: 'working' });
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'created', r.reason);
  assert.equal(s.fake.calls.filter((c) => c.op === 'startBg').length, 1);
  const started = s.fake.sessions.find((x) => x.kind === 'background');
  assert.ok(started);
  assert.equal(r.sessionId, started.sessionId);
  assert.equal(s.claims.getLease('L1').sessionId, started.sessionId);
});

test('R78: worktree remove does not stop a failed session and worktree finish does not refuse it', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { push: true, state: 'failed' });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
  assert.equal(s.fake.calls.filter((c) => c.op === 'stop').length, 0);

  const f = await setup(t);
  await addWorktree(f, { state: 'failed' });
  halfRemoveWorktree(f.base, f.wt);
  const fr = await finishWorktree(f.deps, { claims: f.claims, key: KEY, reposDir: REPOS(f) });
  assert.equal(fr.status, 'removed', fr.reason);
  assert.deepEqual(rmCalls(f).map((c) => c.id), ['abcd1234']);
});

test('R24: finish refuses when .git is a directory', async (t) => {
  const s = await setup(t);
  fs.mkdirSync(path.join(s.wt, '.git'), { recursive: true });
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(fs.existsSync(path.join(s.wt, '.git')));
});

test('R24: finish refuses when the folder holds a dotfile', async (t) => {
  const s = await setup(t);
  fs.mkdirSync(s.wt, { recursive: true });
  fs.writeFileSync(path.join(s.wt, '.env'), 'SECRET=1\n', 'utf8');
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.extra, ['.env']);
  assert.ok(fs.existsSync(path.join(s.wt, '.env')));
});

test('R24: finish and remove refuse a junction at the worktree path and leave its target alone', async (t) => {
  const s = await setup(t);
  const targetDir = path.join(makeTempDir(t, 'gvt-fleet-junction-'), 'elsewhere');
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, '.git'), 'gitdir: nowhere\n', 'utf8');
  fs.mkdirSync(path.dirname(s.wt), { recursive: true });
  fs.symlinkSync(targetDir, s.wt, 'junction');
  const fin = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(fin.status, 'refused');
  assert.match(fin.reason, /link or junction/);
  const rem = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(rem.status, 'refused');
  assert.equal(fs.readFileSync(path.join(targetDir, '.git'), 'utf8'), 'gitdir: nowhere\n');
  assert.equal(rmCalls(s).length, 0);
});

test('R22: create refuses an expired held claim', async (t) => {
  const s = await setup(t, { lease: { expiresAt: '2026-11-03T11:00:00.000Z' } });
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /expired/);
  assert.equal(s.fake.calls.length, 0);
});

test('R22: create stops at a dirty base clone before trust and the session', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.base, 'scratch.txt'), 'dirty\n', 'utf8');
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /base clone skipped/);
  assert.equal(s.fake.calls.filter((c) => c.op === 'startBg').length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects, {});
  assert.equal(s.claims.getLease('L1').sessionId, null);
});

test('R22: create stops when the base clone cannot be made', async (t) => {
  const s = await setup(t);
  fs.rmSync(s.base, { recursive: true, force: true });
  const r = await createWorktree(s.deps, { ...createArgs(s), cloneUrl: fwd(path.join(s.root, 'no-such-origin.git')) });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /base clone failed/);
  assert.equal(s.fake.calls.filter((c) => c.op === 'startBg').length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects, {});
});

test('R22: create stops when trust is refused', async (t) => {
  const s = await setup(t);
  const elsewhere = makeTempDir(t, 'gvt-fleet-elsewhere-');
  const r = await createWorktree(s.deps, { ...createArgs(s), trust: { ...s.trust, workspace: elsewhere } });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /trust refused/);
  assert.equal(s.fake.calls.filter((c) => c.op === 'startBg').length, 0);
  assert.equal(s.claims.getLease('L1').sessionId, null);
});

test('R22: create reports a failing claude --bg and records nothing', async (t) => {
  const s = await setup(t, {
    makeScript: () => ({
      startBg: () => {
        throw new Error('claude --bg failed (1): not logged in');
      },
    }),
  });
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /not logged in/);
  assert.equal(s.claims.getLease('L1').sessionId, null);
  assert.equal(s.claims.getLease('L1').wtState ?? null, null);
});

test('R22: create reports a session that is never listed by name and records nothing', async (t) => {
  const s = await setup(t, { makeScript: () => ({ startBg: { stdout: 'started something\n', id: 'deadbeef' } }) });
  const r = await createWorktree(s.deps, createArgs(s));
  assert.equal(r.status, 'failed');
  assert.equal(r.printedId, 'deadbeef');
  assert.match(r.reason, /no session named app-1/);
  assert.deepEqual(s.sleeps, [1000, 1000, 1000, 1000]);
  assert.equal(s.claims.getLease('L1').sessionId, null);
});

test('R105: remove records the upstream-named branch by coordinator before claude rm, with no GitHub call', async (t) => {
  const s = await pushedUnderOtherName(t);
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: REMOTE_NAME, dropped: null });
  assert.deepEqual(readRecord(s), { [REMOTE_NAME]: OWN_ENTRY });
  assert.deepEqual(s.recordAtRm, { [REMOTE_NAME]: OWN_ENTRY }, 'the entry was written before claude rm ran');
  assert.deepEqual(s.gh.calls, []);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'branches.lock')), false);
});

test('R105: remove records nothing when git ls-remote shows the pushed branch gone', async (t) => {
  const s = await pushedUnderOtherName(t);
  // Deleted on the origin only: the base clone still has its tracking ref, so the safety check passes.
  await g(s.sandbox.origin, 'branch', '-D', REMOTE_NAME);
  const before = fs.readFileSync(s.recordFile, 'utf8');
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: null });
  assert.equal(fs.readFileSync(s.recordFile, 'utf8'), before);
});

test('R105: remove never overwrites an entry that is not by coordinator', async (t) => {
  const mine = { disposition: 'keep', decided: '2026-10-01', by: 'coach' };
  const s = await pushedUnderOtherName(t, { 'acme/app': { [REMOTE_NAME]: mine } });
  const before = fs.readFileSync(s.recordFile, 'utf8');
  const r = await removeRecording(s);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: null, dropped: null });
  assert.equal(fs.readFileSync(s.recordFile, 'utf8'), before);
  assert.deepEqual(readRecord(s)[REMOTE_NAME], mine);
});

test('R105: remove drops the coordinator worktree-<name> entry for the same issue and no other entry', async (t) => {
  const own = await pushedUnderOtherName(t, { 'acme/app': { [BRANCH]: OWN_ENTRY } });
  const r = await removeRecording(own);
  assert.equal(r.status, 'removed', r.reason);
  assert.deepEqual(r.branchRecord, { recorded: REMOTE_NAME, dropped: BRANCH });
  assert.deepEqual(readRecord(own), { [REMOTE_NAME]: OWN_ENTRY });

  const otherIssue = { ...OWN_ENTRY, issue: 'acme/app#9' };
  const byCoach = { ...OWN_ENTRY, by: 'coach' };
  for (const kept of [otherIssue, byCoach]) {
    const s = await pushedUnderOtherName(t, { 'acme/app': { [BRANCH]: kept } });
    const res = await removeRecording(s);
    assert.equal(res.status, 'removed', res.reason);
    assert.equal(res.branchRecord.dropped, null);
    assert.deepEqual(readRecord(s)[BRANCH], kept);
  }
});

test('R105: worktree remove --json carries branchRecord and says on stderr that config/branches.json changed', async (t) => {
  const s = await pushedUnderOtherName(t);
  const configFile = path.join(s.root, 'config', 'repos.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const events = [];
  const ctx = {
    configFile, stateDir: s.stateDir, json: true, repoRoot: s.ws, paths: { workspace: s.ws, claudeJson: s.claudeJson },
    clock: { now: () => NOW, sleep: async () => {} }, claude: s.fake, gh: s.gh,
    out: (x) => out.push(x), err: (x) => err.push(x), log: { append: (e) => events.push(e) },
  };
  assert.equal(await worktreeRemoveCommand(ctx, ['app#1']), 0, err.join(' | '));
  assert.deepEqual(JSON.parse(out.join('\n')).branchRecord, { recorded: REMOTE_NAME, dropped: null });
  assert.deepEqual(err.filter((l) => /branches\.json/.test(l)), [`${KEY}: config/branches.json changed; commit it`]);
  assert.deepEqual(events.at(-1).branchRecord, { recorded: REMOTE_NAME });
  assert.deepEqual(readRecord(s), { [REMOTE_NAME]: OWN_ENTRY });

  // Nothing changed in the file: no hint.
  const quiet = await pushedUnderOtherName(t);
  await g(quiet.sandbox.origin, 'branch', '-D', REMOTE_NAME);
  const err2 = [];
  const ctx2 = { ...ctx, stateDir: quiet.stateDir, repoRoot: quiet.ws, paths: { workspace: quiet.ws, claudeJson: quiet.claudeJson }, claude: quiet.fake, gh: quiet.gh, configFile: path.join(quiet.root, 'config', 'repos.json'), out: () => {}, err: (x) => err2.push(x) };
  fs.writeFileSync(ctx2.configFile, fs.readFileSync(configFile, 'utf8'), 'utf8');
  assert.equal(await worktreeRemoveCommand(ctx2, ['app#1']), 0, err2.join(' | '));
  assert.deepEqual(err2.filter((l) => /branches\.json/.test(l)), []);
});

test('R24: holders report source none when handle64 and tasklist both fail', async () => {
  const run = async (argv) => ({ code: 1, stdout: /handle64/.test(argv[0]) ? 'Code.exe pid: 1 type: File\n' : '', stderr: 'access denied' });
  const r = await createFindHolders({ run, resolve: (n) => `C:/tools/${n}.exe` })('C:/x/app-1');
  assert.equal(r.source, 'none');
  assert.deepEqual(r.holders, []);
  assert.match(r.error, /tasklist exited 1/);
});

test('NF-cli: help with no argument prints the global help and exits 0', () => {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli', 'bin', 'gvt-fleet.mjs');
  const res = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Usage: gvt-fleet /);
  assert.match(res.stdout, /worktree finish/);
});
