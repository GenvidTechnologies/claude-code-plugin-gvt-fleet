process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './helpers/run-script.mjs';
import { appendRecord, workerFile } from '../lib/hook-state.mjs';
import { recordRateLimits, snapshotFile } from '../lib/rate-limits.mjs';
import { parseWorktreeCwd } from '../lib/worktree-path.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'append-many.mjs');
const CWD = 'C:\\tmp\\ws\\repos\\o\\n\\.claude\\worktrees\\n-1';
const parsed = parseWorktreeCwd(CWD, 'C:/tmp/ws');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gvt-conc-'));
const CHILD_TIMEOUT = 50000;

test('NF-concurrent: 8 processes appending to one worker file lose and tear no record', { timeout: 60000 }, async () => {
  const dir = tmp();
  try {
    // Control: a failing child must be visible, so a dead child cannot pass this test.
    const bad = await runScript(CHILD, ['bogus', dir, '1', 'x'], { timeoutMs: CHILD_TIMEOUT });
    assert.equal(bad.code, 2);
    assert.notEqual(bad.stderr.length, 0);

    const ids = Array.from({ length: 8 }, (_, i) => `w${i}`);
    const results = await Promise.all(ids.map((id) => runScript(CHILD, ['append', dir, '100', id], { timeoutMs: CHILD_TIMEOUT })));
    for (const r of results) {
      assert.equal(r.code, 0, r.stderr.toString());
      assert.equal(r.stdout.length, 0);
    }
    const raw = fs.readFileSync(workerFile(dir, parsed), 'utf8');
    assert.ok(raw.endsWith('\n'));
    const lines = raw.slice(0, -1).split('\n');
    assert.equal(lines.length, 800);
    const keys = new Set();
    for (const line of lines) keys.add(JSON.parse(line).extra.seq_key);
    assert.equal(keys.size, 800);
    const bytes = Buffer.byteLength(lines[0]) + 1;
    assert.ok(bytes >= 2500 && bytes <= 8192, `line is ${bytes} bytes`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NF-concurrent: concurrent snapshot writers and a reader never expose a torn file', { timeout: 60000 }, async () => {
  const dir = tmp();
  try {
    const file = snapshotFile(dir);
    const running = Array.from({ length: 8 }, (_, i) => runScript(CHILD, ['snapshot', dir, '50', `s${i}`], { timeoutMs: CHILD_TIMEOUT }));
    let done = false;
    const all = Promise.all(running).finally(() => {
      done = true;
    });
    let reads = 0;
    let torn = 0;
    while (!done) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        text = null; // missing before the first write, or briefly unreadable during a replace
      }
      if (text !== null) {
        try {
          JSON.parse(text);
          reads++;
        } catch {
          torn++;
        }
      }
      await new Promise((r) => setImmediate(r));
    }
    const results = await all;
    for (const r of results) {
      assert.equal(r.code, 0, r.stderr.toString());
      assert.equal(r.stdout.length, 0);
    }
    assert.equal(torn, 0);
    assert.ok(reads >= 1, 'reader saw no snapshot');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 1);
    const log = `snapshot test: successful reads=${reads}; ${results.map((r) => r.stderr.toString().trim()).join(' | ')}\n`;
    if (process.env.CONC_LOG) fs.appendFileSync(process.env.CONC_LOG, log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NF-win: worker files and the snapshot use LF line endings', () => {
  const dir = tmp();
  try {
    appendRecord(dir, parsed, { hook_event_name: 'Stop', session_id: 'lf', cwd: CWD, last_assistant_message: 'a\r\nb' });
    const result = recordRateLimits(dir, {
      session_id: 'lf',
      rate_limits: { five_hour: { used_percentage: 5, resets_at: 1790000000 } },
    });
    assert.equal(result, 'written');
    for (const file of [workerFile(dir, parsed), snapshotFile(dir)]) {
      const buf = fs.readFileSync(file);
      assert.equal(buf.filter((b) => b === 0x0d).length, 0, file);
      assert.equal(buf[buf.length - 1], 0x0a, file);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
