// Worker records written by the hook script, one JSON line per hook event.
//
// Each event is one fs.appendFileSync of one line. An append is safe under concurrent writers on
// Windows; a rename over a shared file is not. Records go to one file per worktree because a resume
// can change session_id but never the worktree. The hook runs in every Claude Code session, so this
// module may import only node:fs, node:path, node:url and ./worktree-path.mjs.
import fs from 'node:fs';
import path from 'node:path';

const TEXT_CAP = 2000;
const LINE_CAP = 8192;

const PATH_CAP = 1000;

const capped = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
const head = (s) => (typeof s === 'string' ? s.slice(0, TEXT_CAP) : s);
const tail = (s) => (typeof s === 'string' ? s.slice(-TEXT_CAP) : s);

/** Fields lifted from the payload per event: [recordName, payloadName, transform]. */
const lastMessage = [
  ['last_message', 'last_assistant_message', tail],
  ['last_message_length', 'last_assistant_message', (s) => (typeof s === 'string' ? s.length : s)],
];
const FIELDS = {
  SessionStart: [
    ['source', 'source', head],
    ['model', 'model', head],
    ['session_title', 'session_title', head],
  ],
  Notification: [
    ['notification_type', 'notification_type', (s) => capped(s, PATH_CAP)],
    ['message', 'message', head],
    ['title', 'title', head],
  ],
  Stop: lastMessage,
  StopFailure: [['error', 'error', head], ['error_details', 'error_details', head], ...lastMessage],
  SessionEnd: [['reason', 'reason', head]],
  PreToolUse: [
    ['tool_name', 'tool_name', (s) => capped(s, PATH_CAP)],
    ['tool_use_id', 'tool_use_id', (s) => capped(s, PATH_CAP)],
  ],
};
const ALWAYS_TOP = ['hook_event_name', 'session_id', 'cwd', 'last_assistant_message'];

const ASK_TOOL = 'AskUserQuestion';
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const QUESTION_CAP = 600;
const HEADER_CAP = 60;
const LABEL_CAP = 120;
const QUESTIONS_BYTES = 6000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The questions of an AskUserQuestion call as [{question, header, options: [label], multiSelect}], capped. */
function askedQuestions(toolInput) {
  const list = isObject(toolInput) && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const out = [];
  for (const q of list) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!isObject(q) || typeof q.question !== 'string') continue;
    const options = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (options.length >= MAX_OPTIONS) break;
      if (isObject(o) && typeof o.label === 'string') options.push(o.label.slice(0, LABEL_CAP));
    }
    out.push({
      question: q.question.slice(0, QUESTION_CAP),
      header: typeof q.header === 'string' ? q.header.slice(0, HEADER_CAP) : null,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  // The caps count characters, but the line cap counts bytes: drop trailing questions until the list fits in
  // QUESTIONS_BYTES, so the record keeps its questions. One question at its caps fits, even in 3-byte characters.
  while (out.length > 1 && Buffer.byteLength(JSON.stringify(out)) > QUESTIONS_BYTES) out.pop();
  return out;
}

export function workerFile(stateDir, parsed) {
  return path.join(stateDir, 'workers', parsed.owner, parsed.repoName, parsed.worktree + '.jsonl');
}

export function buildRecord(payload, parsed, { now = new Date() } = {}) {
  const event = payload.hook_event_name;
  const record = {
    v: 1,
    recorded_at: now.toISOString(),
    event: capped(event, PATH_CAP),
    session_id: capped(payload.session_id, PATH_CAP),
    cwd: capped(payload.cwd, PATH_CAP),
    repo: capped(parsed.repo, PATH_CAP),
    worktree: capped(parsed.worktree, PATH_CAP),
    issue: parsed.issue ?? null,
  };
  const used = new Set(ALWAYS_TOP);
  const fields = Object.hasOwn(FIELDS, event) ? FIELDS[event] : [];
  for (const [name, from, fn] of fields) {
    used.add(from);
    const value = payload[from];
    if (value !== undefined) record[name] = fn ? fn(value) : value;
  }
  if (event === 'PreToolUse') {
    // tool_input is never stored whole: only the questions of an AskUserQuestion call are kept.
    used.add('tool_input');
    if (payload.tool_name === ASK_TOOL) {
      const questions = askedQuestions(payload.tool_input);
      if (questions.length > 0) record.questions = questions;
    }
  }
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!used.has(k)) extra[k] = v;
  }
  record.extra = extra;
  return record;
}

export function serializeRecord(record) {
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line) <= LINE_CAP) return line;
  const { extra, ...core } = record;
  const noExtra = JSON.stringify({ ...core, extra_dropped: true }) + '\n';
  if (Buffer.byteLength(noExtra) <= LINE_CAP) return noExtra;
  const { last_message, message, error_details, questions, ...small } = core;
  return JSON.stringify({ ...small, extra_dropped: true, fields_truncated: true }) + '\n';
}

export function appendRecord(stateDir, parsed, payload, opts) {
  const file = workerFile(stateDir, parsed);
  const line = serializeRecord(buildRecord(payload, parsed, opts));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  return file;
}

/** Records a hook failure. Never throws: a broken log must not break a session. */
export function appendHookError(stateDir, error, context = {}) {
  try {
    const record = {
      v: 1,
      recorded_at: new Date().toISOString(),
      message: String(error && error.message !== undefined ? error.message : error),
      stack: String((error && error.stack) || '').slice(0, TEXT_CAP),
      ...context,
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'hook-errors.jsonl'), JSON.stringify(record) + '\n');
  } catch {
    // Swallowed on purpose.
  }
}
