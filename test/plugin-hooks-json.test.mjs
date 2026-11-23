process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginHooksJson } from '../plugin/cli/lib/user-settings.mjs';

// The plugin ships plugin/hooks/hooks.json as a committed file. It must stay the output of
// pluginHooksJson for the plugin's hook command, so that the events, the matcher and the
// timeouts follow the hook script (ADR 0021). The bundle step that wrote it is gone.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'plugin', 'hooks', 'hooks.json');
const COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/cli/bin/gvt-fleet-hook.mjs"';

test('R216: plugin/hooks/hooks.json equals pluginHooksJson for the plugin hook command, with LF and a final newline', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  assert.equal(text.includes('\r'), false, 'no CR');
  assert.ok(text.endsWith('}\n'), 'ends with a newline');
  assert.deepEqual(JSON.parse(text), pluginHooksJson(COMMAND));
});

test('R216: plugin/hooks/hooks.json has one group per event, the AskUserQuestion matcher, and a 10 s timeout except for SessionEnd', () => {
  const { hooks } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const events = ['SessionStart', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'PreToolUse'];
  assert.deepEqual(Object.keys(hooks).sort(), [...events].sort());
  for (const ev of events) {
    assert.equal(hooks[ev].length, 1, ev);
    const group = hooks[ev][0];
    assert.equal(group.matcher, ev === 'PreToolUse' ? 'AskUserQuestion' : undefined, ev);
    assert.equal(group.hooks.length, 1, ev);
    const entry = group.hooks[0];
    assert.equal(entry.type, 'command', ev);
    assert.equal(entry.command, COMMAND, ev);
    assert.equal(entry.timeout, ev === 'SessionEnd' ? undefined : 10, ev);
  }
});
