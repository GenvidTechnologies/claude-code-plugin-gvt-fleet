// The recorded Now of each project (ADR 0022): state/now-pointers.json. `iteration promote` writes
// it; `ready`, `why`, `class` and `iteration list` read it through lib/iterations.mjs `pointers`.
// It is durable state, not cache: the cache can be deleted and rebuilt from GitHub, the pointer
// cannot. A project with no entry falls back to the dates (the iteration that holds today).
//
// { "version": 1, "projects": { "<owner/number>": { "now": "<iteration id>", "setAt": "<ISO time>" } } }

import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write.mjs';

export const NOW_POINTER_FILE = 'now-pointers.json';
const VERSION = 1;

export class NowPointerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NowPointerError';
  }
}

const fileOf = (stateDir) => path.join(stateDir, NOW_POINTER_FILE);
const lower = (s) => String(s ?? '').toLowerCase();

function readFile(stateDir) {
  const file = fileOf(stateDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: VERSION, projects: {} };
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new NowPointerError(`${file}: not valid JSON (${e.message}); fix or delete it, then run iteration list`);
  }
  if (doc?.version !== VERSION || typeof doc.projects !== 'object' || doc.projects === null || Array.isArray(doc.projects)) {
    throw new NowPointerError(`${file}: expected version ${VERSION} with a projects object; fix or delete it, then run iteration list`);
  }
  return doc;
}

/**
 * The recorded Now of every project: Map(lowercased project -> iteration id). A missing file is an
 * empty map; a file that cannot be read as version 1 throws NowPointerError, because falling back to
 * the dates without a word could make a finished goal Now again.
 */
export function readNowPointers(stateDir) {
  const out = new Map();
  for (const [project, v] of Object.entries(readFile(stateDir).projects)) {
    if (v && typeof v.now === 'string' && v.now !== '') out.set(lower(project), v.now);
  }
  return out;
}

/** The recorded Now of one project, or null. */
export const nowPointerOf = (pointers, project) => pointers?.get(lower(project)) ?? null;

/** Record `nowId` as the Now of `project`, keeping every other project's entry. */
export function writeNowPointer(stateDir, project, nowId, setAt) {
  const doc = readFile(stateDir);
  for (const key of Object.keys(doc.projects)) if (lower(key) === lower(project)) delete doc.projects[key];
  doc.projects[project] = { now: nowId, setAt };
  writeTextAtomic(fileOf(stateDir), `${JSON.stringify(doc, null, 2)}\n`);
}
