process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { worktreeRemoveCommand } from '../plugin/cli/lib/commands.mjs';
import { finishWorktree, removeWorktree } from '../plugin/cli/lib/worktrees.mjs';
import { sequence } from './fakes/fake-claude.mjs';
import {
  commitFile,
  fwd,
  g,
  git,
  halfRemoveWorktree,
} from './helpers/git-sandbox.mjs';
import {
  BRANCH,
  KEY,
  NOW,
  OK,
  PULLS_KEY,
  REPOS,
  SESSION_ID,
  addWorktree,
  rmFully,
  setup,
} from './helpers/worktree-sandbox.mjs';
import { branchExists, rmCalls } from './helpers/worktrees-shared.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// ---- review fixes: consent, the safety gate, finish guards, create preconditions ----

const noopRun = { code: 0, stdout: '', stderr: '' };

test('R23: discard consent from a refused run does not carry over to a later remove', async (t) => {
  const s = await setup(t, { makeScript: () => ({ rm: { code: 1, stdout: '', stderr: 'refused: unpushed work\n' } }) });
  await addWorktree(s, { commit: true });
  const first = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s), discard: true });
  assert.equal(first.status, 'refused');
  assert.equal(s.claims.getLease('L1').discardHead, null, 'a refused run clears the consent');
  const callsAfterFirst = s.fake.calls.filter((c) => c.op === 'rm' || c.op === 'stop').length;
  await commitFile(s.wt, 'later.txt', 'made after the refused run\n');
  const second = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(second.status, 'refused');
  assert.ok(second.problems.some((p) => /not pushed to any remote branch/.test(p)), second.problems.join('; '));
  assert.equal(s.fake.calls.filter((c) => c.op === 'rm' || c.op === 'stop').length, callsAfterFirst, 'the second run called neither stop nor rm');
  assert.equal(await branchExists(s), true);
  assert.ok(fs.existsSync(path.join(s.wt, 'later.txt')));
});

test('R23: a plain remove runs the safety check even when a discard commit is recorded on the claim', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { commit: true, state: 'done' }); // no stop, so only the first check can refuse
  s.claims.immediate(() => s.claims.updateLease('L1', { discardHead: 'f'.repeat(40) }));
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.equal(rmCalls(s).length, 0);
  assert.equal(s.claims.getLease('L1').discardHead, null);
});

test('R23: remove exits 1 and reports the branch kept when git branch -d refuses', async (t) => {
  let head = '';
  // claude rm removes the worktree and the session but leaves the branch, whose commit is not merged locally.
  const rmKeepsBranch = (x) => async () => {
    await g(x.base, 'worktree', 'remove', '--force', fwd(x.wt));
    x.fake.sessions.length = 0;
    return OK;
  };
  const s = await setup(t, {
    makeScript: (x) => ({ rm: rmKeepsBranch(x) }),
    ghScript: { [PULLS_KEY]: () => ({ data: [{ merged_at: '2026-11-02T00:00:00Z', head: { sha: head } }] }) },
  });
  await addWorktree(s, { commit: true });
  head = await g(s.wt, 'rev-parse', 'HEAD');
  const configFile = path.join(s.root, 'config', 'repos.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }] }), 'utf8');
  const out = [];
  const err = [];
  const ctx = {
    configFile, stateDir: s.stateDir, json: false, repoRoot: s.ws, paths: { workspace: s.ws, claudeJson: s.claudeJson },
    clock: { now: () => NOW, sleep: async () => {} }, claude: s.fake, gh: s.gh,
    out: (x) => out.push(x), err: (x) => err.push(x), log: { append: () => {} },
  };
  const code = await worktreeRemoveCommand(ctx, ['app#1']);
  assert.equal(code, 1, err.join(' | '));
  assert.equal(out.join(' | '), `${KEY}: branch-kept`);
  assert.match(err.join(' | '), new RegExp(`${KEY}: branch-kept: the worktree is removed but the branch ${BRANCH} was kept: git branch -d ${BRANCH} failed`));
  assert.equal(await branchExists(s), true);
  assert.equal(fs.existsSync(s.wt), false);
});

test('R24: finish keeps a branch that moved after discard consent', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { commit: true, state: 'done' });
  const given = await g(s.wt, 'rev-parse', 'HEAD');
  await commitFile(s.wt, 'after-consent.txt', 'x\n');
  s.claims.immediate(() => s.claims.updateLease('L1', { discardHead: given }));
  halfRemoveWorktree(s.base, s.wt);
  const r = await finishWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'branch-kept');
  assert.match(r.reason, /moved after discard consent/);
  assert.equal(await branchExists(s), true);
});

test('R24: finish passes the value rm reported to --discard-unpushed only while the consent holds', async (t) => {
  const refusal = { code: 1, stdout: 'unpushed commits; rerun with --discard-unpushed 1234abc@wt-9\n', stderr: '' };
  const withConsent = await setup(t, { makeScript: () => ({ rm: sequence(refusal, noopRun) }) });
  await addWorktree(withConsent, { commit: true, state: 'done' });
  const tip = await g(withConsent.wt, 'rev-parse', 'HEAD');
  withConsent.claims.immediate(() => withConsent.claims.updateLease('L1', { discardHead: tip }));
  halfRemoveWorktree(withConsent.base, withConsent.wt);
  const ok = await finishWorktree(withConsent.deps, { claims: withConsent.claims, key: KEY, reposDir: REPOS(withConsent) });
  assert.equal(ok.status, 'removed', ok.reason);
  assert.equal(rmCalls(withConsent)[1].discardUnpushed, '1234abc@wt-9');

  const without = await setup(t, { makeScript: () => ({ rm: sequence(refusal, noopRun) }) });
  await addWorktree(without, { commit: true, state: 'done' });
  halfRemoveWorktree(without.base, without.wt);
  const no = await finishWorktree(without.deps, { claims: without.claims, key: KEY, reposDir: REPOS(without) });
  assert.equal(no.status, 'refused');
  assert.equal(rmCalls(without).length, 1, 'no second rm without consent');
});

test('R23: remove refuses a folder that git does not list and that holds files, with the branch gone', async (t) => {
  const s = await setup(t);
  // Real clones exclude /.claude/worktrees/, so git status inside it shows nothing for an untracked file.
  fs.appendFileSync(path.join(s.base, '.git', 'info', 'exclude'), '/.claude/worktrees/\n');
  fs.mkdirSync(s.wt, { recursive: true });
  fs.writeFileSync(path.join(s.wt, 'notes.txt'), 'unsaved\n', 'utf8');
  s.fake.sessions.push({ id: 'abcd1234', sessionId: SESSION_ID, name: 'app-1', kind: 'background', state: 'done' });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /not a registered worktree/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
  assert.equal(fs.readFileSync(path.join(s.wt, 'notes.txt'), 'utf8'), 'unsaved\n');
});

test('R23: remove refuses a half-removed folder whose status git cannot read', async (t) => {
  const s = await setup(t);
  await addWorktree(s, { push: true, state: 'done' });
  halfRemoveWorktree(s.base, s.wt);
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /git status failed/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
});

test('R23: remove refuses when the session commits between the check and the stop', async (t) => {
  const s = await setup(t, {
    makeScript: (x) => ({
      rm: rmFully(x),
      stop: async () => {
        await commitFile(x.wt, 'late.txt', 'committed while stopping\n');
        return noopRun;
      },
    }),
  });
  await addWorktree(s, { push: true });
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /not pushed/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
  assert.equal(await branchExists(s), true);
});

test('R23: remove refuses a detached HEAD with commits on no remote branch', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { push: true });
  await g(s.wt, 'checkout', '--detach');
  await commitFile(s.wt, 'detached.txt', 'only here\n');
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /detached/.test(p)), r.problems.join('; '));
  assert.equal(rmCalls(s).length, 0);
});

test('R23: remove refuses a stash made on a detached HEAD', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { push: true });
  await g(s.wt, 'checkout', '--detach');
  fs.writeFileSync(path.join(s.wt, 'README.md'), 'edited\n', 'utf8');
  await g(s.wt, 'stash', 'push', '-m', 'wip');
  assert.match(await g(s.wt, 'stash', 'list', '--format=%gs'), /^(WIP on|On) \(no branch\):/);
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'refused');
  assert.ok(r.problems.some((p) => /stash/.test(p)), r.problems.join('; '));
});

test('R23: remove refuses an unpushed branch whose pull request is open or merged at another commit', async (t) => {
  for (const pr of [(head) => ({ merged_at: null, state: 'open', head: { sha: head } }), () => ({ merged_at: '2026-11-02T00:00:00Z', head: { sha: '0'.repeat(40) } })]) {
    let head = '';
    const s = await setup(t, {
      makeScript: (x) => ({ rm: rmFully(x) }),
      ghScript: { [PULLS_KEY]: () => ({ data: [pr(head)] }) },
    });
    await addWorktree(s, { commit: true });
    head = await g(s.wt, 'rev-parse', 'HEAD');
    const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
    assert.equal(r.status, 'refused');
    assert.equal(rmCalls(s).length, 0);
    assert.equal(await branchExists(s), true);
  }
});

test('R23: remove ignores a stash made on another branch', async (t) => {
  const s = await setup(t, { makeScript: (x) => ({ rm: rmFully(x) }) });
  await addWorktree(s, { push: true });
  fs.writeFileSync(path.join(s.base, 'README.md'), 'edited in the base clone\n', 'utf8');
  await g(s.base, 'stash', 'push', '-m', 'someone else');
  assert.match(await g(s.base, 'stash', 'list', '--format=%gs'), /^(WIP on|On) main:/);
  const r = await removeWorktree(s.deps, { claims: s.claims, key: KEY, reposDir: REPOS(s) });
  assert.equal(r.status, 'removed', r.reason);
});
