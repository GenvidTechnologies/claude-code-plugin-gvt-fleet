// Config loader and validator for config/repos.json, plus the branch-record validator
// for config/branches.json. Callers exit 2 on ConfigError.

import { readFile as fsReadFile } from 'node:fs/promises';

const TOP_KEYS = ['version', 'claimAccount', 'leaseMinutes', 'rateReserve', 'fullSyncHours', 'repos'];
export const LABEL_KEYS = ['triagedLabel', 'inProgressLabel', 'blockedLabel'];
const ENTRY_KEYS = ['repo', 'enabled', ...LABEL_KEYS, 'defaultBranch', 'project'];
// A GitHub project, "owner/number" (ADR 0015).
const PROJECT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[1-9][0-9]*$/;
const NUMBER_KEYS = ['leaseMinutes', 'rateReserve', 'fullSyncHours'];
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const ISSUE_REF_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+#[1-9][0-9]*$/;
const DISPOSITIONS = ['issue', 'keep', 'remove'];
const BRANCH_ENTRY_KEYS = ['disposition', 'issue', 'decided', 'by'];

export const BUILT_IN_DEFAULTS = Object.freeze({
  triagedLabel: 'triaged',
  inProgressLabel: 'in-progress',
  blockedLabel: 'blocked',
});

export class ConfigError extends Error {
  /** @param {{entry: string, message: string}[]} errors */
  constructor(errors) {
    super(`config invalid:\n${errors.map((e) => `  ${e.entry}: ${e.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
    this.exitCode = 2;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function shortName(repo) {
  return repo.split('/')[1];
}

// The short name is resolved here so that it can come from the repository entry later.
// `config` is not used yet.
export function repoShortName(repo, config) {
  return shortName(repo);
}

/** The config entry whose full name or short name equals `arg` (case-insensitive), or null. */
export function resolveRepoArg(arg, config) {
  const want = String(arg ?? '').toLowerCase();
  const repos = config?.repos ?? [];
  return (
    repos.find((e) => e.repo.toLowerCase() === want) ??
    repos.find((e) => repoShortName(e.repo, config).toLowerCase() === want) ??
    null
  );
}

function entryLabel(i, e) {
  return `repos[${i}] ${isObject(e) && typeof e.repo === 'string' ? e.repo : '(no repo)'}`;
}

export function validateConfig(obj) {
  const errors = [];
  const add = (entry, message) => errors.push({ entry, message });
  if (!isObject(obj)) {
    add('(config)', 'must be a JSON object');
    return { ok: false, errors };
  }
  for (const k of Object.keys(obj)) {
    if (!TOP_KEYS.includes(k)) add('(config)', `unknown key "${k}"`);
  }
  if (obj.version !== 1) add('(config)', 'version must be 1');
  if ('claimAccount' in obj && typeof obj.claimAccount !== 'string') add('(config)', 'claimAccount must be a string');
  for (const k of NUMBER_KEYS) {
    if (k in obj && !(Number.isFinite(obj[k]) && obj[k] >= 0)) add('(config)', `${k} must be a non-negative number`);
  }
  if (!Array.isArray(obj.repos)) {
    add('(config)', 'repos must be an array');
    return { ok: false, errors };
  }
  const seenRepo = new Map();
  const seenShort = new Map();
  obj.repos.forEach((e, i) => {
    const label = entryLabel(i, e);
    if (!isObject(e)) {
      add(label, 'entry must be an object');
      return;
    }
    for (const k of Object.keys(e)) {
      if (!ENTRY_KEYS.includes(k)) add(label, `unknown key "${k}"`);
    }
    if (typeof e.repo !== 'string' || !REPO_RE.test(e.repo)) {
      add(label, 'repo must be a string of the form owner/name');
    } else {
      const lower = e.repo.toLowerCase();
      if (seenRepo.has(lower)) {
        add(label, `duplicate repo, also ${entryLabel(seenRepo.get(lower), obj.repos[seenRepo.get(lower)])}`);
      } else {
        seenRepo.set(lower, i);
        const sn = repoShortName(lower, obj);
        if (seenShort.has(sn)) {
          const j = seenShort.get(sn);
          add(label, `duplicate short name "${repoShortName(e.repo, obj)}", also ${entryLabel(j, obj.repos[j])}`);
        } else {
          seenShort.set(sn, i);
        }
      }
    }
    if ('enabled' in e && typeof e.enabled !== 'boolean') add(label, 'enabled must be a boolean');
    for (const k of [...LABEL_KEYS, 'defaultBranch']) {
      if (k in e && (typeof e[k] !== 'string' || e[k] === '')) add(label, `${k} must be a non-empty string`);
    }
    if ('project' in e && (typeof e.project !== 'string' || !PROJECT_RE.test(e.project))) {
      add(label, 'project must be a string of the form owner/number');
    }
  });
  return { ok: errors.length === 0, errors };
}

export async function loadConfig({ file, readFile = (f) => fsReadFile(f, 'utf8') }) {
  let text;
  try {
    text = await readFile(file);
  } catch (err) {
    throw new ConfigError([{ entry: '(config)', message: `cannot read ${file}: ${err.message}` }]);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([{ entry: '(config)', message: `invalid JSON in ${file}: ${err.message}` }]);
  }
  const r = validateConfig(obj);
  if (!r.ok) throw new ConfigError(r.errors);
  return obj;
}

/** Validate the config first; call fn(config) only when it is valid. */
export async function runWithConfig(configFile, gh, fn, opts = {}) {
  const config = await loadConfig({ file: configFile, ...opts });
  return fn(config, gh);
}

/**
 * Precedence, lowest first: built-in default, the repo's .gvt-agent.json bugTracker block,
 * the config entry. `bugTracker` is injected. `defaultBranch` is GitHub's default branch.
 */
export function effectiveRepoSettings(entry, bugTracker = {}, defaultBranch = undefined) {
  const out = { ...BUILT_IN_DEFAULTS };
  if (defaultBranch !== undefined) out.defaultBranch = defaultBranch;
  const layers = [bugTracker ?? {}, entry];
  for (const layer of layers) {
    for (const k of [...LABEL_KEYS, 'defaultBranch']) {
      if (layer[k] !== undefined) out[k] = layer[k];
    }
  }
  out.enabled = entry.enabled !== false;
  out.repo = entry.repo;
  out.project = entry.project ?? null;
  return out;
}

/** Validate one branch-record entry (used by `branch set` and by validateBranchRecord). */
export function validateBranchEntry(e, where = '(entry)') {
  const errors = [];
  const add = (message) => errors.push({ entry: where, message });
  if (!isObject(e)) {
    add('entry must be an object');
    return errors;
  }
  for (const k of Object.keys(e)) {
    if (!BRANCH_ENTRY_KEYS.includes(k)) add(`unknown key "${k}"`);
  }
  if (!DISPOSITIONS.includes(e.disposition)) add(`disposition must be one of ${DISPOSITIONS.join(', ')}`);
  if (e.disposition === 'issue') {
    if (typeof e.issue !== 'string' || !ISSUE_REF_RE.test(e.issue)) add('issue must be a full owner/repo#N reference');
  } else if ('issue' in e) {
    add(`issue is only allowed with disposition "issue"`);
  }
  if (typeof e.decided !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.decided)) add('decided must be a YYYY-MM-DD string');
  if (typeof e.by !== 'string' || e.by === '') add('by must be a non-empty string');
  return errors;
}

/** Validate a whole config/branches.json object. Returns {ok, errors:[{entry, message}]}. */
export function validateBranchRecord(obj) {
  const errors = [];
  if (!isObject(obj)) return { ok: false, errors: [{ entry: '(branches)', message: 'must be a JSON object' }] };
  for (const k of Object.keys(obj)) {
    if (k !== 'version' && k !== 'repos') errors.push({ entry: '(branches)', message: `unknown key "${k}"` });
  }
  if (obj.version !== 1) errors.push({ entry: '(branches)', message: 'version must be 1' });
  if (!isObject(obj.repos)) {
    errors.push({ entry: '(branches)', message: 'repos must be an object' });
    return { ok: false, errors };
  }
  for (const [repo, branches] of Object.entries(obj.repos)) {
    if (!REPO_RE.test(repo)) errors.push({ entry: repo, message: 'repo key must be owner/name' });
    if (!isObject(branches)) {
      errors.push({ entry: repo, message: 'must be an object of branch entries' });
      continue;
    }
    for (const [branch, e] of Object.entries(branches)) {
      errors.push(...validateBranchEntry(e, `${repo} ${branch}`));
    }
  }
  return { ok: errors.length === 0, errors };
}
