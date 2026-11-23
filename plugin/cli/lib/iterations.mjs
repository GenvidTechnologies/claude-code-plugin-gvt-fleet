// Iterations of a GitHub project's Iteration field (ADR 0015, ADR 0022). Pure: the iterations, the
// date and the recorded Now pointer enter as arguments. Now is the iteration that the recorded
// pointer names, or, with no record, the one that holds today. Next is the first iteration after Now.
// Every other iteration, or no iteration, is Later. Writes go through lib/projects.mjs.
//
// An iteration is {id, title, startDate: 'YYYY-MM-DD', duration: days}. GitHub keeps the ones that
// ended in `completedIterations`; an update of the field must pass those too, or it deletes them and
// clears their items (probed 2026-11-12, #108). Overlapping iterations are dropped without an error,
// two iterations with the same start date included, and an iteration of zero days is refused
// (probed 2026-11-22, #202). So every layout here is back to back, each iteration at least one day.

export const ITERATION_FIELD = 'Iteration';

/** Days given to Now and to each planned iteration: Now ends on its goal, not on a date. */
export const LONG_DAYS = 365;

const DAY_MS = 86400000;

/** 'YYYY-MM-DD' of a Date, in UTC: "today" is the UTC day everywhere in this module. */
export function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  return isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export const endDay = (it) => addDays(it.startDate, it.duration);

const byStart = (a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0);

/**
 * The Now and Next pointers (ADR 0022). With `nowId`, the Now that `iteration promote` recorded, Now
 * is that iteration whatever the date, and Next is the first one that starts after it. With no
 * record, or a recorded id that is not in the field, Now is the iteration that holds `today` and Next
 * is the first one that starts after today. Either is null when there is none.
 * @param {{id: string, title: string, startDate: string, duration: number}[]} iterations  all of them
 * @param {string} today  'YYYY-MM-DD'
 * @param {string|null} [nowId]  the recorded Now, or null/undefined for none
 * @returns {{now: object|null, next: object|null, source: 'recorded'|'dates'}}
 */
export function pointers(iterations, today, nowId = null) {
  const list = [...(iterations ?? [])].sort(byStart);
  const recorded = nowId ? list.find((it) => it.id === nowId) ?? null : null;
  if (recorded) {
    const next = list.find((it) => it.startDate > recorded.startDate) ?? null;
    return { now: recorded, next, source: 'recorded' };
  }
  const now = list.find((it) => it.startDate <= today && today < endDay(it)) ?? null;
  const next = list.find((it) => it.startDate > today) ?? null;
  return { now, next, source: 'dates' };
}

/** The class of an item from its iteration id: 'now', 'next' or 'later'. */
export function classOfIteration(iterationId, ptrs) {
  if (iterationId && ptrs.now && iterationId === ptrs.now.id) return 'now';
  if (iterationId && ptrs.next && iterationId === ptrs.next.id) return 'next';
  return 'later';
}

/**
 * The role of an iteration for `iteration list`. With a recorded Now, an iteration before it is
 * completed and one after Next is planned, whatever the date; with none, the dates decide.
 */
export function roleOf(it, ptrs, today) {
  if (ptrs.now && it.id === ptrs.now.id) return 'now';
  if (ptrs.next && it.id === ptrs.next.id) return 'next';
  if (ptrs.source === 'recorded') return it.startDate < ptrs.now.startDate ? 'completed' : 'planned';
  return endDay(it) <= today ? 'completed' : 'planned';
}

export class IterationRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'IterationRefusal';
  }
}

/** The iteration of `list` named by `arg`: its id, or its exact title (one match only). */
export function findIteration(list, arg) {
  const byId = list.find((it) => it.id === arg);
  if (byId) return byId;
  const byTitle = list.filter((it) => it.title === arg);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new IterationRefusal(`${byTitle.length} iterations are titled "${arg}"; name one by its id`);
  return null;
}

/**
 * Every iteration of `before` must be in `after` by id. A missing id would delete that iteration
 * and clear its items, so the writers call this before every update.
 */
export function assertKeepsEveryId(before, after) {
  const ids = new Set(after.map((it) => it.id).filter(Boolean));
  const missing = before.filter((it) => !ids.has(it.id)).map((it) => it.id);
  if (missing.length > 0) throw new Error(`the update leaves out iteration ${missing.join(', ')}; it would clear their items`);
}

/**
 * Every iteration lasts at least one whole day and none overlaps another. GitHub refuses an iteration
 * of zero days and drops an overlapping one with no error, clearing its items (probed 2026-11-22,
 * #202), so the writers call this before every update.
 */
export function assertValidLayout(list) {
  for (const it of list) {
    if (!Number.isInteger(it.duration) || it.duration < 1) throw new Error(`iteration ${it.id ?? JSON.stringify(it.title)} lasts ${it.duration} days; GitHub needs at least 1`);
  }
  const sorted = [...list].sort(byStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startDate < endDay(sorted[i - 1])) {
      throw new Error(`iteration ${sorted[i].id ?? JSON.stringify(sorted[i].title)} overlaps ${sorted[i - 1].id ?? JSON.stringify(sorted[i - 1].title)}; GitHub would drop it and clear its items`);
    }
  }
}

/**
 * The layout after promote (ADR 0022). Now ends today, or keeps one day when it started today or
 * later: an iteration cannot have zero days. Next starts where the last kept iteration ends, but not
 * before today, for LONG_DAYS days; the planned iterations follow back to back, `chosen` first.
 * Completed iterations are kept as they are. `nowId` is the recorded Now; the result's `nowId` is
 * the Now to record. No date limits how often it runs.
 * @param {object[]} all  every iteration, completed ones included
 * @param {string} today
 * @param {string|null} chosen  id or title of the planned iteration to become the new Next
 * @param {string|null} [nowId]  the recorded Now
 * @returns {{iterations: object[], nowId: string, from: {now: object|null, next: object}, to: {now: object, next: object|null}}}
 */
export function planPromote(all, today, chosen = null, nowId = null) {
  const ptrs = pointers(all, today, nowId);
  if (!ptrs.next) throw new IterationRefusal('there is no Next iteration to promote; plan one first');
  let planned = all.filter((it) => it.startDate > ptrs.next.startDate).sort(byStart);
  let pick = null;
  if (chosen !== null) {
    pick = findIteration(planned, chosen);
    if (!pick) throw new IterationRefusal(`no planned iteration after Next is "${chosen}"`);
    planned = [pick, ...planned.filter((it) => it.id !== pick.id)];
  }
  const out = [];
  for (const it of all) {
    if (it.id === ptrs.next.id || planned.some((p) => p.id === it.id)) continue;
    if (ptrs.now && it.id === ptrs.now.id) out.push({ ...it, duration: Math.max(1, daysBetween(it.startDate, today)) });
    else out.push({ ...it });
  }
  const lastEnd = out.map(endDay).sort().at(-1);
  const newNow = { ...ptrs.next, startDate: lastEnd && lastEnd > today ? lastEnd : today, duration: LONG_DAYS };
  out.push(newNow);
  let start = endDay(newNow);
  for (const it of planned) {
    out.push({ ...it, startDate: start });
    start = endDay({ ...it, startDate: start });
  }
  assertKeepsEveryId(all, out);
  assertValidLayout(out);
  out.sort(byStart);
  return { iterations: out, nowId: newNow.id, from: ptrs, to: pointers(out, today, newNow.id) };
}

/**
 * The layout after planning a new iteration: it starts where the last one ends, or today when no
 * iteration ends after today (it then becomes Now). It lasts LONG_DAYS days.
 */
export function planAppend(all, today, title) {
  if (typeof title !== 'string' || title.trim() === '') throw new IterationRefusal('the title is empty');
  const lastEnd = all.map(endDay).sort().at(-1);
  const start = lastEnd && lastEnd > today ? lastEnd : today;
  const added = { title, startDate: start, duration: LONG_DAYS };
  const out = [...all.map((it) => ({ ...it })), added].sort(byStart);
  assertKeepsEveryId(all, out);
  return { iterations: out, added };
}

/**
 * Compare a readback with the layout that was written. Returns a list of problems (empty when it
 * agrees). A new iteration (no id) is matched by its title and start date.
 */
export function compareLayout(wanted, actual) {
  const problems = [];
  for (const w of wanted) {
    const a = w.id ? actual.find((x) => x.id === w.id) : actual.find((x) => !wanted.some((y) => y.id === x.id) && x.title === w.title);
    if (!a) {
      problems.push(`iteration ${w.id ?? JSON.stringify(w.title)} is missing`);
      continue;
    }
    if (a.startDate !== w.startDate || a.duration !== w.duration || a.title !== w.title) {
      problems.push(`iteration ${a.id} reads ${a.startDate}+${a.duration} "${a.title}", wanted ${w.startDate}+${w.duration} "${w.title}"`);
    }
  }
  return problems;
}
