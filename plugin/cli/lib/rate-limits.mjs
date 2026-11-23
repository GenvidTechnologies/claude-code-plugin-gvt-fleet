// rate_limits is account-wide and every session reports the same values, so a
// lost write costs only freshness. A payload without limits (a session's first
// render) must not blank the snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicRetry } from './atomic-write.mjs';

const WINDOWS = ['five_hour', 'seven_day'];

export function snapshotFile(stateDir) {
  return path.join(stateDir, 'rate-limits.json');
}

export function extractWindows(payload) {
  const out = {};
  const limits = payload?.rate_limits;
  if (limits === null || typeof limits !== 'object') return out;
  for (const name of WINDOWS) {
    const w = limits[name];
    if (w !== null && typeof w === 'object' && Number.isFinite(w.used_percentage) && Number.isFinite(w.resets_at)) {
      out[name] = { used_percentage: w.used_percentage, resets_at: w.resets_at };
    }
  }
  return out;
}

export function mergeSnapshot(stored, windows, { now, sessionId }) {
  if (!WINDOWS.some((name) => windows?.[name])) return null;
  const observedAt = now.toISOString();
  const next = { v: 1, observed_at: observedAt, session_id: sessionId };
  for (const name of WINDOWS) {
    const w = windows[name];
    if (w) {
      next[name] = {
        used_percentage: w.used_percentage,
        resets_at: w.resets_at,
        resets_at_iso: new Date(w.resets_at * 1000).toISOString(),
        observed_at: observedAt,
        session_id: sessionId,
      };
    } else if (stored?.[name] !== undefined) {
      next[name] = stored[name];
    }
  }
  return next;
}

export function readRateLimits(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotFile(stateDir), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function recordRateLimits(stateDir, payload, { now = new Date(), writer = writeJsonAtomicRetry } = {}) {
  try {
    const windows = extractWindows(payload);
    if (!WINDOWS.some((name) => windows[name])) return 'skipped';
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
    const next = mergeSnapshot(readRateLimits(stateDir), windows, { now, sessionId });
    if (next === null) return 'skipped';
    return writer(snapshotFile(stateDir), next) ? 'written' : 'failed';
  } catch {
    return 'failed';
  }
}
