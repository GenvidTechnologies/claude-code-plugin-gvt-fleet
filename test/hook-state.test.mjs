process.env.GVT_FLEET_FAKE_ONLY = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorktreeCwd } from '../lib/worktree-path.mjs';
import { buildRecord, serializeRecord, appendRecord, workerFile } from '../lib/hook-state.mjs';
import { classifyRecord, classifySession, readWorkerRecords } from '../lib/worker-state.mjs';

const WS = 'C:/work/fleet';
const here = path.dirname(fileURLToPath(import.meta.url));
const events = fs
  .readFileSync(path.join(here, 'fixtures', 'probe-events.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

/** First captured payload for an event name whose cwd is inside a managed worktree. */
function sample(name) {
  const hit = events.find((e) => e.payload.hook_event_name === name && parseWorktreeCwd(e.payload.cwd, WS));
  assert.ok(hit, `fixture has a ${name} sample in a worktree`);
  return { payload: structuredClone(hit.payload), parsed: parseWorktreeCwd(hit.payload.cwd, WS) };
}

const NOW = new Date('2026-11-04T10:00:00.000Z');

test('R31: the record keeps source, notification type and message, error and reason', () => {
  const start = sample('SessionStart');
  const rs = buildRecord(start.payload, start.parsed, { now: NOW });
  assert.equal(rs.v, 1);
  assert.equal(rs.recorded_at, NOW.toISOString());
  assert.equal(rs.event, 'SessionStart');
  assert.equal(rs.session_id, start.payload.session_id);
  assert.equal(rs.worktree, start.parsed.worktree);
  assert.equal(rs.repo, start.parsed.repo);
  assert.equal(rs.issue, null);
  assert.equal(rs.source, start.payload.source);
  assert.ok('source' in rs);

  const note = sample('Notification');
  const rn = buildRecord(note.payload, note.parsed, { now: NOW });
  assert.equal(rn.notification_type, note.payload.notification_type);
  assert.equal(rn.message, note.payload.message.slice(0, 2000));

  const end = sample('SessionEnd');
  const re = buildRecord(end.payload, end.parsed, { now: NOW });
  assert.equal(re.reason, end.payload.reason);
  assert.ok('reason' in re);

  const fail = {
    hook_event_name: 'StopFailure',
    session_id: 's1',
    cwd: start.payload.cwd,
    error: 'rate_limit',
    error_details: 'x'.repeat(3000),
    last_assistant_message: 'tail text',
  };
  const rf = buildRecord(fail, start.parsed, { now: NOW });
  assert.equal(rf.error, 'rate_limit');
  assert.equal(rf.error_details.length, 2000);
  assert.equal(rf.last_message, 'tail text');
  assert.equal(rf.last_message_length, 9);
});

test('R31: a Stop record keeps the tail of last_assistant_message and its length', () => {
  const { payload, parsed } = sample('Stop');
  payload.last_assistant_message = 'a'.repeat(3000) + 'b'.repeat(2000);
  const r = buildRecord(payload, parsed, { now: NOW });
  assert.equal(r.last_message, 'b'.repeat(2000));
  assert.equal(r.last_message_length, 5000);
  assert.ok(!('last_assistant_message' in r));
  assert.ok(!r.extra || !('last_assistant_message' in r.extra));
});

test('R34: an unknown notification_type and unknown fields are stored without error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvt-hook-state-'));
  try {
    const { payload, parsed } = sample('Notification');
    payload.notification_type = 'brand_new_type';
    payload.zzz = { a: 1 };
    const file = appendRecord(tmp, parsed, payload, { now: NOW });
    assert.equal(file, workerFile(tmp, parsed));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(!raw.includes('\r'));
    const lines = raw.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.notification_type, 'brand_new_type');
    assert.deepEqual(rec.extra.zzz, { a: 1 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R34: a record over 8 KB drops extra and keeps the core fields', () => {
  const { payload, parsed } = sample('Notification');
  payload.big_unknown = 'z'.repeat(20000);
  const record = buildRecord(payload, parsed, { now: NOW });
  const line = serializeRecord(record);
  assert.ok(Buffer.byteLength(line) <= 8192);
  assert.ok(line.endsWith('\n'));
  const rec = JSON.parse(line);
  assert.equal(rec.extra_dropped, true);
  assert.ok(!('extra' in rec));
  assert.equal(rec.event, 'Notification');
  assert.equal(rec.session_id, payload.session_id);
  assert.equal(rec.notification_type, payload.notification_type);
  assert.equal(rec.worktree, parsed.worktree);

  // The core fields are capped, so the worst case still fits.
  const worst = { ...payload, message: 'm'.repeat(5000), title: 't'.repeat(20) };
  assert.ok(Buffer.byteLength(serializeRecord(buildRecord(worst, parsed, { now: NOW }))) <= 8192);
});

test('R34: a record with oversized core fields still serializes under 8 KB', () => {
  const big = 'q'.repeat(20000);
  const start = sample('SessionStart');
  start.payload.session_title = big;
  start.payload.model = big;
  const note = sample('Notification');
  note.payload.title = big;
  for (const { payload, parsed } of [start, note]) {
    const line = serializeRecord(buildRecord(payload, parsed, { now: NOW }));
    assert.ok(Buffer.byteLength(line) <= 8192, payload.hook_event_name);
    assert.ok(line.endsWith('\n'));
    assert.equal(JSON.parse(line).event, payload.hook_event_name);
  }
});

const WT12 ='C:\\tmp\\ws\\repos\\o\\construct3-chef\\.claude\\worktrees\\construct3-chef-12';
const parsed12 = () => parseWorktreeCwd(WT12, 'C:/tmp/ws');

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvt-worker-state-'));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const payloadOf = (extra) => ({ session_id: 's1', cwd: WT12, ...extra });

test('R32: the reader returns the latest record per worker from the last 64 KB only', () => {
  withTmp((tmp) => {
    const parsed = parsed12();
    const total = 400;
    for (let i = 0; i < total; i++) {
      appendRecord(
        tmp,
        parsed,
        payloadOf({ hook_event_name: 'Stop', last_assistant_message: `turn ${i} ` + 'x'.repeat(600), counter: i }),
        { now: new Date(NOW.getTime() + i) },
      );
    }
    const file = workerFile(tmp, parsed);
    assert.ok(fs.statSync(file).size > 200 * 1024);
    const entries = readWorkerRecords(tmp);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry.bytesRead <= 65536);
    assert.ok(entry.records < total);
    assert.ok(entry.records > 0);
    const lastLine = fs.readFileSync(file, 'utf8').trimEnd().split('\n').at(-1);
    assert.deepEqual(entry.latest, JSON.parse(lastLine));
    assert.equal(entry.latest.extra.counter, total - 1);
  });
});

test('R32: classifyRecord maps each event to working, needs-you, rate-limited or done', () => {
  const rec = (event, fields = {}) => ({ event, ...fields });
  const note = (type, message) => rec('Notification', { notification_type: type, message });
  const cases = [
    [rec('SessionStart'), undefined, 'working', null, null],
    ...['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'idle_prompt'].map(
      (t) => [note(t, 'msg ' + t), undefined, 'needs-you', `notification:${t}`, 'msg ' + t],
    ),
    ...['quota_auto_resume_stale', 'quota_auto_resume_disabled'].map((t) => [
      note(t, 'q'),
      undefined,
      'rate-limited',
      `notification:${t}`,
      null,
    ]),
    [note('auth_success', 'ok'), rec('Stop', { last_message: 'done' }), 'needs-you', 'turn-ended', 'done'],
    [note('brand_new_type', 'ok'), rec('Stop', { last_message: 'done' }), 'needs-you', 'turn-ended', 'done'],
    [note('brand_new_type', 'ok'), undefined, 'working', null, null],
    [rec('Stop', { last_message: 'all done' }), undefined, 'needs-you', 'turn-ended', 'all done'],
    [rec('StopFailure', { error: 'rate_limit' }), undefined, 'rate-limited', 'error:rate_limit', null],
    [rec('StopFailure', { error: 'overloaded' }), undefined, 'needs-you', 'error:overloaded', null],
    [rec('SessionEnd', { reason: 'logout' }), undefined, 'done', 'end:logout', null],
    [rec('BrandNewEvent'), rec('SessionEnd', { reason: 'clear' }), 'done', 'end:clear', null],
    [rec('BrandNewEvent'), undefined, 'working', null, null],
  ];
  for (const [latest, previous, state, reason, detail] of cases) {
    assert.deepEqual(
      classifyRecord(latest, previous),
      { state, reason, detail },
      `${latest.event} ${latest.notification_type ?? latest.error ?? ''}`,
    );
  }
});

test('R33: records of two session ids in one worktree land in one worker file', () => {
  withTmp((tmp) => {
    const parsed = parsed12();
    appendRecord(tmp, parsed, payloadOf({ hook_event_name: 'SessionStart', session_id: 'sess-a' }), { now: NOW });
    appendRecord(tmp, parsed, payloadOf({ hook_event_name: 'SessionStart', session_id: 'sess-b' }), { now: NOW });
    const entries = readWorkerRecords(tmp);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.sessions.size, 2);
    assert.deepEqual([...entry.sessions.keys()].sort(), ['sess-a', 'sess-b']);
    const lines = fs.readFileSync(workerFile(tmp, parsed), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const r of lines) {
      assert.equal(r.worktree, 'construct3-chef-12');
      assert.equal(r.issue, 'o/construct3-chef#12');
    }
  });
});

test('R42: the reader gives issue key, state, time, reason and last message excerpt per worker', () => {
  withTmp((tmp) => {
    const p12 = parsed12();
    const when = new Date('2026-11-04T11:22:33.000Z');
    appendRecord(
      tmp,
      p12,
      payloadOf({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to run Bash',
      }),
      { now: when },
    );
    const p13 = parseWorktreeCwd(WT12.replace(/-12$/, '-13'), 'C:/tmp/ws');
    const long = 'a'.repeat(3000) + 'THE END';
    appendRecord(tmp, p13, payloadOf({ hook_event_name: 'Stop', last_assistant_message: long }), { now: when });

    const entries = readWorkerRecords(tmp);
    assert.deepEqual(entries.map((e) => e.worktree), ['construct3-chef-12', 'construct3-chef-13']);
    const [a, b] = entries;
    assert.equal(a.repo, 'o/construct3-chef');
    assert.equal(a.issue, 'o/construct3-chef#12');
    assert.equal(a.state, 'needs-you');
    assert.equal(a.since, when.toISOString());
    assert.equal(a.reason, 'notification:permission_prompt');
    assert.equal(a.detail, 'Claude needs your permission to run Bash');
    assert.equal(b.issue, 'o/construct3-chef#13');
    assert.equal(b.state, 'needs-you');
    assert.equal(b.reason, 'turn-ended');
    assert.equal(b.detail, long.slice(-2000));
    assert.ok(b.detail.endsWith('THE END'));
  });
});

const IDLE_TEXT = 'Claude is waiting for your input';
function appendTurn(tmp) {
  const parsed = parsed12();
  const at = (s) => new Date(NOW.getTime() + s * 1000);
  appendRecord(tmp, parsed, payloadOf({ hook_event_name: 'SessionStart' }), { now: at(0) });
  appendRecord(tmp, parsed, payloadOf({ hook_event_name: 'Stop', last_assistant_message: 'Shall I proceed with option A?' }), { now: at(10) });
  appendRecord(tmp, parsed, payloadOf({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: IDLE_TEXT }), { now: at(70) });
  return { stopTime: at(10).toISOString(), idleTime: at(70).toISOString() };
}

test('R124: classifySession gives the Stop message and time for an idle_prompt, and the notification when there is no Stop', () => {
  withTmp((tmp) => {
    const { stopTime, idleTime } = appendTurn(tmp);
    const [entry] = readWorkerRecords(tmp);
    const { latest, previous } = entry;
    assert.equal(latest.notification_type, 'idle_prompt');
    assert.equal(previous.event, 'Stop');
    const withStop = classifySession(latest, previous, previous);
    assert.equal(withStop.state, 'needs-you');
    assert.equal(withStop.reason, 'notification:idle_prompt');
    assert.equal(withStop.detail, 'Shall I proceed with option A?');
    assert.equal(withStop.since, stopTime);
    const without = classifySession(latest, previous, null);
    assert.equal(without.reason, 'notification:idle_prompt');
    assert.equal(without.detail, IDLE_TEXT);
    assert.equal(without.since, idleTime);
    const permission = { ...latest, notification_type: 'permission_prompt', message: 'Claude needs your permission' };
    const other = classifySession(permission, previous, previous);
    assert.equal(other.reason, 'notification:permission_prompt');
    assert.equal(other.detail, 'Claude needs your permission');
    assert.equal(other.since, idleTime);
  });
});

test('R124: the reader keeps the turn Stop of each session and uses it for the entry detail and since', () => {
  withTmp((tmp) => {
    const { stopTime } = appendTurn(tmp);
    const [entry] = readWorkerRecords(tmp);
    assert.ok(entry.turnStops instanceof Map);
    assert.equal(entry.turnStops.get('s1'), entry.previous);
    assert.equal(entry.turnStops.get('s1').event, 'Stop');
    assert.equal(entry.reason, 'notification:idle_prompt');
    assert.equal(entry.detail, 'Shall I proceed with option A?');
    assert.equal(entry.since, stopTime);
  });
});

// ---- the questions of an AskUserQuestion call ----

const QUESTIONS = [
  {
    question: 'Which colour?',
    header: 'Colour',
    options: [
      { label: 'Red', description: 'Choose red' },
      { label: 'Blue', description: 'Choose blue' },
    ],
    multiSelect: false,
  },
];
const RECORDED = [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'], multiSelect: false }];
const ASK_DETAIL = 'Which colour? [Red | Blue]';
const PERMISSION_TEXT = 'Claude needs your permission';
const askPayload = (over = {}) =>
  payloadOf({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: QUESTIONS }, ...over });
const permissionPayload = (over = {}) =>
  payloadOf({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: PERMISSION_TEXT, ...over });
const idlePayload = (over = {}) =>
  payloadOf({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: IDLE_TEXT, ...over });
const stopPayload = (over = {}) => payloadOf({ hook_event_name: 'Stop', last_assistant_message: 'Done with the colour.', ...over });
const sec = (s) => new Date(NOW.getTime() + s * 1000);
/** Writes each [payload, seconds] pair as a record of worktree construct3-chef-12, then reads the worker entry back. */
function writeSteps(tmp, steps) {
  for (const [payload, s] of steps) appendRecord(tmp, parsed12(), payload, { now: sec(s) });
  const [entry] = readWorkerRecords(tmp);
  return entry;
}

test('R197: a PreToolUse record for AskUserQuestion keeps tool_name, tool_use_id and the questions, and no tool_input', () => {
  const r = buildRecord(askPayload(), parsed12(), { now: NOW });
  assert.equal(r.event, 'PreToolUse');
  assert.equal(r.tool_name, 'AskUserQuestion');
  assert.equal(r.tool_use_id, 'toolu_1');
  assert.deepEqual(r.questions, RECORDED);
  assert.ok(!('tool_input' in r));
  assert.ok(!('tool_input' in r.extra));
  assert.deepEqual(r.extra, {});
  // Option descriptions are not kept; only the labels.
  assert.ok(!JSON.stringify(r).includes('Choose red'));
});

test('R197: a PreToolUse record for another tool keeps the tool name and id, and no questions and no tool_input', () => {
  const bash = askPayload({ tool_name: 'Bash', tool_input: { command: 'rm -rf x', questions: QUESTIONS } });
  const r = buildRecord(bash, parsed12(), { now: NOW });
  assert.equal(r.tool_name, 'Bash');
  assert.equal(r.tool_use_id, 'toolu_1');
  assert.ok(!('questions' in r));
  assert.ok(!('tool_input' in r));
  assert.ok(!('tool_input' in r.extra));
  assert.ok(!JSON.stringify(r).includes('rm -rf'));
});

test('R197: the recorded questions are capped and malformed entries are skipped', () => {
  const longOptions = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`.padEnd(300, 'l') }));
  const questions = [
    { question: 'q'.repeat(900), header: 'h'.repeat(100), options: longOptions, multiSelect: true },
    'not an object',
    { header: 'no question text', options: [] },
    { question: 'no header', options: [{ label: 'a' }, { description: 'no label' }, null, 'x'], multiSelect: 'yes' },
    { question: 'header is a number', header: 7 },
    { question: 'third kept' },
    { question: 'fifth, dropped by the cap' },
  ];
  const r = buildRecord(askPayload({ tool_input: { questions } }), parsed12(), { now: NOW });
  assert.equal(r.questions.length, 4);
  assert.equal(r.questions[0].question, 'q'.repeat(600));
  assert.equal(r.questions[0].header, 'h'.repeat(60));
  assert.equal(r.questions[0].options.length, 6);
  assert.ok(r.questions[0].options.every((l) => l.length === 120));
  assert.equal(r.questions[0].multiSelect, true);
  assert.deepEqual(r.questions[1], { question: 'no header', header: null, options: ['a'], multiSelect: false });
  assert.deepEqual(r.questions[2], { question: 'header is a number', header: null, options: [], multiSelect: false });
  assert.deepEqual(r.questions[3], { question: 'third kept', header: null, options: [], multiSelect: false });
  // Nothing usable: no questions key at all.
  for (const tool_input of [{ questions: [] }, { questions: ['x', { header: 'h' }] }, { questions: 'x' }, {}, 'x', null]) {
    const none = buildRecord(askPayload({ tool_input }), parsed12(), { now: NOW });
    assert.ok(!('questions' in none), JSON.stringify(tool_input));
    assert.ok(!('tool_input' in none.extra), JSON.stringify(tool_input));
  }
});

test('R197: the record of the real probe payload stays under 8 KB and keeps the question', () => {
  const [pre] = askFixture();
  const parsed = parseWorktreeCwd(pre.cwd, 'C:/ws');
  assert.ok(parsed, 'the fixture cwd is a worktree of the test workspace');
  const line = serializeRecord(buildRecord(pre, parsed, { now: NOW }));
  assert.ok(Buffer.byteLength(line) < 8192);
  const rec = JSON.parse(line);
  assert.equal(rec.tool_name, 'AskUserQuestion');
  assert.equal(rec.tool_use_id, pre.tool_use_id);
  assert.deepEqual(rec.questions, RECORDED);
  assert.ok(!('extra_dropped' in rec));
});

test('R197: a record that is still over 8 KB without extra drops the questions last', () => {
  const questions = Array.from({ length: 4 }, (_, i) => ({
    question: `${i}`.repeat(600),
    header: 'h'.repeat(60),
    options: Array.from({ length: 6 }, () => ({ label: 'o'.repeat(120) })),
    multiSelect: false,
  }));
  const payload = askPayload({ session_id: 's'.repeat(1000), cwd: 'c'.repeat(1000), tool_use_id: 't'.repeat(1000), tool_input: { questions } });
  const record = buildRecord(payload, parsed12(), { now: NOW });
  assert.equal(record.questions.length, 4);
  const { extra, ...core } = record;
  assert.ok(Buffer.byteLength(JSON.stringify({ ...core, extra_dropped: true })) > 8192, 'the questions are what keeps the core over the cap');
  const line = serializeRecord(record);
  assert.ok(Buffer.byteLength(line) <= 8192);
  const rec = JSON.parse(line);
  assert.ok(!('questions' in rec));
  assert.equal(rec.fields_truncated, true);
  assert.equal(rec.event, 'PreToolUse');
  assert.equal(rec.tool_name, 'AskUserQuestion');
});

test('R197: questions in 3-byte characters drop trailing questions so the record line keeps the first one', () => {
  const wide = (n) => String.fromCharCode(0x4e00).repeat(n);
  const questions = Array.from({ length: 4 }, (_, i) => ({
    question: `${i}${wide(599)}`,
    header: wide(60),
    options: Array.from({ length: 6 }, () => ({ label: wide(120) })),
    multiSelect: false,
  }));
  const record = buildRecord(askPayload({ tool_input: { questions } }), parsed12(), { now: NOW });
  assert.ok(record.questions.length >= 1 && record.questions.length < 4, `kept ${record.questions.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(record.questions)) <= 6000);
  assert.ok(record.questions[0].question.startsWith('0'));
  const line = serializeRecord(record);
  assert.ok(Buffer.byteLength(line) <= 8192);
  const rec = JSON.parse(line);
  assert.deepEqual(rec.questions, record.questions);
  assert.ok(!('fields_truncated' in rec));
});

function askFixture() {
  return fs
    .readFileSync(path.join(here, 'fixtures', 'ask-user-question-events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

test('R198: an AskUserQuestion call and then its permission_prompt give a needs-you wait that shows the question', () => {
  withTmp((tmp) => {
    const entry = writeSteps(tmp, [[askPayload(), 5], [permissionPayload(), 6]]);
    assert.equal(entry.state, 'needs-you');
    assert.equal(entry.reason, 'notification:permission_prompt');
    assert.equal(entry.detail, ASK_DETAIL);
    assert.equal(entry.since, sec(6).toISOString());
    assert.deepEqual(entry.questions, RECORDED);
    assert.deepEqual([...entry.asks.keys()], ['s1']);
    // The per-session path that status takes gives the same result.
    const cls = classifySession(entry.sessions.get('s1'), null, null, entry.asks.get('s1'));
    assert.deepEqual(cls, { state: 'needs-you', reason: 'notification:permission_prompt', detail: ASK_DETAIL, since: sec(6).toISOString(), questions: RECORDED });
    // Several questions: one line each, and a question without options has no brackets.
    const two = { questions: [QUESTIONS[0], { question: 'Free text?' }] };
    const again = writeSteps(tmp, [[askPayload({ tool_input: two }), 20], [permissionPayload(), 21]]);
    assert.equal(again.detail, `${ASK_DETAIL}\nFree text?`);
    assert.equal(again.questions.length, 2);
  });
});

test('R198: idle_prompt records after the question keep the same wait, detail and since', () => {
  withTmp((tmp) => {
    const one = writeSteps(tmp, [[askPayload(), 5], [permissionPayload(), 6], [idlePayload(), 66]]);
    assert.equal(one.latest.notification_type, 'idle_prompt');
    assert.equal(one.state, 'needs-you');
    assert.equal(one.reason, 'notification:permission_prompt');
    assert.equal(one.detail, ASK_DETAIL);
    assert.equal(one.since, sec(6).toISOString());
    assert.deepEqual(one.questions, RECORDED);
    const two = writeSteps(tmp, [[idlePayload(), 126]]);
    assert.equal(two.records, 4);
    assert.equal(two.reason, 'notification:permission_prompt');
    assert.equal(two.detail, ASK_DETAIL);
    assert.equal(two.since, sec(6).toISOString());
    assert.deepEqual(two.questions, RECORDED);
  });
});

test('R198: a permission_prompt that does not directly follow the question keeps the generic message and no questions', () => {
  withTmp((tmp) => {
    // The question was answered; the next tool then asks for its own permission.
    const next = writeSteps(tmp, [[askPayload(), 5], [permissionPayload(), 6], [permissionPayload({ message: 'Claude needs your permission to use Bash' }), 40]]);
    assert.equal(next.reason, 'notification:permission_prompt');
    assert.equal(next.detail, 'Claude needs your permission to use Bash');
    assert.equal(next.since, sec(40).toISOString());
    assert.equal(next.questions, null);
    assert.equal(next.asks.size, 0);
  });
  withTmp((tmp) => {
    // Another record between the question and the prompt breaks the pair.
    const between = writeSteps(tmp, [
      [askPayload(), 5],
      [payloadOf({ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' }), 6],
      [permissionPayload(), 7],
    ]);
    assert.equal(between.detail, PERMISSION_TEXT);
    assert.equal(between.questions, null);
  });
  withTmp((tmp) => {
    // A permission_prompt with no question before it, and an idle_prompt right after the question.
    const plain = writeSteps(tmp, [[permissionPayload(), 6]]);
    assert.equal(plain.detail, PERMISSION_TEXT);
    assert.equal(plain.questions, null);
    const idleOnly = writeSteps(tmp, [[askPayload(), 7], [idlePayload(), 8]]);
    assert.equal(idleOnly.reason, 'notification:idle_prompt');
    assert.equal(idleOnly.detail, IDLE_TEXT);
    assert.equal(idleOnly.questions, null);
    assert.equal(idleOnly.asks.size, 0);
  });
  withTmp((tmp) => {
    // An idle_prompt before any permission_prompt ends the pair, so a later prompt is not the question's.
    const late = writeSteps(tmp, [[askPayload(), 7], [idlePayload(), 8], [permissionPayload(), 9]]);
    assert.equal(late.reason, 'notification:permission_prompt');
    assert.equal(late.detail, PERMISSION_TEXT);
    assert.equal(late.questions, null);
  });
});

test('R198: a Stop after the question gives the turn-end result for a later idle_prompt', () => {
  withTmp((tmp) => {
    const entry = writeSteps(tmp, [
      [askPayload(), 5],
      [permissionPayload(), 6],
      [stopPayload(), 30],
      [idlePayload(), 90],
    ]);
    assert.equal(entry.reason, 'notification:idle_prompt');
    assert.equal(entry.detail, 'Done with the colour.');
    assert.equal(entry.since, sec(30).toISOString());
    assert.equal(entry.questions, null);
    assert.equal(entry.asks.size, 0);
  });
});

test('R198: a PreToolUse record as the latest record gives working, also over an earlier wait', () => {
  withTmp((tmp) => {
    const entry = writeSteps(tmp, [
      [askPayload(), 5],
      [permissionPayload(), 6],
      [askPayload({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_2' }), 50],
    ]);
    assert.equal(entry.state, 'working');
    assert.equal(entry.reason, null);
    assert.equal(entry.detail, null);
    assert.equal(entry.questions, null);
    assert.equal(entry.since, sec(50).toISOString());
    // A new question as the latest record, before its prompt, is working too.
    const asking = writeSteps(tmp, [[askPayload({ tool_use_id: 'toolu_3' }), 60]]);
    assert.equal(asking.state, 'working');
    assert.equal(asking.questions, null);
  });
  assert.deepEqual(classifyRecord({ event: 'PreToolUse', tool_name: 'Read' }, { event: 'Notification', notification_type: 'permission_prompt', message: 'm' }), {
    state: 'working',
    reason: null,
    detail: null,
  });
});

test('R198: records of another session between the question and its prompt do not break the pairing', () => {
  withTmp((tmp) => {
    const entry = writeSteps(tmp, [
      [askPayload(), 5],
      [payloadOf({ hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'other' }), 6],
      [payloadOf({ hook_event_name: 'SessionStart', session_id: 's3' }), 7],
      [permissionPayload(), 8],
    ]);
    assert.equal(entry.state, 'needs-you');
    assert.equal(entry.detail, ASK_DETAIL);
    assert.equal(entry.since, sec(8).toISOString());
    assert.deepEqual(entry.questions, RECORDED);
    assert.deepEqual([...entry.asks.keys()], ['s1']);
    // A record of s1's own session after the prompt is what ends it, not one of another session.
    const later = writeSteps(tmp, [[payloadOf({ hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'again' }), 20]]);
    assert.equal(later.asks.size, 1);
    assert.equal(classifySession(later.sessions.get('s1'), null, null, later.asks.get('s1')).detail, ASK_DETAIL);
  });
});

test('R198: the real probe payloads, written by the hook writer and read back, give the question wait, then the turn end after the answer', () => {
  withTmp((tmp) => {
    const payloads = askFixture();
    assert.deepEqual(payloads.map((p) => p.hook_event_name), ['PreToolUse', 'Notification', 'Notification']);
    const [ask, prompt, idle] = payloads;
    const parsed = parseWorktreeCwd(ask.cwd, 'C:/ws');
    assert.ok(parsed);
    // The probe answered the question, and the turn ended with a Stop before the idle_prompt. The probe registered
    // no Stop hook, so that Stop is built here with the probe's own last message.
    const stop = {
      session_id: ask.session_id,
      transcript_path: ask.transcript_path,
      cwd: ask.cwd,
      hook_event_name: 'Stop',
      last_assistant_message: "You picked **Red**. That's the only action I took.",
    };
    const steps = [[ask, 5], [prompt, 6], [stop, 52], [idle, 115]];
    const written = [];
    for (const [p, s] of steps) {
      appendRecord(tmp, parsed, p, { now: sec(s) });
      const [entry] = readWorkerRecords(tmp);
      written.push(entry);
    }
    const [afterAsk, afterPrompt, afterStop, afterIdle] = written;
    assert.equal(afterAsk.state, 'working');
    assert.equal(afterPrompt.state, 'needs-you');
    assert.equal(afterPrompt.reason, 'notification:permission_prompt');
    assert.equal(afterPrompt.detail, ASK_DETAIL);
    assert.equal(afterPrompt.since, sec(6).toISOString());
    assert.deepEqual(afterPrompt.questions, RECORDED);
    assert.equal(afterPrompt.issue, 'acme/app#1');
    assert.equal(afterStop.reason, 'turn-ended');
    assert.equal(afterStop.questions, null);
    assert.equal(afterIdle.latest.notification_type, 'idle_prompt');
    assert.equal(afterIdle.reason, 'notification:idle_prompt');
    assert.equal(afterIdle.detail, stop.last_assistant_message);
    assert.equal(afterIdle.since, sec(52).toISOString());
    assert.equal(afterIdle.questions, null);
  });
});
