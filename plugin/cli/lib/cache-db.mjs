// state/cache.db: the disposable raw cache. It holds only what GitHub can rebuild (R8). A
// `user_version` that differs from CACHE_SCHEMA_VERSION means the file is deleted and recreated
// empty; the caller then runs a full resync (`fresh` is true).
//
// `node:sqlite` is imported dynamically, never statically. bin/gvt-fleet.mjs installs the
// ExperimentalWarning filter before any dynamic import, and a static import would warn first.

import fs from 'node:fs';
import path from 'node:path';

// Changing the schema text requires bumping this version and recording the new digest in test/db.test.mjs.
export const CACHE_SCHEMA_VERSION = 2;

export const CACHE_SCHEMA = `
CREATE TABLE issues (
  key TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  title TEXT,
  body TEXT,
  updated_at TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  assignees TEXT NOT NULL DEFAULT '[]',
  comments TEXT NOT NULL DEFAULT '[]',
  parent TEXT,
  sub_issues TEXT NOT NULL DEFAULT '[]',
  blocked_by TEXT NOT NULL DEFAULT '[]',
  blocking TEXT NOT NULL DEFAULT '[]',
  closing_prs TEXT NOT NULL DEFAULT '[]',
  managed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX issues_repo ON issues (repo);
CREATE TABLE repo_sync (
  repo TEXT PRIMARY KEY,
  hwm TEXT,
  last_full_sync TEXT,
  bug_tracker TEXT,
  overlay TEXT,
  default_branch TEXT
);
CREATE TABLE branch_heads (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  head_oid TEXT,
  last_commit_date TEXT,
  PRIMARY KEY (repo, name)
);
CREATE TABLE projects (
  project TEXT PRIMARY KEY,
  project_id TEXT,
  field_id TEXT,
  synced_at TEXT
);
CREATE TABLE project_iterations (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  start_date TEXT NOT NULL,
  duration INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE TABLE project_items (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  item_id TEXT,
  iteration_id TEXT,
  PRIMARY KEY (project, key)
);
`;

const JSON_COLUMNS = [
  ['labels', 'labels'],
  ['assignees', 'assignees'],
  ['comments', 'comments'],
  ['subIssues', 'sub_issues'],
  ['blockedBy', 'blocked_by'],
  ['blocking', 'blocking'],
  ['closingPrs', 'closing_prs'],
];

const REPO_STATE_COLUMNS = {
  hwm: 'hwm',
  lastFullSync: 'last_full_sync',
  bugTracker: 'bug_tracker',
  overlay: 'overlay',
  defaultBranch: 'default_branch',
};

const nul = (v) => (v === undefined ? null : v);

function removeDbFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

function readVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * Open (or recreate) the cache database.
 * @param {string} file  path of cache.db; the parent directory is created when missing
 * @param {{version?: number}} [opts]  `version` overrides the expected schema version (tests only)
 * @returns {Promise<CacheDb>}  `fresh` is true when the file was missing or recreated;
 *   `reason` is 'missing' or 'version-mismatch' in that case, else null
 */
export async function openCacheDb(file, { version = CACHE_SCHEMA_VERSION } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let reason = null;
  let db;
  const openDb = () => {
    const d = new DatabaseSync(file);
    d.exec('PRAGMA busy_timeout = 5000');
    return d;
  };
  if (!fs.existsSync(file)) {
    reason = 'missing';
    db = openDb();
  } else {
    db = openDb();
    if (readVersion(db) !== version) {
      db.close();
      removeDbFiles(file);
      reason = 'version-mismatch';
      db = openDb();
    }
  }
  if (reason !== null) {
    // Schema and user_version land in one transaction, so no reader sees tables without a version.
    // The state is re-read under the write lock: a concurrent opener may have initialised it first.
    db.exec('BEGIN IMMEDIATE');
    try {
      const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n === 0;
      if (readVersion(db) === 0 && empty) {
        db.exec(CACHE_SCHEMA);
        db.exec(`PRAGMA user_version = ${Number(version)}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the original error matters more
      }
      throw err;
    }
  }
  return new CacheDb(db, reason);
}

export class CacheDb {
  constructor(db, reason) {
    this.db = db;
    this.fresh = reason !== null;
    this.reason = reason;
    this._depth = 0;
  }

  close() {
    this.db.close();
  }

  /** Run `fn` in one transaction. Commits when `fn` returns, rolls back when it throws. Not re-entrant. */
  transaction(fn) {
    this.db.exec('BEGIN');
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
   * Insert or replace one issue. `row` has the shape graph.mjs and ready.mjs read, plus
   * `updatedAt` and `managed` (boolean).
   */
  upsertIssue(row) {
    const json = JSON_COLUMNS.map(([prop]) => JSON.stringify(row[prop] ?? []));
    this.db
      .prepare(
        `INSERT OR REPLACE INTO issues
         (key, repo, number, state, title, body, updated_at, labels, assignees, comments,
          parent, sub_issues, blocked_by, blocking, closing_prs, managed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.key,
        row.repo,
        row.number,
        row.state,
        nul(row.title),
        nul(row.body),
        nul(row.updatedAt),
        ...json.slice(0, 3),
        row.parent === undefined || row.parent === null ? null : String(row.parent),
        ...json.slice(3),
        row.managed ? 1 : 0,
      );
  }

  /**
   * Record an external lookup (state, title, updatedAt). An existing row keeps its other columns;
   * a missing row is inserted with empty fields. `managed` applies to an inserted row only.
   */
  upsertExternal(row) {
    this.db
      .prepare(
        `INSERT INTO issues (key, repo, number, state, title, updated_at, managed)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET state = excluded.state, title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(row.key, row.repo, row.number, row.state, nul(row.title), nul(row.updatedAt), row.managed ? 1 : 0);
  }

  /**
   * Replace the labels of one cached issue and leave every other column as it is.
   * Returns 1 when the row exists, 0 when it does not.
   */
  setIssueLabels(key, labels) {
    return Number(this.db.prepare('UPDATE issues SET labels = ? WHERE key = ?').run(JSON.stringify(labels), key).changes);
  }

  /** @param {{repo?: string, managedOnly?: boolean}} [filter] @returns {object[]} rows in the IssueRow shape */
  readIssues({ repo, managedOnly = false } = {}) {
    const where = [];
    const args = [];
    if (repo !== undefined) {
      where.push('repo = ?');
      args.push(repo);
    }
    if (managedOnly) where.push('managed = 1');
    const sql = `SELECT * FROM issues${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY repo, number`;
    return this.db.prepare(sql).all(...args).map((r) => {
      const out = {
        key: r.key,
        repo: r.repo,
        number: r.number,
        state: r.state,
        title: r.title,
        body: r.body,
        updatedAt: r.updated_at,
        parent: r.parent,
        managed: r.managed === 1,
      };
      for (const [prop, col] of JSON_COLUMNS) out[prop] = JSON.parse(r[col]);
      return out;
    });
  }

  /** Delete issues of `repo` whose key is not in `keys` (a full resync dropped them). Returns the count. */
  deleteIssuesNotIn(repo, keys) {
    const keep = new Set(keys);
    let n = 0;
    for (const { key } of this.db.prepare('SELECT key FROM issues WHERE repo = ?').all(repo)) {
      if (keep.has(key)) continue;
      this.db.prepare('DELETE FROM issues WHERE key = ?').run(key);
      n += 1;
    }
    return n;
  }

  /**
   * Mark as not managed every row whose repo is not in `repos` (compared without case): the repo
   * was removed, disabled or renamed in the config. The rows stay, so an issue that a managed issue
   * still names keeps its cached state and is looked up again as external. Returns the count.
   */
  unmanageReposNotIn(repos) {
    const keep = new Set(repos.map((r) => String(r).toLowerCase()));
    let n = 0;
    for (const { key, repo } of this.db.prepare('SELECT key, repo FROM issues WHERE managed = 1').all()) {
      if (keep.has(String(repo).toLowerCase())) continue;
      this.db.prepare('UPDATE issues SET managed = 0 WHERE key = ?').run(key);
      n += 1;
    }
    return n;
  }

  /** Per-repo sync state, or null when the repo was never synced. */
  getRepoState(repo) {
    const r = this.db.prepare('SELECT * FROM repo_sync WHERE repo = ?').get(repo);
    if (!r) return null;
    const out = { repo: r.repo };
    for (const [prop, col] of Object.entries(REPO_STATE_COLUMNS)) out[prop] = r[col];
    return out;
  }

  /** Merge `patch` (keys of hwm, lastFullSync, bugTracker, overlay, defaultBranch) into the repo's state. */
  setRepoState(repo, patch) {
    const cur = this.getRepoState(repo) ?? {};
    const next = {};
    for (const prop of Object.keys(REPO_STATE_COLUMNS)) next[prop] = prop in patch ? nul(patch[prop]) : nul(cur[prop]);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO repo_sync (repo, hwm, last_full_sync, bug_tracker, overlay, default_branch)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(repo, next.hwm, next.lastFullSync, next.bugTracker, next.overlay, next.defaultBranch);
  }

  /** Replace the remote branch heads of `repo`. `heads` is `{name, headOid, lastCommitDate}[]`. */
  replaceBranchHeads(repo, heads) {
    this.db.prepare('DELETE FROM branch_heads WHERE repo = ?').run(repo);
    const ins = this.db.prepare('INSERT INTO branch_heads (repo, name, head_oid, last_commit_date) VALUES (?, ?, ?, ?)');
    for (const h of heads) ins.run(repo, h.name, nul(h.headOid), nul(h.lastCommitDate));
  }

  /** @returns {{name: string, headOid: string|null, lastCommitDate: string|null}[]} */
  readBranchHeads(repo) {
    return this.db
      .prepare('SELECT name, head_oid, last_commit_date FROM branch_heads WHERE repo = ? ORDER BY name')
      .all(repo)
      .map((r) => ({ name: r.name, headOid: r.head_oid, lastCommitDate: r.last_commit_date }));
  }

  /**
   * Replace what the cache holds for one project: its ids, its iterations and, when `items` is not
   * null, its items. `items` is `{key, itemId, iterationId}[]`; null keeps the cached items.
   */
  replaceProject(project, { projectId, fieldId, iterations, items = null, syncedAt = null }) {
    this.db
      .prepare('INSERT OR REPLACE INTO projects (project, project_id, field_id, synced_at) VALUES (?, ?, ?, ?)')
      .run(project, nul(projectId), nul(fieldId), syncedAt ?? this.getProject(project)?.syncedAt ?? null);
    this.db.prepare('DELETE FROM project_iterations WHERE project = ?').run(project);
    const ins = this.db.prepare('INSERT INTO project_iterations (project, id, title, start_date, duration) VALUES (?, ?, ?, ?, ?)');
    for (const it of iterations) ins.run(project, it.id, nul(it.title), it.startDate, it.duration);
    if (items !== null) {
      this.db.prepare('DELETE FROM project_items WHERE project = ?').run(project);
      for (const it of items) this.setProjectItem(project, it.key, it.itemId, it.iterationId);
    }
  }

  /** Record one item's Iteration value (iterationId null: none). */
  setProjectItem(project, key, itemId, iterationId) {
    this.db
      .prepare('INSERT OR REPLACE INTO project_items (project, key, item_id, iteration_id) VALUES (?, ?, ?, ?)')
      .run(project, key, nul(itemId), nul(iterationId));
  }

  /** @returns {{project: string, projectId: string|null, fieldId: string|null, syncedAt: string|null}|null} */
  getProject(project) {
    const r = this.db.prepare('SELECT * FROM projects WHERE project = ?').get(project);
    return r ? { project: r.project, projectId: r.project_id, fieldId: r.field_id, syncedAt: r.synced_at } : null;
  }

  /**
   * Every cached project: project -> {iterations, items: Map(lowercased key -> iterationId|null)}.
   * The shape lib/classes.mjs reads.
   */
  readProjects() {
    const out = new Map();
    for (const r of this.db.prepare('SELECT project FROM projects ORDER BY project').all()) {
      out.set(r.project, { iterations: [], items: new Map() });
    }
    for (const r of this.db.prepare('SELECT * FROM project_iterations ORDER BY start_date').all()) {
      out.get(r.project)?.iterations.push({ id: r.id, title: r.title, startDate: r.start_date, duration: r.duration });
    }
    for (const r of this.db.prepare('SELECT * FROM project_items').all()) {
      out.get(r.project)?.items.set(String(r.key).toLowerCase(), r.iteration_id);
    }
    return out;
  }

  /** The `remoteHeads` map ready.mjs reads: repo -> branch names. */
  remoteHeads() {
    const out = {};
    for (const r of this.db.prepare('SELECT repo, name FROM branch_heads ORDER BY repo, name').all()) {
      (out[r.repo] ??= []).push(r.name);
    }
    return out;
  }
}
