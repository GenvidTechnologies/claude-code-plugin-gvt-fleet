// Finds the installed gvt-fleet plugin and builds the status-line launcher that install-hooks
// writes in plugin mode (ADR 0021).
import fs from 'node:fs';
import path from 'node:path';

export const FLEET_PLUGIN_KEY = 'gvt-fleet@gvt-plugins';
// The plugin folder that holds the copy of bin/ and lib/ (not the plugin's top-level bin/).
export const CLI_FOLDER = 'cli';
export const LAUNCHER_NAME = 'gvt-fleet-statusline-launcher.mjs';

const installedPluginsFile = (home) => path.join(home, '.claude', 'plugins', 'installed_plugins.json');

/**
 * The install folder of gvt-fleet@gvt-plugins: the "user" install, else the first one listed.
 * Null when installed_plugins.json cannot be read or lists no install.
 */
export function fleetPluginRoot({ home, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(installedPluginsFile(home)));
  } catch {
    return null;
  }
  const installs = parsed?.plugins?.[FLEET_PLUGIN_KEY];
  const list = Array.isArray(installs) ? installs : installs ? [installs] : [];
  const pick = list.find((i) => i?.scope === 'user' && typeof i.installPath === 'string')
    ?? list.find((i) => typeof i?.installPath === 'string');
  return pick ? pick.installPath : null;
}

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/**
 * Plugin mode: the installed plugin ships its copy of the CLI and its own hooks.json. Returns
 * { root, dataDir, launcher } or null. The data folder is CLAUDE_PLUGIN_DATA when set, else
 * <home>/.claude/plugins/data/gvt-fleet-gvt-plugins, the folder Claude Code gives the plugin.
 */
export function detectPluginMode({ home, env = {}, readFile } = {}) {
  const root = fleetPluginRoot({ home, ...(readFile ? { readFile } : {}) });
  if (root === null) return null;
  if (!isFile(path.join(root, CLI_FOLDER, 'bin', 'gvt-fleet-hook.mjs'))) return null;
  if (!isFile(path.join(root, 'hooks', 'hooks.json'))) return null;
  const dataDir = env.CLAUDE_PLUGIN_DATA
    ? path.resolve(env.CLAUDE_PLUGIN_DATA)
    : path.join(home, '.claude', 'plugins', 'data', FLEET_PLUGIN_KEY.replace('@', '-'));
  return { root, dataDir, launcher: path.join(dataDir, LAUNCHER_NAME) };
}

/**
 * The launcher's source. On each status-line render it finds the current install folder of the
 * plugin and runs that copy's status-line helper with the same arguments, by import, not a second
 * node process. With no copy, it runs the command after --chain itself, so the status line shows.
 * Node built-ins only: it must run whatever the plugin's state.
 */
export const LAUNCHER_SOURCE = [
  '// Written by gvt-fleet install-hooks; the next run replaces it. Do not edit.',
  '// Runs the status-line helper of the installed gvt-fleet plugin, found anew on each run, so a',
  '// plugin update does not move the status line. With no plugin copy it runs the chained command.',
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { spawn } from 'node:child_process';",
  "import { pathToFileURL } from 'node:url';",
  '',
  `const KEY = '${FLEET_PLUGIN_KEY}';`,
  '',
  'function pluginRoot() {',
  '  try {',
  "    const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');",
  "    const installs = JSON.parse(fs.readFileSync(file, 'utf8'))?.plugins?.[KEY];",
  '    const list = Array.isArray(installs) ? installs : installs ? [installs] : [];',
  "    const pick = list.find((i) => i?.scope === 'user' && typeof i.installPath === 'string')",
  "      ?? list.find((i) => typeof i?.installPath === 'string');",
  '    return pick ? pick.installPath : null;',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
  '',
  'const root = pluginRoot();',
  `const script = root === null ? null : path.join(root, '${CLI_FOLDER}', 'bin', 'gvt-fleet-statusline.mjs');`,
  'if (script !== null && fs.existsSync(script)) {',
  '  await import(pathToFileURL(script).href);',
  '} else {',
  '  const argv = process.argv.slice(2);',
  "  const at = argv.indexOf('--chain');",
  '  const chain = at >= 0 ? argv.slice(at + 1) : [];',
  '  if (chain.length === 0) process.exit(0);',
  "  const child = spawn(chain[0], chain.slice(1), { stdio: 'inherit', windowsHide: true });",
  "  child.on('error', () => process.exit(0));",
  "  child.on('exit', (code) => process.exit(code ?? 0));",
  '}',
  '',
].join('\n');
