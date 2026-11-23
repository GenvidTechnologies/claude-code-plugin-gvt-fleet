import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_KEY = 'gvt-dev@gvt-plugins';
const GRAMMAR_RELATIVE = 'skills/triage-issues/scripts/lib/refs-grammar.mjs';
const MANIFEST_RELATIVE = '.claude-plugin/plugin.json';

// The first gvt-dev release that ships the grammar. Its git blob is the same
// at v4.45.0 and v5.1.0 (ADR 0020). Raise it when the coordinator starts to
// rely on a newer grammar.
export const GVT_DEV_MIN_VERSION = '4.45.0';

const NEED = `this command needs the gvt-dev plugin, version ${GVT_DEV_MIN_VERSION} or later, for the issue-reference grammar`;
const HINT = `install or update ${PLUGIN_KEY} with /plugin, or set GVT_DEV_ROOT to a gvt-dev plugin folder`;

/** A missing, unreadable or too old gvt-dev. The CLI prints its message without a stack. */
export class GvtDevError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GvtDevError';
  }
}

function defaults(opts = {}) {
  return {
    env: opts.env ?? process.env,
    homedir: opts.homedir ?? os.homedir(),
    readFile: opts.readFile ?? ((file) => fs.readFileSync(file, 'utf8')),
  };
}

// installed_plugins.json: { plugins: { "<name>@<marketplace>": [ { scope, installPath, ... } ] } }.
// A key can hold several installs. Prefer the "user" scope entry, else the first entry.
export function gvtDevRoot(opts = {}) {
  const { env, homedir, readFile } = defaults(opts);
  if (env.GVT_DEV_ROOT) return env.GVT_DEV_ROOT;
  const file = path.join(homedir, '.claude', 'plugins', 'installed_plugins.json');
  let parsed;
  try {
    parsed = JSON.parse(readFile(file));
  } catch (err) {
    throw new GvtDevError(`${NEED}: cannot read ${file} to locate ${PLUGIN_KEY} (${err.message}); ${HINT}`);
  }
  const installs = parsed && parsed.plugins && parsed.plugins[PLUGIN_KEY];
  const list = Array.isArray(installs) ? installs : installs ? [installs] : [];
  const pick = list.find((i) => i && i.scope === 'user' && i.installPath) ?? list.find((i) => i && i.installPath);
  if (!pick) throw new GvtDevError(`${NEED}: ${file} has no install of ${PLUGIN_KEY}; ${HINT}`);
  return pick.installPath;
}

function parseCore(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare the major.minor.patch core of two versions. A pre-release suffix is ignored.
 * @returns {number|null} negative, zero or positive; null when either is not x.y.z
 */
export function compareVersions(a, b) {
  const x = parseCore(a);
  const y = parseCore(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Locate gvt-dev and check its version against GVT_DEV_MIN_VERSION. The version comes
 * from the plugin's own manifest, so GVT_DEV_ROOT is checked the same way as an install.
 * @returns {{ root: string, version: string }}
 * @throws {GvtDevError}
 */
export function checkGvtDev(opts = {}) {
  const { readFile } = defaults(opts);
  const root = gvtDevRoot(opts);
  const manifest = path.join(root, ...MANIFEST_RELATIVE.split('/'));
  let version;
  try {
    version = JSON.parse(readFile(manifest)).version;
  } catch (err) {
    throw new GvtDevError(`${NEED}: cannot read the version from ${manifest} (${err.message}); ${HINT}`);
  }
  const cmp = compareVersions(version, GVT_DEV_MIN_VERSION);
  if (cmp === null) {
    throw new GvtDevError(`${NEED}: ${manifest} has no x.y.z version (found ${JSON.stringify(version ?? null)}); ${HINT}`);
  }
  if (cmp < 0) {
    throw new GvtDevError(`${NEED}: found gvt-dev ${version} at ${root}; ${HINT}`);
  }
  return { root, version };
}

export function refsGrammarPath(opts = {}) {
  return path.join(gvtDevRoot(opts), ...GRAMMAR_RELATIVE.split('/'));
}

// The grammar lives in the installed plugin and is imported, never copied.
// Relative path: skills/triage-issues/scripts/lib/refs-grammar.mjs
export async function loadRefsGrammar(opts = {}) {
  const { root, version } = checkGvtDev(opts);
  const file = path.join(root, ...GRAMMAR_RELATIVE.split('/'));
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new GvtDevError(`${NEED}: cannot load the grammar of gvt-dev ${version} from ${file} (${err.message}); ${HINT}`);
  }
  if (typeof mod.extract !== 'function') {
    throw new GvtDevError(`${NEED}: the grammar of gvt-dev ${version} at ${file} has no extract function; ${HINT}`);
  }
  return mod;
}
