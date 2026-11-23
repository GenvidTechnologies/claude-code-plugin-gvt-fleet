process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assign,
  meanTimes,
  readTimes,
  testFiles,
  timesFromTap,
} from '../scripts/ci-shard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-shard.mjs');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-shard-'));
const list = (k, n) => {
  const r = spawnSync(process.execPath, [SCRIPT, 'list', String(k), String(n)], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};

test('R212: the three CI shards together run every test file exactly once', () => {
  const all = testFiles().map((f) => `test/${f}`);
  const shards = [1, 2, 3].map((k) => list(k, 3));
  for (const s of shards) assert.ok(s.length > 0);
  const joined = shards.flat();
  assert.equal(new Set(joined).size, joined.length, 'no file in two shards');
  assert.deepEqual([...joined].sort(), all);
  assert.ok(joined.includes('test/ci-shard.test.mjs'));
});

test('R212: with the recorded times, no shard is more than 15% above the lightest', () => {
  const times = readTimes();
  const loads = assign(testFiles(), times, 3).map((files) => files.reduce((s, f) => s + (times[f] ?? 0), 0));
  const [lo, hi] = [Math.min(...loads), Math.max(...loads)];
  assert.ok(hi <= lo * 1.15, `loads ${loads.map((x) => x.toFixed(0)).join('/')}`);
});

test('R212: every recorded time names a test file that exists', () => {
  const files = new Set(testFiles());
  const stale = Object.keys(readTimes()).filter((f) => !files.has(f));
  assert.deepEqual(stale, [], 'refresh scripts/shard-times.json: node scripts/ci-shard.mjs times <run folder>...');
});

test('R212: assign puts the heavy files on different shards, where a split by name would stack them', () => {
  const times = { 'a.test.mjs': 100, 'b.test.mjs': 1, 'c.test.mjs': 1, 'd.test.mjs': 100, 'e.test.mjs': 1, 'f.test.mjs': 1, 'g.test.mjs': 100 };
  const files = Object.keys(times);
  // By name, file i goes to shard (i % 3) + 1: a, d and g all land on shard 1.
  const byName = [0, 1, 2].map((s) => files.filter((_, i) => i % 3 === s));
  assert.deepEqual(byName[0], ['a.test.mjs', 'd.test.mjs', 'g.test.mjs']);
  const shards = assign(files, times, 3);
  for (const s of shards) assert.equal(s.filter((f) => times[f] === 100).length, 1, s.join(','));
});

test('R212: a file with no recorded time weighs the median, and the result does not depend on input order', () => {
  const times = { 'a.test.mjs': 10, 'b.test.mjs': 20, 'c.test.mjs': 30 };
  const files = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'new.test.mjs'];
  const one = assign(files, times, 2);
  // Median 20: c (30) and a (10) on one side, b (20) and the new file (20) on the other.
  assert.deepEqual(one, [['a.test.mjs', 'c.test.mjs'], ['b.test.mjs', 'new.test.mjs']]);
  assert.deepEqual(assign([...files].reverse(), times, 2), one);
});

test('R212: timesFromTap sums durations per declaring file and unescapes # in titles', () => {
  const index = new Map([['R1: one', 'a.test.mjs'], ['R2: two', 'a.test.mjs'], ['R3: x#1 shape', 'b.test.mjs']]);
  const tap = [
    'TAP version 13',
    '# Subtest: R1: one',
    'ok 1 - R1: one',
    '  ---',
    '  duration_ms: 1500',
    '  ...',
    'ok 2 - R2: two',
    '  ---',
    '  duration_ms: 500.5',
    '  ...',
    'not ok 3 - R3: x\\#1 shape',
    '  ---',
    '  duration_ms: 2000',
    '  ...',
    'ok 4 - R9: unknown',
    '  ---',
    '  duration_ms: 9000',
    '  ...',
  ].join('\n');
  const r = timesFromTap([tap], index);
  assert.deepEqual(r.times, { 'a.test.mjs': 2, 'b.test.mjs': 2 });
  assert.equal(r.unmatched, 1);
});

test('R212: meanTimes averages a file over the runs that have it', () => {
  assert.deepEqual(meanTimes([{ 'a.test.mjs': 10, 'b.test.mjs': 4 }, { 'a.test.mjs': 20 }]), { 'a.test.mjs': 15, 'b.test.mjs': 4 });
});

test('R212: the times command reads run folders and refuses a folder with no TAP', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'times', tmp()], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no tests-tap-<n>\/tests\.tap/);
  const bad = spawnSync(process.execPath, [SCRIPT, 'list', '4', '3'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /bad shard/);
});
