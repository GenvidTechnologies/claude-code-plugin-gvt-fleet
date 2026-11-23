// Branch record logic (Q6): unknown branches with PR hints, the recorded-entry listing, and
// `branch set` (read-merge-write of config/branches.json under a lock file).

import fs from 'node:fs';
import path from 'node:path';
import {
  ConfigError,
  repoShortName,
  validateBranchEntry,
  validateBranchRecord,
} from './config.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { unknownBranches } from './sync.mjs';

const lower = (s) => String(s ?? '').toLowerCase();
const FULL_REF_RE = /^([^\s#/]+\/[^\s#/]+)#([1-9][0-9]*)$/;
const NAME_REF_RE = /^([^\s#/]+)#([1-9][0-9]*)$/;
const NUMBER_REF_RE = /^#([1-9][0-9]*)$/;

/** A `branch set` failure that is not a config problem (exit 1). */
export class BranchSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BranchSetError';
    this.exitCode = 1;
  }
}

/**
 * Remote heads that are not the default branch and are not recorded, each with the open or merged
 * closing PRs from that head. The hints come from the cached issue rows and are never written.
 * @returns {{repo: string, branch: string, headOid: string|null, lastCommitDate: string|null, hints: {issue: string, pr: number, state: string}[]}[]}
 */
export function listUnknown(cache, config, record) {
  const byHead = new Map();
  for (const row of cache.readIssues()) {
    for (const pr of Array.isArray(row.closingPrs) ? row.closingPrs : []) {
      const state = String(pr?.state ?? '').toUpperCase();
      if (!pr?.headRefName || !pr.repo || (state !== 'OPEN' && state !== 'MERGED')) continue;
      const k = `${lower(pr.repo)}\u0000${pr.headRefName}`;
      const list = byHead.get(k) ?? [];
      list.push({ issue: row.key, pr: pr.number, state });
      byHead.set(k, list);
    }
  }
  return unknownBranches(cache, config, record).map((u) => ({
    repo: u.repo,
    branch: u.name,
    headOid: u.headOid,
    lastCommitDate: u.lastCommitDate,
    hints: byHead.get(`${lower(u.repo)}\u0000${u.name}`) ?? [],
  }));
}

/** Every recorded entry with its status: `on-remote`, or `gone` when the branch left the remote. */
export function listRecorded(record, cache) {
  const out = [];
  const heads = cache.remoteHeads();
  for (const repo of Object.keys(record.repos ?? {}).sort()) {
    const names = Object.entries(heads).find(([r]) => lower(r) === lower(repo))?.[1] ?? [];
    for (const branch of Object.keys(record.repos[repo]).sort()) {
      out.push({ repo, branch, ...record.repos[repo][branch], status: names.includes(branch) ? 'on-remote' : 'gone' });
    }
  }
  return out;
}

/** Resolve the `--issue` argument to a full `owner/repo#N` key. Throws ConfigError. */
export function resolveIssueArg(arg, { repo, config }) {
  const where = `${repo} --issue`;
  const fail = (message) => new ConfigError([{ entry: where, message }]);
  const full = FULL_REF_RE.exec(arg);
  if (full) return `${full[1]}#${full[2]}`;
  const num = NUMBER_REF_RE.exec(arg);
  if (num) return `${repo}#${num[1]}`;
  const named = NAME_REF_RE.exec(arg);
  if (named) {
    const matches = (config.repos ?? []).filter((e) => lower(repoShortName(e.repo, config)) === lower(named[1]));
    if (matches.length === 1) return `${matches[0].repo}#${named[2]}`;
    throw fail(`"${named[1]}" is not a configured short name`);
  }
  throw fail(`cannot read "${arg}" as an issue reference (use #N, name#N or owner/repo#N)`);
}

export function readRecordFile(recordFile) {
  let text;
  try {
    text = fs.readFileSync(recordFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, repos: {} };
    throw new ConfigError([{ entry: '(branches)', message: `cannot read ${recordFile}: ${e.message}` }]);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([{ entry: '(branches)', message: `invalid JSON in ${recordFile}: ${e.message}` }]);
  }
  const v = validateBranchRecord(record);
  if (!v.ok) throw new ConfigError(v.errors);
  return record;
}

/** Take the lock by exclusive create. A lock that already exists is reported, never stolen. */
function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = '';
    try {
      holder = fs.readFileSync(lockFile, 'utf8').trim();
    } catch {
      // the holder may have just released it; the report below still stands
    }
    throw new BranchSetError(
      `${lockFile} is held${holder ? ` (pid ${holder})` : ''}; if no gvt-fleet command is running, the lock is stale: remove it by hand and retry`,
    );
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Record one branch. Returns {repo, branch, entry, prior, written}. `prior` is the entry that was there
 * before (read under the lock), or undefined. `onlyIf(prior)` is evaluated under the lock on that fresh
 * read; when it returns false nothing is written and the result has `written: false` (and `entry` is `prior`).
 * Throws ConfigError (exit 2) for a bad argument or record, BranchSetError (exit 1) for a missing branch
 * or a held lock.
 * @param {{recordFile: string, lockFile: string, repo: string, branch: string, disposition: string,
 *   issueArg?: string, allowMissing?: boolean, config: object, cache: object, clock: {now: () => Date}, by?: string,
 *   onlyIf?: (prior: object|undefined) => boolean}} a
 */
export function setBranch({ recordFile, lockFile, repo, branch, disposition, issueArg, allowMissing = false, config, cache, clock, by = 'coach', onlyIf }) {
  const managed = (config.repos ?? []).find((e) => lower(e.repo) === lower(repo));
  if (!managed) throw new ConfigError([{ entry: repo, message: 'repo is not in the config' }]);
  const canonical = managed.repo;
  if (!allowMissing && !cache.readBranchHeads(canonical).some((h) => h.name === branch)) {
    throw new BranchSetError(`${canonical}: branch "${branch}" is not in the cached remote list (run gvt-fleet sync, or pass --allow-missing)`);
  }
  const entry = { disposition, decided: clock.now().toISOString().slice(0, 10), by };
  if (disposition === 'issue') {
    entry.issue = issueArg === undefined ? undefined : resolveIssueArg(issueArg, { repo: canonical, config });
  }
  const errors = validateBranchEntry(entry, `${canonical} ${branch}`);
  if (errors.length > 0) throw new ConfigError(errors);

  let prior;
  acquireLock(lockFile);
  try {
    const record = readRecordFile(recordFile);
    const key = Object.keys(record.repos).find((r) => lower(r) === lower(canonical)) ?? canonical;
    prior = record.repos[key]?.[branch];
    if (onlyIf && !onlyIf(prior)) return { repo: canonical, branch, entry: prior, prior, written: false };
    record.repos[key] = { ...record.repos[key], [branch]: entry };
    writeJsonAtomic(recordFile, record);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
  return { repo: canonical, branch, entry, prior, written: true };
}

/**
 * Drop one recorded branch entry, but only when `matches(entry)` is true for it. The caller
 * supplies the guard, so an entry a person wrote is never dropped by accident. Reads, merges and
 * writes the record under the lock, like setBranch. An absent entry or a guard that returns
 * false writes nothing. Returns {dropped: boolean, entry?}, where entry is the dropped entry.
 * @param {{recordFile: string, lockFile: string, repo: string, branch: string, matches: (entry: object) => boolean}} a
 */
export function dropBranch({ recordFile, lockFile, repo, branch, matches }) {
  if (typeof matches !== 'function') throw new TypeError('dropBranch needs a matches(entry) guard');
  acquireLock(lockFile);
  try {
    const record = readRecordFile(recordFile);
    const key = Object.keys(record.repos).find((r) => lower(r) === lower(repo));
    const entry = key === undefined ? undefined : record.repos[key][branch];
    if (entry === undefined || !matches(entry)) return { dropped: false };
    const errors = validateBranchEntry(entry, `${key} ${branch}`);
    if (errors.length > 0) throw new ConfigError(errors);
    delete record.repos[key][branch];
    writeJsonAtomic(recordFile, record);
    return { dropped: true, entry };
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
