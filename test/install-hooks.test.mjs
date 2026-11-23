process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planSettings } from '../plugin/cli/lib/user-settings.mjs';
import { installHooksCommand } from '../plugin/cli/lib/commands.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(path.join(here, 'fixtures', 'user-settings.json'), 'utf8'));
const W = 'C:/work/fleet';
const EVENTS = ['SessionStart', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'PreToolUse'];
// The five events that an install made before the PreToolUse entry wrote.
const OLD_EVENTS = EVENTS.slice(0, 5);
const hookCmd = (w) => `node "${w}/bin/gvt-fleet-hook.mjs" --workspace "${w}"`;
const statusCmd = (w) => `node "${w}/bin/gvt-fleet-statusline.mjs" --workspace "${w}"`;
const ourGroup = (event, w = W, flag = '') => ({
  ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}),
  hooks: [{ type: 'command', command: hookCmd(w) + flag, ...(event === 'SessionEnd' ? {} : { timeout: 10 }) }],
});

test('R39: planSettings chains an existing statusLine command verbatim after --chain', () => {
  const input = fixture();
  const plan = planSettings(input, { workspace: W });
  assert.equal(plan.refused, undefined);
  assert.equal(plan.next.statusLine.command, `${statusCmd(W)} --chain ${input.statusLine.command}`);
  assert.equal(plan.next.statusLine.type, 'command');
  assert.ok(plan.changes.length > 0);
});

test('R39: planSettings keeps other top-level keys and their order, and adds each of the six events once', () => {
  const input = fixture();
  const { next } = planSettings(input, { workspace: W });
  assert.deepEqual(Object.keys(next), Object.keys(input));
  for (const k of ['env', 'defaultShell', 'enabledPlugins']) assert.deepEqual(next[k], input[k]);
  for (const ev of EVENTS) {
    const before = (input.hooks[ev] ?? []).length;
    const groups = next.hooks[ev];
    assert.equal(groups.length, before + 1, ev);
    assert.deepEqual(groups[groups.length - 1], ourGroup(ev), ev);
  }
  const end = next.hooks.SessionEnd[0].hooks[0];
  assert.equal(Object.hasOwn(end, 'timeout'), false);
  assert.equal(next.hooks.Stop[0].hooks[0].timeout, undefined);
  assert.equal(next.hooks.SessionStart[0].hooks[0].timeout, 10);
});

test('R39: planSettings is idempotent and keeps the --chain tail on the second run', () => {
  const input = fixture();
  const first = planSettings(input, { workspace: W });
  const second = planSettings(first.next, { workspace: W });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.next, first.next);
  assert.equal(second.next.statusLine.command, `${statusCmd(W)} --chain ${input.statusLine.command}`);
});

test('R39: planSettings updates our entries in place after a workspace move and keeps the chain tail', () => {
  const input = fixture();
  const first = planSettings(input, { workspace: W });
  const D = 'D:/elsewhere/loop';
  const moved = planSettings(first.next, { workspace: D });
  assert.ok(moved.changes.length > 0);
  for (const ev of EVENTS) {
    assert.equal(moved.next.hooks[ev].length, first.next.hooks[ev].length, ev);
    const idx = first.next.hooks[ev].length - 1;
    assert.equal(moved.next.hooks[ev][idx].hooks[0].command, hookCmd(D), ev);
  }
  assert.equal(moved.next.statusLine.command, `${statusCmd(D)} --chain ${input.statusLine.command}`);
  assert.deepEqual(moved.next.hooks.PreToolUse[0], input.hooks.PreToolUse[0]);
  assert.deepEqual(planSettings(moved.next, { workspace: D }).changes, []);
});

test('R39: planSettings normalises a backslash workspace with a lowercase drive letter', () => {
  const plan = planSettings({}, { workspace: 'c:\\work\\fleet\\' });
  assert.equal(plan.next.statusLine.command, statusCmd(W));
  assert.equal(plan.next.hooks.Stop[0].hooks[0].command, hookCmd(W));
});

test('R39: planSettings handles undefined, empty, and partly missing settings', () => {
  for (const input of [undefined, {}, { hooks: {} }, { statusLine: { type: 'command', command: 'x' } }]) {
    const plan = planSettings(input, { workspace: W });
    assert.equal(plan.refused, undefined);
    for (const ev of EVENTS) assert.deepEqual(plan.next.hooks[ev], [ourGroup(ev)], ev);
  }
  assert.equal(planSettings(undefined, { workspace: W }).next.statusLine.command, statusCmd(W));
  assert.equal(planSettings({}, { workspace: W }).next.statusLine.command, statusCmd(W));
  const keys = Object.keys(planSettings({ a: 1 }, { workspace: W }).next);
  assert.deepEqual(keys, ['a', 'hooks', 'statusLine']);
  const onlyStatus = planSettings({ statusLine: { type: 'command', command: 'x' }, b: 2 }, { workspace: W }).next;
  assert.deepEqual(Object.keys(onlyStatus), ['statusLine', 'b', 'hooks']);
});

test('R39: planSettings keeps other statusLine keys such as padding', () => {
  const input = { statusLine: { type: 'command', command: 'mytool --x', padding: 2 } };
  const { next } = planSettings(input, { workspace: W });
  assert.equal(next.statusLine.padding, 2);
  assert.equal(next.statusLine.command, `${statusCmd(W)} --chain mytool --x`);
});

test('R39: planSettings refuses a statusLine command with a shell operator, and plans once it is removed', () => {
  const bad = { statusLine: { type: 'command', command: 'a | b' } };
  const refused = planSettings(bad, { workspace: W });
  assert.equal(typeof refused.refused, 'string');
  assert.equal(refused.next, undefined);
  const ok = planSettings({ statusLine: { type: 'command', command: 'a b' } }, { workspace: W });
  assert.equal(ok.refused, undefined);
  assert.ok(ok.changes.length > 0);
  for (const op of ['&', ';', '<', '>', '`', '$(', '\n']) {
    const r = planSettings({ statusLine: { type: 'command', command: `a ${op} b` } }, { workspace: W });
    assert.equal(typeof r.refused, 'string', JSON.stringify(op));
  }
});

test('R39: planSettings refuses a non-command statusLine, a non-object input, and malformed hooks', () => {
  assert.equal(typeof planSettings({ statusLine: { type: 'static' } }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ statusLine: { type: 'command' } }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ statusLine: 'x' }, { workspace: W }).refused, 'string');
  for (const bad of [null, 'text', 5, [], [1]]) {
    assert.equal(typeof planSettings(bad, { workspace: W }).refused, 'string', JSON.stringify(bad));
  }
  assert.equal(typeof planSettings({ hooks: [] }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ hooks: 'x' }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ hooks: { Stop: {} } }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ hooks: { SessionEnd: 'x' } }, { workspace: W }).refused, 'string');
  assert.equal(typeof planSettings({ hooks: { PreToolUse: 'x' } }, { workspace: W }).refused, 'string');
  // An event we do not own may hold any shape.
  assert.equal(planSettings({ hooks: { PostToolUse: 'x' } }, { workspace: W }).refused, undefined);
});

test('R39: planSettings does not mutate its input', () => {
  const input = fixture();
  const before = structuredClone(input);
  planSettings(input, { workspace: W });
  assert.deepEqual(input, before);
  const planned = planSettings(input, { workspace: W }).next;
  const plannedBefore = structuredClone(planned);
  planSettings(planned, { workspace: 'D:/elsewhere/loop' });
  assert.deepEqual(planned, plannedBefore);
});

test('R40: planSettings appends after existing user hooks without reordering them', () => {
  const input = fixture();
  const { next } = planSettings(input, { workspace: W });
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.Stop[0], input.hooks.Stop[0]);
  assert.deepEqual(next.hooks.Stop[1], ourGroup('Stop'));
  assert.equal(next.hooks.PreToolUse.length, 2);
  assert.deepEqual(next.hooks.PreToolUse[0], input.hooks.PreToolUse[0]);
  assert.deepEqual(next.hooks.PreToolUse[1], ourGroup('PreToolUse'));
  assert.deepEqual(Object.keys(next.hooks).slice(0, 2), ['Stop', 'PreToolUse']);
});

test('R40: planSettings leaves other groups alone when it replaces our entry in place', () => {
  const input = fixture();
  const first = planSettings(input, { workspace: W }).next;
  // Put a user group after ours, then move the workspace.
  first.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-after' }] });
  const moved = planSettings(first, { workspace: 'D:/elsewhere/loop' }).next;
  assert.deepEqual(moved.hooks.Stop[0], input.hooks.Stop[0]);
  assert.equal(moved.hooks.Stop[1].hooks[0].command, hookCmd('D:/elsewhere/loop'));
  assert.equal(moved.hooks.Stop[1].hooks[0].timeout, 10);
  assert.deepEqual(moved.hooks.Stop[2], { hooks: [{ type: 'command', command: 'user-after' }] });
});

// ---- the install-hooks command, against a temp settings file ----

function makeSandbox(t, mutate) {
  const root = makeTempDir(t, 'gvt-fleet-hooks-');
  const settings = path.join(root, 'settings.json');
  const bytes = readFileSync(path.join(here, 'fixtures', 'user-settings.json'));
  if (mutate) writeFileSync(settings, mutate(bytes.toString('utf8')));
  else writeFileSync(settings, bytes);
  const stateDir = path.join(root, 'state');
  const outs = [];
  const errs = [];
  const events = [];
  const ctx = {
    root, repoRoot: W, stateDir, json: false,
    log: { append: (e) => events.push(e) },
    out: (s) => outs.push(s),
    err: (s) => errs.push(s),
    // home: no installed_plugins.json there, so the run is never in plugin mode (ADR 0021).
    paths: { claudeSettings: settings, workspace: W, home: root },
    env: {},
    clock: { now: () => new Date(), sleep: async () => {} },
  };
  return { ctx, outs, errs, events, root, settings, backup: path.join(stateDir, 'settings.json.bak') };
}

function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  }
  return found.sort();
}

test('R39: install-hooks chains the existing statusLine and keeps every other key', async (t) => {
  const s = makeSandbox(t);
  const original = fixture();
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.match(s.outs.at(-1), /: written$/);
  const next = JSON.parse(readFileSync(s.settings, 'utf8'));
  assert.deepEqual(Object.keys(next), Object.keys(original));
  for (const k of Object.keys(original)) {
    if (k !== 'hooks' && k !== 'statusLine') assert.deepEqual(next[k], original[k], k);
  }
  assert.ok(next.statusLine.command.endsWith(` --chain ${original.statusLine.command}`));
  assert.ok(next.statusLine.command.includes(`"${W}/bin/gvt-fleet-statusline.mjs"`));
  assert.ok(next.hooks.Stop[1].hooks[0].command.includes(`"${W}/bin/gvt-fleet-hook.mjs"`));
  assert.ok(!next.statusLine.command.slice(0, next.statusLine.command.indexOf(' --chain ')).includes(String.fromCharCode(92)));
});

test('R39: a second install-hooks run changes nothing and takes no second backup', async (t) => {
  const s = makeSandbox(t);
  const original = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const afterFirst = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.match(s.outs.at(-1), /: noop$/);
  assert.deepEqual(s.events.map((e) => e.status), ['written', 'noop']);
  assert.ok(readFileSync(s.settings).equals(afterFirst));
  assert.ok(readFileSync(s.backup).equals(original));
});

test('R39: install-hooks writes LF with a trailing newline and backs up the original bytes', async (t) => {
  const s = makeSandbox(t);
  const original = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const written = readFileSync(s.settings);
  assert.equal(written.filter((b) => b === 13).length, 0);
  assert.equal(written.at(-1), 10);
  assert.ok(readFileSync(s.backup).equals(original));
});

test('R47: a missing settings file leaves settings.json.absent and never a .bak, even after a later run', async (t) => {
  const s = makeSandbox(t);
  const missing = path.join(s.root, 'missing', 'settings.json');
  s.ctx.paths.claudeSettings = missing;
  const absent = path.join(path.dirname(s.backup), 'settings.json.absent');
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.ok(existsSync(missing));
  assert.ok(existsSync(absent));
  assert.ok(!existsSync(s.backup));
  const marker = readFileSync(absent);
  assert.equal(marker.at(-1), 10);
  assert.equal(marker.filter((b) => b === 13).length, 0);
  assert.match(marker.toString('utf8'), /^.+ did not exist at \d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  assert.ok(marker.toString('utf8').startsWith(missing));
  s.ctx.paths.workspace = 'C:/work/other-workspace';
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(s.events.at(-1).status, 'written');
  assert.ok(!existsSync(s.backup));
  assert.ok(readFileSync(absent).equals(marker));
});

test('R47: a settings file that already holds our entries and has no records takes no backup and says so', async (t) => {
  const s = makeSandbox(t);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const stateDir = path.dirname(s.backup);
  rmSync(stateDir, { recursive: true, force: true });
  s.outs.length = 0;
  s.ctx.paths.workspace = 'C:/work/other-workspace';
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(s.events.at(-1).status, 'written');
  assert.ok(!existsSync(s.backup));
  assert.ok(!existsSync(path.join(stateDir, 'settings.json.absent')));
  assert.ok(s.outs.includes('backup: none taken, the file already holds our entries'));
});

test('R39: install-hooks refuses a statusLine command with shell operators and writes nothing', async (t) => {
  const s = makeSandbox(t, (text) => {
    const doc = JSON.parse(text);
    doc.statusLine.command += ' | more';
    return JSON.stringify(doc, null, 2) + '\n';
  });
  const before = readFileSync(s.settings);
  const code = await installHooksCommand(s.ctx, []);
  assert.notEqual(code, 0);
  assert.match(s.errs.join('\n'), /shell operator/);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

const batchResolver = (name) => ({ foo: 'C:/tools/foo.cmd', bar: 'C:/tools/bar.exe' })[name] ?? null;
const planStatus = (command, extra = {}) =>
  planSettings({ statusLine: { type: 'command', command } }, { workspace: W, resolveExe: batchResolver, ...extra });

test('R44: planSettings refuses a batch-file status line with an argument the helper cannot pass, and names it', () => {
  const bs = String.fromCharCode(92);
  for (const arg of ['"a b"', `C:${bs}x`, '~/x', '$HOME']) {
    const r = planStatus(`foo ${arg}`);
    assert.equal(typeof r.refused, 'string', arg);
    assert.match(r.refused, /starts a batch file \(C:\/tools\/foo\.cmd\)/, arg);
    assert.ok(r.refused.includes(`its argument ${arg} has a character`), arg);
  }
});

test('R44: planSettings plans a batch-file status line whose arguments are shell-neutral, and skips exe and unknown targets', () => {
  for (const command of ['foo ok', 'foo "ok"', "foo 'ok'", 'foo --x=1', 'bar "a b"', 'unknown "a b"', 'foo']) {
    const r = planStatus(command);
    assert.equal(r.refused, undefined, command);
    assert.ok(r.changes.length > 0, command);
  }
  const noResolver = planSettings({ statusLine: { type: 'command', command: 'foo "a b"' } }, { workspace: W });
  assert.equal(noResolver.refused, undefined);
});

test('R44: planSettings checks the chained tail again when the status line is already ours', () => {
  const ours = (tail) => ({ statusLine: { type: 'command', command: `${statusCmd(W)} --chain ${tail}` } });
  const bad = planSettings(ours('foo "a b"'), { workspace: W, resolveExe: batchResolver });
  assert.match(bad.refused, /starts a batch file/);
  const good = planSettings(ours('foo ok'), { workspace: W, resolveExe: batchResolver });
  assert.equal(good.refused, undefined);
});

test('R44: install-hooks refuses a status line that starts a real batch file with an unsafe argument and writes nothing', async (t) => {
  const s = makeSandbox(t);
  const bat = path.join(s.root, 'line.cmd').replaceAll(String.fromCharCode(92), '/');
  writeFileSync(bat, '@echo off\r\n');
  const doc = fixture();
  doc.statusLine.command = `"${bat}" "a b"`;
  writeFileSync(s.settings, JSON.stringify(doc, null, 2) + '\n');
  const before = readFileSync(s.settings);
  const code = await installHooksCommand(s.ctx, []);
  assert.equal(code, 2);
  assert.match(s.errs.join('\n'), /its argument "a b" has a character/);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R44: planSettings refuses a batch-file status line whose path has a percent sign or a quote', () => {
  const paths = { pct: 'C:/a%b/x.cmd', quo: `C:/a${String.fromCharCode(34)}b/x.cmd`, plain: 'C:/tools/foo.cmd' };
  const resolveExe = (name) => paths[name] ?? null;
  for (const command of ['pct', 'pct ok', 'quo', 'quo ok']) {
    const r = planStatus(command, { resolveExe });
    assert.equal(typeof r.refused, 'string', command);
    assert.ok(r.refused.includes('whose path has a quote or percent sign, which the status-line helper does not run'), command);
    assert.ok(r.refused.includes(paths[command.split(' ')[0]]), command);
  }
  const plain = planStatus('plain', { resolveExe });
  assert.equal(plain.refused, undefined);
  assert.ok(plain.changes.length > 0);
});

test('R47: a dangling symlink at the settings path writes no settings.json.absent', async (t) => {
  const s = makeSandbox(t);
  const link = path.join(s.root, 'link-settings.json');
  symlinkSync(path.join(s.root, 'no-such-target.json'), link, 'file');
  s.ctx.paths.claudeSettings = link;
  const stateDir = path.dirname(s.backup);
  assert.equal(await installHooksCommand(s.ctx, []), 1);
  assert.equal(s.events.at(-1).status, 'failed');
  assert.ok(!existsSync(path.join(stateDir, 'settings.json.absent')));
  assert.ok(!existsSync(s.backup));
});

test('R39: --dry-run writes nothing', async (t) => {
  const s = makeSandbox(t);
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, ['--dry-run']), 0);
  assert.match(s.outs.at(-1), /: dry-run$/);
  assert.ok(s.outs.length > 1);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R40: install-hooks appends after existing user hooks without reordering them', async (t) => {
  const s = makeSandbox(t);
  const original = fixture();
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const next = JSON.parse(readFileSync(s.settings, 'utf8'));
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.Stop[0], original.hooks.Stop[0]);
  const flag = ` --state-dir "${s.ctx.stateDir.replaceAll(String.fromCharCode(92), '/')}"`;
  assert.deepEqual(next.hooks.Stop[1], ourGroup('Stop', W, flag));
  assert.deepEqual(next.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.deepEqual(next.hooks.PreToolUse[1], ourGroup('PreToolUse', W, flag));
});

test('NF-boundary: install-hooks writes only the injected settings path', async (t) => {
  const s = makeSandbox(t);
  const before = new Map(listFiles(s.root).map((f) => [f, readFileSync(f).toString('hex')]));
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const after = new Map(listFiles(s.root).map((f) => [f, readFileSync(f).toString('hex')]));
  const changed = [...after.keys()].filter((f) => before.get(f) !== after.get(f)).sort();
  const removed = [...before.keys()].filter((f) => !after.has(f));
  assert.deepEqual(removed, []);
  assert.deepEqual(changed, [s.settings, s.backup].sort());
  assert.equal(before.has(s.backup), false);
});

test('R39: install-hooks refuses a settings file that is not valid JSON and writes nothing', async (t) => {
  const s = makeSandbox(t, () => '{ not json');
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 2);
  assert.ok(s.errs.join('\n').includes(s.settings));
  assert.match(s.errs.join('\n'), /: refused: /);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R46: install-hooks refuses a settings file with a duplicate key and writes nothing', async (t) => {
  const s = makeSandbox(t, (text) => text.replace(/^(\s*)\{/, '$1{"dupkey":1,"dupkey":2,'));
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 2);
  const err = s.errs.join('\n');
  assert.match(err, /: refused: /);
  assert.ok(err.includes('"dupkey"'));
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R46: install-hooks refuses a settings file with a number that would change and writes nothing', async (t) => {
  const s = makeSandbox(t, (text) => text.replace(/^(\s*)\{/, '$1{"big":12345678901234567890,'));
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 2);
  const err = s.errs.join('\n');
  assert.match(err, /: refused: /);
  assert.ok(err.includes('12345678901234567890'));
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R52: install-hooks refuses a settings file that starts with a byte order mark and names it', async (t) => {
  const bom = String.fromCharCode(0xFEFF);
  const s = makeSandbox(t, (text) => bom + text);
  const before = readFileSync(s.settings);
  assert.equal(before[0], 0xEF);
  assert.equal(await installHooksCommand(s.ctx, []), 2);
  assert.match(s.errs.join('\n'), /byte order mark/);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.equal(existsSync(s.backup), false);
});

test('R39: install-hooks reports failed, not a stack trace, when the write fails', async (t) => {
  const s = makeSandbox(t);
  // A regular file where the state folder should be: mkdir for the backup fails on Windows (EEXIST).
  const blocker = path.join(s.root, 'state-is-a-file');
  writeFileSync(blocker, 'x');
  s.ctx.stateDir = blocker;
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 1);
  const err = s.errs.join('\n');
  assert.match(err, /: failed: /);
  assert.doesNotMatch(err, /\n\s+at /);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.deepEqual(s.events.map((e) => e.status), ['failed']);
});

test('R39: install-hooks reports failed when the read-back keeps showing changes', async (t) => {
  const s = makeSandbox(t);
  const original = readFileSync(s.settings);
  let sleeps = 0;
  // Each write is followed by exactly one sleep; undo the write there so every re-plan still has changes.
  s.ctx.clock = {
    now: () => new Date(),
    sleep: async () => {
      sleeps += 1;
      writeFileSync(s.settings, original);
    },
  };
  assert.equal(await installHooksCommand(s.ctx, []), 1);
  assert.equal(sleeps, 3);
  assert.match(s.errs.join('\n'), /: failed: /);
  assert.deepEqual(s.events.map((e) => e.status), ['failed']);
  assert.ok(readFileSync(s.settings).equals(original));
});

test('R49: planSettings keeps a user Stop hook whose command only mentions our script name, and appends our group', () => {
  const userGroup = { hooks: [{ type: 'command', command: 'echo not-gvt-loop-hook.mjs-related' }] };
  const input = { hooks: { Stop: [userGroup] } };
  const { next, hadOurs } = planSettings(input, { workspace: W });
  assert.equal(hadOurs, false);
  assert.equal(next.hooks.Stop.length, 2);
  assert.equal(JSON.stringify(next.hooks.Stop[0]), JSON.stringify(userGroup));
  assert.deepEqual(next.hooks.Stop[1], ourGroup('Stop'));
});

test('R48: planSettings passes a non-default state folder to the hook and status-line commands, with forward slashes', () => {
  const S = 'D:/elsewhere/loop-state';
  for (const given of [S, 'd:\\elsewhere\\loop-state']) {
    const { next } = planSettings(fixture(), { workspace: W, stateDir: given });
    const flag = ` --state-dir "${S}"`;
    for (const ev of EVENTS) {
      const groups = next.hooks[ev];
      assert.equal(groups[groups.length - 1].hooks[0].command, hookCmd(W) + flag, ev);
    }
    const sl = next.statusLine.command;
    assert.ok(sl.startsWith(statusCmd(W) + flag + ' --chain '), sl);
  }
  const { next } = planSettings(undefined, { workspace: W, stateDir: S });
  assert.equal(next.statusLine.command, statusCmd(W) + ` --state-dir "${S}"`);
});

test('R48: planSettings writes no --state-dir for the default folder or an undefined one', () => {
  for (const stateDir of [`${W}/state`, 'c:\\work\\fleet\\state', 'c:/work/fleet/state/', undefined]) {
    const { next } = planSettings(fixture(), { workspace: W, stateDir });
    for (const ev of EVENTS) {
      const groups = next.hooks[ev];
      assert.equal(groups[groups.length - 1].hooks[0].command, hookCmd(W), String(stateDir));
    }
    assert.ok(next.statusLine.command.startsWith(statusCmd(W) + ' --chain '), String(stateDir));
    assert.ok(!next.statusLine.command.slice(0, next.statusLine.command.indexOf(' --chain ')).includes('--state-dir'));
  }
});

test('R48: a re-run with a changed state folder updates our entries in place', () => {
  const first = planSettings(fixture(), { workspace: W, stateDir: 'D:/a/state' }).next;
  const second = planSettings(first, { workspace: W, stateDir: 'D:/b/state' });
  assert.equal(second.hadOurs, true);
  assert.equal(second.next.hooks.Stop.length, first.hooks.Stop.length);
  assert.equal(second.next.hooks.Stop.at(-1).hooks[0].command, hookCmd(W) + ' --state-dir "D:/b/state"');
  assert.ok(second.next.statusLine.command.startsWith(statusCmd(W) + ' --state-dir "D:/b/state" --chain '));
});

// ---- entries written under the old gvt-loop names ----

const OLD_HOOK = 'node "C:/work/fleet/bin/gvt-loop-hook.mjs" --workspace "C:/work/fleet"';
const OLD_STATUS = 'node "C:/work/fleet/bin/gvt-loop-statusline.mjs" --workspace "C:/work/fleet"';
const USER_STATUS = 'node "C:/tools/user-status.mjs" --fancy';
const oldSettings = () => {
  const hooks = {};
  for (const ev of OLD_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: OLD_HOOK, ...(ev === 'SessionEnd' ? {} : { timeout: 10 }) }] }];
  }
  return { hooks, statusLine: { type: 'command', command: `${OLD_STATUS} --chain ${USER_STATUS}` } };
};

test('N5: an old-path hook entry and an old-path status line that chains a user command are replaced in place', () => {
  const input = oldSettings();
  input.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'user-before' }] });
  const { next, hadOurs } = planSettings(input, { workspace: W });
  assert.equal(hadOurs, true);
  const ours = Object.values(next.hooks).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes('-hook.mjs'));
  assert.equal(ours.length, 6);
  for (const h of ours) assert.ok(h.command.startsWith(`node "${W}/bin/gvt-fleet-hook.mjs"`), h.command);
  assert.deepEqual(next.hooks.Stop[0], { hooks: [{ type: 'command', command: 'user-before' }] });
  assert.equal(next.hooks.Stop[1].hooks[0].command, hookCmd(W));
  assert.equal(next.statusLine.command, `${statusCmd(W)} --chain ${USER_STATUS}`);
  assert.equal(next.statusLine.command.split(USER_STATUS).length - 1, 1);
  assert.equal(JSON.stringify(next).split('statusline.mjs').length - 1, 1);
  assert.equal(JSON.stringify(next).includes('gvt-loop'), false);
});

test('N6: a user status line that only mentions the old script name stays untouched and is chained whole', () => {
  const user = 'pwsh -File "C:/tools/gvt-loop-statusline.mjs.ps1"';
  const userHook = { hooks: [{ type: 'command', command: 'echo gvt-loop-hook.mjs.bak' }] };
  const { next, hadOurs } = planSettings({ hooks: { Stop: [userHook] }, statusLine: { type: 'command', command: user } }, { workspace: W });
  assert.equal(hadOurs, false);
  assert.equal(next.statusLine.command, `${statusCmd(W)} --chain ${user}`);
  assert.equal(next.statusLine.command.split(user).length - 1, 1);
  assert.equal(JSON.stringify(next.hooks.Stop[0]), JSON.stringify(userHook));
});

test('N6: a user entry that only mentions gvt-fleet-hook.mjs stays untouched and our group is appended', () => {
  const userGroup = { hooks: [{ type: 'command', command: 'echo not-gvt-fleet-hook.mjs-related' }] };
  const { next, hadOurs } = planSettings({ hooks: { Stop: [userGroup] } }, { workspace: W });
  assert.equal(hadOurs, false);
  assert.equal(next.hooks.Stop.length, 2);
  assert.equal(JSON.stringify(next.hooks.Stop[0]), JSON.stringify(userGroup));
  assert.deepEqual(next.hooks.Stop[1], ourGroup('Stop'));
});

test('N7: old-named entries count as ours for the backup decision, so a run with no records takes no backup', async (t) => {
  const s = makeSandbox(t, () => JSON.stringify(oldSettings(), null, 2) + '\n');
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(s.events.at(-1).status, 'written');
  assert.ok(!existsSync(s.backup));
  assert.ok(s.outs.includes('backup: none taken, the file already holds our entries'));
  const next = JSON.parse(readFileSync(s.settings, 'utf8'));
  assert.ok(next.hooks.Stop[0].hooks[0].command.startsWith(hookCmd(W)));
  assert.equal(next.hooks.Stop.length, 1);
});

test('N5: the change lines name the rename of a hook entry and of the status line', () => {
  const { changes } = planSettings(oldSettings(), { workspace: W });
  // Five renames, the new PreToolUse entry and the status line.
  assert.equal(changes.length, 7);
  assert.ok(changes.includes('hooks.PreToolUse: add our entry'), changes.join('\n'));
  assert.ok(changes.includes('hooks.Stop: rename our entry from gvt-loop-hook.mjs to gvt-fleet-hook.mjs'), changes.join('\n'));
  assert.ok(changes.includes('statusLine: rename our command from gvt-loop-statusline.mjs to gvt-fleet-statusline.mjs'), changes.join('\n'));
});

test('N5: a status line that our helper chains through an old-named helper is unwrapped and keeps the user tail once', () => {
  const input = oldSettings();
  input.statusLine.command = `${statusCmd(W)} --chain ${OLD_STATUS} --chain ${USER_STATUS}`;
  const plan = planSettings(input, { workspace: W });
  assert.equal(plan.refused, undefined);
  assert.equal(plan.next.statusLine.command, `${statusCmd(W)} --chain ${USER_STATUS}`);
  assert.equal(plan.next.statusLine.command.split(USER_STATUS).length - 1, 1);
  assert.equal(plan.next.statusLine.command.split('--chain').length - 1, 1);
  assert.ok(plan.changes.includes('statusLine: unwrap a nested status-line helper'));
  // Two helpers and no user command leave our helper alone.
  input.statusLine.command = `${statusCmd(W)} --chain ${OLD_STATUS}`;
  assert.equal(planSettings(input, { workspace: W }).next.statusLine.command, statusCmd(W));
});

test('N5: the batch-file refusal looks at the user tail of a nested status line', () => {
  const nested = (tail) => ({
    ...oldSettings(),
    statusLine: { type: 'command', command: `${statusCmd(W)} --chain ${OLD_STATUS} --chain ${tail}` },
  });
  const bad = planSettings(nested('foo "a b"'), { workspace: W, resolveExe: batchResolver });
  assert.match(bad.refused, /starts a batch file \(C:\/tools\/foo\.cmd\)/);
  assert.equal(planSettings(nested('foo ok'), { workspace: W, resolveExe: batchResolver }).refused, undefined);
});

test('N5: a second entry of ours in one event is removed, and a group left empty goes with it', () => {
  const input = oldSettings();
  input.hooks.Stop.push({ hooks: [{ type: 'command', command: hookCmd(W), timeout: 10 }] });
  input.hooks.Notification[0].hooks.push({ type: 'command', command: 'user-mixed' }, { type: 'command', command: OLD_HOOK });
  const plan = planSettings(input, { workspace: W });
  assert.equal(plan.next.hooks.Stop.length, 1);
  assert.equal(plan.next.hooks.Stop[0].hooks[0].command, hookCmd(W));
  assert.deepEqual(plan.next.hooks.Notification[0].hooks.map((h) => h.command), [hookCmd(W), 'user-mixed']);
  assert.equal(plan.changes.filter((c) => c === 'hooks.Stop: remove a duplicate of our entry').length, 1);
  assert.equal(plan.changes.filter((c) => c === 'hooks.Notification: remove a duplicate of our entry').length, 1);
});

// ---- the PreToolUse entry for AskUserQuestion ----

const ASK = 'AskUserQuestion';
const ourEntry = (w = W) => ({ type: 'command', command: hookCmd(w), timeout: 10 });

test('R199: a first install adds hooks.PreToolUse with a group that has the matcher AskUserQuestion', async (t) => {
  const plan = planSettings({}, { workspace: W });
  assert.deepEqual(plan.next.hooks.PreToolUse, [{ matcher: ASK, hooks: [ourEntry()] }]);
  assert.ok(plan.changes.includes('hooks.PreToolUse: add our entry'), plan.changes.join('\n'));
  // Through the command, after a user PreToolUse group: ours comes last, with the matcher.
  const s = makeSandbox(t);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const next = JSON.parse(readFileSync(s.settings, 'utf8'));
  assert.equal(next.hooks.PreToolUse.length, 2);
  assert.equal(next.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(next.hooks.PreToolUse[1].matcher, ASK);
  assert.ok(next.hooks.PreToolUse[1].hooks[0].command.includes(`"${W}/bin/gvt-fleet-hook.mjs"`));
});

test('R199: a second install-hooks run prints noop and leaves the PreToolUse group as it was', async (t) => {
  const s = makeSandbox(t);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  const afterFirst = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.match(s.outs.at(-1), /: noop$/);
  assert.ok(readFileSync(s.settings).equals(afterFirst));
});

test('R199: our entry in a PreToolUse group with another matcher or none is moved to a group with our matcher', () => {
  for (const group of [{ matcher: 'Bash' }, {}, { matcher: 'AskUserQuestion|Bash' }]) {
    const userEntry = { type: 'command', command: 'user-guard' };
    const input = { hooks: { PreToolUse: [{ ...group, hooks: [userEntry, ourEntry()] }] } };
    const plan = planSettings(input, { workspace: W });
    const name = JSON.stringify(group);
    assert.deepEqual(plan.next.hooks.PreToolUse, [{ ...group, hooks: [userEntry] }, { matcher: ASK, hooks: [ourEntry()] }], name);
    assert.ok(plan.changes.includes('hooks.PreToolUse: move our entry to matcher AskUserQuestion'), plan.changes.join('\n'));
    assert.equal(plan.changes.filter((c) => c.startsWith('hooks.PreToolUse:')).length, 1, name);
    assert.deepEqual(planSettings(plan.next, { workspace: W }).changes, [], name);
  }
  // A group that held only our entry goes with it.
  const alone = planSettings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [ourEntry()] }] } }, { workspace: W });
  assert.deepEqual(alone.next.hooks.PreToolUse, [{ matcher: ASK, hooks: [ourEntry()] }]);
});

test('R199: an entry of ours under another matcher is dropped when the right group already holds one', () => {
  const stray = { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-guard' }, ourEntry()] };
  const right = { matcher: ASK, hooks: [{ type: 'command', command: 'user-ask' }, ourEntry()] };
  const plan = planSettings({ hooks: { PreToolUse: [stray, right] } }, { workspace: W });
  assert.deepEqual(plan.next.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-guard' }] }, right]);
  assert.deepEqual(plan.changes.filter((c) => c.startsWith('hooks.PreToolUse:')), ['hooks.PreToolUse: remove our entry from a group with another matcher']);
  // The same entry listed the other way round: the one in the right group is kept.
  const flipped = planSettings({ hooks: { PreToolUse: [right, stray] } }, { workspace: W });
  assert.deepEqual(flipped.next.hooks.PreToolUse, [right, { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-guard' }] }]);
});

test('R199: install-hooks refuses a hooks.PreToolUse that is not a list, exits 2 and writes nothing', async (t) => {
  const s = makeSandbox(t, (text) => JSON.stringify({ ...JSON.parse(text), hooks: { PreToolUse: { matcher: 'Bash' } } }, null, 2));
  const before = readFileSync(s.settings);
  assert.equal(await installHooksCommand(s.ctx, []), 2);
  assert.ok(readFileSync(s.settings).equals(before));
  assert.ok(s.errs.some((e) => e.includes('hooks.PreToolUse is not an array')), s.errs.join('\n'));
  assert.equal(existsSync(s.backup), false);
});

test('N5: a rerun after the migration is a noop', async (t) => {
  const s = makeSandbox(t, () => JSON.stringify(oldSettings(), null, 2) + '\n');
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(s.events.at(-1).status, 'written');
  assert.equal(await installHooksCommand(s.ctx, []), 0);
  assert.equal(s.events.at(-1).status, 'noop');
  assert.equal(readFileSync(s.settings, 'utf8').includes('gvt-loop'), false);
});
