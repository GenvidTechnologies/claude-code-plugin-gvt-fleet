#!/usr/bin/env node
// Splits the test files across the CI shards by recorded run time.
//
// node's --test-shard gives file i of the sorted list to shard (i % total) + 1. The heavy git-sandbox
// files then land together by name, and each new test file reshuffles them: on 2026-11-20 one shard
// took 4 min while another took 2. This script balances by time instead.
//
//   node scripts/ci-shard.mjs list <shard> <total>
//     Prints the files of one shard, one per line (test/<name>.test.mjs). Every file of test/ goes
//     to exactly one shard: longest first, each to the shard with the least time so far. A file
//     with no recorded time counts as the median recorded time.
//
//   node scripts/ci-shard.mjs times <run folder>...
//     Rewrites scripts/shard-times.json. Each run folder is what `gh run download <run id> --dir
//     <folder>` writes for one CI run: tests-tap-<n>/tests.tap per shard. Each test's duration is
//     added to the file that declares its title, and a file's time is its mean over the runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TIMES_FILE = path.join(ROOT, 'scripts', 'shard-times.json');

/** The test files of `testDir`, sorted: the names node --test "test/*.test.mjs" runs. */
export function testFiles(testDir = path.join(ROOT, 'test')) {
  return fs.readdirSync(testDir).filter((n) => n.endsWith('.test.mjs')).sort();
}

function median(values) {
  if (values.length === 0) return 1;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Assigns `files` to `total` shards by time. Returns an array of `total` lists of file names.
 * Deterministic: ties on weight go by name, ties on load go to the lower shard.
 */
export function assign(files, times, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`bad shard total: ${total}`);
  const known = files.filter((f) => typeof times[f] === 'number').map((f) => times[f]);
  const fallback = median(known);
  const weight = (f) => (typeof times[f] === 'number' ? times[f] : fallback);
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ files: [], load: 0 }));
  for (const f of order) {
    let best = 0;
    for (let i = 1; i < total; i += 1) if (shards[i].load < shards[best].load) best = i;
    shards[best].files.push(f);
    shards[best].load += weight(f);
  }
  return shards.map((s) => s.files.sort());
}

/** Maps each test title declared with test('…') to its file. */
export function titleIndex(testDir = path.join(ROOT, 'test')) {
  const index = new Map();
  for (const f of testFiles(testDir)) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    for (const m of src.matchAll(/^test\(\s*(['"`])((?:(?!\1).)*)\1/gm)) index.set(m[2].replace(/\\(['"`])/g, '$1'), f);
  }
  return index;
}

/** Seconds per file from TAP text: each top-level `ok N - title` line and the duration_ms after it. */
export function timesFromTap(texts, index) {
  const secs = {};
  let unmatched = 0;
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(?:not )?ok \d+ - (.*)$/.exec(lines[i]);
      if (!m) continue;
      // TAP writes a '#' in a title as '\#'; ' # SKIP' and the like follow the title.
      const file = index.get(m[1].replace(/ # .*$/, '').replace(/\\#/g, '#'));
      if (file === undefined) {
        unmatched += 1;
        continue;
      }
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const d = /^ {2}duration_ms: ([\d.]+)/.exec(lines[j]);
        if (d) {
          secs[file] = (secs[file] ?? 0) + Number(d[1]) / 1000;
          break;
        }
      }
    }
  }
  const rounded = {};
  for (const f of Object.keys(secs).sort()) rounded[f] = Math.round(secs[f] * 10) / 10;
  return { times: rounded, unmatched };
}

/** A file's mean time over the runs that have it, rounded to 0.1 s, keys sorted. */
export function meanTimes(runs) {
  const acc = {};
  for (const t of runs) {
    for (const [f, s] of Object.entries(t)) {
      acc[f] ??= { sum: 0, n: 0 };
      acc[f].sum += s;
      acc[f].n += 1;
    }
  }
  const out = {};
  for (const f of Object.keys(acc).sort()) out[f] = Math.round((acc[f].sum / acc[f].n) * 10) / 10;
  return out;
}

export function readTimes(file = TIMES_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'list' && rest.length === 2) {
    const shard = Number(rest[0]);
    const total = Number(rest[1]);
    if (!Number.isInteger(shard) || shard < 1 || shard > total) throw new Error(`bad shard: ${rest[0]}/${rest[1]}`);
    const lists = assign(testFiles(), readTimes(), total);
    for (const f of lists[shard - 1]) process.stdout.write(`test/${f}\n`);
    return 0;
  }
  if (mode === 'times' && rest.length > 0) {
    const index = titleIndex();
    const runs = rest.map((dir) => {
      const taps = fs.readdirSync(dir)
        .filter((d) => /^tests-tap-\d+$/.test(d))
        .map((d) => fs.readFileSync(path.join(dir, d, 'tests.tap'), 'utf8'));
      if (taps.length === 0) throw new Error(`${dir} has no tests-tap-<n>/tests.tap`);
      return timesFromTap(taps, index);
    });
    const times = meanTimes(runs.map((r) => r.times));
    fs.writeFileSync(TIMES_FILE, JSON.stringify(times, null, 2) + '\n');
    const unmatched = runs.map((r) => r.unmatched).join('/');
    process.stdout.write(`${Object.keys(times).length} files from ${runs.length} runs written to ${TIMES_FILE}; tests without a known title per run: ${unmatched}\n`);
    return 0;
  }
  process.stderr.write('usage: ci-shard.mjs list <shard> <total> | times <run folder>...\n');
  return 64;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ci-shard: ${e.message}\n`);
    process.exitCode = 1;
  }
}
