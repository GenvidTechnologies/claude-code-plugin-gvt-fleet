process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveExe, run } from '../lib/proc.mjs';

test('NF-boundary: real runner refuses gh and claude under GVT_FLEET_FAKE_ONLY', async () => {
  assert.equal(process.env.GVT_FLEET_FAKE_ONLY, '1');
  await assert.rejects(run(['gh', '--version']), /GVT_FLEET_FAKE_ONLY/);
  await assert.rejects(run(['claude', '--version']), /GVT_FLEET_FAKE_ONLY/);
  // git stays allowed.
  const res = await run(['git', '--version']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^git version /);
});

test('NF-win: executable resolution returns an absolute path with extension', () => {
  const exe = resolveExe('git');
  assert.ok(path.isAbsolute(exe), exe);
  if (process.platform === 'win32') {
    assert.match(exe, /\.(exe|cmd|bat|com)$/i);
  }
  assert.notEqual(path.basename(exe).toLowerCase(), 'git');
  assert.throws(() => resolveExe('gvt-fleet-no-such-exe-xyz'), /not found/);
});
