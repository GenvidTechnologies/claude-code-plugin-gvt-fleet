#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createLog } from '../lib/log.mjs';
import { LEGACY } from '../lib/legacy-names.mjs';
import { GVT_DEV_MIN_VERSION, GvtDevError } from '../lib/plugin-path.mjs';
import {
  branchSetCommand,
  branchesCommand,
  claimCommand,
  classCommand,
  cloneCommand,
  dispatchCommand,
  expireCommand,
  installHooksCommand,
  iterationListCommand,
  iterationPlanCommand,
  iterationPromoteCommand,
  trustCommand,
  heartbeatCommand,
  readyCommand,
  releaseCommand,
  statusCommand,
  syncCommand,
  watchCommand,
  whyCommand,
  worktreeCreateCommand,
  worktreeFinishCommand,
  worktreeRemoveCommand,
  wrapCommand,
} from '../lib/commands.mjs';
import { ConfigError, effectiveRepoSettings, loadConfig, validateBranchRecord } from '../lib/config.mjs';
import { findWorkspace } from '../lib/workspace.mjs';

// Installed before any dynamic import('node:sqlite'). Only the sqlite
// ExperimentalWarning is swallowed; every other warning goes to stderr.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const EXIT_RUNTIME = 1;
const EXIT_USAGE = 64;

// The folder that holds this CLI's bin/ and lib/. It is not the workspace: see findWorkspace.
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function notImplemented(name) {
  return async (ctx) => {
    ctx.err(`gvt-fleet: ${name}: not implemented yet`);
    return EXIT_USAGE;
  };
}

async function checkConfig(ctx, args) {
  if (args.length > 0) {
    ctx.err('usage: gvt-fleet check-config');
    return EXIT_USAGE;
  }
  const branchesFile = path.join(path.dirname(ctx.configFile), 'branches.json');
  const errors = [];
  let config = null;
  try {
    config = await loadConfig({ file: ctx.configFile });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    errors.push(...e.errors);
  }
  let record = { version: 1, repos: {} };
  let text = null;
  try {
    text = await readFile(branchesFile, 'utf8');
  } catch (e) {
    // A branch record beside a non-default config is optional; a missing one is an empty record.
    if (e.code !== 'ENOENT') errors.push({ entry: '(branches)', message: `cannot read ${branchesFile}: ${e.message}` });
  }
  if (text !== null) {
    try {
      record = JSON.parse(text);
      errors.push(...validateBranchRecord(record).errors);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      errors.push({ entry: '(branches)', message: `invalid JSON in ${branchesFile}: ${e.message}` });
    }
  }
  if (errors.length > 0) {
    const ce = new ConfigError(errors);
    for (const x of ce.errors) ctx.err(`${x.entry}: ${x.message}`);
    return ce.exitCode;
  }
  const repos = config.repos.map((entry) => {
    const { triagedLabel, inProgressLabel, blockedLabel, project, enabled, repo } = effectiveRepoSettings(entry);
    return { repo, enabled, triagedLabel, inProgressLabel, blockedLabel, project };
  });
  const branchRepos = Object.keys(record.repos);
  const branchCount = branchRepos.reduce((n, r) => n + Object.keys(record.repos[r]).length, 0);
  const enabledCount = repos.filter((r) => r.enabled).length;
  if (ctx.json) {
    const [{ run }, { createGit }, { COACH_CONTRACT, workspaceRepo }] = await Promise.all([import('../lib/proc.mjs'), import('../lib/git.mjs'), import('../lib/dispatch.mjs')]);
    const coach = { contract: COACH_CONTRACT, workspaceRepo: await workspaceRepo(createGit({ run: ctx.run ?? run }), ctx.paths?.workspace ?? ctx.repoRoot) };
    ctx.out(JSON.stringify({ repos, branches: { repos: branchRepos.length, entries: branchCount }, coach }, null, 2));
  } else {
    ctx.out(`${repos.length} repos, ${enabledCount} enabled; branch record: ${branchCount} entries in ${branchRepos.length} repos`);
  }
  return 0;
}

const IMPLEMENTED = {
  'check-config': checkConfig,
  sync: syncCommand,
  ready: readyCommand,
  why: whyCommand,
  branches: branchesCommand,
  'branch set': branchSetCommand,
  claim: claimCommand,
  class: classCommand,
  'iteration list': iterationListCommand,
  'iteration plan': iterationPlanCommand,
  'iteration promote': iterationPromoteCommand,
  release: releaseCommand,
  heartbeat: heartbeatCommand,
  expire: expireCommand,
  dispatch: dispatchCommand,
  status: statusCommand,
  watch: watchCommand,
  clone: cloneCommand,
  trust: trustCommand,
  'install-hooks': installHooksCommand,
  'worktree create': worktreeCreateCommand,
  'worktree remove': worktreeRemoveCommand,
  'worktree finish': worktreeFinishCommand,
  wrap: wrapCommand,
};

const COMMANDS = [
  ['check-config', 'validate config/repos.json'],
  ['sync', 'refresh the issue cache from GitHub'],
  ['ready', 'list ready issues'],
  ['why', 'explain why an issue is or is not ready'],
  ['claim', 'claim an issue'],
  ['class', 'set the class of an issue: now, next or later'],
  ['iteration list', 'list the iterations of each project, with Now and Next'],
  ['iteration plan', 'add an iteration with a goal after the last one'],
  ['iteration promote', 'start the next iteration: Next becomes Now'],
  ['release', 'release a claim'],
  ['heartbeat', 'refresh a claim'],
  ['expire', 'expire stale claims'],
  ['dispatch', 'claim an issue and start its worktree session'],
  ['status', 'show the workers: claims, sessions and hook records'],
  ['watch', 'print one line each time a worker starts to need you'],
  ['branches', 'show the branch map'],
  ['branch set', 'set a branch for a repository'],
  ['clone', 'clone a base repository'],
  ['trust', 'write Claude trust entries'],
  ['install-hooks', 'register the session hooks and status line in ~/.claude/settings.json'],
  ['worktree create', 'create a worktree for an issue'],
  ['worktree remove', 'remove a worktree'],
  ['worktree finish', 'finish a worktree'],
  ['wrap', 'prove the merge, remove the worktree and branch, and release the claim'],
].map(([name, summary]) => ({
  name,
  summary,
  run: IMPLEMENTED[name] ?? notImplemented(name),
}));

// Help text for each command. One table, so wiki/coordinator.md can be written from it.
// `usage` is the command line, `args` lists its arguments and flags, `description` is one paragraph.
// `exit2` (optional) is the text of the exit-code 2 line; the default is the EXIT_CODES text.
const HELP = {
  'check-config': {
    usage: 'gvt-fleet check-config',
    args: [],
    description:
      'Reads config/repos.json and the branch record beside it (branches.json). Reports every invalid entry, then prints the number of repos, how many are enabled, and the size of the branch record. With --json it prints the effective settings of each repo, and a coach block {contract, workspaceRepo}: contract is the version number of that block (2), and workspaceRepo is the owner/name of the workspace origin remote, or null when it cannot be read. It exits 2 when any entry is invalid.',
  },
  sync: {
    usage: 'gvt-fleet sync [--full]',
    args: [['--full', 'Fetch every issue again instead of only those changed since the last sync.']],
    description:
      'Refreshes the issue cache (state/cache.db) from GitHub for every enabled repo. The first run for a repo is a full sync. Later runs fetch only changed issues, unless the last full sync is older than fullSyncHours. It also looks up issues that are named but not in a managed repo, and reads the remote branch heads. For each project that an enabled repo names (the project key), it reads the Iteration field and the Iteration value of every item, which ready and why use for the class; a project write does not change an issue, so these are read in full on every sync. Cached issues of a repo that is no longer enabled in the config (removed, disabled or renamed) are kept but no longer counted as managed, so ready does not list them. It prints counts of issues, unresolved refs, cycles and unknown branches, and on stderr one line per project. Progress and warnings go to stderr. It exits 75 when it stopped at the rate limit (run it again after the reset time), 2 when an overlay entry is invalid, and 1 when a repo or a project failed.',
  },
  ready: {
    usage: 'gvt-fleet ready [--all | --class <class>]',
    args: [
      ['--all', 'Also list the issues that are not ready, each with its reasons, class and conflict.'],
      ['--class <class>', 'List the open managed issues of one class (now, next or later), ready or not, each with its reasons. It cannot be combined with --all.'],
    ],
    description:
      'Lists the ready issues of the managed repos from the cache. An issue is ready when no reason code applies to it. It reads the cache only and never calls GitHub, so run sync first. With --json it prints {ready: [{key, title}], untriaged: [{repo, count, keys, onlyReason}]}, and with --all also {issues: [...]} with every reason. untriaged summarises the open managed issues that lack the triaged label, per repo, from every such issue whether or not --all is given; onlyReason counts those with no other reason. Without --json, one line "untriaged <repo>: <count> issues, <onlyReason> with no other reason" per repo follows the list. The output always carries now and next, even when they are empty. now lists every open managed issue of class Now with {key, title, ready, reasons, conflict}, ready or not. The class comes from the cached project of the repo: an issue whose item is in the Now iteration of the Iteration field is Now, one in the Next iteration is Next, and any other issue is Later, also when its repo has no project. Now is the iteration that iteration promote recorded in state/now-pointers.json, whatever its dates, or with no record the one that holds today; Next is the first iteration after Now. A now-pointers.json that cannot be read exits 1. conflict is always false (it meant both class labels, which are no longer read). next lists {repo, count} for each managed repo with open Next issues. Without --json, a line "now <key> ready|not ready <title>" per Now issue (with its reasons below it) and a line "next <repo>: <count>" per repo follow the untriaged lines. With --all, each entry of issues also carries class and conflict. --class <class> lists the open managed issues of that class (now, next or later) in issues, each with {key, title, state, ready, reasons, class, conflict}; the other keys stay, and without --json only that list is printed. The class is not a ready reason: the ready list and why are the same in every class. A class other than now, next or later, a missing class, --class together with --all, or any other argument exits 64.',
  },
  why: {
    usage: 'gvt-fleet why <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N. The repo must be in the config.']],
    description:
      'Explains the ready verdict of one issue from the cache. It prints ready or not ready, a line "  class: now|next|later" (followed by "(iteration <title>)" when the item has an iteration), every reason with its detail, and every edge that points at the issue with its source and line. With --json it prints {key, title, state, managed, ready, reasons, edges, class, conflict, iteration}; iteration is {id, title} or null, and conflict is always false. It exits 0 whether the issue is ready or not. The class follows the recorded Now pointer, as in ready. It exits 1 when the issue is not in the cache (run sync, then try again), or when state/now-pointers.json cannot be read. A ref it cannot read exits 64. A task id (owner/name@slug.YYYYMMDD.n) is refused with exit 64: it is a task, not an issue reference.',
  },
  claim: {
    exit2: 'invalid configuration, or a missing claim account',
    usage: 'gvt-fleet claim <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N.']],
    description:
      'Takes a local lease on an issue. It reads the issue from GitHub again and refuses when any ready reason applies (see why), otherwise it adds the in-progress label and the claim account as assignee, and reads them back. It prints held and the lease expiry. A claim that is already held prints noop. A refusal prints each reason on stderr and exits 1. A task id (owner/name@slug.YYYYMMDD.n) is refused with exit 64: it is a task, not an issue reference.',
  },
  class: {
    exit2: 'invalid configuration, or a repo with no project in the config',
    usage: 'gvt-fleet class <ref> <class>',
    args: [
      ['<ref>', 'The issue, as owner/name#N or short#N.'],
      ['<class>', 'now, next or later (lowercase).'],
    ],
    description:
      'Sets the class of an open issue through the Iteration field of its repo\'s project (the project key of the config entry): now puts its item in the Now iteration, next in the Next iteration, and later clears its Iteration value. Now is the iteration that iteration promote recorded, or with no record the one that holds today; Next is the first iteration after Now. An item in a planned or completed iteration is Later already, and later leaves it there (noop). It reads the field and the issue\'s item from GitHub (from the project\'s items of the repo when the issue lists none, as for a project of another organization), adds the issue to the project when it is not in it (not for later), writes the value and reads it back by the item\'s id. When the readback agrees and sync has read the project, it writes the value and the iterations to the cache, so ready shows the change without a sync. An issue that already has the class prints noop and makes no GitHub write. It does not open the claims database, and the class is not a ready reason. It refuses and exits 1 for a closed issue, for a project with no Iteration field, and for now or next when the project has no current or no next iteration (see iteration plan). A GitHub error or a readback that disagrees also exits 1 and leaves the cache unchanged, and so does a state/now-pointers.json that cannot be read, with no write. The class labels class:now and class:next are no longer written or read. With --json it prints {key, status, class, previous, project, iteration, addedToProject, cached}, plus reason for refused and failed. status is changed, noop, refused or failed; previous is the class before the change; iteration is {id, title} of the iteration it was put in, or null for later; addedToProject says whether the issue was added to the project; cached is false when the cache was not written. An unknown class, a ref it cannot read, a task id (owner/name@slug.YYYYMMDD.n; it is a task, not an issue reference) or the wrong number of arguments exits 64.',
  },
  'iteration list': {
    usage: 'gvt-fleet iteration list [<owner/number>]',
    args: [['<owner/number>', 'One project of the config, such as example-org/6. Without it, every project of an enabled repo.']],
    description:
      'Reads the Iteration field of each project live from GitHub and lists its iterations by start date: role (now, next, planned or completed), start and end date, id and title. The title holds the goal. Now is the iteration that iteration promote recorded in state/now-pointers.json, whatever its dates; Next is the first one after it, an iteration before Now is completed and one after Next is planned. With no record, or a recorded id that is no longer in the field (it warns on stderr), the dates decide: Now holds today (the UTC day), Next is the first one that starts after today. It writes nothing. With --json it prints {today, projects: [{project, field, pointer, iterations: [{id, title, startDate, duration, endDate, role}]}]}; field is false when the project has no Iteration field, pointer is recorded or dates, and a project that could not be read carries error. It exits 1 when a project or now-pointers.json could not be read, and 64 for a project that no enabled repo names.',
  },
  'iteration plan': {
    usage: 'gvt-fleet iteration plan <owner/number> <title>',
    args: [
      ['<owner/number>', 'A project of the config.'],
      ['<title>', 'The goal of the iteration. GitHub gives an iteration no description, so the goal is the title.'],
    ],
    description:
      'Adds an iteration of 365 days that starts where the last iteration ends. When no iteration ends after today it starts today, and with no recorded Now it becomes Now. It does not change the recorded Now. It writes the whole Iteration field in one update that passes the id of every existing iteration, completed ones included, and checks that before the write: an update without an id deletes that iteration and clears its items. It also checks that every iteration lasts at least one day and none overlaps another, which GitHub would refuse or drop. It reads the field back and compares it with the layout it wrote. It writes no item. The new layout goes to the cache, so ready sees it without a sync. With --json it prints {project, status, added, iterations, reason?}; status is changed, refused or failed. It exits 1 for a project with no Iteration field, an empty title, a GitHub error or a readback that disagrees, and 64 for a project that no enabled repo names.',
  },
  'iteration promote': {
    usage: 'gvt-fleet iteration promote <owner/number> [<iteration>]',
    args: [
      ['<owner/number>', 'A project of the config.'],
      ['<iteration>', 'The id or exact title of the planned iteration to become the new Next. Without it, the planned iteration that starts first.'],
    ],
    description:
      'Starts the next iteration: Next becomes Now at once, and no date limits how often it runs. In one update of the Iteration field it ends Now today (it moves to the completed iterations and keeps its items; a Now that started today or later keeps one day, as GitHub refuses an iteration of zero days), starts Next for 365 days where the last kept iteration ends but not before today, and lays out the planned iterations back to back after it, the chosen one first. The update passes the id of every iteration, completed ones included, and this is checked before the write. It writes no item: an issue keeps its iteration, and the pointers move. It reads the field back and compares it with the layout it wrote, then writes the new layout to the cache. Once GitHub has taken the update it records the new Now in state/now-pointers.json, which ready, why, class and iteration list read, so a second promote on one day makes a Now that starts tomorrow and is Now at once. A readback that fails after the update was taken still records it, and the reason says to run iteration list before another promote. It refuses and exits 1 when there is no Next, or when the chosen iteration is not a planned one after Next. A now-pointers.json that cannot be read exits 1 with no write. With --json it prints {project, status, from: {now, next}, to: {now, next}, iterations, reason?}. It exits 1 for a GitHub error or a readback that disagrees, and 64 for a project that no enabled repo names.',
  },
  release: {
    usage: 'gvt-fleet release <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N, or a task, as <owner/name or short>@<slug>.<YYYYMMDD>.<n>.']],
    description:
      'Ends the lease on an issue or a task. For an issue it removes the label and the assignee only if the claim added them, and keeps any that were already there. Releasing a task makes no GitHub write: its lease is set to released. It exits 1 when there is no claim to release or when the GitHub update failed.',
  },
  wrap: {
    exit2: 'invalid configuration',
    usage: 'gvt-fleet wrap <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N, or a task, as <owner/name or short>@<slug>.<YYYYMMDD>.<n>.']],
    description:
      'Wraps up one finished worker. It proves the merge with the gate of worktree remove --require-merged, removes the worktree and the Claude session (or finishes a half-removed one; a transient EBUSY or EPERM with no likely holder gets up to 3 attempts in all, as in worktree remove and worktree finish), deletes the branch worktree-<name>, and then releases the claim. The claim is released only after the proof passed and the worktree and branch are gone. For an issue, it deletes the branch with -D only when a merged pull request has the branch tip as its head (or the nothing-to-lose proof below passed), the tip did not move since the check, and a remote-tracking branch contains the tip (refs are not fetched first). Otherwise it uses git branch -d. When that refuses, the result is branch-kept and the claim stays. A rerun continues from the state it finds. A rerun after full success prints wrapped (nothing to do) and exits 0, also after a later claim of the issue failed: the release of that failed claim takes the wrapped marker with it. When the issue branch is gone, a merged closing pull request proves the work only when it merged into the default branch at or after the time of the claim, so an old pull request of a reopened issue does not prove a new claim. Unlike worktree remove --require-merged, when the issue branch has commits of its own, a merged pull request at its tip proves the work only when it is a closing pull request of the issue (listed in the cache, or found by the one live read when the cache lists none). So a pull request that merged with Part of #N and no closing keyword does not wrap the issue: the proof is refused, and the worktree, the session and the claim are kept. A closed issue can still pass on the nothing-to-lose proof. For an issue, every path that removes the worktree, finishes a half-removed one or finds nothing left updates config/branches.json as worktree remove does, once the proof passed: it drops the worktree-<name> entry the coordinator wrote for the issue and records the branch the work was pushed under. It takes one ref and no flags; it never discards work. For an issue, when the cache holds no closing pull request and nothing else proved the work, the closing pull requests are read live from GitHub (one GraphQL call, the first 10); a failed read leaves the work unproven and names the issue; after a read that found none, the problem no longer suggests running sync. For an issue, when that proof refuses, a nothing-to-lose proof is tried (ADR 0016): it passes when the issue is closed, every pull request of the same repository that refers to the issue (a cross-referenced event in its timeline) is merged, and every branch the worktree holds (the issue branch, the checked-out branch or a detached HEAD, the other branches it checked out) has no commits of its own or its tip at the head of a merged pull request, with no uncommitted or untracked files and no stash. It reads the issue and, when it is closed, its timeline; it is not tried while files or a stash are left. When it fails, its reasons are added to problems, each starting with "no nothing-to-lose proof:". worktree remove --require-merged does not use it. To drop work, use worktree remove --discard. It deletes no remote branch and writes nothing to GitHub except the release. For a task (a worker with no issue) no merge proof is required: steps.proof is not-required, whatever the outcome. A task that wrote nothing is removed. It wrote nothing when it has no uncommitted changes and no stash, its branch worktree-<name> is absent or has no commits of its own (its tip is on the default branch of origin, read locally with no fetch), and every other branch it checked out is on a remote branch. A task that committed must have pushed its branch, with no pull request needed; otherwise the result is refused, steps.worktree is refused, problems names the branch, the lease is kept, and the hint names worktree remove <task> --discard (only on the coach\'s words) and then release <task>. The lease of a task is released with no GitHub call, and nothing is written to config/branches.json. For a task, the branch is deleted with -D when it was the branch checked out in the worktree, its tip is still the one checked and a remote-tracking branch contains it; otherwise git branch -d is used. When the branch checked out in the worktree is not the issue (or task) branch, the result reports it as checkedOutBranch {branch, tip, kept}; kept says whether the branch is still in the base clone after the removal (null when the removal did not run; also set on a half-removed result); checkedOutBranch is null otherwise. gvt-fleet does not delete it itself; claude rm may, and kept reports what happened (#82). Each result other than wrapped names the next command in its hint. It exits 0 for wrapped; 1 for refused, half-removed, held, branch-kept or failed; 2 for an invalid configuration; 64 for a usage error.',
  },
  heartbeat: {
    usage: 'gvt-fleet heartbeat <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N, or a task, as <owner/name or short>@<slug>.<YYYYMMDD>.<n>.']],
    description:
      'Extends a held lease (of an issue or a task) by leaseMinutes from now. It does not revive a lease that has already expired: run expire, then claim again. It exits 1 when there is no held claim or the lease has expired.',
  },
  expire: {
    usage: 'gvt-fleet expire',
    args: [],
    description:
      'Handles leases past their expiry. A lease whose worker is live (its session is listed by claude agents, matched by session id or by worktree name in the base clone, and is not done, failed or stopped) is extended. Any other expired lease is released. A release that failed earlier is retried, and a claim that stopped mid-way (still claiming after leaseMinutes) is released. It leaves labels and assignees that were set by hand alone. A task lease follows the same rule (live: extended; otherwise released), and a dead expired task lease is released with no GitHub call. A lease whose key cannot be read is reported as failed, and the other leases are still handled. It exits 1 when any lease could not be handled.',
  },
  dispatch: {
    exit2: 'invalid configuration, or (issue form only) a missing claim account',
    usage: 'gvt-fleet dispatch [--allow-self] <ref> [prompt]\n       gvt-fleet dispatch --task [--allow-self] <repo> <slug> [prompt]',
    args: [
      ['<ref>', 'The issue, as owner/name#N or short#N.'],
      ['--task', 'Start a task worker, one that has no GitHub issue. The arguments are then <repo> <slug> [prompt].'],
      ['<repo>', 'With --task: the repo, as owner/name or its short name; it must be in the config.'],
      ['<slug>', 'With --task: the task name, lowercase letters, digits and single hyphens. It is at most 24 characters, and shorter for a repo with a long short name so that the worktree name stays within 64 characters; the error names the maximum.'],
      ['[prompt]', 'The first prompt for the Claude session. It is passed unchanged and must not start with -. The default is "Work on GitHub issue <owner/name#N>. When you open a pull request for this issue, put a closing keyword for it in the body (Fixes <owner/name#N>), so that gvt-fleet wrap can prove the merge." An empty prompt counts as no prompt. A prompt of only spaces is passed as given.'],
      ['--allow-self', 'Dispatch an issue of the workspace repository. Without it, such an issue is refused.'],
    ],
    description:
      'Claims an issue and starts its worktree session in one step: claim, then create (fetch and fast-forward the base clone, trust it, and start a background session named for the issue). It writes nothing to the branch record. Before the claim it makes no GitHub call and writes nothing. It stops with exit 1 when the issue is in the workspace repository (read from the origin remote of the workspace; an unreadable remote also stops it), when the default branch is unknown (run sync), or when the base clone is dirty or on another branch. A refused claim prints each reason, as claim does, and exits 1. A claim that another assignee took at the same moment is rolled back, and the command exits 1. When a step after the claim fails (clone, trust, claude agents, an existing folder without a session, or claude --bg that left nothing), dispatch releases the claim it took and exits 1; the base clone, its exclude line and its trust entry stay. If that release fails, it says so on a separate line, names the releasing lease and gvt-fleet release <ref>, and exits 1. A claim that was held before the command is never released, even when its lease had expired. When claude --bg printed an id but no session is listed (or claude agents failed while it looked), or left a folder or a session behind, the claim is kept and the command exits 1; run it again to adopt the session, or run release. A second run on a held issue whose session is listed starts nothing and prints noop. A session that already exists after a fresh claim is adopted and the claim is kept: exit 0 when it is live, exit 1 when it is done, failed or stopped. It prints the worktree path, the session short id and the lease expiry. With --json it prints the result, including status, step, claim and rollback. A usage error (no ref, more than two arguments, or an argument that starts with - other than --allow-self) exits 64; for an issue, a missing claim account (checked once the pre-checks pass) or an invalid config exits 2. With --task it starts a task worker: a lease with no issue, so it makes no GitHub call at all (no label, no assignee). The id is owner/name@<slug>.<YYYYMMDD>.<n>, where the date is the UTC date and n is one more than the highest n of any lease row of that slug and date (released history included); an n whose worktree folder or branch already exists is skipped. The worktree is named <short>.<slug>.<YYYYMMDD>.<n> and the lease is held at once. The same pre-checks apply as for an issue (workspace repository, default branch, base clone). A task whose repo and slug already have an active lease is refused with step task-active, and nothing is written; a second run makes a new id only when no lease of that slug is active. When the start fails and leaves nothing, the lease is released with no GitHub call; when claude --bg left a folder or a session, or the session cannot be confirmed, the lease is kept, and gvt-fleet worktree create <task id> adopts the session. The tracker rule is appended to every task prompt, the default one included: there is no issue, so the session must not write to the issue tracker unless the coach approves that one write. The default prompt is "Task <slug> in <owner/name> (<task id>)." A usage error (a missing or bad slug, a slug longer than the maximum for the repo, a repo that is not in the config, or a prompt that starts with -) exits 64 before any write. The task form never reads the claim account, so its exit 2 is an invalid config only; every refusal (self-repo, default-branch, base-clone, task-active, task-id, or a failed start) exits 1, and a created session exits 0.',
  },
  status: {
    usage: 'gvt-fleet status [--restart]',
    args: [
      [
        '--restart',
        'Print the restart steps instead of the status view, as a Markdown sheet to save before a reboot or to run after one: one line per worker and task worker (key, session short id, state, last message), then a claude respawn <short id> line per session, then a fallback cd "<worktree>" && claude --bg --resume <session id> line per session. The session is the listed one, else the one the lease names (state/claims.db keeps its id, short id and worktree path, so the steps can be built after a reboot when claude agents lists nothing); a short id the lease lacks is the first 8 characters of the session id. A worktree folder that does not exist gets a "# <key>: worktree missing: <path>" line instead of its cd line, and a worker with no session id is named on a last "No session id:" line. With --json it prints {generatedAt, agents, entries: [{key, state, detail, shortId, sessionId, path, pathExists}]}. The joins, the lease refresh, the log event (with restart: true) and the exit codes are those of status.',
      ],
    ],
    description:
      'Shows one line per worker: its issue, state, the reason it needs you, the lease expiry, the session short id and the worktree path. It reads the leases (state/claims.db), claude agents --json --all and the hook worker files (state/workers) once each and joins them by repo and worktree name. Workers are sorted needs-you first, then rate-limited, working, no-session, done and unknown. A line can end with markers in brackets that name a mismatch between the sources (for example no-session, no-claim or revived). A held lease whose session is live is extended by leaseMinutes from now; one that had expired is revived and the line shows when it had expired. It never releases a lease and makes no GitHub call, so run expire to release the claims of workers that are no longer live. A task worker (one that has no issue) is listed in the same sorted list, with its task id where an issue worker has its key. The last line is workers: N, which counts both. With --json it prints {agents, workers, tasks, ignored, rateLimits}, where ignored is {records, leases}. tasks lists the task workers with the same keys as a worker, key being the task id (owner/name@slug.YYYYMMDD.n) and issue null; it is an empty list when there are none. A lease whose key is neither an issue key nor a task key cannot be read: it is not shown, is counted in ignored.leases, and is named on stderr (<key>: cannot read lease key; ignored). A hook file with no lease and no session gets an issue only when its worktree is named <repo name>-<N>. Each worker has a markers list and an issue: {title, state, closingPrs: [{number, state, headRefName}]} read from the issue cache (state/cache.db, filled by sync; the status line is unchanged), or null when the issue is not cached or the worker has no issue number. In --json, detail is the worker\'s last message, or the questions of an AskUserQuestion wait (below): for an idle prompt it is the last message of the Stop that ended the turn, and since is the time of that Stop; without such a Stop with a non-empty last message in the last 64 KB of the file, detail and since are those of the notification. A wait on an AskUserQuestion call (needs the PreToolUse hook that install-hooks adds) has the reason notification:permission_prompt, and detail lists each question with its option labels, one line per question (question [label | label]); since is the time of the permission prompt. Every row carries questions: for such a wait an array of {question, header, options, multiSelect} (options are the labels), else null. It exits 1 when the agents list cannot be read: the claims and hook view is still printed, no lease changes, and stderr says claude agents unavailable. The claude agents call has a time limit of 30 seconds; a call that passes it counts as an unreadable agents list. An invalid config exits 2, and any argument other than --restart exits 64.',
  },
  watch: {
    usage: 'gvt-fleet watch [--minutes N] [--interval S] [--since <iso>]',
    args: [
      ['--minutes N', 'How long to watch, as a whole number of minutes, 0 to 1440. The default is 25. With 0 it polls once.'],
      ['--interval S', 'Seconds between polls, 5 to 3600. The default is 15.'],
      ['--since <iso>', 'Report hook waits that began at or after this time. The default is the time the command started.'],
    ],
    description:
      'Polls the workers for the given time and prints one line each time a worker starts to need you, then a final watch-end line that names a cursor: the start of the last poll minus 5 seconds. Pass the cursor as --since to the next run so no wait falls between two runs. Each poll reads the leases (state/claims.db), runs claude agents --json --all once (about 1 second on the measured machine) and reads the hook worker files, the same inputs as status. It changes no lease, makes no GitHub call and never reads the issue cache (like every command, it opens the state databases, which can create them). A line is printed once per wait: a hook wait is identified by the worker and the time it began, and a Stop and its later idle prompt print one line (also when the Stop had an empty last message, as long as both fall in the same run), while a Stop after a new turn prints another. A line for agents:blocked is printed only for a session that the join reports as agents:blocked (the agents list shows it blocked and it has no hook record, or only a done one), and only when it turns so during the watch: the baseline is the first poll with a readable agents list, and a session already blocked then prints nothing. Its since is the time of the poll that saw it. A task worker that needs you is reported with its task id (owner/name@slug.YYYYMMDD.n) as key. Any other worker without an issue number is named owner/name:<worktree>. Text lines read <key> needs-you <reason> since <time>: <last message or questions>; with --json each line is one object. A wait on an AskUserQuestion call has the reason notification:permission_prompt and the questions with their option labels as detail (on one line, each question as question [label | label], cut to its last 160 characters like any detail); its JSON line carries questions, an array of {question, header, options, multiSelect}, and every other line carries questions: null. An idle prompt that follows such a wait is the same wait and prints no second line. When the agents list cannot be read, the poll runs on the hook records and stderr says claude agents unavailable (once, and again after a recovery). The claude agents call has a time limit of 30 seconds; a call that passes it counts as an unreadable agents list. That does not change the exit code. It exits 0 at the end of the period, 2 for an invalid config, 1 when claims.db has an unsupported version, and 64 for an unknown argument or a bad value.',
  },
  branches: {
    usage: 'gvt-fleet branches [--unknown]',
    args: [['--unknown', 'List the remote branches that the branch record does not name, with any PR hint.']],
    description:
      'Shows the branch record (config/branches.json): each branch, its disposition (issue, keep or remove) and its status. With --unknown it lists the remote branches from the cache that the record does not name. It reads the cache only and never calls GitHub. Answer each unknown branch with branch set.',
  },
  'branch set': {
    usage: 'gvt-fleet branch set <owner/repo> <branch> (--issue <ref> | --keep | --remove) [--allow-missing] [--by <name>]',
    args: [
      ['<owner/repo>', 'The repo, as it is written in the config.'],
      ['<branch>', 'The branch name.'],
      ['--issue <ref>', 'The branch belongs to this issue (owner/name#N, short#N or #N in the same repo).'],
      ['--keep', 'Keep the branch; it belongs to no issue.'],
      ['--remove', 'The branch is to be deleted.'],
      ['--allow-missing', 'Accept a branch that is not in the cached remote heads.'],
      ['--by <name>', 'Who decided. The default is coach.'],
    ],
    description:
      'Records the decision for one branch in config/branches.json. Exactly one of --issue, --keep and --remove is required. A branch that is not in the cached remote heads exits 1 unless --allow-missing is given. It prints a reminder on stderr to commit the file.',
  },
  clone: {
    usage: 'gvt-fleet clone [<owner/repo>]',
    args: [['<owner/repo>', 'One enabled repo. The default is every enabled repo.']],
    description:
      'Makes the base clone of each enabled repo under repos/<owner>/<name> from its HTTPS URL, and excludes /.claude/worktrees/ from it. A clean clone on the default branch is fetched and fast-forwarded; a dirty clone, one on another branch, or a non-repo is skipped. The default branch comes from the config entry, else from the last sync. It exits 1 when a clone was skipped or failed.',
  },
  trust: {
    exit2: 'a refused trust path',
    usage: 'gvt-fleet trust <path>',
    args: [['<path>', 'A folder below the workspace root.']],
    description:
      'Writes a Claude trust entry for the folder in ~/.claude.json. The key uses forward slashes and an uppercase drive letter. A folder that is already trusted is not written again. The workspace root itself and any folder outside it are refused with exit 2. When ~/.claude.json is a symbolic link, the change is written through the link to its target.',
  },
  'install-hooks': {
    exit2: 'a refused settings file',
    usage: 'gvt-fleet install-hooks [--dry-run]',
    args: [['--dry-run', 'Print the changes and the result. Write nothing to the settings file and take no backup; the result line is still appended to the log in the state folder.']],
    description:
      'Registers the session hooks and the status line in ~/.claude/settings.json. Plugin mode applies when the installed gvt-fleet@gvt-plugins (the user install, else the first listed in ~/.claude/plugins/installed_plugins.json) has cli/bin/gvt-fleet-hook.mjs and hooks/hooks.json: the plugin runs the hooks, so it removes every hook entry of its own, writes the launcher gvt-fleet-statusline-launcher.mjs into the plugin data folder (CLAUDE_PLUGIN_DATA, else ~/.claude/plugins/data/gvt-fleet-gvt-plugins), and points statusLine at it; the launcher runs the current plugin copy of the status-line helper on each render, or the chained command alone when it finds none. Otherwise (user-settings mode) it writes the entries below, naming the scripts in the bin/ folder of the CLI that runs it and the workspace after --workspace. In user-settings mode it adds six hook entries (SessionStart, Notification, Stop, StopFailure, SessionEnd, and PreToolUse with the matcher AskUserQuestion, which records the questions of an AskUserQuestion call) that run bin/gvt-fleet-hook.mjs, and a statusLine that runs bin/gvt-fleet-statusline.mjs and then the existing status-line command, which it passes after --chain. Existing hooks and other keys are kept; it refuses a file with a duplicate key or a number that would change when rewritten, and writes nothing. On a re-run its own entries are updated in place and nothing is added twice; an entry of its own under a PreToolUse matcher other than AskUserQuestion, or under none, is moved to a group with that matcher (or dropped when such a group already holds one), and the other entries of the group stay; an entry written under the old script names (' + LEGACY.hookScript + ', ' + LEGACY.statusScript + ') is replaced in place by the new one; a run with nothing to change prints noop. The first run that writes copies the original file to state/settings.json.bak; a later run never replaces that backup. A missing settings file is created, and state/settings.json.absent records that it did not exist. A file that already holds gvt-fleet entries and has no record in state/ gets no backup, and the run reports that. It refuses and writes nothing when the file cannot be read, is not valid JSON, starts with a UTF-8 byte order mark (save it without a BOM) or is not a JSON object, when hooks is not an object, when statusLine is not a command, when the existing status-line command contains a shell operator, when the status-line command starts a batch file and has an argument the helper cannot pass to it or a path with a quote or percent sign, or when one of the six hook events is not a list; a refusal exits 2. A failed read-back exits 1. When the settings file is a symbolic link, the change is written through the link to its target. With a non-default --state-dir, the installed hook and status-line commands pass it on, so they write to the same folder. Open sessions may keep the hooks and status line it read at start, so restart them after the install.',
  },
  'worktree create': {
    usage: 'gvt-fleet worktree create <ref> [prompt]',
    args: [
      ['<ref>', 'The issue, as owner/name#N or short#N, or a task id (owner/name@<slug>.<YYYYMMDD>.<n> or short@<slug>.<YYYYMMDD>.<n>). It needs a held claim or a held task lease.'],
      ['[prompt]', 'The first prompt for the Claude session. For an issue it is passed unchanged. For a task id the prompt is this one, or "Task <slug> in <owner/name> (<task id>)." when none is given, followed by the tracker rule, as dispatch --task builds it. A task prompt that starts with - exits 64.'],
    ],
    description:
      'Creates the worktree of a claimed issue or of a held task lease (use it to adopt a task session after dispatch --task kept the lease), clones and trusts the base repo if that has not been done, and starts a background Claude session named for the issue in the base clone. It writes nothing to the branch record (worktree remove records the pushed branch). It prints the worktree path and the session short id (use it with claude attach). An existing worktree prints noop with the same fields. It exits 1 when the claim is missing or expired, or a step failed.',
  },
  'worktree remove': {
    usage: 'gvt-fleet worktree remove <ref> [--discard | --require-merged]',
    args: [
      ['<ref>', 'The issue, as owner/name#N or short#N, or a task, as <owner/name or short>@<slug>.<YYYYMMDD>.<n>.'],
      ['--discard', 'Skip the safety check for this run, and let claude rm drop unpushed work (see below).'],
      ['--require-merged', 'Also require a merged pull request whose head is HEAD, found by the name of the branch on the remote, and that merged into the default branch. Cannot be combined with --discard (exit 64). Not for a task (exit 64).'],
    ],
    description:
      'Removes the worktree, its Claude session and its branch (claude rm deletes the branch when it succeeds). It first checks that nothing would be lost: the working tree is clean, and the work of the issue is safe on every branch that holds it. That is the checked-out branch or a detached HEAD (every commit of HEAD is on a remote-tracking branch, or the HEAD commit is the head of a merged pull request, found by the commit when HEAD is not the issue branch), the issue branch worktree-<name> (its commits are on a remote branch or its tip is the head of a merged pull request), and the other local branches the worktree checked out, found in the HEAD reflog of the worktree (their commits must be on a remote branch). No stash may have been made on any of those branches. A pushed other branch is listed in otherBranches and is not deleted. If a check fails it refuses and exits 1. --discard overrides those checks for this run only: uncommitted changes, stashes on the branch, a branch with commits on no remote branch. It also retries claude rm with --discard-unpushed, using the value that claude rm reported, and the branch is then deleted with git branch -D. --require-merged adds a check on top of those: the tip of the issue branch must be the head of a merged pull request, even when the branch is pushed. The pull request is looked up live by the remote name of the issue branch (which can differ from the local name) and, one GitHub call each, among the closing pull requests of the issue in the cache. It refuses while any closing pull request is open. When the issue branch has no commits of its own (its tip is on the default branch), a merged closing pull request is required instead; a merged pull request of another branch does not satisfy the other case. In both cases a pull request counts only when it merged into the default branch of the repository (its base); one merged into another branch is named as a problem, and when the default branch is unknown (no config entry and no sync yet) no pull request proves the work. Otherwise it refuses and exits 1, naming the pull request found and its state, or that there is none, or the lookup error. With --require-merged, when the cache holds no closing pull request for the issue and nothing else proved the work, the closing pull requests are read live from GitHub (one GraphQL call, the first 10); a failed read leaves the work unproven and names the issue; after a read that found none, the problem no longer suggests running sync.With --require-merged, a detached HEAD does not refuse by itself: the issue branch is still proven by its own merged pull request, and the detached HEAD needs the same rule as the checked-out branch. --require-merged runs no check when nothing is left to remove. The result carries pushedBranch (the name of the issue branch on the remote, taken from its upstream or from the head of the proving pull request; null only when the issue branch is absent or nothing was left to check), pr ({number, state, mergedAt, headSha} or null), proofs ([{branch, pr}]: the merged pull requests that proved the work) and otherBranches ([{branch, tip}]). When the branch checked out in the worktree is not the issue (or task) branch, the result reports it as checkedOutBranch {branch, tip, kept}; kept says whether the branch is still in the base clone after the removal (null when the removal did not run; also set on a half-removed result); checkedOutBranch is null otherwise. The log event carries requireMerged, the pull request number as pr, and branchRecord.recorded. Once the check has passed (so never for a --discard run that skipped a failed check) and before claude rm, it records the issue branch (its remote name, never a follow-up branch that is checked out; a detached HEAD records it too) in config/branches.json as an issue entry by coordinator, so that the open issue is not ready while that branch exists. It runs git ls-remote on the base clone first and records nothing when the branch is gone from the remote; when ls-remote fails it records the branch and warns. It never overwrites an entry that is not by coordinator. It also drops the worktree-<name> entry that the coordinator wrote for the same issue (older versions recorded it at create). The result carries branchRecord ({recorded, dropped, warning}: branch names or null; recorded is null when the entry already held the same values), and when the file changed it prints config/branches.json changed; commit it on stderr. A failed record write is a warning; the removal goes on. The consent is tied to the commit the worktree was at; it lapses on a refused run, on any run without --discard, and when the branch has moved since. When claude rm fails with EBUSY or EPERM and no likely holder is found, it waits and tries again, up to 3 attempts in all, waiting 2 seconds, then 5 seconds: claude rm again while git lists the worktree, else it deletes a leftover folder that holds at most a .git file, as worktree finish does. removalAttempts reports the number of attempts. When the folder is still held open after that, or a likely holder is found, it reports half-removed, names the likely holders, and exits 1. Close the holders and run worktree finish. When git branch -d refuses to delete the branch, it reports branch-kept and exits 1; run worktree finish to retry. When the result is removed (including when there was nothing left to remove) or branch-kept, it also deletes the worker hook file state/workers/<owner>/<name>/<worktree>.jsonl, so that status no longer lists the worker; it keeps the file when the result is refused, half-removed or failed. A hook file that cannot be deleted is reported in notes and does not change the result. For a task, the same checks apply with these changes: a task worktree whose branch worktree-<name> has no commits of its own (its tip is on the default branch of origin, read locally with no fetch) and that has no uncommitted changes is removed without --discard, and its branch is deleted with -D under the same guard as wrap; a task that committed must have every commit on a remote branch; no merge proof is asked for, and nothing is written to config/branches.json. --require-merged is refused for a task with exit 64.',
  },
  'worktree finish': {
    usage: 'gvt-fleet worktree finish <ref>',
    args: [['<ref>', 'The issue, as owner/name#N or short#N, or a task, as <owner/name or short>@<slug>.<YYYYMMDD>.<n>.']],
    description:
      'Completes a removal that stopped half-way. It checks what is left (folder, git worktree entry, branch, session) and does only the steps that are still needed. It refuses while the session is still running (run worktree remove first), and when the folder holds anything but an empty folder or a lone .git file, or is a link or junction. It deletes the branch with -d, or with -D only when the branch is still at the commit a --discard run was given at. When the folder delete fails with EBUSY or EPERM and no likely holder is found, it waits and tries again, up to 3 attempts in all, waiting 2 seconds, then 5 seconds; before each retry it reads the state again and refuses, deleting nothing, if git lists the worktree again (an empty folder that git marks prunable does not count), the session runs, or the folder holds more than a .git file. removalAttempts reports the number of attempts. A likely holder, ENOTEMPTY or EACCES gives held at once. It exits 1 when a step is refused, held or failed, or when the branch is kept (branch-kept: git branch -d deletes only a branch that is merged into its upstream, or into the HEAD of the base clone when it has no upstream, so a squash-merged branch, or one whose remote-tracking branch was pruned, is kept as well). When it ends removed, it also deletes the worker hook file state/workers/<owner>/<name>/<worktree>.jsonl; it keeps the file for every other result. A hook file that cannot be deleted is reported in notes and does not change the result.',
  },
};

const EXIT_CODES = [
  ['0', 'success'],
  ['1', 'the command ran and failed, or refused'],
  ['2', 'invalid configuration'],
  ['64', 'wrong arguments'],
  ['75', 'sync stopped at the rate limit; run it again later'],
];

// The commands that load the gvt-dev grammar (loadExtract in lib/commands.mjs), with the
// opening of their help line.
const NEEDS_GVT_DEV = {
  sync: 'Needs',
  ready: 'Needs',
  why: 'Needs',
  claim: 'Needs',
  dispatch: 'The issue form needs',
};

function commandHelp(command) {
  const h = HELP[command.name];
  const lines = [`Usage: ${h.usage}`, '', command.summary[0].toUpperCase() + command.summary.slice(1) + '.', '', h.description];
  if (h.args.length > 0) {
    lines.push('', 'Arguments and flags:');
    for (const [name, text] of h.args) lines.push(`  ${name.padEnd(18)}${text}`);
  }
  if (NEEDS_GVT_DEV[command.name]) {
    lines.push('', `${NEEDS_GVT_DEV[command.name]} the gvt-dev plugin, version ${GVT_DEV_MIN_VERSION} or later, for the issue-reference grammar (see gvt-fleet --help).`);
  }
  lines.push('', 'Global flags (before or after the command): --json, --workspace <dir>, --config <file>, --state-dir <dir>.');
  lines.push('With --json the result is JSON on stdout. Errors and warnings go to stderr.');
  lines.push('', 'Exit codes:');
  for (const [code, text] of EXIT_CODES) lines.push(`  ${code.padEnd(4)}${code === '2' ? (h.exit2 ?? text) : text}`);
  return lines.join('\n') + '\n';
}

function usage() {
  const lines = [
    'Usage: gvt-fleet [--json] [--workspace <dir>] [--config <file>] [--state-dir <dir>] <command> [args]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(18)}${c.summary}`),
    '',
    'Global flags:',
    '  --json              machine-readable output on stdout',
    '  --workspace <dir>   the workspace: the folder that holds config/, state/ and repos/ (default: the',
    '                      folder of this CLI when it holds config/repos.json, else the outermost folder',
    '                      at or above the current folder that does)',
    '  --config <file>     config file (default: config/repos.json in the workspace)',
    '  --state-dir <dir>   state directory (default: state/ in the workspace)',
    '  --help              show this text',
    '',
    'sync, ready, why, claim and dispatch <ref> need the gvt-dev plugin, version ' + GVT_DEV_MIN_VERSION + ' or later, for the',
    'issue-reference grammar: the gvt-dev@gvt-plugins install, or the plugin folder that GVT_DEV_ROOT names.',
  ];
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const flags = { json: false, help: false, config: null, stateDir: null, workspace: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--config' || a === '--state-dir' || a === '--workspace') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      if (a === '--config') flags.config = value;
      else if (a === '--workspace') flags.workspace = value;
      else flags.stateDir = value;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main(argv) {
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
  const err = (s) => process.stderr.write(s.endsWith('\n') ? s : s + '\n');

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`gvt-fleet: ${e.message}`);
    return EXIT_USAGE;
  }
  const { flags, rest } = parsed;
  if (rest[0] === 'help' && rest.length > 1) {
    rest.shift();
    flags.help = true;
  }
  if (rest.length === 1 && rest[0] === 'help') {
    out(usage());
    return 0;
  }
  if (rest.length === 0) {
    if (flags.help) out(usage());
    else err(usage());
    return flags.help ? 0 : EXIT_USAGE;
  }

  const two = rest.slice(0, 2).join(' ');
  let command = COMMANDS.find((c) => c.name === two);
  let args = rest.slice(2);
  if (!command) {
    command = COMMANDS.find((c) => c.name === rest[0]);
    args = rest.slice(1);
  }
  if (!command) {
    err(`gvt-fleet: unknown command: ${rest.slice(0, 2).join(' ')}`);
    err('Run gvt-fleet --help for the list of commands.');
    return EXIT_USAGE;
  }

  if (flags.help) {
    out(commandHelp(command));
    return 0;
  }

  const found = findWorkspace({ flag: flags.workspace, cliRoot });
  if (found === null) {
    err(`gvt-fleet: no workspace: neither ${cliRoot} nor ${process.cwd()} or a folder above it holds config/repos.json; pass --workspace <dir>`);
    return EXIT_USAGE;
  }
  const workspace = found.workspace;
  const stateDir = path.resolve(flags.stateDir ?? path.join(workspace, 'state'));
  const ctx = {
    // repoRoot is the workspace; the commands read it as ctx.paths?.workspace ?? ctx.repoRoot.
    repoRoot: workspace,
    cliRoot,
    json: flags.json,
    configFile: path.resolve(flags.config ?? path.join(workspace, 'config', 'repos.json')),
    stateDir,
    log: createLog(stateDir),
    out,
    err,
  };
  return command.run(ctx, args);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // A missing or too old gvt-dev is a setup problem, not a bug: its message says what to install.
  process.stderr.write(`gvt-fleet: ${e instanceof GvtDevError ? e.message : e?.stack ?? e}\n`);
  process.exitCode = EXIT_RUNTIME;
}
