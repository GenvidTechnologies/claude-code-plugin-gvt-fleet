process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openCacheDb } from '../plugin/cli/lib/cache-db.mjs';
import { openClaimsDb } from '../plugin/cli/lib/claims-db.mjs';
import {
  dispatchCommand,
  readyCommand,
  statusCommand,
  whyCommand,
  worktreeCreateCommand,
} from '../plugin/cli/lib/commands.mjs';
import {
  defaultPrompt,
  repoFromRemoteUrl,
  TASK_RULE,
  workspaceRepo,
} from '../plugin/cli/lib/dispatch.mjs';
import { trustKey } from '../plugin/cli/lib/trust.mjs';
import { LABEL } from './helpers/fake-github.mjs';
import { dispatchSandbox, NOW, seedTaskLease } from './helpers/dispatch-sandbox.mjs';
import { fwd, g, git, pushCommit } from './helpers/git-sandbox.mjs';

// Same filter as bin/gvt-fleet.mjs: only the sqlite ExperimentalWarning is swallowed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const KEY = 'acme/app#1';
const SELF_KEY = 'example-org/fleet-home#1';
const PROMPT = 'Work on GitHub issue acme/app#1. When you open a pull request for this issue, put a closing keyword for it in the body (Fixes acme/app#1), so that gvt-fleet wrap can prove the merge.';
const EXPIRY = new Date(NOW.getTime() + 120 * 60 * 1000).toISOString();
const LABEL_DELETE = `repos/acme/app/issues/1/labels/${LABEL}`;
const ASSIGNEE_DELETE = 'repos/acme/app/issues/1/assignees';
const EXCLUDE_LINE = '/.claude/worktrees/';

const errText = (s) => s.err.join('\n');
const wtPath = (s) => path.join(s.base, '.claude', 'worktrees', 'app-1');
const starts = (s) => s.fake.calls.filter((c) => c.op === 'startBg');
const deletes = (s) => s.gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const head = (dir) => g(dir, 'rev-parse', 'HEAD');
const writeConfig = (s, config) => fs.writeFileSync(s.configFile, JSON.stringify(config), 'utf8');

async function leaseRows(s, key = KEY) {
  const db = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
  try {
    return db.listLeases().filter((l) => l.key === key);
  } finally {
    db.close();
  }
}

async function putHeldLease(s, extra = {}) {
  const db = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
  try {
    db.immediate(() =>
      db.putLease({ leaseId: 'L0', key: KEY, state: 'held', claimedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), expiresAt: '2099-01-01T00:00:00.000Z', labelAdded: true, assigneePreexisting: false, ...extra }),
    );
  } finally {
    db.close();
  }
}

/** The common shape of a rolled-back dispatch: both GitHub marks removed, the lease released, the step and "rolled back" on stderr, exit 1. */
async function assertRolledBack(s, code, step) {
  assert.equal(code, 1, errText(s));
  assert.deepEqual(deletes(s), [LABEL_DELETE, ASSIGNEE_DELETE]);
  assert.equal((await leaseRows(s)).at(-1).state, 'released');
  assert.match(errText(s), new RegExp(`${KEY}: ${step} `), errText(s));
  assert.match(errText(s), /rolled back/);
}

/** Let git ignore the worktree folder, so that a folder made by the test does not make the base clone dirty. */
function excludeWorktrees(s) {
  const file = path.join(s.base, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${EXCLUDE_LINE}\n`, 'utf8');
}

const SESSION = (s, state) => ({ id: 'abcd1234', sessionId: 'abcd1234-0000-4000-8000-000000000000', name: 'app-1', cwd: wtPath(s), kind: 'background', state });

test('R53: dispatch with no ref, three positional arguments, a bad ref or a prompt that starts with - exits 64 and calls neither gh nor claude', async (t) => {
  const s = await dispatchSandbox({ t });
  const bad = [[], ['--allow-self'], [KEY, 'a', 'b'], ['nonsense'], ['other/repo#1'], [KEY, '-fix it'], [KEY, '--frobnicate'], ['-x']];
  for (const args of bad) {
    assert.equal(await dispatchCommand(s.ctx, args), 64, JSON.stringify(args));
  }
  assert.equal(s.err.length, bad.length, errText(s));
  assert.deepEqual(s.out, []);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
});

test('R54: dispatch claims, refreshes the base clone, trusts it, starts the session, and exits 0', async (t) => {
  const s = await dispatchSandbox({ t });
  const newHead = await pushCommit(s.sandbox, 'later.txt', 'later\n');
  assert.notEqual(await head(s.base), newHead);
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 0, errText(s));

  const lease = (await leaseRows(s)).at(-1);
  assert.equal(lease.state, 'held');
  assert.equal(lease.expiresAt, EXPIRY);
  assert.equal(lease.worktreePath, wtPath(s));
  assert.equal(lease.branch, 'worktree-app-1');
  assert.match(lease.shortId, /^[0-9a-f]{8}$/);
  assert.deepEqual(s.gh.writes().map((c) => c.key).sort(), [`POST repos/acme/app/issues/1/assignees`, `POST repos/acme/app/issues/1/labels`]);

  assert.equal(await head(s.base), newHead, 'the base clone was fast-forwarded');
  const projects = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects;
  assert.equal(projects[trustKey(s.base)]?.hasTrustDialogAccepted, true);
  assert.equal(starts(s).length, 1);
  assert.deepEqual(starts(s)[0].argv, ['--bg', '-w', 'app-1', '-n', 'app-1', PROMPT]);
  assert.equal(starts(s)[0].cwd, s.base);

  assert.equal(fs.existsSync(path.join(path.dirname(s.configFile), 'branches.json')), false, 'no branch record entry was written');
  assert.match(s.out.join('\n'), new RegExp(`^${KEY}: created .*app-1 \\(session [0-9a-f]{8}\\) until ${EXPIRY}$`));
});

test('R106: dispatch leaves the branch record file byte for byte as it was', async (t) => {
  const s = await dispatchSandbox({ t });
  const recordFile = path.join(path.dirname(s.configFile), 'branches.json');
  const before = JSON.stringify({ version: 1, repos: { 'acme/app': { 'other-branch': { disposition: 'keep', decided: '2026-11-01', by: 'coach' } } } }, null, 2) + '\n';
  fs.writeFileSync(recordFile, before, 'utf8');
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(s.stateDir, 'branches.lock')), false);
});

test('R54: dispatch --json prints the key, the lease expiry, the worktree path and the session short id', async (t) => {
  const s = await dispatchSandbox({ t });
  s.ctx.json = true;
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  const body = JSON.parse(s.out.join('\n'));
  assert.equal(body.status, 'created');
  assert.equal(body.key, KEY);
  assert.equal(body.expiresAt, EXPIRY);
  assert.equal(body.path, wtPath(s));
  assert.equal(body.shortId, s.fake.sessions[0].sessionId.slice(0, 8));
});

test('R55: a refused claim stops dispatch before any clone, trust write or session, and exits 1', async (t) => {
  const s = await dispatchSandbox({ t, issues: { 1: { labels: ['triaged', LABEL], assignees: [] } } });
  const oldHead = await head(s.base);
  await pushCommit(s.sandbox, 'later.txt', 'later\n');
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1);
  assert.match(errText(s), /acme\/app#1: in-progress-label: /);
  assert.equal(s.gh.writes().length, 0);
  assert.equal(await head(s.base), oldHead, 'the base clone was not refreshed');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects, {});
  assert.equal(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')), false);
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(s.out, []);
});

test('R55: an unknown default branch or a dirty base clone stops dispatch before the claim, with no GitHub call', async (t) => {
  const s = await dispatchSandbox({ t });
  writeConfig(s, { version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app' }, { repo: 'example-org/fleet-home', defaultBranch: 'main' }] });
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 1);
  assert.match(errText(s), /acme\/app#1: default-branch refused: default branch unknown; run gvt-fleet sync first/);

  s.err.length = 0;
  writeConfig(s, { version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }, { repo: 'example-org/fleet-home', defaultBranch: 'main' }] });
  fs.writeFileSync(path.join(s.base, 'dirty.txt'), 'x\n', 'utf8');
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 1);
  assert.match(errText(s), /acme\/app#1: base-clone refused: .*dirty/);

  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(await leaseRows(s), [], 'no claim row was written');
});

test('R56: dispatch rolls back its own claim when the base clone cannot be made', async (t) => {
  const s = await dispatchSandbox({ t });
  fs.rmSync(s.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  s.ctx.cloneUrlOf = () => fwd(path.join(s.root, 'no-such-origin.git'));
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'clone');
  assert.equal(starts(s).length, 0);
});

test('R56: dispatch rolls back its own claim when trust is refused', async (t) => {
  const s = await dispatchSandbox({ t });
  // The base clone is a junction to a folder outside the workspace, so its real path is outside.
  const outside = path.join(s.root, 'outside', 'app');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.renameSync(s.base, outside);
  fs.symlinkSync(outside, s.base, 'junction');
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'trust');
  assert.match(errText(s), /outside workspace/);
  assert.equal(starts(s).length, 0);
});

test('R56: dispatch rolls back its own claim when claude agents cannot be read', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      agents: () => {
        throw new Error('agents down');
      },
    },
  });
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'agents');
  assert.match(errText(s), /agents down/);
  assert.equal(starts(s).length, 0);
});

test('R56: dispatch rolls back its own claim when the worktree folder exists without a session', async (t) => {
  const s = await dispatchSandbox({ t });
  excludeWorktrees(s);
  fs.mkdirSync(wtPath(s), { recursive: true });
  fs.writeFileSync(path.join(wtPath(s), 'mine.txt'), 'keep', 'utf8');
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'folder');
  assert.equal(fs.readFileSync(path.join(wtPath(s), 'mine.txt'), 'utf8'), 'keep');
  assert.equal(starts(s).length, 0);
});

test('R56: dispatch rolls back its own claim when claude --bg fails and leaves no folder and no session', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'start');
  assert.match(errText(s), /claude exploded/);
  assert.equal(fs.existsSync(wtPath(s)), false);
});

test('R56: dispatch rolls back its own claim when another assignee appeared during the claim', async (t) => {
  const s = await dispatchSandbox({ t, extraAssignee: 'rival' });
  await assertRolledBack(s, await dispatchCommand(s.ctx, [KEY]), 'contention');
  assert.match(errText(s), /rival/);
  assert.equal(s.fake.calls.length, 0, 'no session was looked for or started');
  assert.equal(s.github.state.issues[1].assignees.join(','), 'rival');
});

test('R57: dispatch never releases a claim that was held before it ran', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      agents: () => {
        throw new Error('agents down');
      },
    },
  });
  await putHeldLease(s);
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1);
  assert.match(errText(s), /agents/);
  assert.equal(s.gh.writes().length, 0);
  const rows = await leaseRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'held');
  assert.doesNotMatch(errText(s), /rolled back/);
});

test('R57: dispatch never releases an expired claim that was held before it ran', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  await putHeldLease(s, { expiresAt: '2000-01-01T00:00:00.000Z' });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1, errText(s));
  assert.match(errText(s), /claude exploded/);
  const rows = await leaseRows(s);
  assert.notEqual(rows.at(-1).state, 'released');
  assert.equal(rows.at(-1).state, 'held');
  assert.deepEqual(deletes(s), []);
  assert.doesNotMatch(errText(s), /rolled back/);
  assert.match(errText(s), /held before this command and is kept/);
});

test('R57: dispatch keeps an expired claim that was held before it ran when another assignee appeared', async (t) => {
  const s = await dispatchSandbox({ t, extraAssignee: 'rival' });
  await putHeldLease(s, { expiresAt: '2000-01-01T00:00:00.000Z' });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1, errText(s));
  assert.match(errText(s), /rival/);
  assert.equal((await leaseRows(s)).at(-1).state, 'held');
  assert.deepEqual(deletes(s), []);
  assert.equal(s.fake.calls.length, 0);
  assert.doesNotMatch(errText(s), /rolled back/);
});

test('R58: the rollback keeps the base clone, the exclude line, the trust entry, the backup, the repo label and a pre-existing assignee', async (t) => {
  const s = await dispatchSandbox({
    t,
    issues: { 1: { labels: ['triaged'], assignees: ['me'] } },
    claudeScript: {
      track: true,
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  const newHead = await pushCommit(s.sandbox, 'later.txt', 'later\n');
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1, errText(s));
  assert.match(errText(s), /rolled back/);
  assert.equal((await leaseRows(s)).at(-1).state, 'released');

  assert.equal(await head(s.base), newHead, 'the base clone keeps the refresh');
  assert.ok(fs.readFileSync(path.join(s.base, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/).includes(EXCLUDE_LINE));
  assert.equal(JSON.parse(fs.readFileSync(s.claudeJson, 'utf8')).projects[trustKey(s.base)]?.hasTrustDialogAccepted, true);
  assert.ok(fs.existsSync(path.join(s.stateDir, 'claude.json.bak')));
  assert.deepEqual(deletes(s), [LABEL_DELETE], 'only the label this claim added is removed');
  assert.equal(deletes(s).filter((p) => p.startsWith('repos/acme/app/labels/')).length, 0, 'the repo label stays');
  assert.deepEqual(s.github.state.issues[1].assignees, ['me']);
});

test('R59: a failed rollback is reported apart from the step failure, names the releasing state and the recovery command, and exits 1', async (t) => {
  const s = await dispatchSandbox({
    t,
    failDelete: true,
    claudeScript: {
      track: true,
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1);
  const lines = s.err;
  const stepLine = lines.findIndex((l) => /^acme\/app#1: start failed: claude exploded/.test(l));
  const rollbackLine = lines.findIndex((l) => /rollback failed/.test(l));
  assert.ok(stepLine >= 0, errText(s));
  assert.ok(rollbackLine >= 0 && rollbackLine !== stepLine, errText(s));
  assert.match(lines[rollbackLine], /releasing/);
  assert.match(lines[rollbackLine], /gvt-fleet release acme\/app#1/);
  assert.doesNotMatch(errText(s), /was rolled back/);
  assert.equal((await leaseRows(s)).at(-1).state, 'releasing');
});

test('R60: when claude --bg exits 0 but no session is listed, dispatch keeps the claim, removes nothing, names the session and the id hint, and exits 1', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: { track: true, startBg: () => ({ stdout: 'backgrounded deadbeef\n', id: 'deadbeef' }) },
  });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1);
  assert.equal((await leaseRows(s)).at(-1).state, 'held');
  assert.equal(s.fake.calls.filter((c) => c.op === 'rm' || c.op === 'stop').length, 0);
  assert.deepEqual(deletes(s), []);
  assert.match(errText(s), /app-1/);
  assert.match(errText(s), /deadbeef/);
  assert.doesNotMatch(errText(s), /rolled back/);
});

test('R60: when claude agents fails after claude --bg started, dispatch keeps the claim, removes nothing and exits 1', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      startBg: () => ({ stdout: 'backgrounded deadbeef\n', id: 'deadbeef' }),
      agents: (_arg, n) => {
        if (n === 0) return [];
        throw new Error('agents down');
      },
    },
  });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal((await leaseRows(s)).at(-1).state, 'held');
  assert.deepEqual(deletes(s), []);
  assert.equal(s.fake.calls.filter((c) => c.op === 'rm' || c.op === 'stop').length, 0);
  assert.match(errText(s), /claude agents failed after claude --bg: agents down/);
  assert.match(errText(s), /deadbeef/);
  assert.match(errText(s), /the claim is kept/);
  assert.doesNotMatch(errText(s), /rolled back/);
});

test('R60: when claude --bg fails and the worktree folder exists, dispatch keeps the claim and exits 1', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      startBg: (opts) => {
        fs.mkdirSync(path.join(opts.cwd, '.claude', 'worktrees', 'app-1'), { recursive: true });
        throw new Error('claude --bg failed');
      },
    },
  });
  const code = await dispatchCommand(s.ctx, [KEY]);
  assert.equal(code, 1);
  assert.equal((await leaseRows(s)).at(-1).state, 'held');
  assert.deepEqual(deletes(s), []);
  assert.ok(fs.existsSync(wtPath(s)), 'the folder is left alone');
  assert.match(errText(s), /claude --bg failed/);
  assert.match(errText(s), /app-1/);
  assert.doesNotMatch(errText(s), /rolled back/);
});

test('R61: dispatch refuses an issue in the workspace repository with no gh call and no claude call, and exits 1', async (t) => {
  const s = await dispatchSandbox({ t });
  const code = await dispatchCommand(s.ctx, [SELF_KEY]);
  assert.equal(code, 1);
  assert.match(errText(s), /example-org\/fleet-home#1: self-repo refused: .*--allow-self/);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(await leaseRows(s, SELF_KEY), []);
});

test('R61: dispatch --allow-self dispatches an issue in the workspace repository', async (t) => {
  const s = await dispatchSandbox({ t });
  const code = await dispatchCommand(s.ctx, ['--allow-self', SELF_KEY]);
  assert.equal(code, 0, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal(starts(s)[0].cwd, path.join(s.ws, 'repos', 'example-org', 'fleet-home'));
  assert.equal((await leaseRows(s, SELF_KEY)).at(-1).state, 'held');
});

test('R61: dispatch refuses when the workspace repository cannot be read, unless --allow-self is given', async (t) => {
  const s = await dispatchSandbox({ t, remote: null });
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 1);
  assert.match(errText(s), /acme\/app#1: self-repo refused: cannot read the workspace repository/);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);

  assert.equal(await dispatchCommand(s.ctx, ['--allow-self', KEY]), 0, errText(s));
  assert.equal(starts(s).length, 1);
});

test('R61: the workspace repository is read from an SSH or an HTTPS origin URL', async (t) => {
  const s = await dispatchSandbox({ t, remote: 'https://github.com/example-org/fleet-home' });
  assert.equal(await workspaceRepo(git, s.ws), 'example-org/fleet-home');
  await g(s.ws, 'remote', 'set-url', 'origin', 'git@github.com:example-org/fleet-home.git');
  assert.equal(await workspaceRepo(git, s.ws), 'example-org/fleet-home');
  assert.equal(await workspaceRepo(git, path.join(s.ws, 'repos')), null, 'a folder below the workspace root is not the workspace repository');
  assert.equal(await dispatchCommand(s.ctx, [SELF_KEY]), 1, 'the SSH form refuses');
  await g(s.ws, 'remote', 'set-url', 'origin', 'https://github.com/Example-Org/Fleet-Home.git');
  assert.equal(await dispatchCommand(s.ctx, [SELF_KEY]), 1, 'the HTTPS form refuses, whatever the case');

  const table = [
    ['git@github.com:o/n.git', 'o/n'],
    ['git@github.com:o/n', 'o/n'],
    ['https://github.com/o/n.git', 'o/n'],
    ['https://github.com/o/n', 'o/n'],
    ['https://github.com/o/n/', 'o/n'],
    ['ssh://git@github.com/o/n.git', 'o/n'],
    ['https://user@github.com/o/n.git', 'o/n'],
    ['https://example.com/o/n.git', null],
    ['https://github.com/o', null],
    ['not a url', null],
    ['', null],
  ];
  for (const [url, want] of table) assert.equal(repoFromRemoteUrl(url), want, url);
});

test('R62: dispatch with no prompt passes a first prompt that names the issue key', async (t) => {
  const s = await dispatchSandbox({ t });
  assert.equal(defaultPrompt(KEY), PROMPT);
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal(starts(s)[0].argv.at(-1), PROMPT);
});

test('R62: dispatch passes a given prompt to claude unchanged', async (t) => {
  const s = await dispatchSandbox({ t });
  const prompt = '  Fix the bug: see "#1" and `src/a.mjs`  ';
  assert.equal(await dispatchCommand(s.ctx, [KEY, prompt]), 0, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal(starts(s)[0].argv.at(-1), prompt);
  assert.equal(starts(s)[0].argv.filter((a) => a === PROMPT).length, 0);
});

test('N15: dispatch with an empty prompt starts the session with the default prompt', async (t) => {
  const s = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(s.ctx, [KEY, '']), 0, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal(starts(s)[0].argv.at(-1), PROMPT);
});

test('R63: a second dispatch of a held issue with a listed session makes no GitHub write, starts no session and exits 0', async (t) => {
  const s = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  const writes = s.gh.writes().length;
  const calls = s.gh.calls.length;
  s.out.length = 0;
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  assert.equal(s.gh.writes().length, writes);
  assert.equal(s.gh.calls.length, calls, 'no GitHub read either');
  assert.equal(starts(s).length, 1);
  assert.match(s.out.join('\n'), new RegExp(`^${KEY}: noop `));
  assert.equal((await leaseRows(s)).at(-1).state, 'held');
});

test('R63: dispatch adopts an existing session after a fresh claim and keeps the claim, exiting 0 when it is live and 1 when it is done', async (t) => {
  const live = await dispatchSandbox({ t });
  live.fake.sessions.push(SESSION(live, 'working'));
  assert.equal(await dispatchCommand(live.ctx, [KEY]), 0, errText(live));
  assert.equal(starts(live).length, 0);
  assert.equal((await leaseRows(live)).at(-1).state, 'held');
  assert.match(live.out.join('\n'), new RegExp(`^${KEY}: adopted `));

  const done = await dispatchSandbox({ t });
  done.fake.sessions.push(SESSION(done, 'done'));
  assert.equal(await dispatchCommand(done.ctx, [KEY]), 1);
  assert.equal(starts(done).length, 0);
  assert.equal((await leaseRows(done)).at(-1).state, 'held');
  assert.deepEqual(deletes(done), []);
  assert.match(errText(done), /done/);
  assert.doesNotMatch(errText(done), /rolled back/);
});

test('NF-log: dispatch and status each append one line to the log', async (t) => {
  const s = await dispatchSandbox({ t });
  const events = [];
  s.ctx.log = { append: (e) => events.push(e) };
  assert.equal(await dispatchCommand(s.ctx, [KEY]), 0, errText(s));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'dispatch');
  s.ctx.json = true;
  s.out.length = 0;
  assert.equal(await statusCommand(s.ctx, []), 0, errText(s));
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { event: 'status', workers: 1, tasks: 0, refreshed: 1, revived: 0, agents: 1 });
  assert.equal(JSON.parse(s.out.join('\n')).workers[0].key, KEY);
});

// ---- dispatch --task ----

const TASK_DATE = '20261103';
const TASK_KEY = `acme/app@fix-x.${TASK_DATE}.1`;
const SELF_REPO = 'example-org/fleet-home';
const taskName = (n, slug = 'fix-x') => `app.${slug}.${TASK_DATE}.${n}`;
const taskPath = (s, n) => path.join(s.base, '.claude', 'worktrees', taskName(n));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\@/]/g, '\\$&');

async function seedTask(s, row) {
  const db = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
  try {
    return seedTaskLease(db, { repo: 'acme/app', slug: 'fix-x', date: TASK_DATE, n: 1, ...row });
  } finally {
    db.close();
  }
}

test('R149: dispatch --task makes a held task lease and a session, with no GitHub call', async (t) => {
  const s = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(s.ctx, ['--task', 'acme/app', 'fix-x']), 0, errText(s));
  assert.equal(s.gh.calls.length, 0, 'no GitHub read or write');
  const rows = await leaseRows(s, TASK_KEY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'held');
  assert.equal(rows[0].expiresAt, EXPIRY);
  assert.equal(rows[0].worktreePath, taskPath(s, 1));
  assert.equal(rows[0].branch, `worktree-${taskName(1)}`);
  assert.match(rows[0].shortId, /^[0-9a-f]{8}$/);
  assert.equal(starts(s).length, 1);
  assert.deepEqual(starts(s)[0].argv, ['--bg', '-w', taskName(1), '-n', taskName(1), `Task fix-x in acme/app (${TASK_KEY}). ${TASK_RULE}`]);
  assert.equal(starts(s)[0].cwd, s.base);
  assert.match(s.out.join('\n'), new RegExp(`^${escapeRe(TASK_KEY)}: created .*${escapeRe(taskName(1))} \\(session [0-9a-f]{8}\\) until ${EXPIRY}$`));

  const other = await dispatchSandbox({ t });
  other.ctx.json = true;
  assert.equal(await dispatchCommand(other.ctx, ['--task', 'app', 'fix-x']), 0, errText(other));
  const body = JSON.parse(other.out.join('\n'));
  assert.equal(body.status, 'created');
  assert.equal(body.key, TASK_KEY);
  assert.equal(body.claim, 'held');
  assert.equal(body.path, taskPath(other, 1));
});

test('R149: dispatch --task numbers after every row of the slug and date, released history included, and skips a leftover folder or branch', async (t) => {
  const s = await dispatchSandbox({ t });
  excludeWorktrees(s);
  await seedTask(s, { n: 1, state: 'released' });
  await seedTask(s, { n: 2, state: 'released' });
  await seedTask(s, { n: 1, date: '20261102', state: 'released' });
  await seedTask(s, { n: 1, slug: 'fix-x-2', state: 'released' });
  fs.mkdirSync(taskPath(s, 3), { recursive: true });
  await g(s.base, 'branch', `worktree-${taskName(4)}`);
  assert.equal(await dispatchCommand(s.ctx, ['--task', 'acme/app', 'fix-x']), 0, errText(s));
  assert.equal((await leaseRows(s, `acme/app@fix-x.${TASK_DATE}.5`)).at(-1).state, 'held');
  for (const n of [3, 4]) assert.deepEqual(await leaseRows(s, `acme/app@fix-x.${TASK_DATE}.${n}`), []);
  assert.equal(starts(s)[0].argv[2], taskName(5));
  assert.ok(fs.existsSync(taskPath(s, 3)), 'the leftover folder was not touched');
});

test('R149: dispatch --task refuses the workspace repository unless --allow-self is given', async (t) => {
  const s = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(s.ctx, ['--task', SELF_REPO, 'fix-x']), 1);
  assert.match(errText(s), /self-repo refused: .*--allow-self/);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(await leaseRows(s, `${SELF_REPO}@fix-x.${TASK_DATE}.1`), []);

  s.err.length = 0;
  assert.equal(await dispatchCommand(s.ctx, ['--task', '--allow-self', 'fleet-home', 'fix-x']), 0, errText(s));
  assert.equal(starts(s).length, 1);
  assert.equal(starts(s)[0].cwd, path.join(s.ws, 'repos', 'example-org', 'fleet-home'));
  assert.equal((await leaseRows(s, `${SELF_REPO}@fix-x.${TASK_DATE}.1`)).at(-1).state, 'held');
});

test('R149: dispatch --task is refused as task-active while a lease of the same repo and slug is active, and writes nothing', async (t) => {
  const s = await dispatchSandbox({ t });
  const active = await seedTask(s, { n: 7, date: '20261101' });
  s.ctx.json = true;
  assert.equal(await dispatchCommand(s.ctx, ['--task', 'acme/app', 'fix-x']), 1);
  const body = JSON.parse(s.out.join('\n'));
  assert.equal(body.status, 'refused');
  assert.equal(body.step, 'task-active');
  assert.equal(body.key, 'acme/app@fix-x', 'a refusal before the id is allocated reports owner/name@slug');
  assert.ok(body.reason.includes(active), body.reason);
  assert.match(errText(s), /task-active refused/);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
  const db = await openClaimsDb(path.join(s.stateDir, 'claims.db'));
  try {
    assert.equal(db.listLeases().length, 1, 'no row was added');
  } finally {
    db.close();
  }
});

test('R149: every task prompt is the prompt followed by the tracker rule', async (t) => {
  assert.match(TASK_RULE, /unless the coach approves that one write/);
  const a = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(a.ctx, ['--task', 'acme/app', 'fix-x']), 0, errText(a));
  assert.equal(starts(a)[0].argv.at(-1), `Task fix-x in acme/app (${TASK_KEY}). ${TASK_RULE}`);

  const b = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(b.ctx, ['--task', 'acme/app', 'fix-x', 'Repair the build.']), 0, errText(b));
  assert.equal(starts(b)[0].argv.at(-1), `Repair the build. ${TASK_RULE}`);

  const c = await dispatchSandbox({ t });
  assert.equal(await dispatchCommand(c.ctx, ['--task', 'acme/app', 'fix-x', '']), 0, errText(c));
  assert.equal(starts(c)[0].argv.at(-1), `Task fix-x in acme/app (${TASK_KEY}). ${TASK_RULE}`);
});

test('R149: a task start that fails with no traces releases the lease with no GitHub call, and a confirm failure keeps it', async (t) => {
  const failed = await dispatchSandbox({
    t,
    claudeScript: {
      track: true,
      startBg: () => {
        throw new Error('claude exploded');
      },
    },
  });
  assert.equal(await dispatchCommand(failed.ctx, ['--task', 'acme/app', 'fix-x']), 1);
  assert.match(errText(failed), /claude exploded/);
  assert.match(errText(failed), /rolled back/);
  assert.equal((await leaseRows(failed, TASK_KEY)).at(-1).state, 'released');
  assert.equal(failed.gh.calls.length, 0);

  const kept = await dispatchSandbox({
    t,
    claudeScript: { track: true, startBg: () => ({ stdout: 'backgrounded deadbeef\n', id: 'deadbeef' }) },
  });
  assert.equal(await dispatchCommand(kept.ctx, ['--task', 'acme/app', 'fix-x']), 1);
  assert.equal((await leaseRows(kept, TASK_KEY)).at(-1).state, 'held');
  assert.match(errText(kept), /the claim is kept/);
  assert.match(errText(kept), new RegExp(`gvt-fleet worktree create ${escapeRe(TASK_KEY)} to adopt`));
  assert.doesNotMatch(errText(kept), /gvt-fleet dispatch acme/);
  assert.doesNotMatch(errText(kept), /rolled back/);
  assert.equal(kept.gh.calls.length, 0);
});

test('R149: worktree create takes a task id and adopts the session after a confirm failure', async (t) => {
  const s = await dispatchSandbox({
    t,
    claudeScript: { track: true, startBg: () => ({ stdout: 'backgrounded deadbeef\n', id: 'deadbeef' }) },
  });
  assert.equal(await dispatchCommand(s.ctx, ['--task', 'acme/app', 'fix-x']), 1);
  s.fake.sessions.push({ id: 'abcd1234', sessionId: 'abcd1234-0000-4000-8000-000000000000', name: taskName(1), cwd: taskPath(s, 1), kind: 'background', state: 'working' });
  s.out.length = 0;
  assert.equal(await worktreeCreateCommand(s.ctx, [TASK_KEY]), 0, errText(s));
  assert.match(s.out.join('\n'), new RegExp(`^${escapeRe(TASK_KEY)}: noop `));
});

test('R149: worktree create of a task id starts the session with the prompt, or the default one, followed by the tracker rule', async (t) => {
  const a = await dispatchSandbox({ t });
  await seedTask(a, { n: 1 });
  assert.equal(await worktreeCreateCommand(a.ctx, [TASK_KEY]), 0, errText(a));
  assert.equal(starts(a).length, 1);
  assert.equal(starts(a)[0].argv.at(-1), `Task fix-x in acme/app (${TASK_KEY}). ${TASK_RULE}`);

  const b = await dispatchSandbox({ t });
  await seedTask(b, { n: 1 });
  assert.equal(await worktreeCreateCommand(b.ctx, [TASK_KEY, 'Repair the build.']), 0, errText(b));
  assert.equal(starts(b)[0].argv.at(-1), `Repair the build. ${TASK_RULE}`);
});

test('R149: worktree create of a task id refuses a prompt that starts with - and starts nothing', async (t) => {
  const s = await dispatchSandbox({ t });
  await seedTask(s, { n: 1 });
  assert.equal(await worktreeCreateCommand(s.ctx, [TASK_KEY, '--model=x']), 64);
  assert.match(errText(s), /must not start with -/);
  assert.equal(starts(s).length, 0);
});

test('R149: dispatch --task numbers after a row whose repo differs only in letter case', async (t) => {
  const s = await dispatchSandbox({ t });
  await seedTask(s, { repo: 'ACME/app', n: 1, state: 'released' });
  assert.equal(await dispatchCommand(s.ctx, ['--task', 'acme/app', 'fix-x']), 0, errText(s));
  assert.equal((await leaseRows(s, `acme/app@fix-x.${TASK_DATE}.2`)).length, 1);
  assert.equal((await leaseRows(s, TASK_KEY)).length, 0);
});

test('R149: dispatch --task with a missing or bad slug, an unknown repo, a slug past the maximum or a prompt that starts with - exits 64 and calls neither gh nor claude', async (t) => {
  const s = await dispatchSandbox({ t });
  const c3 = 'example-org/a-long-repository-name-for-the-tests';
  const longConfig = path.join(path.dirname(s.configFile), 'long.json');
  fs.writeFileSync(longConfig, JSON.stringify({ version: 1, claimAccount: 'me', repos: [{ repo: 'acme/app', defaultBranch: 'main' }, { repo: c3 }] }), 'utf8');
  const bad = [
    ['--task'],
    ['--task', 'acme/app'],
    ['--task', 'acme/app', 'Fix_X'],
    ['--task', 'acme/app', 'Fix'],
    ['--task', 'acme/app', 'a'.repeat(25)],
    ['--task', 'nope/none', 'fix-x'],
    ['--task', 'acme/app', 'fix-x', '-fix it'],
    ['--task', 'acme/app', 'fix-x', 'a', 'b'],
  ];
  for (const args of bad) assert.equal(await dispatchCommand(s.ctx, args), 64, JSON.stringify(args));
  assert.match(s.err[4], /the maximum is 24 for acme\/app/);

  s.ctx.configFile = longConfig;
  assert.equal(await dispatchCommand(s.ctx, ['--task', c3, 'a'.repeat(17)]), 64);
  assert.match(s.err.at(-1), new RegExp(`the maximum is 16 for ${escapeRe(c3)}`));

  assert.equal(s.err.length, bad.length + 1, errText(s));
  assert.deepEqual(s.out, []);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.fake.calls.length, 0);
});

test('R155: a held task lease in the repo leaves ready and why for an issue unchanged', async (t) => {
  const s = await dispatchSandbox({ t });
  const cache = await openCacheDb(path.join(s.stateDir, 'cache.db'));
  cache.transaction(() => {
    cache.upsertIssue({
      key: KEY, repo: 'acme/app', number: 1, state: 'open', title: 'Issue 1', body: '', updatedAt: '2026-11-03T09:00:00Z',
      labels: ['triaged'], assignees: [], comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [], closingPrs: [], managed: true,
    });
  });
  cache.close();
  s.ctx.json = true;
  const snapshot = async () => {
    s.out.length = 0;
    assert.equal(await readyCommand(s.ctx, []), 0, errText(s));
    const ready = s.out.join('\n');
    s.out.length = 0;
    assert.equal(await whyCommand(s.ctx, [KEY]), 0, errText(s));
    return { ready, why: s.out.join('\n') };
  };
  const before = await snapshot();
  assert.equal(JSON.parse(before.why).ready, true);
  await seedTask(s, { n: 1 });
  assert.deepEqual(await snapshot(), before);
});
