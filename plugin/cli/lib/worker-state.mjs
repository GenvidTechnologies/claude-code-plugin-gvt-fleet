// Reads the worker records that the hook script appends and classifies each worker's state.
//
// The read is bounded: it takes only the last tailBytes of each worker file, so a status read never
// replays a long history. The classification is provisional: the status command is expected to refine it.
import fs from 'node:fs';
import path from 'node:path';

const NEEDS_YOU_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
  'idle_prompt',
]);
const RATE_LIMITED_NOTIFICATIONS = new Set(['quota_auto_resume_stale', 'quota_auto_resume_disabled']);

/**
 * Maps the latest record to { state, reason, detail }. A record that says nothing about the state
 * (other notifications, unknown events) takes the state of `previous`, else 'working'.
 */
export function classifyRecord(latest, previous) {
  const fallThrough = () => (previous ? classifyRecord(previous, null) : { state: 'working', reason: null, detail: null });
  if (!latest) return fallThrough();
  switch (latest.event) {
    case 'SessionStart':
    case 'PreToolUse':
      return { state: 'working', reason: null, detail: null };
    case 'Notification': {
      const type = latest.notification_type;
      if (NEEDS_YOU_NOTIFICATIONS.has(type)) {
        return { state: 'needs-you', reason: `notification:${type}`, detail: latest.message ?? null };
      }
      if (RATE_LIMITED_NOTIFICATIONS.has(type)) {
        return { state: 'rate-limited', reason: `notification:${type}`, detail: null };
      }
      return fallThrough();
    }
    case 'Stop':
      return { state: 'needs-you', reason: 'turn-ended', detail: latest.last_message ?? null };
    case 'StopFailure':
      if (latest.error === 'rate_limit') return { state: 'rate-limited', reason: 'error:rate_limit', detail: null };
      return { state: 'needs-you', reason: `error:${latest.error ?? 'unknown'}`, detail: null };
    case 'SessionEnd':
      return { state: 'done', reason: `end:${latest.reason}`, detail: null };
    default:
      return fallThrough();
  }
}

const isIdlePrompt = (r) => r?.event === 'Notification' && r.notification_type === 'idle_prompt';
const isPermissionPrompt = (r) => r?.event === 'Notification' && r.notification_type === 'permission_prompt';
const isAskCall = (r) =>
  r?.event === 'PreToolUse' && r.tool_name === 'AskUserQuestion' && Array.isArray(r.questions) && r.questions.length > 0;

/** One line per question: `<question> [<label> | <label>]`, or just `<question>` when it has no options. */
function questionsText(questions) {
  return questions
    .filter((q) => q !== null && typeof q === 'object' && typeof q.question === 'string')
    .map((q) => (Array.isArray(q.options) && q.options.length > 0 ? `${q.question} [${q.options.join(' | ')}]` : q.question))
    .join('\n');
}

/**
 * classifyRecord plus `since` and `questions`. For an idle_prompt whose turn Stop (`turnStop`) has a non-empty last
 * message, `detail` is that message and `since` is the time of that Stop.
 * `ask` is `{ pre, prompt }` from readWorkerRecords: the PreToolUse record of an AskUserQuestion call and the
 * permission_prompt that directly followed it. When `latest` is that permission_prompt, or an idle_prompt after it,
 * the wait is the question: `detail` lists each question with its option labels, `since` is the time of the
 * permission_prompt and `questions` is the recorded list. Otherwise `questions` is null.
 */
export function classifySession(latest, previous, turnStop, ask = null) {
  const cls = { ...classifyRecord(latest, previous), since: latest?.recorded_at ?? null, questions: null };
  if (ask?.prompt && (isPermissionPrompt(latest) || isIdlePrompt(latest)) && latest.session_id === ask.prompt.session_id) {
    return {
      state: 'needs-you',
      reason: 'notification:permission_prompt',
      detail: questionsText(ask.pre.questions),
      since: ask.prompt.recorded_at ?? cls.since,
      questions: ask.pre.questions,
    };
  }
  const msg = turnStop?.last_message;
  if (isIdlePrompt(latest) && turnStop?.event === 'Stop' && typeof msg === 'string' && msg !== '') {
    return { ...cls, detail: msg, since: turnStop.recorded_at ?? cls.since };
  }
  return cls;
}

function readTail(file, tailBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString('utf8'), bytesRead: got, partialStart: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, partialStart) {
  const lines = text.split('\n');
  lines.pop(); // the text after the last newline: empty, or a line still being written
  if (partialStart) lines.shift(); // the read began mid-line
  const records = [];
  for (const line of lines) {
    if (line === '') continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') records.push(rec);
    } catch {
      // A line that does not parse is skipped.
    }
  }
  return records;
}

const dirs = (p) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

/** One entry per worker file under <stateDir>/workers/<owner>/<repoName>/, sorted by repo then worktree. */
export function readWorkerRecords(stateDir, { tailBytes = 65536 } = {}) {
  const root = path.join(stateDir, 'workers');
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const owner of dirs(root)) {
    for (const repoName of dirs(path.join(root, owner))) {
      const folder = path.join(root, owner, repoName);
      for (const name of fs.readdirSync(folder)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(folder, name);
        const { text, bytesRead, partialStart } = readTail(file, tailBytes);
        const records = parseLines(text, partialStart);
        const latest = records.at(-1) ?? null;
        const previous = records.length > 1 ? records.at(-2) : null;
        const sessions = new Map();
        // turnStops: the Stop that ended the session's last turn, kept across later idle_prompt records only.
        const turnStops = new Map();
        // pending: per session, the AskUserQuestion call and the permission_prompt that directly followed it.
        // An idle_prompt keeps the pair only after that permission_prompt; any other record ends it.
        const pending = new Map();
        for (const r of records) {
          sessions.set(r.session_id, r);
          if (r.event === 'Stop') turnStops.set(r.session_id, r);
          else if (!isIdlePrompt(r)) turnStops.delete(r.session_id);
          const ask = pending.get(r.session_id);
          if (isAskCall(r)) pending.set(r.session_id, { pre: r, prompt: null });
          else if (isPermissionPrompt(r) && ask && ask.prompt === null) ask.prompt = r;
          else if (!(isIdlePrompt(r) && ask && ask.prompt !== null)) pending.delete(r.session_id);
        }
        // asks: the pairs that have their permission_prompt.
        const asks = new Map([...pending].filter(([, a]) => a.prompt !== null));
        const cls = latest
          ? classifySession(latest, previous, turnStops.get(latest.session_id) ?? null, asks.get(latest.session_id) ?? null)
          : { state: null, reason: null, detail: null, since: null, questions: null };
        entries.push({
          repo: `${owner}/${repoName}`,
          worktree: name.slice(0, -'.jsonl'.length),
          issue: latest?.issue ?? null,
          file,
          bytesRead,
          records: records.length,
          latest,
          previous,
          sessions,
          turnStops,
          asks,
          state: cls.state,
          reason: cls.reason,
          detail: cls.detail,
          since: cls.since,
          questions: cls.questions,
        });
      }
    }
  }
  entries.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.worktree < b.worktree ? -1 : a.worktree > b.worktree ? 1 : 0));
  return entries;
}
