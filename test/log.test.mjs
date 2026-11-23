process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLog } from '../plugin/cli/lib/log.mjs';
import { makeTempDir } from './helpers/git-sandbox.mjs';

const OLD = 'gvt-loop.log.jsonl';
const NEW = 'gvt-fleet.log.jsonl';
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

function sandbox(t) {
  const dir = makeTempDir(t, 'gvt-fleet-log-');
  return { dir, oldFile: path.join(dir, OLD), newFile: path.join(dir, NEW) };
}

test('N4: the first append renames the old log, keeps its lines and adds one log-renamed line', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.oldFile, '{"event":"a"}\n{"event":"b"}\n');
  const log = createLog(s.dir);
  log.append({ event: 'c' });
  log.append({ event: 'd' });
  assert.equal(fs.existsSync(s.oldFile), false);
  const got = lines(s.newFile);
  assert.deepEqual(got.map((l) => l.event), ['a', 'b', 'log-renamed', 'c', 'd']);
  assert.equal(got[2].from, OLD);
});

test('N4: when the old file disappears before the rename, the line is still appended', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.oldFile, '{"event":"a"}\n');
  const racing = {
    ...fs,
    renameSync(from, to) {
      fs.rmSync(from); // another process won the rename
      return fs.renameSync(from, to);
    },
  };
  const log = createLog(s.dir, { fs: racing });
  log.append({ event: 'c' });
  assert.deepEqual(lines(s.newFile).map((l) => l.event), ['c']);
  assert.equal(fs.existsSync(s.oldFile), false);
});

test('N4: when both files exist nothing is renamed and no log-renamed line is written', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.oldFile, '{"event":"old"}\n');
  fs.writeFileSync(s.newFile, '{"event":"new"}\n');
  createLog(s.dir).append({ event: 'c' });
  assert.deepEqual(lines(s.oldFile).map((l) => l.event), ['old']);
  assert.deepEqual(lines(s.newFile).map((l) => l.event), ['new', 'c']);
});

test('N4: a rename failure other than ENOENT keeps the old file and appends to the new one', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.oldFile, '{"event":"old"}\n');
  const failing = {
    ...fs,
    renameSync() {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    },
  };
  createLog(s.dir, { fs: failing }).append({ event: 'c' });
  assert.deepEqual(lines(s.oldFile).map((l) => l.event), ['old']);
  const got = lines(s.newFile);
  assert.deepEqual(got.map((l) => l.event), ['log-rename-failed', 'c']);
  assert.equal(got[0].from, OLD);
  assert.equal(got[0].code, 'EBUSY');
});

test('N4: an lstat error other than ENOENT skips the carry-over and still appends the event', (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.oldFile, '{"event":"old"}\n');
  let renames = 0;
  const denied = {
    ...fs,
    lstatSync(p, ...rest) {
      if (p === s.newFile) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.lstatSync(p, ...rest);
    },
    renameSync(...a) {
      renames += 1;
      return fs.renameSync(...a);
    },
  };
  createLog(s.dir, { fs: denied }).append({ event: 'c' });
  assert.equal(renames, 0);
  assert.deepEqual(lines(s.oldFile).map((l) => l.event), ['old']);
  assert.deepEqual(lines(s.newFile).map((l) => l.event), ['c']);
});

test('N4: with no old file the first append just creates the new log', (t) => {
  const s = sandbox(t);
  createLog(s.dir).append({ event: 'c' });
  assert.deepEqual(lines(s.newFile).map((l) => l.event), ['c']);
  assert.equal(fs.existsSync(s.oldFile), false);
});
