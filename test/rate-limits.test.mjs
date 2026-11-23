process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TMP_INFIX, writeJsonAtomicRetry } from '../plugin/cli/lib/atomic-write.mjs';
import { recordRateLimits, readRateLimits, snapshotFile } from '../plugin/cli/lib/rate-limits.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe-events.jsonl');
const fixtureLines = fs.readFileSync(fixture, 'utf8').split('\n');

function payloadAt(lineNo) {
  return JSON.parse(fixtureLines[lineNo - 1]).payload;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gvt-rate-'));
}

const NOW = new Date('2026-11-03T15:00:00.000Z');
const LATER = new Date('2026-11-03T15:05:00.000Z');

test('R35: a status-line payload writes both windows with observed_at and session_id', () => {
  const dir = tempDir();
  try {
    const payload = payloadAt(3);
    assert.equal(recordRateLimits(dir, payload, { now: NOW }), 'written');
    const snap = JSON.parse(fs.readFileSync(snapshotFile(dir), 'utf8'));
    assert.equal(snap.v, 1);
    assert.equal(snap.observed_at, NOW.toISOString());
    assert.equal(snap.session_id, payload.session_id);
    assert.equal(snap.five_hour.used_percentage, 34);
    assert.equal(snap.five_hour.resets_at, 1793729400);
    assert.equal(snap.five_hour.observed_at, NOW.toISOString());
    assert.equal(snap.five_hour.session_id, payload.session_id);
    assert.equal(snap.seven_day.used_percentage, 5);
    assert.equal(snap.seven_day.resets_at, 1794304800);
    assert.equal(snap.seven_day.observed_at, NOW.toISOString());
    assert.equal(snap.seven_day.session_id, payload.session_id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R35: a payload from a cwd outside any worktree still updates the snapshot', () => {
  const dir = tempDir();
  try {
    const base = 'C:\\work\\fleet\\repos\\probe\\sandbox';
    const payload = { ...payloadAt(3), cwd: base, workspace: { ...payloadAt(3).workspace, current_dir: base } };
    assert.equal(recordRateLimits(dir, payload, { now: NOW }), 'written');
    const snap = readRateLimits(dir);
    assert.equal(snap.five_hour.used_percentage, 34);
    assert.equal(snap.seven_day.used_percentage, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R36: a payload with no rate_limits leaves the snapshot byte-identical', () => {
  const dir = tempDir();
  try {
    recordRateLimits(dir, payloadAt(3), { now: NOW });
    const before = fs.readFileSync(snapshotFile(dir));
    assert.equal(recordRateLimits(dir, payloadAt(1), { now: LATER }), 'skipped');
    assert.equal(recordRateLimits(dir, payloadAt(43), { now: LATER }), 'skipped');
    assert.equal(recordRateLimits(dir, { rate_limits: {} }, { now: LATER }), 'skipped');
    assert.ok(before.equals(fs.readFileSync(snapshotFile(dir))), 'bytes unchanged');

    const changed = structuredClone(payloadAt(3));
    changed.rate_limits.five_hour.used_percentage = 61;
    assert.equal(recordRateLimits(dir, changed, { now: LATER }), 'written');
    assert.ok(!before.equals(fs.readFileSync(snapshotFile(dir))), 'control: bytes change');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R36: a payload with one window keeps the other window from the stored snapshot', () => {
  const dir = tempDir();
  try {
    recordRateLimits(dir, payloadAt(3), { now: NOW });
    const stored = readRateLimits(dir);
    const only = {
      session_id: 'other-session',
      rate_limits: { five_hour: { used_percentage: 70, resets_at: 1793733000 } },
    };
    assert.equal(recordRateLimits(dir, only, { now: LATER }), 'written');
    const snap = readRateLimits(dir);
    assert.equal(snap.five_hour.used_percentage, 70);
    assert.equal(snap.five_hour.session_id, 'other-session');
    assert.equal(snap.five_hour.observed_at, LATER.toISOString());
    assert.deepEqual(snap.seven_day, stored.seven_day);
    assert.equal(snap.observed_at, LATER.toISOString());
    assert.equal(snap.session_id, 'other-session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R37: resets_at is stored as epoch seconds with an ISO copy', () => {
  const dir = tempDir();
  try {
    recordRateLimits(dir, payloadAt(3), { now: NOW });
    const snap = readRateLimits(dir);
    assert.equal(snap.five_hour.resets_at, 1793729400);
    assert.equal(snap.five_hour.resets_at_iso, '2026-11-03T18:10:00.000Z');
    assert.equal(snap.seven_day.resets_at_iso, new Date(1794304800 * 1000).toISOString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R43: the snapshot reader gives both used_percentage values, both resets_at and observed_at', () => {
  const dir = tempDir();
  try {
    assert.equal(readRateLimits(dir), null, 'missing file reads as null');
    recordRateLimits(dir, payloadAt(3), { now: NOW });
    const snap = readRateLimits(dir);
    assert.equal(snap.five_hour.used_percentage, 34);
    assert.equal(snap.seven_day.used_percentage, 5);
    assert.equal(snap.five_hour.resets_at, 1793729400);
    assert.equal(snap.seven_day.resets_at, 1794304800);
    assert.equal(snap.observed_at, NOW.toISOString());
    fs.writeFileSync(snapshotFile(dir), '{not json');
    assert.equal(readRateLimits(dir), null, 'unparsable file reads as null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NF-concurrent: writeJsonAtomicRetry retries on EPERM and gives up silently after five attempts', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'sub', 'out.json');
    let renames = 0;
    let sleeps = 0;
    const failing = () => {
      renames += 1;
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    };
    const result = writeJsonAtomicRetry(file, { b: 1, a: 2 }, { rename: failing, sleep: () => { sleeps += 1; } });
    assert.equal(result, false);
    assert.equal(renames, 5, 'five rename attempts');
    assert.equal(sleeps, 4, 'a sleep between attempts only');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(TMP_INFIX)), []);
    assert.equal(fs.existsSync(file), false);

    let calls = 0;
    const flaky = (from, to) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('x'), { code: 'EPERM' });
      fs.renameSync(from, to);
    };
    assert.equal(writeJsonAtomicRetry(file, { b: 1, a: 2 }, { rename: flaky, sleep: () => {} }), true);
    assert.equal(calls, 3);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, JSON.stringify({ b: 1, a: 2 }, null, 2) + '\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(TMP_INFIX)), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
