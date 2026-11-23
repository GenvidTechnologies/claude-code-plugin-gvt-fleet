process.env.GVT_FLEET_FAKE_ONLY = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEAD_STATES, isLive, matchSessions, pickSession } from '../lib/sessions.mjs';

const BASE = 'C:\\work\\fleet\\repos\\acme\\app';
const WT = `${BASE}\\.claude\\worktrees\\app-1`;

const bg = (extra = {}) => ({ kind: 'background', name: 'app-1', cwd: WT, state: 'working', sessionId: 's-bg', id: 'i-bg', ...extra });

test('R76: an interactive session and a session outside the base clone never match a worker, even with the worker name', () => {
  const q = { name: 'app-1', base: BASE };
  const interactive = { kind: 'interactive', name: 'app-1', cwd: WT, status: 'busy', sessionId: 's-int', id: 'i-int' };
  assert.deepEqual(matchSessions([interactive], q), []);

  const outside = bg({ cwd: 'C:\\work\\other\\app\\.claude\\worktrees\\app-1' });
  assert.deepEqual(matchSessions([outside], q), []);

  // a sibling folder that merely shares the base as a string prefix is outside it
  const prefixOnly = bg({ cwd: `${BASE}-two\\.claude\\worktrees\\app-1` });
  assert.deepEqual(matchSessions([prefixOnly], q), []);

  // drive-letter case and slash direction differ from base
  const shifted = bg({ cwd: 'c:/WORK/fleet/repos/ACME/app' });
  assert.deepEqual(matchSessions([shifted], q), [shifted]);

  // the name compares case-insensitively
  const upper = bg({ name: 'APP-1' });
  assert.deepEqual(matchSessions([upper], q), [upper]);

  // a worktree below the base matches
  const below = bg();
  assert.deepEqual(matchSessions([below], q), [below]);

  // another worker name does not match
  assert.deepEqual(matchSessions([bg({ name: 'app-2' })], q), []);

  // no cwd: never matches by name
  const noCwd = bg({ cwd: undefined });
  assert.deepEqual(matchSessions([noCwd], q), []);

  // a session id matches regardless of kind, cwd or name
  const byId = { kind: 'interactive', name: 'other', cwd: 'D:\\elsewhere', sessionId: 's-want', id: 'i-x' };
  assert.deepEqual(matchSessions([byId], { ...q, sessionId: 's-want' }), [byId]);
  const byAgentId = { kind: 'interactive', name: 'other', id: 's-want2' };
  assert.deepEqual(matchSessions([byAgentId], { ...q, sessionId: 's-want2' }), [byAgentId]);

  // matching by name and by id gives one result, not two
  assert.equal(matchSessions([below], { ...q, sessionId: 's-bg' }).length, 1);
});

test('R76: a live match is preferred over a done or failed entry with the same name or session id', () => {
  const q = { name: 'app-1', base: BASE, sessionId: 's-old' };
  const done = bg({ state: 'done', sessionId: 's-old' });
  const live = bg({ state: 'working', sessionId: 's-new' });
  assert.equal(pickSession(matchSessions([done, live], q)), live);
  assert.equal(pickSession(matchSessions([live, done], q)), live);

  const failed = bg({ state: 'failed' });
  const only = pickSession(matchSessions([failed], q));
  assert.equal(only, failed);
  assert.equal(isLive(only), false);

  assert.equal(pickSession([]), null);
  assert.deepEqual(DEAD_STATES, ['done', 'failed', 'stopped']);
  assert.equal(isLive({ state: 'stopped' }), false);
  assert.equal(isLive({ state: 'done' }), false);
  assert.equal(isLive({ state: 'working' }), true);
  assert.equal(isLive({ state: 'some-new-state' }), true);
  assert.equal(isLive(null), false);
});
