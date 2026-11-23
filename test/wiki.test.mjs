process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The documentation is a maintain-wiki bundle under wiki/ (wiki/schema.md).
// The maintain-wiki lint checks that a link's file exists, but drops the
// #fragment. These tests check the fragments too, against GitHub's heading
// slugs, and the page format that the schema requires.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = 'wiki';
const FENCE = /^\s*(```|~~~)/;

function walkMd(rel, out = []) {
  for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${ent.name}`;
    if (ent.isDirectory()) walkMd(child, out);
    else if (ent.name.endsWith('.md')) out.push(child);
  }
  return out.sort();
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  try {
    fs.lstatSync(path.join(ROOT, rel));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// Lines outside fenced code, with the frontmatter block blanked.
function proseLines(text) {
  const lines = text.split('\n');
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }
  let inFence = false;
  return lines.map((raw, i) => {
    if (i < start) return '';
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : raw;
  });
}

// GitHub's heading anchor: lower case, punctuation dropped, spaces to
// hyphens, and -1, -2 ... for a repeated slug.
function slugs(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of proseLines(text)) {
    const m = /^#{1,6} (.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

function links(text) {
  const out = [];
  proseLines(text).forEach((line, i) => {
    const masked = line.replace(/`[^`]*`/g, (c) => ' '.repeat(c.length));
    for (const m of masked.matchAll(/\]\(([^)\s]+)\)/g)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
}

// Returns null when the link resolves, else the reason.
function linkProblem(fromRel, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith('/')) return 'starts with /';
  const i = target.indexOf('#');
  const p = i < 0 ? target : target.slice(0, i);
  const frag = i < 0 ? '' : decodeURIComponent(target.slice(i + 1));
  const toRel = p === '' ? fromRel : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), p));
  if (toRel.startsWith('..')) return 'outside the repository';
  if (!exists(toRel)) return 'missing file';
  if (frag && toRel.endsWith('.md') && !slugs(read(toRel)).has(frag)) return 'missing anchor';
  return null;
}

function frontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fm = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([a-z_]+): ?(.*)$/.exec(l);
    if (!m) continue;
    let v = m[2].trim();
    if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(v)) v = v.slice(1, -1);
    fm[m[1]] = v;
  }
  return fm;
}

const RESERVED = new Set(['index.md', 'log.md']);
const isReserved = (rel) => RESERVED.has(path.posix.basename(rel));

test('NF-wiki: every relative link in the docs resolves, with its anchor', () => {
  const files = [...walkMd(WIKI), 'README.md', 'CLAUDE.md'];
  assert.ok(files.length >= 30, `control: found ${files.length} files`);
  assert.equal(linkProblem('wiki/coordinator.md', '#no-such-anchor-control'), 'missing anchor', 'control: a bad anchor is reported');
  assert.equal(linkProblem('wiki/coordinator.md', 'coordinator/no-such-page.md'), 'missing file', 'control: a bad page is reported');
  assert.equal(linkProblem('wiki/coordinator.md', '/schema.md'), 'starts with /', 'control: a bundle-absolute link is reported');
  let checked = 0;
  const bad = [];
  for (const rel of files) {
    for (const { line, target } of links(read(rel))) {
      checked++;
      const p = linkProblem(rel, target);
      if (p) bad.push(`${rel}:${line} ${target} (${p})`);
    }
  }
  assert.ok(checked >= 120,`control: checked ${checked} links`);
  assert.deepEqual(bad, []);
});

test('NF-wiki: the slug rule matches GitHub on the reference headings', () => {
  const s = slugs('# Commands: base clones and trust\n## `config/branches.json`\n## Notes\n## Notes\n```\n# not a heading\n```\n');
  assert.deepEqual([...s], ['commands-base-clones-and-trust', 'configbranchesjson', 'notes', 'notes-1']);
});

test('NF-wiki: every page opens with frontmatter whose type is set and whose title is its H1', () => {
  const pages = walkMd(WIKI).filter((rel) => !isReserved(rel));
  assert.ok(pages.length >= 29, `control: found ${pages.length} pages`);
  const bad = [];
  for (const rel of pages) {
    const text = read(rel);
    const fm = frontmatter(text);
    if (!fm) {
      bad.push(`${rel}: no frontmatter`);
      continue;
    }
    if (!fm.type) bad.push(`${rel}: empty type`);
    if (!fm.description) bad.push(`${rel}: empty description`);
    const h1 = /^# (.+?)\s*$/m.exec(proseLines(text).join('\n'))?.[1];
    const want = rel.startsWith(`${WIKI}/decisions/`) ? h1?.replace(/^\d{4}\. /, '') : h1;
    if (fm.title !== want) bad.push(`${rel}: title ${JSON.stringify(fm.title)} is not the H1 ${JSON.stringify(want)}`);
  }
  assert.deepEqual(bad, []);
});

test('NF-wiki: only the bundle-root index carries frontmatter, and only okf_version', () => {
  const root = frontmatter(read(`${WIKI}/index.md`));
  assert.deepEqual(root, { okf_version: '0.2' });
  const bad = walkMd(WIKI)
    .filter((rel) => isReserved(rel) && rel !== `${WIKI}/index.md`)
    .filter((rel) => frontmatter(read(rel)) !== null);
  assert.deepEqual(bad, []);
});

test('NF-wiki: every page is listed in the root index or in its own folder index', () => {
  const listed = new Set();
  for (const idx of walkMd(WIKI).filter((rel) => path.posix.basename(rel) === 'index.md')) {
    for (const { target } of links(read(idx))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const p = target.split('#')[0];
      if (p) listed.add(path.posix.normalize(path.posix.join(path.posix.dirname(idx), p)));
    }
  }
  const rootIndexLinks = links(read(`${WIKI}/index.md`)).map(({ target }) => path.posix.join(WIKI, target.split('#')[0]));
  const bad = [];
  for (const rel of walkMd(WIKI)) {
    if (rel === `${WIKI}/index.md` || path.posix.basename(rel) === 'log.md') continue;
    const dir = path.posix.dirname(rel);
    if (path.posix.basename(rel) === 'index.md') {
      if (!rootIndexLinks.includes(rel)) bad.push(`${rel}: folder index not linked from ${WIKI}/index.md`);
      continue;
    }
    const ownIndex = `${dir}/index.md`;
    const inOwn = dir !== WIKI && links(exists(ownIndex) ? read(ownIndex) : '').some(({ target }) => path.posix.join(dir, target.split('#')[0]) === rel);
    if (!rootIndexLinks.includes(rel) && !inOwn) bad.push(`${rel}: in no index`);
  }
  assert.ok(listed.size >= 29, `control: the indexes link ${listed.size} files`);
  assert.deepEqual(bad, []);
});

test('NF-wiki: no Markdown documentation is left in docs/', () => {
  assert.equal(exists('docs'), false);
});
