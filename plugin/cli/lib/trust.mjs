// Trust entries in ~/.claude.json for base clones.
import fs from 'node:fs';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write.mjs';

/** realpath, forward slashes, uppercase drive letter, no trailing slash. */
export function trustKey(folder) {
  return normalizeKey(fs.realpathSync.native(folder));
}

/** Pure part of the key: forward slashes, uppercase drive letter, no trailing slash. */
export function normalizeKey(real) {
  const key = real.replace(/\\/g, '/').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
  return key.replace(/\/+$/, '');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Mark a folder as trusted. ctx: {claudeJson, workspace, stateDir, sleep, waitMs?, retries?}.
 * `workspace` is the allowed prefix, for example 'C:/work/fleet/'.
 * Returns {status: 'refused'|'already-trusted'|'written', key, attempts?}.
 * The file is rewritten in its existing key order; it is not sorted.
 */
export async function ensureTrusted(folder, ctx) {
  const { claudeJson, workspace, stateDir, sleep } = ctx;
  const waitMs = ctx.waitMs ?? 3000;
  const retries = ctx.retries ?? 3;
  const key = trustKey(folder);
  const prefix = workspace.replace(/\\/g, '/').replace(/\/*$/, '/');
  // The key must lie below the workspace root; the root itself is not accepted.
  if (!key.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { status: 'refused', key, reason: `outside workspace ${prefix}` };
  }
  try {
    if (readJson(claudeJson).projects?.[key]?.hasTrustDialogAccepted === true) {
      return { status: 'already-trusted', key };
    }
  } catch (e) {
    return { status: 'failed', key, reason: `cannot read ${claudeJson}: ${e.message}` };
  }

  const backup = path.join(stateDir, 'claude.json.bak');
  // `run` is an object the caller keeps for one command run, so the backup is taken once.
  const run = ctx.run ?? {};
  if (!run.backedUp) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(claudeJson, backup);
    run.backedUp = true;
  }

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const json = readJson(claudeJson);
    json.projects ??= {};
    json.projects[key] = { ...(json.projects[key] ?? {}), hasTrustDialogAccepted: true };
    writeTextAtomic(claudeJson, JSON.stringify(json, null, 2) + '\n');
    await sleep(waitMs);
    if (readJson(claudeJson).projects?.[key]?.hasTrustDialogAccepted === true) {
      return { status: 'written', key, attempts };
    }
    if (attempts > retries) {
      return { status: 'failed', key, attempts, reason: 'entry missing after re-read' };
    }
  }
}
