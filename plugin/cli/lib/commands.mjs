// Command bodies for `sync` and `ready`. bin/gvt-fleet.mjs wires them to the CLI.

import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  loadConfig,
  resolveRepoArg,
  validateBranchRecord,
} from './config.mjs';
import { checkTaskSlug, parseLeaseKey } from './worker-key.mjs';
import { openCacheDb } from './cache-db.mjs';
import { ClaimsVersionError, openClaimsDb } from './claims-db.mjs';
import { BranchSetError, listRecorded, listUnknown, setBranch } from './branches.mjs';
import {
  ClaimError,
  claimIssue,
  expireClaims,
  heartbeatClaim,
  parseClaimRef,
  parseWorkerRef,
  releaseClaim,
} from './claims.mjs';
import {
  CLASSES,
  classOfRow,
  groupByClass,
  issuesOfClass,
  setClass,
} from './classes.mjs';
import {
  IterationRefusal,
  endDay,
  isoDay,
  planAppend,
  planPromote,
  pointers,
  roleOf,
} from './iterations.mjs';
import {
  NowPointerError,
  nowPointerOf,
  readNowPointers,
  writeNowPointer,
} from './now-pointer.mjs';
import { parseProject, readProjectField, writeIterations } from './projects.mjs';
import { buildGraph } from './graph.mjs';
import { computeReady, explain, untriagedSummary } from './ready.mjs';
import { applyOverlays, readClosingPrs, runSync } from './sync.mjs';

const EXIT_RUNTIME = 1;
const EXIT_CONFIG = 2;
const EXIT_USAGE = 64;
const EXIT_STOPPED = 75; // EX_TEMPFAIL: the sync stopped at a rate limit and can be retried

/** Load and validate config and the branch record. Returns {config, record} or {exitCode}. */
async function loadAll(ctx) {
  const errors = [];
  let config = null;
  try {
    config = await loadConfig({ file: ctx.configFile });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    errors.push(...e.errors);
  }
  const branchesFile = path.join(path.dirname(ctx.configFile), 'branches.json');
  let record = { version: 1, repos: {} };
  let text = null;
  try {
    text = await readFile(branchesFile, 'utf8');
  } catch (e) {
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
    for (const x of errors) ctx.err(`${x.entry}: ${x.message}`);
    return { exitCode: EXIT_CONFIG };
  }
  return { config, record };
}

async function loadExtract() {
  const { loadRefsGrammar } = await import('./plugin-path.mjs');
  return (await loadRefsGrammar()).extract;
}

export async function syncCommand(ctx, args) {
  if (rejectUnknownArgs(ctx, args, ['--full'], 'gvt-fleet sync [--full]')) return EXIT_USAGE;
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const { config, record } = loaded;
  const [{ run }, { createGh }, { realClock }] = await Promise.all([
    import('./proc.mjs'),
    import('./gh.mjs'),
    import('./clock.mjs'),
  ]);
  const extract = await loadExtract();
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  try {
    const gh = createGh({ run: ctx.run ?? run });
    const summary = await runSync({ gh, clock: ctx.clock ?? realClock, config }, { cache, full: args.includes('--full'), extract, branchRecord: record });
    for (const r of summary.repos) ctx.err(`${r.repo}: ${r.mode}${r.reason ? ` (${r.reason})` : ''}, ${r.pages} pages, ${r.issues} issues`);
    for (const e of summary.errors) ctx.err(`${e.repo}: sync failed: ${e.message}`);
    if (summary.unmanaged > 0) ctx.err(`${summary.unmanaged} cached issues of repos not in the config are no longer managed`);
    if (summary.notFound.length > 0) ctx.err(`${summary.notFound.length} external lookups not found: ${summary.notFound.join(', ')}`);
    for (const e of summary.overlayErrors) ctx.err(`${e.entry}: ${e.message}`);
    for (const p of summary.projects) {
      ctx.err(`project ${p.project}: ${p.pages} pages, ${p.items} items, ${p.field ? `${p.iterations} iterations` : 'no Iteration field'}`);
    }
    if (summary.stopped) {
      ctx.err(`sync stopped (${summary.stopped.reason})${summary.stopped.resetAt ? `; rate limit resets at ${summary.stopped.resetAt}` : ''}`);
    }
    ctx.log.append({ event: 'sync', pages: summary.pages, issues: summary.issues, cost: summary.cost, remaining: summary.remaining, stopped: summary.stopped?.reason ?? null });
    if (ctx.json) {
      ctx.out(JSON.stringify(summary, null, 2));
    } else {
      ctx.out(`synced ${summary.issues} issues in ${summary.pages} pages; ${summary.external} external lookups (${summary.notFound.length} not found); ${summary.cost} points used, ${summary.remaining ?? '?'} remaining`);
      ctx.out(`unresolved refs: ${summary.unresolved}; cycles: ${summary.cycles}`);
      ctx.out(`unknown branches: ${summary.unknownBranches} (gvt-fleet branches --unknown)`);
    }
    if (summary.overlayErrors.length > 0) return EXIT_CONFIG;
    if (summary.errors.length > 0) return EXIT_RUNTIME;
    return summary.stopped ? EXIT_STOPPED : 0;
  } finally {
    cache.close();
  }
}

/** The branch record file sits beside the config file. */
const recordFileOf = (ctx) => path.join(path.dirname(ctx.configFile), 'branches.json');

export async function branchesCommand(ctx, args) {
  if (rejectUnknownArgs(ctx, args, ['--unknown'], 'gvt-fleet branches [--unknown]')) return EXIT_USAGE;
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const { config, record } = loaded;
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  try {
    if (args.includes('--unknown')) {
      const unknown = listUnknown(cache, applyOverlays(config, cache), record);
      if (ctx.json) {
        ctx.out(JSON.stringify({ unknown }, null, 2));
      } else {
        for (const u of unknown) {
          ctx.out(`${u.repo} ${u.branch} ${u.headOid ?? '?'} ${u.lastCommitDate ?? '?'}`);
          for (const h of u.hints) ctx.out(`  hint: PR #${h.pr} (${h.state}) closes ${h.issue}`);
        }
        ctx.out(`unknown branches: ${unknown.length}`);
      }
      return 0;
    }
    const entries = listRecorded(record, cache);
    if (ctx.json) {
      ctx.out(JSON.stringify({ branches: entries }, null, 2));
    } else {
      for (const e of entries) {
        ctx.out(`${e.repo} ${e.branch} ${e.disposition}${e.issue ? ` ${e.issue}` : ''} [${e.status}] decided ${e.decided} by ${e.by}`);
      }
      ctx.out(`recorded branches: ${entries.length}`);
    }
    return 0;
  } finally {
    cache.close();
  }
}

export async function branchSetCommand(ctx, args) {
  const flags = { issue: undefined, keep: false, remove: false, allowMissing: false, by: undefined };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keep') flags.keep = true;
    else if (a === '--remove') flags.remove = true;
    else if (a === '--allow-missing') flags.allowMissing = true;
    else if (a === '--issue' || a === '--by') {
      const v = args[++i];
      if (v === undefined) {
        ctx.err(`gvt-fleet: ${a} needs a value`);
        return EXIT_USAGE;
      }
      if (a === '--issue') flags.issue = v;
      else flags.by = v;
    } else positional.push(a);
  }
  const chosen = [flags.issue !== undefined, flags.keep, flags.remove].filter(Boolean).length;
  if (positional.length !== 2 || chosen !== 1) {
    ctx.err('usage: gvt-fleet branch set <owner/repo> <branch> (--issue <ref> | --keep | --remove) [--allow-missing] [--by <name>]');
    return EXIT_USAGE;
  }
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const { realClock } = await import('./clock.mjs');
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  try {
    const recordFile = recordFileOf(ctx);
    const result = setBranch({
      recordFile,
      lockFile: path.join(ctx.stateDir, 'branches.lock'),
      repo: positional[0],
      branch: positional[1],
      disposition: flags.issue !== undefined ? 'issue' : flags.keep ? 'keep' : 'remove',
      issueArg: flags.issue,
      allowMissing: flags.allowMissing,
      config: loaded.config,
      cache,
      clock: ctx.clock ?? realClock,
      by: flags.by,
    });
    ctx.log.append({ event: 'branch-set', repo: result.repo, branch: result.branch, disposition: result.entry.disposition });
    if (ctx.json) ctx.out(JSON.stringify({ repo: result.repo, branch: result.branch, entry: result.entry, changed: recordFile }, null, 2));
    else ctx.out(`${result.repo} ${result.branch}: ${result.entry.disposition}${result.entry.issue ? ` ${result.entry.issue}` : ''}`);
    ctx.err('config/branches.json changed; commit it');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const x of e.errors) ctx.err(`${x.entry}: ${x.message}`);
      return EXIT_CONFIG;
    }
    if (e instanceof BranchSetError) {
      ctx.err(`gvt-fleet: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  } finally {
    cache.close();
  }
}

/** Reject any argument not in `allowed`. Prints the usage line and returns true when one is found. */
function rejectUnknownArgs(ctx, args, allowed, usageLine) {
  if (args.every((a) => allowed.includes(a))) return false;
  ctx.err(`usage: ${usageLine}`);
  return true;
}

/** The cached projects, each with the Now that `iteration promote` recorded for it (ADR 0022). */
function withNowPointers(projects, nowPointers) {
  for (const [project, p] of projects) p.nowId = nowPointerOf(nowPointers, project);
  return projects;
}

/**
 * The one readiness path, shared by `ready` and `why`: open the cache and claims, build the graph
 * and run computeReady. `fn` gets {rows, graph, entries}. Returns the exit code of `fn`.
 */
async function withReadiness(ctx, loaded, fn) {
  const { record } = loaded;
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  let claims;
  try {
    claims = await openClaimsDb(path.join(ctx.stateDir, 'claims.db'));
  } catch (e) {
    cache.close();
    if (!(e instanceof ClaimsVersionError)) throw e;
    ctx.err(`gvt-fleet: ${e.message}`);
    return EXIT_RUNTIME;
  }
  try {
    const config = applyOverlays(loaded.config, cache);
    const extract = await loadExtract();
    const rows = cache.readIssues();
    if (rows.length === 0) ctx.err('gvt-fleet: the cache is empty; run gvt-fleet sync');
    const graph = buildGraph(rows, { extract, config });
    const now = ctx.clock?.now() ?? new Date();
    const entries = computeReady({
      issues: rows,
      graph,
      claims: claims.listLeases({ states: ['held'] }),
      branchRecord: { repos: record.repos, remoteHeads: cache.remoteHeads() },
      config,
      now,
      extract,
    });
    let projects;
    try {
      projects = withNowPointers(cache.readProjects(), readNowPointers(ctx.stateDir));
    } catch (e) {
      if (!(e instanceof NowPointerError)) throw e;
      ctx.err(`gvt-fleet: ${e.message}`);
      return EXIT_RUNTIME;
    }
    return await fn({ rows, graph, entries, config, projects, today: isoDay(now) });
  } finally {
    cache.close();
    claims.close();
  }
}

export async function whyCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet why <ref>');
    return EXIT_USAGE;
  }
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  let ref;
  try {
    ref = parseClaimRef(args[0], loaded.config);
  } catch (e) {
    if (!(e instanceof ClaimError)) throw e;
    ctx.err(`gvt-fleet: ${e.message}`);
    return e.exitCode;
  }
  return withReadiness(ctx, loaded, ({ rows, graph, entries, config, projects, today }) => {
    const row = rows.find((r) => r.key.toLowerCase() === ref.key.toLowerCase());
    const entry = row && entries.find((e) => e.key === row.key);
    if (!entry) {
      ctx.err(`gvt-fleet: ${ref.key} is not in the cache; run gvt-fleet sync`);
      return EXIT_RUNTIME;
    }
    const cls = classOfRow(row, { config, projects, today });
    if (ctx.json) {
      const edges = graph.edges.filter((e) => String(e.to).toLowerCase() === entry.key.toLowerCase());
      ctx.out(JSON.stringify({ key: entry.key, title: row.title, state: row.state, managed: row.managed, ready: entry.ready, reasons: entry.reasons, edges, class: cls.class, conflict: cls.conflict, iteration: cls.iteration }, null, 2));
    } else {
      const lines = explain(entry, graph);
      lines[0] += ` ${row.title ?? ''}`.trimEnd();
      lines.splice(1, 0, `  class: ${cls.class}${cls.iteration ? ` (iteration ${cls.iteration.title})` : ''}`);
      for (const l of lines) ctx.out(l);
    }
    return 0;
  });
}

export async function readyCommand(ctx, args) {
  const READY_USAGE = 'gvt-fleet ready [--all | --class <class>]';
  let showAll = false;
  let cls = null;
  if (args.length > 0 && args.every((a) => a === '--all')) {
    showAll = true;
  } else if (args.length === 2 && args[0] === '--class' && CLASSES.includes(args[1])) {
    cls = args[1];
  } else if (args.length > 0) {
    ctx.err(`usage: ${READY_USAGE}`);
    return EXIT_USAGE;
  }
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  return withReadiness(ctx, loaded, ({ rows, entries, config, projects, today }) => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const classArgs = { rows, entries, config, projects, today };
    const listed = entries
      .filter((e) => byKey.get(e.key).managed)
      .map((e) => {
        const row = byKey.get(e.key);
        const base = { ...e, title: row.title, state: row.state };
        if (!showAll) return base;
        const c = classOfRow(row, { config, projects, today });
        return { ...base, class: c.class, conflict: c.conflict };
      })
      .filter((e) => showAll || e.ready);
    // Computed from every entry, not from `listed`, so the filters above never change it.
    const untriaged = untriagedSummary(entries, rows);
    const { now, next } = groupByClass(classArgs);
    if (ctx.json) {
      const brief = (e) => ({ key: e.key, title: e.title });
      const readyList = listed.filter((e) => e.ready).map(brief);
      let body;
      if (showAll) body = { ready: readyList, issues: listed, untriaged, now, next };
      else if (cls) body = { ready: readyList, untriaged, now, next, issues: issuesOfClass(classArgs, cls) };
      else body = { ready: readyList, untriaged, now, next };
      ctx.out(JSON.stringify(body, null, 2));
    } else if (cls) {
      for (const e of issuesOfClass(classArgs, cls)) {
        ctx.out(`${e.key} [${e.ready ? 'ready' : 'not ready'}] ${e.title ?? ''}`);
        for (const r of e.reasons) ctx.out(`  ${r.code}: ${r.detail}`);
      }
    } else {
      for (const e of listed) {
        ctx.out(showAll ? `${e.key} [${e.ready ? 'ready' : 'not ready'}] ${e.title ?? ''}` : `${e.key} ${e.title ?? ''}`);
        if (showAll) for (const r of e.reasons) ctx.out(`  ${r.code}: ${r.detail}`);
      }
      for (const u of untriaged) ctx.out(`untriaged ${u.repo}: ${u.count} issues, ${u.onlyReason} with no other reason`);
      for (const n of now) {
        ctx.out(`now ${n.key} ${n.ready ? 'ready' : 'not ready'} ${n.title ?? ''}`);
        for (const r of n.reasons) ctx.out(`  ${r.code}: ${r.detail}`);
      }
      for (const n of next) ctx.out(`next ${n.repo}: ${n.count}`);
    }
    return 0;
  });
}

// ---- clones and trust ----

export async function cloneCommand(ctx, args) {
  if (args.length > 1) {
    ctx.err('usage: gvt-fleet clone [<owner/repo>]');
    return EXIT_USAGE;
  }
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const entries = loaded.config.repos.filter((e) => e.enabled !== false);
  const wanted = args.length === 1 ? entries.filter((e) => e.repo.toLowerCase() === args[0].toLowerCase()) : entries;
  if (args.length === 1 && wanted.length === 0) {
    ctx.err(`gvt-fleet: ${args[0]} is not an enabled repo in the config`);
    return EXIT_USAGE;
  }
  const [{ run }, { createGit }, { ensureClone }] = await Promise.all([import('./proc.mjs'), import('./git.mjs'), import('./clones.mjs')]);
  const git = createGit({ run: ctx.run ?? run });
  const reposDir = path.join(ctx.paths?.workspace ?? ctx.repoRoot, 'repos');
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  const results = [];
  try {
    for (const entry of wanted) {
      // The default branch comes from the config entry, then from the branch stored by the last sync.
      const defaultBranch = entry.defaultBranch ?? cache.getRepoState(entry.repo)?.defaultBranch;
      if (!defaultBranch) {
        results.push({ repo: entry.repo, status: 'failed', reason: 'default branch unknown; run gvt-fleet sync first' });
        continue;
      }
      try {
        results.push({ repo: entry.repo, ...(await ensureClone({ git, reposDir, repo: entry.repo, defaultBranch, url: ctx.cloneUrlOf?.(entry.repo) })) });
      } catch (e) {
        results.push({ repo: entry.repo, status: 'failed', reason: e.message });
      }
    }
  } finally {
    cache.close();
  }
  for (const r of results) {
    ctx.log.append({ event: 'clone', repo: r.repo, status: r.status });
    if (r.status === 'skipped' || r.status === 'failed') ctx.err(`${r.repo}: ${r.status}: ${r.reason}`);
  }
  if (ctx.json) ctx.out(JSON.stringify(results, null, 2));
  else for (const r of results) ctx.out(`${r.repo}: ${r.status}`);
  return results.some((r) => r.status === 'skipped' || r.status === 'failed') ? EXIT_RUNTIME : 0;
}

export async function trustCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet trust <path>');
    return EXIT_USAGE;
  }
  const [{ ensureTrusted }, { realClock }, os] = await Promise.all([import('./trust.mjs'), import('./clock.mjs'), import('node:os')]);
  let r;
  try {
    r = await ensureTrusted(path.resolve(args[0]), {
      claudeJson: ctx.paths?.claudeJson ?? path.join(os.homedir(), '.claude.json'),
      workspace: ctx.paths?.workspace ?? ctx.repoRoot,
      stateDir: ctx.stateDir,
      sleep: (ctx.clock ?? realClock).sleep,
    });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    ctx.err(`gvt-fleet: ${e.message}`);
    return EXIT_RUNTIME;
  }
  ctx.log.append({ event: 'trust', key: r.key, status: r.status });
  if (r.status === 'refused' || r.status === 'failed') ctx.err(`${r.key}: ${r.status}: ${r.reason}`);
  printResult(ctx, r, `${r.key}: ${r.status}`);
  return r.status === 'refused' ? EXIT_CONFIG : r.status === 'failed' ? EXIT_RUNTIME : 0;
}

export async function installHooksCommand(ctx, args) {
  if (rejectUnknownArgs(ctx, args, ['--dry-run'], 'gvt-fleet install-hooks [--dry-run]')) return EXIT_USAGE;
  const [{ applySettings }, { realClock }, os] = await Promise.all([import('./user-settings.mjs'), import('./clock.mjs'), import('node:os')]);
  const settingsPath = ctx.paths?.claudeSettings ?? path.join(os.homedir(), '.claude', 'settings.json');
  const { detectPluginMode, LAUNCHER_SOURCE } = await import('./plugin-install.mjs');
  // Plugin mode only when the installed gvt-fleet plugin ships its copy of the CLI and hooks.json (ADR 0021).
  const plugin = detectPluginMode({ home: ctx.paths?.home ?? os.homedir(), env: ctx.env ?? process.env });
  const r = await applySettings(settingsPath, {
    scripts: ctx.cliRoot,
    launcher: plugin === null ? undefined : { path: plugin.launcher, source: LAUNCHER_SOURCE },
    workspace: ctx.paths?.workspace ?? ctx.repoRoot,
    stateDir: ctx.stateDir,
    dryRun: args.includes('--dry-run'),
    sleep: (ctx.clock ?? realClock).sleep,
  });
  ctx.log.append({ event: 'install-hooks', status: r.status });
  if (r.status === 'refused' || r.status === 'failed') ctx.err(`${settingsPath}: ${r.status}: ${r.reason}`);
  const result = { path: settingsPath, status: r.status, changes: r.changes };
  if (r.reason !== undefined) result.reason = r.reason;
  if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
  else for (const line of [...r.changes, `${settingsPath}: ${r.status}`]) ctx.out(line);
  return r.status === 'refused' ? EXIT_CONFIG : r.status === 'failed' ? EXIT_RUNTIME : 0;
}

// ---- claims ----

async function withClaims(ctx, fn) {
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  let claims;
  try {
    claims = await openClaimsDb(path.join(ctx.stateDir, 'claims.db'));
  } catch (e) {
    cache.close();
    if (!(e instanceof ClaimsVersionError)) throw e;
    ctx.err(`gvt-fleet: ${e.message}`);
    return EXIT_RUNTIME;
  }
  try {
    const [{ run }, { createGh }, { realClock }] = await Promise.all([import('./proc.mjs'), import('./gh.mjs'), import('./clock.mjs')]);
    const gh = ctx.gh ?? createGh({ run: ctx.run ?? run });
    return await fn({ ...loaded, cache, claims, gh, clock: ctx.clock ?? realClock, run: ctx.run ?? run });
  } catch (e) {
    if (e instanceof ClaimError) {
      ctx.err(`gvt-fleet: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  } finally {
    cache.close();
    claims.close();
  }
}

function printResult(ctx, result, line) {
  if (ctx.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(line);
}

export async function claimCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet claim <ref>');
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, record, cache, claims, gh, clock }) => {
    const ref = parseClaimRef(args[0], config);
    const extract = await loadExtract();
    const r = await claimIssue({ gh, clock, config }, { claims, cache, key: ref.key, extract, branchRecord: { repos: record.repos, remoteHeads: cache.remoteHeads() } });
    ctx.log.append({ event: 'claim', key: ref.key, status: r.status });
    printClaimProblems(ctx, ref.key, r);
    printResult(ctx, r, `${ref.key}: ${r.status}${r.expiresAt ? ` until ${r.expiresAt}` : ''}`);
    return r.status === 'held' || r.status === 'noop' ? 0 : EXIT_RUNTIME;
  });
}

/**
 * Print the stderr lines of a claim result: each refusal reason, a failure and a contention.
 * Prints nothing on stdout, so a command that claims as one of its steps prints its own result.
 */
function printClaimProblems(ctx, key, r) {
  if (r.status === 'refused') for (const x of r.reasons) ctx.err(`${key}: ${x.code}: ${x.detail}`);
  if (r.status === 'failed') ctx.err(`${key}: claim failed: ${r.reason}`);
  if (r.contention) ctx.err(`${key}: contention: another assignee appeared: ${r.contention.join(', ')}`);
}

export async function releaseCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet release <ref>');
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, cache, claims, gh, clock }) => {
    const ref = parseWorkerRef(args[0], config);
    const r = await releaseClaim({ gh, clock, config }, { claims, cache, key: ref.key });
    ctx.log.append({ event: 'release', key: ref.key, status: r.status });
    if (r.status === 'failed') ctx.err(`${ref.key}: release failed: ${r.reason}`);
    if (r.status === 'none') ctx.err(`${ref.key}: no claim to release`);
    printResult(ctx, r, `${ref.key}: ${r.status}`);
    return r.status === 'released' ? 0 : EXIT_RUNTIME;
  });
}

/** Like withClaims, but opens only cache.db: the class has nothing to do with leases. */
async function withCacheAndGh(ctx, fn) {
  const loaded = await loadAll(ctx);
  if (loaded.exitCode) return loaded.exitCode;
  const cache = await openCacheDb(path.join(ctx.stateDir, 'cache.db'));
  try {
    const [{ run }, { createGh }] = await Promise.all([import('./proc.mjs'), import('./gh.mjs')]);
    const gh = ctx.gh ?? createGh({ run: ctx.run ?? run });
    return await fn({ ...loaded, cache, gh });
  } catch (e) {
    if (e instanceof ClaimError) {
      ctx.err(`gvt-fleet: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof NowPointerError) {
      ctx.err(`gvt-fleet: ${e.message}`);
      return EXIT_RUNTIME;
    }
    throw e;
  } finally {
    cache.close();
  }
}

export async function classCommand(ctx, args) {
  if (args.length !== 2 || !CLASSES.includes(args[1])) {
    ctx.err('usage: gvt-fleet class <ref> <now|next|later>');
    return EXIT_USAGE;
  }
  return withCacheAndGh(ctx, async ({ config, cache, gh }) => {
    const ref = parseClaimRef(args[0], config);
    const nowPointers = readNowPointers(ctx.stateDir);
    const r = await setClass({ gh, config, now: ctx.clock?.now() ?? new Date(), nowPointers }, { cache, key: ref.key, target: args[1] });
    ctx.log.append({ event: 'class', key: ref.key, status: r.status, class: r.class, previous: r.previous, iteration: r.iteration?.id ?? null });
    if (r.status === 'refused' || r.status === 'failed') ctx.err(`${ref.key}: ${r.status}: ${r.reason}`);
    const where = r.iteration ? ` in iteration ${r.iteration.title}` : '';
    const line =
      r.status === 'changed' ? `${ref.key}: ${r.class}${where} (was ${r.previous})` : r.status === 'noop' ? `${ref.key}: noop (${r.class})` : `${ref.key}: ${r.status}`;
    printResult(ctx, r, line);
    return r.status === 'changed' || r.status === 'noop' ? 0 : EXIT_RUNTIME;
  });
}

// ---- iterations (ADR 0015) ----

/** The distinct projects of the enabled config entries, in config order. */
function configProjects(config) {
  const out = new Map();
  for (const e of config.repos) if (e.enabled !== false && e.project && !out.has(e.project.toLowerCase())) out.set(e.project.toLowerCase(), e.project);
  return [...out.values()];
}

/** The configured project named by `arg` (compared without case), or throws a usage ClaimError. */
function projectArg(config, arg) {
  const p = parseProject(arg);
  const found = p && configProjects(config).find((x) => x.toLowerCase() === p.name.toLowerCase());
  if (!found) throw new ClaimError(`${arg} is not a project of an enabled repo in the config (use owner/number)`);
  return found;
}

const brief = (it) => (it ? { id: it.id, title: it.title, startDate: it.startDate, duration: it.duration } : null);

function describeIterations(iterations, today, nowId = null) {
  const ptrs = pointers(iterations, today, nowId);
  return [...iterations]
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((it) => ({ ...brief(it), endDate: endDay(it), role: roleOf(it, ptrs, today) }));
}

const cacheIterations = (cache, field) =>
  cache.transaction(() => cache.replaceProject(field.project, { projectId: field.projectId, fieldId: field.fieldId, iterations: field.iterations }));

export async function iterationListCommand(ctx, args) {
  if (args.length > 1) {
    ctx.err('usage: gvt-fleet iteration list [<owner/number>]');
    return EXIT_USAGE;
  }
  return withCacheAndGh(ctx, async ({ config, gh }) => {
    const projects = args.length === 1 ? [projectArg(config, args[0])] : configProjects(config);
    const today = isoDay(ctx.clock?.now() ?? new Date());
    const nowPointers = readNowPointers(ctx.stateDir);
    const out = [];
    let failed = false;
    for (const project of projects) {
      try {
        const f = await readProjectField(gh, project);
        const nowId = nowPointerOf(nowPointers, project);
        const source = pointers(f.iterations, today, nowId).source;
        if (nowId && source !== 'recorded') ctx.err(`${project}: the recorded Now ${nowId} is not in the Iteration field; Now and Next follow the dates`);
        out.push({ project, field: f.fieldId !== null, pointer: source, iterations: describeIterations(f.iterations, today, nowId) });
      } catch (e) {
        failed = true;
        out.push({ project, field: null, iterations: [], error: e.message });
        ctx.err(`${project}: ${e.message}`);
      }
    }
    if (ctx.json) {
      ctx.out(JSON.stringify({ today, projects: out }, null, 2));
    } else {
      for (const p of out) {
        if (p.error) continue;
        if (!p.field) {
          ctx.out(`${p.project}: no Iteration field`);
          continue;
        }
        ctx.out(`${p.project}:`);
        for (const it of p.iterations) ctx.out(`  ${it.role.padEnd(9)} ${it.startDate} to ${it.endDate} ${it.id} ${it.title}`);
      }
    }
    return failed ? EXIT_RUNTIME : 0;
  });
}

/**
 * Shared body of plan and promote: read, lay out, write, read back, cache, print. A layout that
 * returns `nowId` (promote) records it as the project's Now once GitHub has taken the update, even
 * when the readback then fails: the update is applied, and a rerun from the old pointer would
 * promote again.
 */
async function writeLayout(ctx, { event, project, gh, cache, layoutOf, describe }) {
  const now = ctx.clock?.now() ?? new Date();
  const today = isoDay(now);
  const base = { project, status: 'failed' };
  let nowId;
  try {
    nowId = nowPointerOf(readNowPointers(ctx.stateDir), project);
  } catch (e) {
    if (!(e instanceof NowPointerError)) throw e;
    return finish({ ...base, reason: e.message });
  }
  let field;
  try {
    field = await readProjectField(gh, project);
  } catch (e) {
    return finish({ ...base, reason: e.message });
  }
  if (!field.fieldId) return finish({ ...base, status: 'refused', reason: `project ${project} has no Iteration field` });
  let plan;
  try {
    plan = layoutOf(field.iterations, today, nowId);
  } catch (e) {
    if (!(e instanceof IterationRefusal)) throw e;
    return finish({ ...base, status: 'refused', reason: e.message });
  }
  const w = await writeIterations(gh, field, field.iterations, plan.iterations);
  if (w.status === 'changed' || w.problems.length > 0) cacheIterations(cache, { ...field, iterations: w.iterations });
  let reason = w.reason;
  let status = w.status;
  if (w.applied && plan.nowId) {
    try {
      writeNowPointer(ctx.stateDir, project, plan.nowId, now.toISOString());
      nowId = plan.nowId;
      if (status !== 'changed') reason = `${reason}; the update was sent and Now is recorded as ${nowId}: run iteration list before another promote`;
    } catch (e) {
      status = 'failed';
      reason = `${reason ? `${reason}; ` : ''}the update was sent, but Now could not be recorded as ${plan.nowId}: ${e.message}`;
    }
  }
  const result = { ...base, status, ...describe(plan, w.iterations, today, nowId), iterations: describeIterations(w.iterations, today, nowId) };
  if (reason) result.reason = reason;
  return finish(result);

  function finish(r) {
    const { line, ...body } = r;
    ctx.log.append({ event, project, status: body.status });
    if (body.reason) ctx.err(`${project}: ${body.status}: ${body.reason}`);
    if (ctx.json) ctx.out(JSON.stringify(body, null, 2));
    else ctx.out(body.status === 'changed' ? line : `${project}: ${body.status}`);
    return body.status === 'changed' ? 0 : EXIT_RUNTIME;
  }
}

export async function iterationPlanCommand(ctx, args) {
  if (args.length !== 2) {
    ctx.err('usage: gvt-fleet iteration plan <owner/number> <title>');
    return EXIT_USAGE;
  }
  return withCacheAndGh(ctx, async ({ config, cache, gh }) => {
    const project = projectArg(config, args[0]);
    return writeLayout(ctx, {
      event: 'iteration plan',
      project,
      gh,
      cache,
      layoutOf: (all, today) => planAppend(all, today, args[1]),
      describe: (plan, back) => {
        const added = back.find((it) => !plan.iterations.some((x) => x.id === it.id && x.id)) ?? null;
        return { added: brief(added), line: `${project}: planned ${plan.added.startDate} to ${endDay(plan.added)} ${added?.id ?? '?'} ${plan.added.title}` };
      },
    });
  });
}

export async function iterationPromoteCommand(ctx, args) {
  if (args.length < 1 || args.length > 2) {
    ctx.err('usage: gvt-fleet iteration promote <owner/number> [<iteration>]');
    return EXIT_USAGE;
  }
  return withCacheAndGh(ctx, async ({ config, cache, gh }) => {
    const project = projectArg(config, args[0]);
    return writeLayout(ctx, {
      event: 'iteration promote',
      project,
      gh,
      cache,
      layoutOf: (all, today, nowId) => planPromote(all, today, args[1] ?? null, nowId),
      describe: (plan, back, today, nowId) => {
        const to = pointers(back, today, nowId);
        return {
          from: { now: brief(plan.from.now), next: brief(plan.from.next) },
          to: { now: brief(to.now), next: brief(to.next) },
          line: `${project}: Now is ${to.now?.title ?? '(none)'}; Next is ${to.next?.title ?? '(none)'}`,
        };
      },
    });
  });
}

export async function heartbeatCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet heartbeat <ref>');
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, claims, clock }) => {
    const ref = parseWorkerRef(args[0], config);
    const r = heartbeatClaim({ clock, config }, { claims, key: ref.key });
    if (r.status === 'none') ctx.err(`${ref.key}: no held claim`);
    if (r.status === 'expired') ctx.err(`${ref.key}: the lease expired at ${r.expiresAt}; heartbeat does not revive it (run gvt-fleet expire, then claim again)`);
    printResult(ctx, r, `${ref.key}: ${r.status}${r.expiresAt ? ` until ${r.expiresAt}` : ''}`);
    return r.status === 'refreshed' ? 0 : EXIT_RUNTIME;
  });
}

// ---- worktrees ----

async function withWorktrees(ctx, fn) {
  return withClaims(ctx, async (env) => {
    const [{ createClaude }, { createGit }, { createFindHolders }] = await Promise.all([import('./claude-cli.mjs'), import('./git.mjs'), import('./worktrees.mjs')]);
    const deps = {
      git: createGit({ run: env.run }),
      claude: ctx.claude ?? createClaude({ run: env.run }),
      gh: env.gh,
      sleep: env.clock.sleep,
      now: () => env.clock.now(),
      findHolders: ctx.findHolders ?? createFindHolders({ run: env.run }),
    };
    const workspace = ctx.paths?.workspace ?? ctx.repoRoot;
    return fn({ ...env, deps, workspace, reposDir: path.join(workspace, 'repos') });
  });
}

/** Print a worktree result: JSON, or one line plus detail lines. Failures go to stderr. */
function reportWorktree(ctx, event, r, line, logExtra = {}) {
  ctx.log.append({ event, key: r.key, status: r.status, ...logExtra });
  const bad = !['created', 'noop', 'removed'].includes(r.status);
  if (bad) {
    if (r.reason) ctx.err(`${r.key}: ${r.status}: ${r.reason}`);
    if (r.status === 'half-removed') {
      ctx.err(`${r.key}: the folder ${r.folder} is still on disk (claude rm: ${r.output || 'no output'})`);
      const who = r.holders.length > 0 ? r.holders.map((h) => `${h.process} (pid ${h.pid})`).join(', ') : 'none found';
      ctx.err(`likely holders (${r.holderSource}): ${who}`);
      ctx.err(r.hint);
    }
    if (r.status === 'held' && r.hint) {
      ctx.err(`likely holders (${r.holderSource}): ${r.holders.map((h) => `${h.process} (pid ${h.pid})`).join(', ') || 'none found'}`);
      ctx.err(r.hint);
    }
    for (const p of r.problems ?? []) ctx.err(`${r.key}: ${p}`);
  }
  for (const n of r.notes ?? []) ctx.err(`${r.key}: ${n}`);
  if (r.branchRecord?.warning) ctx.err(`${r.key}: ${r.branchRecord.warning}`);
  if (r.branchRecord?.recorded || r.branchRecord?.dropped) ctx.err(`${r.key}: config/branches.json changed; commit it`);
  printResult(ctx, r, line);
  return bad ? EXIT_RUNTIME : 0;
}

/** The default branch of a repo: the config entry, else the last sync. Undefined when neither knows it. */
const defaultBranchOf = (config, cache, repo) => config.repos.find((e) => e.repo === repo)?.defaultBranch ?? cache.getRepoState(repo)?.defaultBranch;

/** The pull requests the cache says close the issue: [{number, state, headRefName, repo}]. Empty when the issue is not cached. */
function closingPrsOf(cache, key) {
  const repo = key.slice(0, key.lastIndexOf('#'));
  return cache.readIssues({ repo }).find((i) => i.key === key)?.closingPrs ?? [];
}

/** The `trust` input of createWorktree, shared by `worktree create` and `dispatch`. */
async function createInputs(ctx, { clock, workspace }) {
  const os = await import('node:os');
  return {
    trust: {
      claudeJson: ctx.paths?.claudeJson ?? path.join(os.homedir(), '.claude.json'),
      workspace,
      stateDir: ctx.stateDir,
      sleep: clock.sleep,
    },
  };
}

export async function worktreeCreateCommand(ctx, args) {
  if (args.length < 1 || args.length > 2) {
    ctx.err('usage: gvt-fleet worktree create <ref> [prompt]');
    return EXIT_USAGE;
  }
  return withWorktrees(ctx, async ({ config, cache, claims, clock, deps, workspace, reposDir }) => {
    const ref = parseWorkerRef(args[0], config);
    const { createWorktree } = await import('./worktrees.mjs');
    const defaultBranch = defaultBranchOf(config, cache, ref.repo);
    if (!defaultBranch) {
      ctx.err(`${ref.key}: default branch unknown; run gvt-fleet sync first`);
      return EXIT_RUNTIME;
    }
    // A task has no issue, so its session gets the same prompt as dispatch --task: the given one or the default, then the tracker rule.
    let prompt = args[1];
    const task = parseLeaseKey(ref.key);
    if (task?.kind === 'task') {
      if (prompt?.startsWith('-')) {
        ctx.err(`gvt-fleet worktree create: ${JSON.stringify(prompt)} starts with -; a task prompt must not start with -`);
        return EXIT_USAGE;
      }
      const { defaultTaskPrompt, TASK_RULE } = await import('./dispatch.mjs');
      prompt = `${prompt || defaultTaskPrompt(task.slug, task.repo, ref.key)} ${TASK_RULE}`;
    }
    const r = await createWorktree(deps, {
      claims,
      key: ref.key,
      reposDir,
      defaultBranch,
      cloneUrl: ctx.cloneUrlOf?.(ref.repo),
      prompt,
      ...(await createInputs(ctx, { clock, workspace })),
    });
    return reportWorktree(ctx, 'worktree-create', r, `${ref.key}: ${r.status}${r.path ? ` ${r.path}` : ''}${r.shortId ? ` (session ${r.shortId})` : ''}`);
  });
}

/** Print a dispatch result: JSON, or one line on stdout for a session, and the problems and the claim's fate on stderr. */
function reportDispatch(ctx, r) {
  ctx.log.append({ event: 'dispatch', key: r.key, status: r.status, step: r.step, claim: r.claim, rollback: r.rollback });
  const ok = r.status === 'created' || r.status === 'noop' || (r.status === 'adopted' && r.live);
  const key = r.key;
  if (r.claim === 'refused' || r.claim === 'failed') {
    printClaimProblems(ctx, key, { status: r.claim, reasons: r.reasons, reason: r.reason });
  } else if (r.step) {
    ctx.err(`${key}: ${r.step} ${r.status}: ${r.reason}`);
  }
  if (r.status === 'adopted' && !r.live) ctx.err(`${key}: adopted a session in state ${r.sessionState ?? 'unknown'}, not a live one`);
  for (const line of r.found ?? []) ctx.err(`${key}: found: ${line}`);
  if (r.rollback === 'released') ctx.err(`${key}: the claim was rolled back`);
  if (r.rollback === 'failed') {
    ctx.err(`${key}: rollback failed: ${r.rollbackReason}; the lease is left ${r.leaseState ?? 'in an unknown state'}; run gvt-fleet release ${key} or gvt-fleet expire`);
  }
  if (r.rollback === 'not-needed') ctx.err(`${key}: the claim was held before this command and is kept`);
  if (r.rollback === 'kept' && r.status === 'adopted') {
    ctx.err(`${key}: the claim is kept; run gvt-fleet worktree remove ${key}, then gvt-fleet release ${key}`);
  } else if (r.rollback === 'kept') {
    const hint = r.step === 'confirm' ? ` (claude printed ${r.printedId ?? 'no id'}; look for ${r.name} with claude agents)` : '';
    // A second `dispatch --task` makes a new id, so a task is adopted with worktree create.
    const again = parseLeaseKey(key)?.kind === 'task' ? `gvt-fleet worktree create ${key}` : `gvt-fleet dispatch ${key} again`;
    ctx.err(`${key}: the claim is kept${hint}; run ${again} to adopt a session, or gvt-fleet release ${key}`);
  }
  if (ctx.json) ctx.out(JSON.stringify(r, null, 2));
  else if (r.path && ['created', 'noop', 'adopted'].includes(r.status)) {
    const state = r.status === 'adopted' ? `, ${r.sessionState ?? 'state unknown'}` : '';
    ctx.out(`${key}: ${r.status} ${r.path} (session ${r.shortId}${state})${r.expiresAt ? ` until ${r.expiresAt}` : ''}`);
  }
  return ok ? 0 : EXIT_RUNTIME;
}

export async function dispatchCommand(ctx, args) {
  const allowSelf = args.includes('--allow-self');
  const task = args.includes('--task');
  const rest = args.filter((a) => a !== '--allow-self' && a !== '--task');
  if (task ? rest.length < 2 || rest.length > 3 : rest.length < 1 || rest.length > 2) {
    ctx.err(task ? 'usage: gvt-fleet dispatch --task [--allow-self] <repo> <slug> [prompt]' : 'usage: gvt-fleet dispatch [--allow-self] <ref> [prompt]');
    return EXIT_USAGE;
  }
  const flag = rest.find((a) => a.startsWith('-'));
  if (flag !== undefined) {
    ctx.err(`gvt-fleet dispatch: ${JSON.stringify(flag)} starts with -; the only flags are --allow-self and --task, and a prompt must not start with -`);
    return EXIT_USAGE;
  }
  if (task) {
    return withWorktrees(ctx, async ({ config, cache, claims, clock, deps, workspace, reposDir }) => {
      const entry = resolveRepoArg(rest[0], config);
      if (!entry) throw new ClaimError(`${rest[0]} is not in the config`);
      const bad = checkTaskSlug(entry.repo, rest[1], config);
      if (bad) throw new ClaimError(bad);
      const { dispatchTask } = await import('./dispatch.mjs');
      const r = await dispatchTask(deps, {
        claims,
        cache,
        config,
        clock,
        repo: entry.repo,
        slug: rest[1],
        reposDir,
        workspace,
        defaultBranch: defaultBranchOf(config, cache, entry.repo),
        cloneUrl: ctx.cloneUrlOf?.(entry.repo),
        prompt: rest[2],
        allowSelf,
        ...(await createInputs(ctx, { clock, workspace })),
      });
      return reportDispatch(ctx, r);
    });
  }
  return withWorktrees(ctx, async ({ config, cache, claims, clock, deps, workspace, reposDir, record }) => {
    const ref = parseClaimRef(rest[0], config);
    const { dispatchIssue } = await import('./dispatch.mjs');
    const extract = await loadExtract();
    const r = await dispatchIssue(deps, {
      claims,
      cache,
      config,
      clock,
      key: ref.key,
      reposDir,
      workspace,
      defaultBranch: defaultBranchOf(config, cache, ref.repo),
      cloneUrl: ctx.cloneUrlOf?.(ref.repo),
      prompt: rest[1],
      allowSelf,
      extract,
      branchRecord: { repos: record.repos, remoteHeads: cache.remoteHeads() },
      ...(await createInputs(ctx, { clock, workspace })),
    });
    return reportDispatch(ctx, r);
  });
}

export async function worktreeRemoveCommand(ctx, args) {
  const discard = args.includes('--discard');
  const requireMerged = args.includes('--require-merged');
  const rest = args.filter((a) => a !== '--discard' && a !== '--require-merged');
  if (rest.length !== 1) {
    ctx.err('usage: gvt-fleet worktree remove <ref> [--discard | --require-merged]');
    return EXIT_USAGE;
  }
  if (discard && requireMerged) {
    ctx.err('gvt-fleet worktree remove: --discard and --require-merged cannot be combined');
    return EXIT_USAGE;
  }
  return withWorktrees(ctx, async ({ config, cache, claims, clock, deps, reposDir }) => {
    const ref = parseWorkerRef(rest[0], config);
    const isTask = ref.kind === 'task';
    if (isTask && requireMerged) {
      ctx.err('gvt-fleet worktree remove: --require-merged does not apply to a task; a task has no pull request to merge');
      return EXIT_USAGE;
    }
    const { removeWorktree } = await import('./worktrees.mjs');
    const branchRecord = isTask ? undefined : { recordFile: recordFileOf(ctx), lockFile: path.join(ctx.stateDir, 'branches.lock'), config, cache, clock };
    const r = await removeWorktree(deps, {
      claims, key: ref.key, reposDir, discard, requireMerged, closingPrs: isTask ? [] : closingPrsOf(cache, ref.key), readClosingPrs: isTask ? undefined : () => readClosingPrs(deps.gh, ref.repo, ref.number), defaultBranch: defaultBranchOf(config, cache, ref.repo), branchRecord, stateDir: ctx.stateDir,
    });
    return reportWorktree(ctx, 'worktree-remove', r, `${ref.key}: ${r.status}`, { requireMerged, pr: r.pr?.number ?? null, branchRecord: { recorded: r.branchRecord?.recorded ?? null } });
  });
}

/** Print a wrap result: JSON, or the status, each step's outcome and the hint. Exit 0 only for `wrapped`. */
function reportWrap(ctx, r) {
  ctx.log.append({
    event: 'wrap',
    key: r.key,
    status: r.status,
    steps: r.steps,
    pr: r.pr?.number ?? null,
    proofs: (r.proofs ?? []).map((p) => p.pr?.number ?? null),
    branchFlag: r.branchFlag ?? null,
    branchRecord: { recorded: r.branchRecord?.recorded ?? null },
  });
  const ok = r.status === 'wrapped';
  if (!ok) {
    if (r.reason) ctx.err(`${r.key}: ${r.status}: ${r.reason}`);
    if (r.holderSource) {
      const who = (r.holders ?? []).length > 0 ? r.holders.map((h) => `${h.process} (pid ${h.pid})`).join(', ') : 'none found';
      ctx.err(`likely holders (${r.holderSource}): ${who}`);
    }
    for (const p of r.problems ?? []) ctx.err(`${r.key}: ${p}`);
    if (r.hint) ctx.err(r.hint);
  }
  for (const n of r.notes ?? []) ctx.err(`${r.key}: ${n}`);
  if (r.branchRecord?.warning) ctx.err(`${r.key}: ${r.branchRecord.warning}`);
  if (r.branchRecord?.recorded || r.branchRecord?.dropped) ctx.err(`${r.key}: config/branches.json changed; commit it`);
  const steps = Object.entries(r.steps).map(([k, v]) => `${k} ${v}`).join(', ');
  printResult(ctx, r, `${r.key}: ${r.status}${r.nothing ? ' (nothing to do)' : ''} (${steps})${r.hint && ok ? ` ${r.hint}` : ''}`);
  return ok ? 0 : EXIT_RUNTIME;
}

export async function wrapCommand(ctx, args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    ctx.err('usage: gvt-fleet wrap <ref>');
    return EXIT_USAGE;
  }
  return withWorktrees(ctx, async ({ config, cache, claims, clock, deps, reposDir }) => {
    const ref = parseWorkerRef(args[0], config);
    const { wrapIssue, wrapTask } = await import('./wrap.mjs');
    const common = { claims, cache, config, clock, key: ref.key, reposDir, defaultBranch: defaultBranchOf(config, cache, ref.repo), stateDir: ctx.stateDir };
    if (ref.kind === 'task') return reportWrap(ctx, await wrapTask(deps, { ...common, closingPrs: [] }));
    const branchRecord = { recordFile: recordFileOf(ctx), lockFile: path.join(ctx.stateDir, 'branches.lock'), config, cache, clock };
    const { readIssueRefs } = await import('./nothing-to-lose.mjs');
    const r = await wrapIssue(deps, {
      ...common,
      closingPrs: closingPrsOf(cache, ref.key),
      readClosingPrs: () => readClosingPrs(deps.gh, ref.repo, ref.number),
      readIssueRefs: () => readIssueRefs(deps.gh, ref.repo, ref.number),
      branchRecord,
    });
    return reportWrap(ctx, r);
  });
}

export async function worktreeFinishCommand(ctx, args) {
  if (args.length !== 1) {
    ctx.err('usage: gvt-fleet worktree finish <ref>');
    return EXIT_USAGE;
  }
  return withWorktrees(ctx, async ({ config, claims, deps, reposDir }) => {
    const ref = parseWorkerRef(args[0], config);
    const { finishWorktree } = await import('./worktrees.mjs');
    const r = await finishWorktree(deps, { claims, key: ref.key, reposDir, stateDir: ctx.stateDir });
    return reportWorktree(ctx, 'worktree-finish', r, `${ref.key}: ${r.status}`);
  });
}

export async function expireCommand(ctx, args) {
  if (args.length !== 0) {
    ctx.err('usage: gvt-fleet expire');
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, cache, claims, gh, clock, run }) => {
    const { createClaude } = await import('./claude-cli.mjs');
    const claude = ctx.claude ?? createClaude({ run });
    const reposDir = path.join(ctx.paths?.workspace ?? ctx.repoRoot, 'repos');
    const r = await expireClaims({ gh, claude, clock, config }, { claims, cache, reposDir });
    ctx.log.append({ event: 'expire', refreshed: r.refreshed.length, released: r.released.length, failed: r.failed.length });
    for (const f of r.failed) ctx.err(`${f.key}: ${f.reason}`);
    printResult(ctx, r, `refreshed ${r.refreshed.length}, released ${r.released.length}, failed ${r.failed.length}`);
    return r.failed.length > 0 ? EXIT_RUNTIME : 0;
  });
}

/**
 * The worker view: leases, `claude agents --json --all` and the hook worker files, read once each and joined in memory.
 * Held leases whose worker is live are extended. It makes no GitHub call. Exit 1 when the agents list cannot be read
 * (the claims and hook view is still printed and no lease changes).
 */
export async function statusCommand(ctx, args) {
  const restart = args.length === 1 && args[0] === '--restart';
  if (args.length !== 0 && !restart) {
    ctx.err('usage: gvt-fleet status [--restart]');
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, claims, clock, cache }) => {
    const [
      { createClaude },
      { joinWorkers, refreshLiveLeases, formatStatus, restartEntries, formatRestart },
      { readWorkerRecords },
      { readRateLimits },
    ] = await Promise.all([
      import('./claude-cli.mjs'),
      import('./status.mjs'),
      import('./worker-state.mjs'),
      import('./rate-limits.mjs'),
    ]);
    const claude = ctx.claude ?? createClaude({ run: ctx.run ?? (await import('./proc.mjs')).run });
    const workspace = ctx.paths?.workspace ?? ctx.repoRoot;
    const now = clock.now();
    const leases = claims.listLeases({ states: ['claiming', 'held', 'releasing'] });
    let agents = [];
    let agentsError = null;
    try {
      agents = await claude.agents({ all: true });
    } catch (e) {
      agentsError = e;
    }
    const joined = joinWorkers({
      leases,
      agents,
      agentsError,
      records: readWorkerRecords(ctx.stateDir),
      config,
      workspace,
      reposDir: path.join(workspace, 'repos'),
      now,
      rateLimits: readRateLimits(ctx.stateDir),
      issues: new Map(cache.readIssues().map((r) => [String(r.key).toLowerCase(), r])),
    });
    const { refreshed, revived } = agentsError ? { refreshed: 0, revived: 0 } : refreshLiveLeases(claims, [...joined.workers, ...joined.tasks], { now, leaseMinutes: config.leaseMinutes ?? 120 });
    const { ignoredLeaseKeys, ...shown } = joined;
    const plain = ({ refresh, leaseId, ...row }) => row;
    const view = { ...shown, workers: joined.workers.map(plain), tasks: joined.tasks.map(plain) };
    for (const key of ignoredLeaseKeys) ctx.err(`${key}: cannot read lease key; ignored`);
    ctx.log.append({
      event: 'status',
      workers: view.workers.length,
      tasks: view.tasks.length,
      refreshed,
      revived,
      agents: agentsError ? null : agents.length,
      ...(restart ? { restart: true } : {}),
    });
    if (agentsError) ctx.err(`claude agents unavailable: ${view.agents.error}`);
    if (restart) {
      const isDir = (p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      };
      const entries = restartEntries([...joined.workers, ...joined.tasks], leases, { exists: isDir });
      const generatedAt = new Date(now instanceof Date ? now.getTime() : Number(now)).toISOString();
      if (ctx.json) ctx.out(JSON.stringify({ generatedAt, agents: view.agents, entries }, null, 2));
      else ctx.out(formatRestart(entries, { generatedAt }));
    } else if (ctx.json) ctx.out(JSON.stringify(view, null, 2));
    else ctx.out(formatStatus(view));
    return agentsError ? EXIT_RUNTIME : 0;
  });
}

const WATCH_USAGE = 'gvt-fleet watch [--minutes N] [--interval S] [--since <iso>]';

function parseWatchArgs(args) {
  const opts = { minutes: 25, interval: 15, since: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--minutes' && flag !== '--interval' && flag !== '--since') return null;
    const value = args[++i];
    if (value === undefined) return null;
    if (flag === '--since') {
      if (!Number.isFinite(Date.parse(value))) return null;
      opts.since = Date.parse(value);
    } else {
      if (!/^[0-9]+$/.test(value)) return null;
      const n = Number(value);
      if (flag === '--interval' && (n < 5 || n > 3600)) return null;
      if (flag === '--minutes' && n > 1440) return null;
      opts[flag.slice(2)] = n;
    }
  }
  return opts;
}

/**
 * Polls the worker view for `--minutes` and prints one line each time a worker starts to need you. It lists leases,
 * calls `claude agents --json --all` once per poll, reads the hook worker files, and makes no GitHub call, no lease
 * change and no read of the issue cache. An unreadable agents list does not change the exit code; the poll runs on the hook records.
 */
export async function watchCommand(ctx, args) {
  const opts = parseWatchArgs(args);
  if (!opts) {
    ctx.err(`usage: ${WATCH_USAGE}`);
    return EXIT_USAGE;
  }
  return withClaims(ctx, async ({ config, claims, clock }) => {
    const [{ createClaude }, { joinWorkers }, { readWorkerRecords }, { nextWaits, formatWait }] = await Promise.all([
      import('./claude-cli.mjs'),
      import('./status.mjs'),
      import('./worker-state.mjs'),
      import('./watch.mjs'),
    ]);
    const claude = ctx.claude ?? createClaude({ run: ctx.run ?? (await import('./proc.mjs')).run });
    const workspace = ctx.paths?.workspace ?? ctx.repoRoot;
    const startMs = clock.now().getTime();
    const endMs = startMs + opts.minutes * 60 * 1000;
    const cursorMs = opts.since ?? startMs;
    ctx.log.append({ event: 'watch-start', minutes: opts.minutes, interval: opts.interval, since: new Date(cursorMs).toISOString() });
    let memo = null;
    let polls = 0;
    let emitted = 0;
    let agentsErrors = 0;
    let lastFailed = false;
    let lastPollMs = startMs;
    for (;;) {
      const pollMs = clock.now().getTime();
      lastPollMs = pollMs;
      polls += 1;
      let agents = [];
      let agentsError = null;
      try {
        agents = await claude.agents({ all: true });
      } catch (e) {
        agentsError = e;
      }
      if (agentsError) {
        agentsErrors += 1;
        if (!lastFailed) ctx.err(`claude agents unavailable: ${agentsError.message ?? agentsError}`);
      }
      lastFailed = Boolean(agentsError);
      const joined = joinWorkers({
        leases: claims.listLeases({ states: ['claiming', 'held', 'releasing'] }),
        agents,
        agentsError,
        records: readWorkerRecords(ctx.stateDir),
        config,
        workspace,
        reposDir: path.join(workspace, 'repos'),
        now: new Date(pollMs),
        issues: new Map(),
      });
      const rows = [...joined.workers, ...joined.tasks].map((w) => ({ key: w.key ?? `${w.repo}:${w.worktree}`, state: w.state, reason: w.reason, detail: w.detail, questions: w.questions, since: w.since }));
      const next = nextWaits(memo, rows, { cursorMs, agentsOk: !agentsError, nowMs: pollMs });
      memo = next.memo;
      for (const line of next.lines) {
        ctx.out(formatWait(line, { json: ctx.json }));
        ctx.log.append({ event: 'watch-wait', key: line.key, reason: line.reason });
        emitted += 1;
      }
      const left = endMs - clock.now().getTime();
      if (left <= 0) break;
      await clock.sleep(Math.min(opts.interval * 1000, left));
    }
    ctx.log.append({ event: 'watch-end', polls, emitted, agentsErrors });
    ctx.out(formatWait({ event: 'watch-end', cursor: new Date(lastPollMs - 5000).toISOString(), polls, agentsErrors }, { json: ctx.json }));
    return 0;
  });
}
