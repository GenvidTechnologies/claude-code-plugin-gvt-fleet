// Session liveness rule shared by status, dispatch, expire and observe.
// Pure: no I/O.

export const DEAD_STATES = ['done', 'failed', 'stopped'];

// An unknown state counts as live, so a claim is not lost on an unrecognised value.
export const isLive = (e) => Boolean(e) && !DEAD_STATES.includes(e.state);

const segments = (p) => String(p).replace(/\\/g, '/').split('/').filter((s) => s !== '').map((s) => s.toLowerCase());

function isAtOrBelow(cwd, base) {
  if (typeof cwd !== 'string' || cwd === '' || typeof base !== 'string') return false;
  const c = segments(cwd);
  const b = segments(base);
  if (b.length === 0 || c.length < b.length) return false;
  return b.every((s, i) => c[i] === s);
}

// Background entries with this name whose cwd is at or below `base`, plus, when
// `sessionId` is given, entries whose sessionId or id equals it (any kind).
export function matchSessions(agents, { name, base, sessionId = null }) {
  const want = typeof name === 'string' ? name.toLowerCase() : null;
  const out = [];
  for (const a of agents ?? []) {
    if (!a) continue;
    const byName = a.kind !== 'interactive'
      && want !== null
      && typeof a.name === 'string'
      && a.name.toLowerCase() === want
      && isAtOrBelow(a.cwd, base);
    const byId = sessionId != null && (a.sessionId === sessionId || a.id === sessionId);
    if (byName || byId) out.push(a);
  }
  return out;
}

// A live match wins over a dead copy.
export const pickSession = (m) => m.find(isLive) ?? m[0] ?? null;
