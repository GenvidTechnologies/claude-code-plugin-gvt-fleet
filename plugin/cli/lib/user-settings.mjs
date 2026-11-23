// Plans the edit to the user's Claude settings for `install-hooks`.
// planSettings is pure so that refusal and idempotence can be tested without
// a settings file. applySettings below does the backup, the write and the read-back.
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write.mjs';
import { findLossyJson } from './json-scan.mjs';
import { isSafeCmdArg, resolveExe as realResolveExe } from './proc.mjs';
import { LEGACY } from './legacy-names.mjs';
import { LAUNCHER_NAME } from './plugin-install.mjs';

const EVENTS = ['SessionStart', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'PreToolUse'];
// An event listed here runs our entry only for the tool named by the group's matcher.
const MATCHERS = { PreToolUse: 'AskUserQuestion' };
const CHAIN = ' --chain ';
const SHELL_OPERATORS = ['|', '&', ';', '<', '>', '`', '$(', '\n', '\r'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A command is ours only when it has the exact shape planSettings writes: the
// helper script under <scripts>/bin (or, for the status line, the plugin
// launcher) and a workspace after --workspace. The script folder and the
// workspace may differ: the CLI that writes the entry need not sit in the
// workspace (ADR 0021). An entry that points at an old workspace still matches.
// The optional --state-dir group is the form a later install writes.
// Accepted edge case: a user status line that wraps our helper after another
// command (other --chain node ".../gvt-fleet-statusline.mjs" ...) is not ours.
// Helper script names: index 0 is written; the rest are only recognised.
const HOOK_SCRIPT = 'gvt-fleet-hook.mjs';
const STATUS_SCRIPT = 'gvt-fleet-statusline.mjs';
const HOOK_NAMES = [HOOK_SCRIPT, LEGACY.hookScript];
const STATUS_NAMES = [STATUS_SCRIPT, LEGACY.statusScript];
const nameAlt = (names) => names.map((n) => n.replace(/[.]/g, '\\.')).join('|');
const OURS_HOOK = new RegExp(
  `^node "[^"]+/bin/(?:${nameAlt(HOOK_NAMES)})" --workspace "[^"]+"(?: --state-dir "[^"]+")?$`,
);
const OURS_STATUS = new RegExp(
  `^node "(?:[^"]+/bin/(?:${nameAlt(STATUS_NAMES)})|[^"]+/${nameAlt([LAUNCHER_NAME])})" --workspace "[^"]+"(?: --state-dir "[^"]+")?(?: --chain .+)?$`,
);
const isOurs = (command, kind) =>
  typeof command === 'string' && (kind === 'hook' ? OURS_HOOK : OURS_STATUS).test(command);

const usesLegacyName = (command, legacyScript) => command.includes(`/bin/${legacyScript}"`);

// The user's own status-line command: the innermost command after the --chain
// of our helper, or null when our helper chains nothing. A command that is not
// ours is its own tail. Each step cuts the string, so the loop ends.
function userTail(command) {
  let cmd = command;
  while (isOurs(cmd, 'statusline')) {
    const at = cmd.indexOf(CHAIN);
    if (at < 0) return null;
    cmd = cmd.slice(at + CHAIN.length);
  }
  return cmd;
}

// True when the group runs our entry for the event: always, unless the event has a matcher.
const inPlace = (event, group) => !Object.hasOwn(MATCHERS, event) || group.matcher === MATCHERS[event];

// True when an entry of ours comes before position (gi, ei) in the event's groups.
// For an event with a matcher, only a group with that matcher counts.
function earlierOurs(event, groups, gi, ei) {
  for (let g = 0; g <= gi; g += 1) {
    const group = groups[g];
    if (!isPlainObject(group) || !Array.isArray(group.hooks) || !inPlace(event, group)) continue;
    const end = g === gi ? ei : group.hooks.length;
    for (let e = 0; e < end; e += 1) {
      if (isPlainObject(group.hooks[e]) && isOurs(group.hooks[e].command, 'hook')) return true;
    }
  }
  return false;
}

function normaliseWorkspace(workspace) {
  let w = path.win32.normalize(String(workspace)).replaceAll('\\', '/');
  w = w.replace(/\/+$/, '');
  return w.replace(/^[a-z]:/, (d) => d.toUpperCase());
}

// Splits a command line into words with bash rules. Each word keeps its raw
// text as written and its unquoted value.
function splitWords(text) {
  const words = [];
  let raw = '';
  let value = '';
  let active = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      raw += c;
      if (c === "'") quote = null;
      else value += c;
    } else if (quote === '"') {
      raw += c;
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length) {
        i += 1;
        raw += text[i];
        value += text[i];
      } else value += c;
    } else if (/\s/.test(c)) {
      if (active) words.push({ raw, value });
      raw = '';
      value = '';
      active = false;
    } else {
      active = true;
      raw += c;
      if (c === "'" || c === '"') quote = c;
      else if (c === '\\' && i + 1 < text.length) {
        i += 1;
        raw += text[i];
        value += text[i];
      } else value += c;
    }
  }
  if (active) words.push({ raw, value });
  return words;
}

// Returns a refusal text when the command starts a batch file and an argument
// is not shell-neutral as written, else undefined. The helper refuses such an
// argument, or a batch-file path with a quote or percent sign, at render time
// and the status line would go blank.
function batchArgRefusal(command, resolveExe) {
  const words = splitWords(command);
  if (words.length < 1) return undefined;
  const exe = resolveExe(words[0].value);
  if (typeof exe !== 'string' || !/\.(cmd|bat)$/i.test(exe)) return undefined;
  if (/["%]/.test(exe)) {
    return `statusLine command starts a batch file (${exe}) whose path has a quote or percent sign, which the status-line helper does not run`;
  }
  for (const w of words.slice(1)) {
    const quoted = /^(['"])(.*)\1$/s.exec(w.raw);
    const inner = quoted !== null && !quoted[2].includes(quoted[1]) ? quoted[2] : undefined;
    if (isSafeCmdArg(w.raw) || (inner !== undefined && isSafeCmdArg(inner))) continue;
    return `statusLine command starts a batch file (${exe}) and its argument ${w.raw} has a character the status-line helper does not pass to a batch file`;
  }
  return undefined;
}

function ourGroup(event, command) {
  const entry = { type: 'command', command };
  if (event !== 'SessionEnd') entry.timeout = 10;
  return Object.hasOwn(MATCHERS, event) ? { matcher: MATCHERS[event], hooks: [entry] } : { hooks: [entry] };
}

/**
 * The plugin's hooks/hooks.json for the hook command `command`: one group per event of the table
 * above, with the same matcher and timeout as a user-settings entry. The file is committed
 * as plugin/hooks/hooks.json, and the R216 tests check that it equals this output (ADR 0023).
 */
export function pluginHooksJson(command) {
  const hooks = {};
  for (const event of EVENTS) hooks[event] = [ourGroup(event, command)];
  return { hooks };
}

/**
 * Plans the settings edit. `scripts` is the folder of the CLI whose bin/ holds the hook and
 * status-line scripts (default: the workspace). `launcher`, when given, is plugin mode (ADR 0021):
 * the plugin runs the hooks, so our hook entries are removed, and the status line runs the launcher.
 */
export function planSettings(settings, { workspace, stateDir, resolveExe, scripts, launcher }) {
  if (settings !== undefined && !isPlainObject(settings)) {
    return { refused: 'settings is not a JSON object' };
  }
  const W = normaliseWorkspace(workspace);
  const B = scripts === undefined ? W : normaliseWorkspace(scripts);
  const L = launcher === undefined ? undefined : normaliseWorkspace(launcher);
  // The state folder is passed on only when it is not the default <workspace>/state.
  let stateFlag = '';
  if (stateDir !== undefined) {
    const S = normaliseWorkspace(stateDir);
    if (S.toLowerCase() !== `${W}/state`.toLowerCase()) stateFlag = ` --state-dir "${S}"`;
  }
  const hookCommand = `node "${B}/bin/${HOOK_SCRIPT}" --workspace "${W}"${stateFlag}`;
  const statusBase = L === undefined
    ? `node "${B}/bin/${STATUS_SCRIPT}" --workspace "${W}"${stateFlag}`
    : `node "${L}" --workspace "${W}"${stateFlag}`;

  const next = structuredClone(settings ?? {});
  const changes = [];
  let hadOurs = false;

  if (Object.hasOwn(next, 'hooks') && !isPlainObject(next.hooks)) {
    return { refused: 'hooks is not an object' };
  }
  for (const event of EVENTS) {
    if (isPlainObject(next.hooks) && Object.hasOwn(next.hooks, event) && !Array.isArray(next.hooks[event])) {
      return { refused: `hooks.${event} is not an array` };
    }
  }

  if (Object.hasOwn(next, 'statusLine')) {
    const sl = next.statusLine;
    if (!isPlainObject(sl) || sl.type !== 'command' || typeof sl.command !== 'string') {
      return { refused: 'statusLine is not a command status line' };
    }
    let chained = null;
    if (!isOurs(sl.command, 'statusline')) {
      const op = SHELL_OPERATORS.find((o) => sl.command.includes(o));
      if (op !== undefined) {
        return { refused: `statusLine command contains a shell operator (${JSON.stringify(op)})` };
      }
      chained = sl.command;
    } else {
      chained = userTail(sl.command);
    }
    if (chained !== null && typeof resolveExe === 'function') {
      const refused = batchArgRefusal(chained, resolveExe);
      if (refused !== undefined) return { refused };
    }
  }

  for (const event of EVENTS) {
    const groups = next.hooks?.[event];
    let found = false;
    let misplaced = 0;
    let dropped = 0;
    for (let gi = (groups ?? []).length - 1; gi >= 0; gi -= 1) {
      const group = groups[gi];
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      // Walk from the end so that the first entry of ours is the one kept
      // and a removal does not shift the entries still to visit.
      let emptied = false;
      for (let ei = group.hooks.length - 1; ei >= 0; ei -= 1) {
        const entry = group.hooks[ei];
        if (!isPlainObject(entry) || !isOurs(entry.command, 'hook')) continue;
        hadOurs = true;
        if (L !== undefined) {
          // Plugin mode: the plugin's hooks.json runs the hook; a user entry would record twice.
          group.hooks.splice(ei, 1);
          if (group.hooks.length === 0) emptied = true;
          dropped += 1;
          continue;
        }
        if (!inPlace(event, group)) {
          // Our entry under another matcher (or none) would run for the wrong tools.
          group.hooks.splice(ei, 1);
          if (group.hooks.length === 0) emptied = true;
          misplaced += 1;
          continue;
        }
        if (earlierOurs(event, groups, gi, ei)) {
          group.hooks.splice(ei, 1);
          if (group.hooks.length === 0) emptied = true;
          changes.push(`hooks.${event}: remove a duplicate of our entry`);
          continue;
        }
        found = true;
        if (entry.command !== hookCommand) {
          const renamed = usesLegacyName(entry.command, LEGACY.hookScript);
          entry.command = hookCommand;
          changes.push(
            renamed
              ? `hooks.${event}: rename our entry from ${LEGACY.hookScript} to ${HOOK_SCRIPT}`
              : `hooks.${event}: update our entry to workspace ${W}`,
          );
        }
      }
      if (emptied) groups.splice(gi, 1);
    }
    if (L !== undefined) {
      if (dropped > 0) {
        changes.push(`hooks.${event}: remove our entry (the gvt-fleet plugin runs the hook)`);
        if (groups.length === 0) delete next.hooks[event];
      }
      continue;
    }
    if (!found) {
      if (!isPlainObject(next.hooks)) next.hooks = {};
      if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
      next.hooks[event].push(ourGroup(event, hookCommand));
      changes.push(
        misplaced > 0
          ? `hooks.${event}: move our entry to matcher ${MATCHERS[event]}`
          : `hooks.${event}: add our entry`,
      );
    } else if (misplaced > 0) {
      changes.push(`hooks.${event}: remove our entry from a group with another matcher`);
    }
  }

  if (!Object.hasOwn(next, 'statusLine')) {
    next.statusLine = { type: 'command', command: statusBase };
    changes.push('statusLine: set ours');
  } else if (!isOurs(next.statusLine.command, 'statusline')) {
    next.statusLine.command = `${statusBase}${CHAIN}${next.statusLine.command}`;
    changes.push('statusLine: chain the existing command');
  } else {
    hadOurs = true;
    const cmd = next.statusLine.command;
    const tail = userTail(cmd);
    const wanted = statusBase + (tail !== null ? CHAIN + tail : '');
    if (cmd !== wanted) {
      const at = cmd.indexOf(CHAIN);
      const nested = at >= 0 && isOurs(cmd.slice(at + CHAIN.length), 'statusline');
      next.statusLine.command = wanted;
      const wasLauncher = cmd.startsWith('node "') && cmd.split('"')[1].endsWith(`/${LAUNCHER_NAME}`);
      if (nested) changes.push('statusLine: unwrap a nested status-line helper');
      else if (L !== undefined && !wasLauncher) changes.push(`statusLine: run our command through the plugin launcher ${L}`);
      else if (L === undefined && wasLauncher) changes.push(`statusLine: run our command from ${B}/bin, not the plugin launcher`);
      else if (usesLegacyName(cmd, LEGACY.statusScript)) {
        changes.push(`statusLine: rename our command from ${LEGACY.statusScript} to ${STATUS_SCRIPT}`);
      } else changes.push(`statusLine: update our command to workspace ${W}`);
    }
  }

  return { changes, next, hadOurs };
}

function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { settings: undefined };
    return { settings: null, error: `cannot read ${file}: ${e.message}` };
  }
  if (text.charCodeAt(0) === 0xFEFF) {
    return { settings: null, error: `${file} starts with a UTF-8 byte order mark (BOM); save it as UTF-8 without a BOM` };
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    return { settings: null, error: `invalid JSON in ${file}: ${e.message}` };
  }
  const lossy = findLossyJson(text);
  if (lossy?.kind === 'duplicate-key') {
    return { settings: null, error: `${file} has a duplicate key ${JSON.stringify(lossy.token)} (line ${lossy.line}); a rewrite would keep only the last value` };
  }
  if (lossy?.kind === 'number') {
    return { settings: null, error: `${file} has the number ${lossy.token} (line ${lossy.line}), a number that would change when rewritten` };
  }
  return { settings };
}

/**
 * Apply planSettings to the settings file. The original bytes are copied to
 * <stateDir>/settings.json.bak once; a later run never replaces that backup.
 * A missing file leaves <stateDir>/settings.json.absent instead. A file that
 * already holds our entries gets neither record (the copy would hold our hooks).
 * Returns {status: 'written'|'noop'|'dry-run'|'refused'|'failed', changes, reason?}.
 */
export async function applySettings(settingsPath, opts) {
  const { workspace, stateDir, scripts, launcher, dryRun = false, sleep, waitMs = 3000, attempts = 3 } = opts;
  // In plugin mode, `launcher` is { path, source }: the file is written before the settings that name it.
  const launcherStale = () => {
    if (launcher === undefined) return false;
    try {
      return fs.readFileSync(launcher.path, 'utf8') !== launcher.source;
    } catch {
      return true;
    }
  };
  const lookup = opts.resolveExe ?? realResolveExe;
  const resolveExe = (name) => {
    try {
      return lookup(name);
    } catch {
      return null;
    }
  };
  const plan = () => {
    const { settings, error } = readSettings(settingsPath);
    const p = planSettings(settings, { workspace, stateDir, resolveExe, scripts, launcher: launcher?.path });
    if (p.refused !== undefined && error !== undefined) p.refused = error;
    if (p.refused === undefined && launcherStale()) p.changes.unshift(`launcher: write ${launcher.path}`);
    return p;
  };
  let first = plan();
  if (first.refused !== undefined) return { status: 'refused', changes: [], reason: first.refused };
  if (first.changes.length === 0) return { status: 'noop', changes: [] };
  const changes = first.changes;
  if (dryRun) return { status: 'dry-run', changes };

  try {
    const backup = path.join(stateDir, 'settings.json.bak');
    const absent = path.join(stateDir, 'settings.json.absent');
    if (!fs.existsSync(backup) && !fs.existsSync(absent)) {
      // lstat, not exists: a dangling symlink is not a missing file.
      let missing = false;
      try {
        fs.lstatSync(settingsPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        missing = true;
      }
      if (missing) {
        writeTextAtomic(absent, `${settingsPath} did not exist at ${new Date().toISOString()}\n`);
      } else if (!first.hadOurs) {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.copyFileSync(settingsPath, backup);
      } else {
        changes.push('backup: none taken, the file already holds our entries');
      }
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        first = plan();
        if (first.refused !== undefined) return { status: 'failed', changes, reason: first.refused };
        if (first.changes.length === 0) return { status: 'written', changes };
      }
      if (launcherStale()) writeTextAtomic(launcher.path, launcher.source);
      writeTextAtomic(settingsPath, JSON.stringify(first.next, null, 2) + '\n');
      await sleep(waitMs);
      const again = plan();
      if (again.refused === undefined && again.changes.length === 0) return { status: 'written', changes };
    }
  } catch (e) {
    return { status: 'failed', changes, reason: e instanceof Error ? e.message : String(e) };
  }
  return { status: 'failed', changes, reason: `the changes were missing after ${attempts} attempts` };
}
