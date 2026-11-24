// The Foreman's SQLite store (DESIGN.md D2): a local file in the orch state root, never on a
// network share. Built-in `node:sqlite`; every multi-statement change runs in one
// transaction, and every state change appends an `events` row in the same transaction, so
// the audit trail can never disagree with the table.
//
// Run evidence stays in orch's own run folders; this database holds only what the Foreman
// decides: items, dependencies, goals, checks, settings and the audit log.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrchError } from '../errors.mjs';
import { TRANSITIONS, PRIORITIES, isProjectId, isItemId, STATES, PARK_TAGS } from './schema.mjs';

export const SCHEMA_VERSION = 3;

const MIGRATIONS = [
  // 1
  `
  CREATE TABLE projects(
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE goals(
    id TEXT NOT NULL,
    project TEXT NOT NULL REFERENCES projects(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','approved','retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project, id)
  );
  CREATE TABLE items(
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL REFERENCES projects(id),
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    domain TEXT NOT NULL,
    goal_ref TEXT,
    priority TEXT NOT NULL,
    latency TEXT NOT NULL,
    size TEXT NOT NULL,
    capability TEXT,
    review TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    state TEXT NOT NULL,
    park_tag TEXT,
    park_reason TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    wp TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX items_state ON items(state, priority, created_at);
  CREATE INDEX items_project ON items(project, state);
  CREATE TABLE deps(
    item TEXT NOT NULL REFERENCES items(id),
    depends_on TEXT NOT NULL REFERENCES items(id),
    PRIMARY KEY(item, depends_on)
  );
  CREATE TABLE events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    item TEXT,
    run TEXT,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX events_item ON events(item, seq);
  CREATE TABLE checks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL REFERENCES items(id),
    run TEXT NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (1,2)),
    at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','done')),
    signals_json TEXT,
    verdict TEXT,
    reason TEXT,
    executor TEXT,
    packet_path TEXT
  );
  CREATE INDEX checks_item ON checks(item, id);
  CREATE TABLE settings(
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 2: one row per launch attempt, written BEFORE any side effect so a crash leaves evidence.
  `
  CREATE TABLE runs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item TEXT NOT NULL REFERENCES items(id),
    attempt INTEGER NOT NULL,
    wp TEXT NOT NULL,
    slice TEXT NOT NULL,
    worktree TEXT,
    run_id TEXT,
    route_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('preparing','running','finished','abandoned')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    result_json TEXT
  );
  CREATE INDEX runs_item ON runs(item, id);
  `,
  // 3: a verdict is applied exactly once; an off-track verdict may name the park tag.
  `
  ALTER TABLE checks ADD COLUMN applied INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE checks ADD COLUMN tag TEXT;
  `,
];

const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

export function foremanDir(stateRoot) {
  return path.join(stateRoot, 'foreman');
}

const nowIso = () => new Date().toISOString();

function rowItem(row) {
  if (!row) return null;
  const { spec_json: spec, ...rest } = row;
  return { ...rest, paused: !!rest.paused, spec: JSON.parse(spec) };
}

export class Store {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.depth = 0;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (error) {
      this.db.close(); // a refused database must not stay locked
      throw error;
    }
  }

  static open(stateRoot) {
    const dir = foremanDir(stateRoot);
    fs.mkdirSync(dir, { recursive: true });
    return new Store(path.join(dir, 'foreman.db'));
  }

  close() {
    this.db.close();
  }

  /** A prepared statement whose rows are plain objects (node:sqlite types them loosely). */
  q(sql) {
    return /** @type {{get: (...a: any[]) => any, all: (...a: any[]) => any[], run: (...a: any[]) => any}} */ (this.db.prepare(sql));
  }

  migrate() {
    const current = this.q('PRAGMA user_version').get().user_version;
    if (current > SCHEMA_VERSION) {
      throw new OrchError(`the Foreman database is version ${current}, newer than this orch (${SCHEMA_VERSION}); refusing to open it`, 'foreman-db-newer');
    }
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /**
   * Run `fn` in one immediate transaction; roll back on any throw. Calls nest: an inner `tx`
   * joins the outer one, so a method built from other methods is still one atomic change.
   */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  // ---- events ------------------------------------------------------------------------

  event(kind, { item = null, run = null, actor, data = null }) {
    if (!actor) throw new OrchError('an event needs an actor', 'foreman-actor');
    const info = this
      .q('INSERT INTO events(at, item, run, kind, actor, data_json) VALUES (?,?,?,?,?,?)')
      .run(nowIso(), item, run, kind, actor, data === null ? null : JSON.stringify(data));
    return Number(info.lastInsertRowid);
  }

  /** @param {{item?: string, after?: number, limit?: number}} [param0] */
  events({ item, after = 0, limit = 200 } = {}) {
    const rows = item
      ? this.q('SELECT * FROM events WHERE item = ? AND seq > ? ORDER BY seq LIMIT ?').all(item, after, limit)
      : this.q('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit);
    return rows.map((r) => ({ ...r, data: r.data_json ? JSON.parse(r.data_json) : null, data_json: undefined }));
  }

  // ---- projects and goals ------------------------------------------------------------

  addProject({ id, repo, defaultBranch }, actor) {
    if (!isProjectId(id)) throw new OrchError(`invalid project id "${id}"`, 'foreman-bad-project');
    return this.tx(() => {
      if (this.getProject(id)) throw new OrchError(`project ${id} is already registered`, 'foreman-project-exists');
      this.q('INSERT INTO projects(id, repo, default_branch, created_at) VALUES (?,?,?,?)').run(id, repo, defaultBranch, nowIso());
      this.event('project-added', { actor, data: { id, repo, default_branch: defaultBranch } });
      return this.getProject(id);
    });
  }

  getProject(id) {
    const row = this.q('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? { ...row, paused: !!row.paused } : null;
  }

  listProjects() {
    return this.q('SELECT * FROM projects ORDER BY id').all().map((r) => ({ ...r, paused: !!r.paused }));
  }

  setProjectPaused(id, paused, actor) {
    return this.tx(() => {
      if (!this.getProject(id)) throw new OrchError(`no such project: ${id}`, 'foreman-no-project');
      this.q('UPDATE projects SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
      this.event(paused ? 'project-paused' : 'project-resumed', { actor, data: { id } });
      return this.getProject(id);
    });
  }

  ensureGoal(project, id, actor) {
    const existing = this.q('SELECT * FROM goals WHERE project = ? AND id = ?').get(project, id);
    if (existing) return existing;
    const at = nowIso();
    this.q("INSERT INTO goals(id, project, text, status, created_at, updated_at) VALUES (?,?,?,'proposed',?,?)").run(id, project, id, at, at);
    this.event('goal-proposed', { actor, data: { id, project } });
    return this.q('SELECT * FROM goals WHERE project = ? AND id = ?').get(project, id);
  }

  setGoalStatus(project, id, status, actor, text) {
    if (!['proposed', 'approved', 'retired'].includes(status)) throw new OrchError(`invalid goal status ${status}`, 'foreman-bad-goal');
    return this.tx(() => {
      const goal = this.q('SELECT * FROM goals WHERE project = ? AND id = ?').get(project, id);
      if (!goal) throw new OrchError(`no such goal: ${project}/${id}`, 'foreman-no-goal');
      this.q('UPDATE goals SET status = ?, text = ?, updated_at = ? WHERE project = ? AND id = ?').run(status, text ?? goal.text, nowIso(), project, id);
      this.event(`goal-${status}`, { actor, data: { id, project } });
      return this.q('SELECT * FROM goals WHERE project = ? AND id = ?').get(project, id);
    });
  }

  listGoals(project) {
    return project
      ? this.q('SELECT * FROM goals WHERE project = ? ORDER BY id').all(project)
      : this.q('SELECT * FROM goals ORDER BY project, id').all();
  }

  // ---- items -------------------------------------------------------------------------

  /** Insert a validated item. Dependencies must exist, belong to the project and form no cycle. */
  insertItem(item, actor) {
    return this.tx(() => {
      const project = this.getProject(item.project);
      if (!project) throw new OrchError(`project ${item.project} is not registered (orch foreman project add ...)`, 'foreman-no-project');
      for (const dep of item.depends_on) {
        const row = this.q('SELECT project FROM items WHERE id = ?').get(dep);
        if (!row) throw new OrchError(`depends_on: no such item ${dep}`, 'foreman-no-dependency');
        if (row.project !== item.project) throw new OrchError(`depends_on: ${dep} belongs to another project`, 'foreman-cross-project');
      }
      const seq = Number(this.q('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM items WHERE project = ?').get(item.project).n);
      const id = `${item.project}-${String(seq).padStart(4, '0')}`;
      if (item.goal_ref) this.ensureGoal(item.project, item.goal_ref, actor);
      const unmet = item.depends_on.filter((dep) => this.q('SELECT state FROM items WHERE id = ?').get(dep).state !== 'done');
      const state = unmet.length ? 'blocked' : 'ready';
      const at = nowIso();
      const { handoff, notes, ...rest } = item;
      void rest;
      this
        .q(
          `INSERT INTO items(id, project, seq, title, domain, goal_ref, priority, latency, size, capability, review, spec_json, state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, item.project, seq, item.title, item.domain, item.goal_ref, item.priority, item.latency, item.size, item.capability, item.review,
          JSON.stringify({ allowlist: item.allowlist, acceptance: item.acceptance, context_budget: item.context_budget, route: item.route, handoff, notes }), state, at, at);
      for (const dep of item.depends_on) this.q('INSERT INTO deps(item, depends_on) VALUES (?,?)').run(id, dep);
      this.event('item-enqueued', { item: id, actor, data: { priority: item.priority, state, depends_on: item.depends_on, goal_ref: item.goal_ref } });
      return this.getItem(id);
    });
  }

  getItem(id) {
    const item = rowItem(this.q('SELECT * FROM items WHERE id = ?').get(id));
    if (!item) return null;
    item.depends_on = this.q('SELECT depends_on FROM deps WHERE item = ? ORDER BY depends_on').all(id).map((r) => r.depends_on);
    return item;
  }

  /** @param {{project?: string, state?: string, limit?: number}} [param0] */
  listItems({ project, state, limit = 500 } = {}) {
    const where = [];
    const args = [];
    if (project) { where.push('project = ?'); args.push(project); }
    if (state) { where.push('state = ?'); args.push(state); }
    const rows = this
      .q(`SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY project, seq LIMIT ?`)
      .all(...args, limit);
    return rows.map((r) => {
      const item = rowItem(r);
      item.depends_on = this.q('SELECT depends_on FROM deps WHERE item = ? ORDER BY depends_on').all(r.id).map((d) => d.depends_on);
      return item;
    });
  }

  /** Move an item to a new state; the table of allowed moves is the only authority. */
  transition(id, to, { actor, reason = null, parkTag = null, patch = {}, data = null }) {
    if (!STATES.includes(to)) throw new OrchError(`invalid state ${to}`, 'foreman-bad-state');
    if (to === 'parked' && !PARK_TAGS.includes(parkTag)) throw new OrchError(`parking needs a tag from: ${PARK_TAGS.join(', ')}`, 'foreman-park-tag');
    return this.tx(() => {
      const item = this.q('SELECT * FROM items WHERE id = ?').get(id);
      if (!item) throw new OrchError(`no such item: ${id}`, 'foreman-no-item');
      if (!TRANSITIONS[item.state].includes(to)) {
        throw new OrchError(`item ${id} cannot go from ${item.state} to ${to}`, 'foreman-bad-transition');
      }
      /** @type {Record<string, any>} */
      const columns = { state: to, park_tag: to === 'parked' ? parkTag : null, park_reason: to === 'parked' ? reason : null, updated_at: nowIso(), ...patch };
      const allowed = new Set(['state', 'park_tag', 'park_reason', 'updated_at', 'run_id', 'wp', 'attempt', 'paused', 'priority', 'latency']);
      for (const key of Object.keys(columns)) if (!allowed.has(key)) throw new OrchError(`cannot set ${key}`, 'foreman-bad-column');
      const sets = Object.keys(columns).map((k) => `${k} = ?`).join(', ');
      this.q(`UPDATE items SET ${sets} WHERE id = ?`).run(...Object.values(columns).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), id);
      this.event('item-' + to, { item: id, run: columns.run_id ?? item.run_id, actor, data: { from: item.state, reason, park_tag: parkTag, ...(data || {}) } });
      if (to === 'done') this.refreshBlocked(actor);
      return this.getItem(id);
    });
  }

  /** Items whose dependencies are all done become ready. Returns the ids promoted. */
  refreshBlocked(actor) {
    const rows = this
      .q(
        `SELECT i.id FROM items i WHERE i.state = 'blocked' AND NOT EXISTS (
           SELECT 1 FROM deps d JOIN items x ON x.id = d.depends_on WHERE d.item = i.id AND x.state <> 'done')`,
      )
      .all();
    for (const { id } of rows) {
      this.q("UPDATE items SET state = 'ready', updated_at = ? WHERE id = ?").run(nowIso(), id);
      this.event('item-ready', { item: id, actor, data: { from: 'blocked', reason: 'dependencies done' } });
    }
    return rows.map((r) => r.id);
  }

  /** Edit the few fields an operator may change on a live item. */
  updateItem(id, fields, actor) {
    const allowed = { priority: PRIORITIES, latency: ['blocking', 'today', 'whenever'] };
    return this.tx(() => {
      const item = this.q('SELECT * FROM items WHERE id = ?').get(id);
      if (!item) throw new OrchError(`no such item: ${id}`, 'foreman-no-item');
      if (['running', 'verifying'].includes(item.state)) throw new OrchError(`item ${id} is ${item.state}; edit it after it stops`, 'foreman-item-busy');
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'paused') this.q('UPDATE items SET paused = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, nowIso(), id);
        else if (allowed[key]?.includes(value)) this.q(`UPDATE items SET ${key} = ?, updated_at = ? WHERE id = ?`).run(value, nowIso(), id);
        else throw new OrchError(`cannot set ${key} to ${value}`, 'foreman-bad-edit');
      }
      this.event('item-edited', { item: id, actor, data: fields });
      return this.getItem(id);
    });
  }

  /**
   * The next item to run: ready, dependencies done, goal approved, item and project not paused.
   * Highest priority class first; inside the class, the project after the one dispatched last
   * (so no project monopolises the box), oldest item first.
   */
  pickNext() {
    const rows = this
      .q(
        `SELECT i.* FROM items i
           JOIN projects p ON p.id = i.project
           JOIN goals g ON g.project = i.project AND g.id = i.goal_ref
          WHERE i.state = 'ready' AND i.paused = 0 AND p.paused = 0 AND g.status = 'approved'
          ORDER BY i.created_at, i.seq`,
      )
      .all();
    if (!rows.length) return null;
    const best = Math.min(...rows.map((r) => PRIORITY_RANK[r.priority]));
    const top = rows.filter((r) => PRIORITY_RANK[r.priority] === best);
    const projects = [...new Set(top.map((r) => r.project))].sort();
    const last = this.kvGet('last_project');
    const next = projects.find((p) => last && p > last) ?? projects[0];
    const chosen = top.find((r) => r.project === next);
    return this.getItem(chosen.id);
  }

  // ---- runs --------------------------------------------------------------------------

  /** Claim the next launch for an item: ready -> running and a `preparing` run row, atomically. */
  startRun(itemId, route, actor) {
    return this.tx(() => {
      const item = this.q('SELECT * FROM items WHERE id = ?').get(itemId);
      if (!item) throw new OrchError(`no such item: ${itemId}`, 'foreman-no-item');
      const attempt = Number(item.attempt) + 1;
      this.transition(itemId, 'running', { actor, reason: 'launch', patch: { attempt, wp: itemId }, data: { attempt, route } });
      const info = this.q('INSERT INTO runs(item, attempt, wp, slice, route_json, state, started_at) VALUES (?,?,?,?,?,?,?)').run(itemId, attempt, itemId, 'pending', JSON.stringify(route), 'preparing', nowIso());
      const id = Number(info.lastInsertRowid);
      this.q('UPDATE runs SET slice = ? WHERE id = ?').run(`r${id}`, id);
      return this.getRun(id);
    });
  }

  getRun(id) {
    const row = this.q('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? { ...row, route: row.route_json ? JSON.parse(row.route_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null } : null;
  }

  /** The most recent run row of an item, or null. */
  currentRun(itemId) {
    const row = this.q('SELECT id FROM runs WHERE item = ? ORDER BY id DESC LIMIT 1').get(itemId);
    return row ? this.getRun(row.id) : null;
  }

  runsFor(itemId) {
    return this.q('SELECT id FROM runs WHERE item = ? ORDER BY id').all(itemId).map((r) => this.getRun(r.id));
  }

  updateRun(id, fields) {
    const allowed = new Set(['worktree', 'run_id', 'state', 'ended_at', 'result']);
    for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new OrchError(`cannot set run field ${key}`, 'foreman-bad-column');
    const sets = [];
    const args = [];
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'result') { sets.push('result_json = ?'); args.push(JSON.stringify(value)); } else { sets.push(`${key} = ?`); args.push(value); }
    }
    this.q(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.getRun(id);
  }

  /** Items the dispatcher must watch: running (a worker may be alive) or verifying (it finished). */
  activeItems() {
    return this.q("SELECT id FROM items WHERE state IN ('running', 'verifying') ORDER BY updated_at").all().map((r) => this.getItem(r.id));
  }

  // ---- checks ------------------------------------------------------------------------

  /** @param {{item: string, run: string, tier: number, status?: string, signals?: any, verdict?: string|null, reason?: string|null, executor?: string|null, packetPath?: string|null}} param0 */
  addCheck({ item, run, tier, status = 'done', signals = null, verdict = null, reason = null, executor = null, packetPath = null }) {
    const info = this
      .q('INSERT INTO checks(item, run, tier, at, status, signals_json, verdict, reason, executor, packet_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(item, run, tier, nowIso(), status, signals === null ? null : JSON.stringify(signals), verdict, reason, executor, packetPath);
    return Number(info.lastInsertRowid);
  }

  answerCheck(id, { verdict, reason, executor, tag = null }) {
    this.q("UPDATE checks SET status = 'done', verdict = ?, reason = ?, executor = ?, tag = ?, at = ? WHERE id = ? AND status = 'pending'").run(verdict, reason, executor, tag, nowIso(), id);
    return this.getCheck(id);
  }

  markCheckApplied(id) {
    this.q('UPDATE checks SET applied = 1 WHERE id = ?').run(id);
  }

  getCheck(id) {
    const row = this.q('SELECT * FROM checks WHERE id = ?').get(id);
    return row ? { ...row, signals: row.signals_json ? JSON.parse(row.signals_json) : null, signals_json: undefined } : null;
  }

  /** @param {{item?: string, status?: string, tier?: number}} [param0] */
  listChecks({ item, status, tier } = {}) {
    const where = [];
    const args = [];
    if (item) { where.push('item = ?'); args.push(item); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (tier) { where.push('tier = ?'); args.push(tier); }
    return this
      .q(`SELECT * FROM checks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`)
      .all(...args)
      .map((row) => ({ ...row, signals: row.signals_json ? JSON.parse(row.signals_json) : null, signals_json: undefined }));
  }

  // ---- settings and kv ---------------------------------------------------------------

  getSetting(key, fallback = null) {
    const row = this.q('SELECT value_json, version FROM settings WHERE key = ?').get(key);
    return row ? { value: JSON.parse(row.value_json), version: row.version } : { value: fallback, version: 0 };
  }

  setSetting(key, value, actor) {
    return this.tx(() => {
      const current = this.getSetting(key);
      const version = current.version + 1;
      this
        .q('INSERT INTO settings(key, value_json, version, at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, at = excluded.at')
        .run(key, JSON.stringify(value), version, nowIso());
      this.event('setting-changed', { actor, data: { key, version } });
      return { value, version };
    });
  }

  kvGet(key) {
    const row = this.q('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  kvDelete(key) {
    this.q('DELETE FROM kv WHERE key = ?').run(key);
  }

  kvSet(key, value) {
    this.q('INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /** Counts by state, for status screens. */
  counts() {
    const rows = this.q('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all();
    return Object.fromEntries(STATES.map((s) => [s, Number(rows.find((r) => r.state === s)?.n ?? 0)]));
  }
}

export { isItemId };
