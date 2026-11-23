process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSettings } from '../plugin/cli/lib/user-settings.mjs';
import { installHooksCommand } from '../plugin/cli/lib/commands.mjs';
import {
  LAUNCHER_NAME,
  LAUNCHER_SOURCE,
  detectPluginMode,
  fleetPluginRoot,
} from '../plugin/cli/lib/plugin-install.mjs';
import { runScript } from './helpers/run-script.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', 'plugin', 'cli');
const fake = path.join(here, 'fixtures', 'fake-statusline.mjs');
const fixture = () => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'user-settings.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-plugin-'));
const fwd = (p) => p.split(path.sep).join('/');

const W = 'C:/work/fleet';
const B = 'C:/tools/gvt-fleet';
const L = `C:/home/someone/.claude/plugins/data/gvt-fleet-gvt-plugins/${LAUNCHER_NAME}`;
const EVENTS = ['SessionStart', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'PreToolUse'];
const isOursHook = (c) => /\/bin\/gvt-(fleet|loop)-hook\.mjs" --workspace /.test(c);
const ourHookCommands = (settings) =>
  EVENTS.flatMap((ev) => (settings.hooks?.[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command))).filter(isOursHook);

/** A fake home whose installed_plugins.json names a gvt-fleet install with the given files. */
function fakeHome({ cli = true, hooksJson = true, copyCode = false, scope = 'user' } = {}) {
  const home = tmp();
  const root = path.join(home, '.claude', 'plugins', 'cache', 'gvt-plugins', 'gvt-fleet', '0.5.0');
  fs.mkdirSync(root, { recursive: true });
  if (copyCode) {
    fs.cpSync(path.join(ROOT, 'bin'), path.join(root, 'cli', 'bin'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'cli', 'lib'), { recursive: true });
  } else if (cli) {
    fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli', 'bin', 'gvt-fleet-hook.mjs'), '');
  }
  if (hooksJson) {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  }
  const installs = [
    { scope: 'project', projectPath: 'C:/elsewhere', installPath: path.join(home, 'no-such-install'), version: '0.4.0' },
    { scope, installPath: root, version: '0.5.0' },
  ];
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'gvt-fleet@gvt-plugins': installs, 'gvt-dev@gvt-plugins': [] } }),
  );
  return { home, root };
}

function sandbox({ home, env = {}, settings = fixture() }) {
  const root = tmp();
  const settingsPath = path.join(root, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const outs = [];
  const errs = [];
  const ctx = {
    repoRoot: W, cliRoot: B, stateDir: path.join(root, 'state'), json: false,
    log: { append() {} },
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    paths: { claudeSettings: settingsPath, workspace: W, home },
    env,
    clock: { now: () => new Date(), sleep: async () => {} },
  };
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { ctx, outs, errs, read };
}

test('R209: outside plugin mode, the entries name the scripts of the CLI folder and the workspace after --workspace', () => {
  const plan = planSettings(fixture(), { workspace: W, scripts: B });
  for (const ev of EVENTS) {
    const groups = plan.next.hooks[ev];
    assert.equal(groups[groups.length - 1].hooks[0].command, `node "${B}/bin/gvt-fleet-hook.mjs" --workspace "${W}"`, ev);
  }
  assert.match(plan.next.statusLine.command, new RegExp(`^node "${B}/bin/gvt-fleet-statusline\\.mjs" --workspace "${W}" --chain `));
  const again = planSettings(plan.next, { workspace: W, scripts: B });
  assert.deepEqual(again.changes, []);
});

test('R209: an entry whose script folder differs from the workspace counts as ours and is updated in place', () => {
  const first = planSettings(fixture(), { workspace: W, scripts: B });
  const moved = planSettings(first.next, { workspace: W, scripts: 'D:/other/cli' });
  for (const ev of EVENTS) assert.equal(moved.next.hooks[ev].length, first.next.hooks[ev].length, ev);
  assert.equal(ourHookCommands(moved.next).length, EVENTS.length);
  assert.ok(ourHookCommands(moved.next).every((c) => c.startsWith('node "D:/other/cli/bin/')));
});

test('R209: plugin mode removes every hook entry of ours, keeps the user hooks, and points the status line at the launcher', () => {
  const input = fixture();
  const installed = planSettings(input, { workspace: W, scripts: B }).next;
  assert.equal(ourHookCommands(installed).length, EVENTS.length);
  const plan = planSettings(installed, { workspace: W, scripts: B, launcher: L });
  assert.equal(plan.refused, undefined);
  assert.deepEqual(ourHookCommands(plan.next), []);
  // Every user hook of the fixture is still there, in order.
  for (const ev of Object.keys(input.hooks)) assert.deepEqual(plan.next.hooks[ev] ?? [], input.hooks[ev], ev);
  assert.equal(plan.next.statusLine.command, `node "${L}" --workspace "${W}" --chain ${input.statusLine.command}`);
  for (const ev of EVENTS) {
    const removed = plan.changes.includes(`hooks.${ev}: remove our entry (the gvt-fleet plugin runs the hook)`);
    assert.ok(removed, ev);
  }
  assert.ok(plan.changes.some((c) => c.startsWith('statusLine: run our command through the plugin launcher')));
  const again = planSettings(plan.next, { workspace: W, scripts: B, launcher: L });
  assert.deepEqual(again.changes, []);
});

test('R209: plugin mode on a file with no entries of ours adds no hook entry and chains the status line through the launcher', () => {
  const input = fixture();
  const plan = planSettings(input, { workspace: W, launcher: L });
  assert.deepEqual(ourHookCommands(plan.next), []);
  for (const ev of Object.keys(input.hooks)) assert.deepEqual(plan.next.hooks[ev], input.hooks[ev], ev);
  assert.equal(plan.next.statusLine.command, `node "${L}" --workspace "${W}" --chain ${input.statusLine.command}`);
});

test('R209: an event whose only group held our entry loses the key in plugin mode', () => {
  const installed = planSettings({}, { workspace: W, scripts: B }).next;
  const plan = planSettings(installed, { workspace: W, scripts: B, launcher: L });
  assert.deepEqual(plan.next.hooks, {});
  assert.equal(plan.next.statusLine.command, `node "${L}" --workspace "${W}"`);
});

test('R209: going back from plugin mode to an install with no cli/ writes the hook entries again', () => {
  const input = fixture();
  const pluginMode = planSettings(planSettings(input, { workspace: W, scripts: B }).next, { workspace: W, scripts: B, launcher: L }).next;
  const back = planSettings(pluginMode, { workspace: W, scripts: B });
  assert.equal(ourHookCommands(back.next).length, EVENTS.length);
  assert.equal(back.next.statusLine.command, `node "${B}/bin/gvt-fleet-statusline.mjs" --workspace "${W}" --chain ${input.statusLine.command}`);
  assert.ok(back.changes.includes(`statusLine: run our command from ${B}/bin, not the plugin launcher`));
});

test('R209: plugin mode needs an install with both cli/bin/gvt-fleet-hook.mjs and hooks/hooks.json', () => {
  assert.equal(detectPluginMode({ home: tmp() }), null);
  assert.equal(detectPluginMode({ home: fakeHome({ cli: false }).home }), null);
  assert.equal(detectPluginMode({ home: fakeHome({ hooksJson: false }).home }), null);
  const { home, root } = fakeHome();
  const mode = detectPluginMode({ home });
  assert.equal(mode.root, root);
  assert.equal(mode.launcher, path.join(home, '.claude', 'plugins', 'data', 'gvt-fleet-gvt-plugins', LAUNCHER_NAME));
  const data = path.join(tmp(), 'data');
  assert.equal(detectPluginMode({ home, env: { CLAUDE_PLUGIN_DATA: data } }).launcher, path.join(data, LAUNCHER_NAME));
});

test('R209: the plugin root is the user install, else the first install listed', () => {
  const user = fakeHome();
  assert.equal(fleetPluginRoot({ home: user.home }), user.root);
  const project = fakeHome({ scope: 'project' });
  assert.equal(fleetPluginRoot({ home: project.home }), path.join(project.home, 'no-such-install'));
});

test('R209: install-hooks in plugin mode writes the launcher, removes our hook entries, and a second run prints noop', async () => {
  const { home } = fakeHome();
  const installed = planSettings(fixture(), { workspace: W, scripts: B }).next;
  const s = sandbox({ home, settings: installed });
  const code = await installHooksCommand(s.ctx, []);
  assert.equal(code, 0, s.errs.join('\n'));
  const launcher = path.join(home, '.claude', 'plugins', 'data', 'gvt-fleet-gvt-plugins', LAUNCHER_NAME);
  assert.equal(fs.readFileSync(launcher, 'utf8'), LAUNCHER_SOURCE);
  assert.ok(s.outs.includes(`launcher: write ${launcher}`));
  const after = s.read();
  assert.deepEqual(ourHookCommands(after), []);
  // The sandbox state folder is not <W>/state, so --state-dir comes between the workspace and the chain.
  assert.ok(after.statusLine.command.startsWith(`node "${fwd(launcher)}" --workspace "${W}" --state-dir "`), after.statusLine.command);
  assert.ok(after.statusLine.command.includes(' --chain '));
  s.outs.length = 0;
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.deepEqual(s.outs, [`${s.ctx.paths.claudeSettings}: noop`]);
});

test('R209: install-hooks rewrites a launcher that differs from the current source', async () => {
  const { home } = fakeHome();
  const s = sandbox({ home });
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const launcher = path.join(home, '.claude', 'plugins', 'data', 'gvt-fleet-gvt-plugins', LAUNCHER_NAME);
  fs.writeFileSync(launcher, '// an older launcher\n');
  s.outs.length = 0;
  assert.equal(await installHooksCommand(s.ctx, ['--dry-run']), 0);
  assert.ok(s.outs.includes(`launcher: write ${launcher}`));
  assert.equal(fs.readFileSync(launcher, 'utf8'), '// an older launcher\n');
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(fs.readFileSync(launcher, 'utf8'), LAUNCHER_SOURCE);
});

test('R209: install-hooks without a plugin copy writes the entries with the CLI folder', async () => {
  const s = sandbox({ home: fakeHome({ cli: false }).home });
  assert.equal(await installHooksCommand(s.ctx, []), 0, s.errs.join('\n'));
  const after = s.read();
  assert.equal(ourHookCommands(after).length, EVENTS.length);
  const state = fwd(s.ctx.stateDir);
  assert.ok(ourHookCommands(after).every((c) => c === `node "${B}/bin/gvt-fleet-hook.mjs" --workspace "${W}" --state-dir "${state}"`));
});

// ---- the launcher (R210) ----

/** Writes the launcher into a data folder of `home` and runs it like the status line does. */
function runLauncher(home, args, input) {
  const dir = path.join(home, '.claude', 'plugins', 'data', 'gvt-fleet-gvt-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, LAUNCHER_NAME);
  fs.writeFileSync(launcher, LAUNCHER_SOURCE);
  return runScript(launcher, args, { input, env: { USERPROFILE: home, HOME: home } });
}

const payload = () => JSON.stringify({
  session_id: 'sess-1',
  cwd: 'C:/work/fleet',
  rate_limits: { five_hour: { used_percentage: 34, resets_at: 1893456000 }, seven_day: { used_percentage: 12, resets_at: 1893888000 } },
});

test('R210: the launcher runs the plugin copy of the status-line helper: same output and exit code, and the limits are recorded', async () => {
  const { home } = fakeHome({ copyCode: true });
  const ws = tmp();
  const input = payload();
  const direct = await runScript(fake, ['3'], { input });
  const r = await runLauncher(home, ['--workspace', ws, '--chain', process.execPath, fake, '3'], input);
  assert.equal(r.code, 3, r.stderr.toString());
  assert.ok(direct.stdout.length > 0);
  assert.ok(r.stdout.equals(direct.stdout));
  const snap = JSON.parse(fs.readFileSync(path.join(ws, 'state', 'rate-limits.json'), 'utf8'));
  assert.equal(snap.five_hour.used_percentage, 34);
});

test('R210: with no plugin copy the launcher still runs the chained command, with its output and exit code', async () => {
  const home = tmp();
  const ws = tmp();
  const input = payload();
  const direct = await runScript(fake, ['3'], { input });
  const r = await runLauncher(home, ['--workspace', ws, '--chain', process.execPath, fake, '3'], input);
  assert.equal(r.code, 3, r.stderr.toString());
  assert.ok(r.stdout.equals(direct.stdout));
  assert.equal(fs.existsSync(path.join(ws, 'state')), false);
});

test('R210: with no plugin copy and nothing chained the launcher prints nothing and exits 0', async () => {
  const r = await runLauncher(tmp(), ['--workspace', tmp()], payload());
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 0);
});
