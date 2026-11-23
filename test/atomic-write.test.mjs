process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as atomic from '../lib/atomic-write.mjs';
import { TMP_INFIX } from '../lib/atomic-write.mjs';

const { writeJsonAtomic, writeTextAtomic } = atomic;

function enoent() {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

test('R51: resolveWriteTarget follows a link, keeps an absent path, and refuses a dangling link', () => {
  const { resolveWriteTarget } = atomic;
  assert.equal(typeof resolveWriteTarget, 'function', 'resolveWriteTarget is exported');

  const link = path.join('x', 'link.json');
  const real = path.join('x', 'real.json');
  assert.equal(
    resolveWriteTarget(link, {
      realpath: () => real,
      lstat: () => assert.fail('lstat is not needed when realpath succeeds'),
    }),
    real,
  );

  const absent = path.join('x', 'absent.json');
  assert.equal(
    resolveWriteTarget(absent, {
      realpath: () => {
        throw enoent();
      },
      lstat: () => {
        throw enoent();
      },
    }),
    absent,
  );

  assert.throws(
    () =>
      resolveWriteTarget(link, {
        realpath: () => {
          throw enoent();
        },
        lstat: () => ({ isSymbolicLink: () => true }),
      }),
    (err) => err.message === `${link} is a symbolic link to a missing file`,
  );

  const boom = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.throws(
    () =>
      resolveWriteTarget(link, {
        realpath: () => {
          throw boom;
        },
      }),
    (err) => err === boom,
  );
});

test('R51: writeTextAtomic writes through a symbolic link and keeps the link', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-atomic-link-'));
  try {
    const target = path.join(dir, 'real', 'target.txt');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'old\n');
    const link = path.join(dir, 'link.txt');
    fs.symlinkSync(target, link, 'file');

    writeTextAtomic(link, 'new\n');

    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['target.txt'], 'no temp file left beside the target');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['link.txt', 'real'], 'no temp file left beside the link');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q6: atomic write produces sorted LF JSON with a trailing newline', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gvt-fleet-atomic-'));
  try {
    const file = path.join(dir, 'nested', 'out.json');
    writeJsonAtomic(file, { b: 1, a: { z: [{ y: 1, x: 2 }, 3], c: null }, 'a-first': true });

    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    assert.equal(bytes.includes(0x0d), false, 'no CR byte');
    assert.ok(text.endsWith('\n'), 'ends with LF');
    assert.ok(!text.endsWith('\n\n'), 'exactly one trailing LF');

    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), ['a', 'a-first', 'b']);
    assert.deepEqual(Object.keys(parsed.a), ['c', 'z']);
    assert.deepEqual(Object.keys(parsed.a.z[0]), ['x', 'y']);
    assert.equal(parsed.a.z[1], 3, 'array order kept');
    assert.ok(text.includes('\n  "a": {'), '2-space indent');

    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(TMP_INFIX));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
