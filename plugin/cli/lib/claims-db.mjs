// state/claims.db: the durable local lease table. A `user_version` mismatch stops with a
// ClaimsVersionError and the file is never deleted or altered.
//
// `node:sqlite` is imported dynamically, never statically. bin/gvt-fleet.mjs installs the
// ExperimentalWarning filter before any dynamic import, and a static import would warn first.

import fs from 'node:fs';
import path from 'node:path';

// Changing the schema text requires bumping this version and recording the new digest in test/db.test.mjs.
export const CLAIMS_SCHEMA_VERSION = 2;

export const LEASE_STATES = ['claiming', 'held', 'failed', 'releasing', 'released'];

// One live lease per issue: a key can have many past rows but only one in an active state.
export const CLAIMS_SCHEMA = `
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claiming','held','failed','releasing','released')),
  claimed_at TEXT,
  heartbeat_at TEXT,
  expires_at TEXT,
  assignee_preexisting INTEGER,
  label_added INTEGER,
  session_id TEXT,
  short_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  wt_state TEXT,
  discard_head TEXT
);
CREATE INDEX leases_key ON leases (key);
CREATE UNIQUE INDEX leases_one_active ON leases (key) WHERE state IN ('claiming','held','releasing');
`;

const COLUMNS = [
  ['leaseId', 'lease_id'],
  ['key', 'key'],
  ['state', 'state'],
  ['claimedAt', 'claimed_at'],
  ['heartbeatAt', 'heartbeat_at'],
  ['expiresAt', 'expires_at'],
  ['assigneePreexisting', 'assignee_preexisting'],
  ['labelAdded', 'label_added'],
  ['sessionId', 'session_id'],
  ['shortId', 'short_id'],
  ['worktreePath', 'worktree_path'],
  ['branch', 'branch'],
  ['wtState', 'wt_state'],
  ['discardHead', 'discard_head'],
];

export class ClaimsVersionError extends Error {
  constructor(file, found, expected) {
    super(`${file}: claims database has user_version ${found}, this tool expects ${expected}. The file was left untouched.`);
    this.name = 'ClaimsVersionError';
    this.file = file;
    this.found = found;
    this.expected = expected;
  }
}

const nul = (v) => (v === undefined ? null : v);

// Booleans that are NULL (unknown) until the claim reaches the step that decides them.
const TRI_STATE = ['assigneePreexisting', 'labelAdded'];
const tri = (prop, v) => (TRI_STATE.includes(prop) ? (v === null || v === undefined ? null : v ? 1 : 0) : nul(v));

function toRow(r) {
  const out = {};
  for (const [prop, col] of COLUMNS) out[prop] = r[col];
  for (const prop of TRI_STATE) out[prop] = out[prop] === null ? null : out[prop] === 1;
  return out;
}

/**
 * Open the claims database, creating it (and its parent directory) when missing.
 * @param {string} file
 * @param {{version?: number}} [opts]  `version` overrides the expected schema version (tests only)
 * @returns {Promise<ClaimsDb>}
 * @throws {ClaimsVersionError} when an existing file has another user_version
 */
export async function openClaimsDb(file, { version = CLAIMS_SCHEMA_VERSION } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  const state = () => ({
    found: db.prepare('PRAGMA user_version').get().user_version,
    empty: db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n === 0,
  });
  let { found, empty } = state();
  if (found !== version && !(found === 0 && empty)) {
    db.close();
    throw new ClaimsVersionError(file, found, version);
  }
  if (found === 0 && empty) {
    // Schema and user_version land in one transaction. The state is re-read under the write lock,
    // because a concurrent opener may have initialised the file since the read above.
    db.exec('BEGIN IMMEDIATE');
    try {
      ({ found, empty } = state());
      if (found === 0 && empty) {
        db.exec(CLAIMS_SCHEMA);
        db.exec(`PRAGMA user_version = ${Number(version)}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the original error matters more
      }
      db.close();
      throw err;
    }
    if (found !== 0 && found !== version) {
      db.close();
      throw new ClaimsVersionError(file, found, version);
    }
  }
  return new ClaimsDb(db);
}

export class ClaimsDb {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  /** Run `fn` under BEGIN IMMEDIATE (takes the write lock up front). Commits on return, rolls back on throw. Not re-entrant. */
  immediate(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn(this);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the original error matters more
      }
      throw err;
    }
  }

  /**
   * Insert or replace a lease row by `leaseId`. Call inside `immediate`.
   * Fields: leaseId, key, state, claimedAt, heartbeatAt, expiresAt, assigneePreexisting and labelAdded (boolean, or null while unknown),
   * sessionId, shortId, worktreePath, branch, wtState, discardHead (the worktree HEAD sha that `--discard` was given at, or null for no consent).
   */
  putLease(lease) {
    const vals = COLUMNS.map(([prop]) => tri(prop, lease[prop]));
    this.db
      .prepare(
        // Not INSERT OR REPLACE: that would delete another row that breaks the one-active-lease index.
        `INSERT INTO leases (${COLUMNS.map(([, c]) => c).join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
         ON CONFLICT (lease_id) DO UPDATE SET ${COLUMNS.slice(1)
           .map(([, c]) => `${c} = excluded.${c}`)
           .join(', ')}`,
      )
      .run(...vals);
  }

  getLease(leaseId) {
    const r = this.db.prepare('SELECT * FROM leases WHERE lease_id = ?').get(leaseId);
    return r ? toRow(r) : null;
  }

  /** The claiming, held or releasing lease of an issue, or null. */
  getActiveLease(key) {
    const r = this.db.prepare("SELECT * FROM leases WHERE key = ? AND state IN ('claiming','held','releasing')").get(key);
    return r ? toRow(r) : null;
  }

  /** All rows, or those in `states`. The rows carry `key`, `state` and `expiresAt` as ready.mjs reads them. */
  listLeases({ states } = {}) {
    const all = this.db.prepare('SELECT * FROM leases ORDER BY claimed_at, lease_id').all().map(toRow);
    return states ? all.filter((l) => states.includes(l.state)) : all;
  }

  /** Set columns of one lease: `patch` uses the row property names. Call inside `immediate`. */
  updateLease(leaseId, patch) {
    const sets = [];
    const vals = [];
    for (const [prop, col] of COLUMNS) {
      if (prop === 'leaseId' || !(prop in patch)) continue;
      sets.push(`${col} = ?`);
      vals.push(tri(prop, patch[prop]));
    }
    if (sets.length === 0) return 0;
    return Number(this.db.prepare(`UPDATE leases SET ${sets.join(', ')} WHERE lease_id = ?`).run(...vals, leaseId).changes);
  }
}
