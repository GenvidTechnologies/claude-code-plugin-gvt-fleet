// Pure helpers for `gvt-fleet watch`: no I/O, no clock, no process.

const BLOCKED = 'agents:blocked';

/** Collapse whitespace to single spaces and trim. Over `max` characters, keep the last `max` behind a leading `...`. */
export function oneLine(detail, max = 160) {
  if (detail === null || detail === undefined) return '';
  const s = String(detail).replace(/\s+/g, ' ').trim();
  return s.length > max ? `...${s.slice(s.length - max)}` : s;
}

/**
 * Decide which worker rows start a new wait. `memo` is the value returned by the previous call (null for the first).
 * Memo shape: `{ emitted: {<key>|<since>: true}, turnEnded: {<key>: true}, blocked: null | {<key>: true} }`.
 * `turnEnded` holds the keys whose last emitted hook wait had reason `turn-ended`; an idle prompt that follows such a
 * wait is the same wait (the Stop with an empty last message gives the prompt its own `since`). `blocked` is the set of
 * keys that showed `needs-you` / `agents:blocked` in the last poll with a readable agents list, or null before the
 * first one. `nowMs` is the poll time; an emitted `agents:blocked` line carries it as `since`.
 * Returns `{ lines, memo }` and never changes its input.
 */
export function nextWaits(memo, rows, { cursorMs, agentsOk, nowMs }) {
  const emitted = { ...(memo?.emitted ?? {}) };
  const turnEnded = { ...(memo?.turnEnded ?? {}) };
  const prevBlocked = memo?.blocked ?? null;
  const lines = [];
  const nowBlocked = {};
  const line = (row, since = row.since) => ({ event: 'needs-you', key: row.key, reason: row.reason, detail: oneLine(row.detail), since, questions: row.questions ?? null });

  for (const row of rows ?? []) {
    if (row.state === 'needs-you' && row.reason === BLOCKED) {
      nowBlocked[row.key] = true;
      if (agentsOk && prevBlocked !== null && !prevBlocked[row.key]) {
        lines.push(line(row, Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : row.since));
      }
      continue;
    }
    if (row.state !== 'needs-you') {
      // The wait ended (working, rate-limited, no-session...): a later idle prompt belongs to another turn.
      delete turnEnded[row.key];
      continue;
    }
    const id = `${row.key}|${row.since}`;
    if (emitted[id]) continue;
    if (row.reason === 'notification:idle_prompt' && turnEnded[row.key]) {
      emitted[id] = true;
      continue;
    }
    const sinceMs = Date.parse(row.since);
    if (!Number.isFinite(sinceMs) || sinceMs < cursorMs) continue;
    emitted[id] = true;
    if (row.reason === 'turn-ended') turnEnded[row.key] = true;
    else delete turnEnded[row.key];
    lines.push(line(row));
  }

  return { lines, memo: { emitted, turnEnded, blocked: agentsOk ? nowBlocked : prevBlocked } };
}

/** One output line. A `needs-you` line, or the closing `watch-end` line. */
export function formatWait(line, { json }) {
  if (json) return JSON.stringify(line);
  if (line.event === 'watch-end') return `watch-end ${line.cursor}`;
  const base = `${line.key} needs-you ${line.reason} since ${line.since}`;
  return line.detail ? `${base}: ${line.detail}` : base;
}
