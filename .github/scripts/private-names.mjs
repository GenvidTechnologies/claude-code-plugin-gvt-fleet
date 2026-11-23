#!/usr/bin/env node
// Refuse private names and machine paths in the code that ships (#141).
//
// Usage: node .github/scripts/private-names.mjs [--root <dir>] [<path>...]
//
// Scans the files that git tracks under each <path> (default: bin lib test),
// relative to --root (default: the current folder). Prints one line per match
// as <file>:<line>: <rule>. Exit 0 when nothing matches, 1 on a match, and 2
// when the scan cannot run or lists no file (a scan of nothing is not a pass).
//
// This file names the private names it refuses, so it lives outside the
// scanned paths. The workspace keeps its private names in config/, wiki/ and
// CLAUDE.md, which no option of #35 publishes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveExe } from '../../lib/proc.mjs';

const RULES = [
  ['private org', /genvid-holdings/i],
  ['private repository', /burbank/i],
  ['user name', /fninoles|fabienninoles|fabien~1/i],
  ['machine path', /[a-z]:[\\/]+repos(?:[\\/]|$)/i],
  ['machine path (project slug)', /[a-z]--repos-/i],
  ['workspace folder', /gvt-claude-loop/i],
];

function fail(message) {
  process.stderr.write(`private-names: ${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let root = process.cwd();
const paths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root') {
    root = argv[++i];
    if (!root) fail('--root needs a folder');
  } else if (argv[i].startsWith('-')) {
    fail(`unknown option ${argv[i]}`);
  } else {
    paths.push(argv[i]);
  }
}
if (paths.length === 0) paths.push('bin', 'lib', 'test');

const ls = spawnSync(resolveExe('git'), ['ls-files', '-z', '--', ...paths], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});
if (ls.error) fail(`git ls-files: ${ls.error.message}`);
if (ls.status !== 0) fail(`git ls-files exited ${ls.status}: ${ls.stderr.trim()}`);
const files = ls.stdout.split('\0').filter(Boolean);
if (files.length === 0) fail(`no tracked file under ${paths.join(' ')} in ${root}`);

let hits = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') continue; // deleted in the working tree
    fail(`${file}: ${err.message}`);
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [rule, re] of RULES) {
      if (re.test(line)) {
        hits++;
        process.stdout.write(`${file}:${i + 1}: ${rule}\n`);
      }
    }
  });
}

process.stdout.write(`private-names: ${files.length} files scanned, ${hits} matches\n`);
process.exit(hits === 0 ? 0 : 1);
