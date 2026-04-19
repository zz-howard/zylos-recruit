/**
 * SQLite database layer for zylos-recruit.
 *
 * Tables:
 *   companies                   — companies being recruited for (first-level entity)
 *   company_profiles            — versioned markdown company background
 *   roles                       — job roles, scoped to a company (description=JD, expected_portrait=internal hiring criteria)
 *   role_profiles               — versioned expected_portrait history per role
 *   candidates                  — individuals (scoped to a company via role.company_id)
 *   evaluations                 — AI resume screening + human interview feedback
 *   internal_interviews         — internal stakeholder interviews for building role portraits
 *   internal_interview_messages — chat messages within an internal interview session
 *
 * Candidate state machine:
 *   pending → scheduled → interviewed → passed | rejected
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DB_PATH, DATA_DIR } from './config.js';

export const STATES = ['pending', 'scheduled', 'interviewed', 'passed', 'rejected'];

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrateFromV021(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      eval_prompt TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS company_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, version)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      description        TEXT,
      expected_portrait  TEXT,
      eval_prompt        TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id);

    CREATE TABLE IF NOT EXISTS role_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(role_id, version)
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      role_id        INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      email          TEXT,
      phone          TEXT,
      source         TEXT,
      brief          TEXT,
      resume_path    TEXT,
      state          TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','scheduled','interviewed','passed','rejected')),
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_company ON candidates(company_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_role    ON candidates(role_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_state   ON candidates(state);

    CREATE TABLE IF NOT EXISTS evaluations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      kind          TEXT,
      author        TEXT,
      verdict       TEXT,
      content       TEXT,
      meta          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_evals_candidate ON evaluations(candidate_id);

    CREATE TABLE IF NOT EXISTS internal_interviews (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      interviewee_name  TEXT NOT NULL,
      token             TEXT NOT NULL UNIQUE,
      status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','completed')),
      runtime_type      TEXT,
      model             TEXT,
      effort            TEXT,
      session_id        TEXT,
      summary           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ii_company ON internal_interviews(company_id);
    CREATE INDEX IF NOT EXISTS idx_ii_token   ON internal_interviews(token);

    CREATE TABLE IF NOT EXISTS internal_interview_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id    INTEGER NOT NULL REFERENCES internal_interviews(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_iim_interview ON internal_interview_messages(interview_id);
  `);
}

/** Upgrade from v0.2.1 schema if needed */
function migrateFromV021(db) {
  const tableExists = (name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const columnExists = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);

  // Drop interview_stages table (unused in v0.2.1)
  if (tableExists('interview_stages')) {
    db.exec('DROP TABLE interview_stages');
  }

  // Drop screen_verdict from candidates
  if (columnExists('candidates', 'screen_verdict')) {
    db.exec('ALTER TABLE candidates DROP COLUMN screen_verdict');
  }

  // Drop resume_text from candidates (no longer needed in v0.2.2)
  if (columnExists('candidates', 'resume_text')) {
    db.exec('ALTER TABLE candidates DROP COLUMN resume_text');
  }

  // Migrate evaluations: drop stage_id, add kind + meta
  if (columnExists('evaluations', 'stage_id')) {
    db.exec(`
      CREATE TABLE evaluations_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        kind          TEXT,
        author        TEXT,
        verdict       TEXT,
        content       TEXT,
        meta          TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO evaluations_new (id, candidate_id, kind, author, verdict, content, created_at)
        SELECT id, candidate_id, 'interview', author, verdict, content, created_at
        FROM evaluations;
      DROP TABLE evaluations;
      ALTER TABLE evaluations_new RENAME TO evaluations;
      CREATE INDEX IF NOT EXISTS idx_evals_candidate ON evaluations(candidate_id);
    `);
  }

  // Add kind column if somehow missing (fresh install already has it)
  if (!columnExists('evaluations', 'kind')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN kind TEXT');
  }
  if (!columnExists('evaluations', 'meta')) {
    db.exec('ALTER TABLE evaluations ADD COLUMN meta TEXT');
  }

  // Add eval_prompt to companies and roles (v0.2.3)
  if (!columnExists('companies', 'eval_prompt')) {
    db.exec('ALTER TABLE companies ADD COLUMN eval_prompt TEXT');
  }
  if (!columnExists('roles', 'eval_prompt')) {
    db.exec('ALTER TABLE roles ADD COLUMN eval_prompt TEXT');
  }

  // Add extra_info to candidates (v0.2.5)
  if (!columnExists('candidates', 'extra_info')) {
    db.exec('ALTER TABLE candidates ADD COLUMN extra_info TEXT');
  }

  // Add active column to roles (v0.3.0 — internal interviews feature)
  if (!columnExists('roles', 'active')) {
    db.exec('ALTER TABLE roles ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

  // Add model + effort to internal_interviews (v0.2.5 — lock AI config at creation)
  if (tableExists('internal_interviews') && !columnExists('internal_interviews', 'model')) {
    db.exec('ALTER TABLE internal_interviews ADD COLUMN model TEXT');
  }
  if (tableExists('internal_interviews') && !columnExists('internal_interviews', 'effort')) {
    db.exec('ALTER TABLE internal_interviews ADD COLUMN effort TEXT');
  }

  // Add expected_portrait to roles, migrate eval_prompt content → expected_portrait (v0.2.4)
  if (!columnExists('roles', 'expected_portrait')) {
    db.exec('ALTER TABLE roles ADD COLUMN expected_portrait TEXT');
    // eval_prompt was previously used to store portrait content — migrate it
    db.exec(`UPDATE roles SET expected_portrait = eval_prompt, eval_prompt = NULL WHERE eval_prompt IS NOT NULL`);
    // role_profiles previously stored JD content — copy latest version to description
    db.exec(`UPDATE roles SET description = (
      SELECT rp.content FROM role_profiles rp
      WHERE rp.role_id = roles.id
      ORDER BY rp.version DESC LIMIT 1
    ) WHERE EXISTS (
      SELECT 1 FROM role_profiles rp WHERE rp.role_id = roles.id
    )`);
  }

  migrateSoftDelete(db, columnExists);
}

function migrateSoftDelete(db, columnExists) {
  if (columnExists('companies', 'deleted_at')) return;

  // Step 1: Add deleted_at + delete_batch columns to all 8 tables
  const tables = [
    'companies', 'company_profiles', 'roles', 'role_profiles',
    'candidates', 'evaluations', 'internal_interviews', 'internal_interview_messages',
  ];
  for (const t of tables) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at TEXT DEFAULT NULL`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN delete_batch TEXT DEFAULT NULL`);
  }

  // Step 2: Create partial unique indexes before dropping old constraints
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_active ON companies(name) WHERE deleted_at IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_company_name_active ON roles(company_id, name) WHERE deleted_at IS NULL`);

  // Step 3: Rebuild companies table to drop inline UNIQUE(name)
  db.exec(`
    CREATE TABLE companies_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      eval_prompt TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT DEFAULT NULL,
      delete_batch TEXT DEFAULT NULL
    );
    INSERT INTO companies_new SELECT id, name, eval_prompt, created_at, updated_at, deleted_at, delete_batch FROM companies;
    DROP TABLE companies;
    ALTER TABLE companies_new RENAME TO companies;
    CREATE UNIQUE INDEX idx_companies_name_active ON companies(name) WHERE deleted_at IS NULL;
  `);

  // Step 4: Rebuild roles table to drop inline UNIQUE(company_id, name)
  db.exec(`
    CREATE TABLE roles_new (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      description        TEXT,
      expected_portrait  TEXT,
      eval_prompt        TEXT,
      active             INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at         TEXT DEFAULT NULL,
      delete_batch       TEXT DEFAULT NULL
    );
    INSERT INTO roles_new SELECT id, company_id, name, description, expected_portrait, eval_prompt, active, created_at, updated_at, deleted_at, delete_batch FROM roles;
    DROP TABLE roles;
    ALTER TABLE roles_new RENAME TO roles;
    CREATE INDEX idx_roles_company ON roles(company_id);
    CREATE UNIQUE INDEX idx_roles_company_name_active ON roles(company_id, name) WHERE deleted_at IS NULL;
  `);

  // Step 5: Recreate indexes on soft-delete columns for query performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_companies_deleted ON companies(deleted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_deleted ON candidates(deleted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ii_deleted ON internal_interviews(deleted_at)`);
}

// ─── Companies ────────────────────────────────────────────────────────

export function listCompanies() {
  return getDb().prepare(`
    SELECT c.*, (
      SELECT COUNT(*) FROM roles r WHERE r.company_id = c.id AND r.deleted_at IS NULL
    ) AS role_count, (
      SELECT COUNT(*) FROM candidates cd WHERE cd.company_id = c.id AND cd.deleted_at IS NULL
    ) AS candidate_count
    FROM companies c
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at ASC
  `).all();
}

export function getCompany(id) {
  const company = getDb().prepare('SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!company) return null;
  company.profile = getDb().prepare(`
    SELECT * FROM company_profiles WHERE company_id = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1
  `).get(id) || null;
  return company;
}

export function createCompany({ name }) {
  const info = getDb().prepare(`
    INSERT INTO companies (name) VALUES (?)
  `).run(name);
  return getCompany(info.lastInsertRowid);
}

export function updateCompany(id, updates) {
  const fields = [];
  const params = [];
  if (typeof updates.name === 'string') { fields.push('name = ?'); params.push(updates.name); }
  if (updates.eval_prompt !== undefined) { fields.push('eval_prompt = ?'); params.push(updates.eval_prompt || null); }
  if (fields.length === 0) return getCompany(id);
  fields.push(`updated_at = datetime('now')`);
  params.push(id);
  getDb().prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
  return getCompany(id);
}

export function updateCompanyProfile(companyId, content) {
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM company_profiles WHERE company_id = ? AND deleted_at IS NULL
  `).get(companyId);
  const nextVersion = (row?.v || 0) + 1;
  getDb().prepare(`
    INSERT INTO company_profiles (company_id, version, content) VALUES (?, ?, ?)
  `).run(companyId, nextVersion, content);
  getDb().prepare(`UPDATE companies SET updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(companyId);
  return getCompany(companyId);
}

export function deleteCompany(id) {
  const batch = crypto.randomUUID();
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    result.messages = d.prepare(
      `UPDATE internal_interview_messages SET deleted_at=datetime('now'), delete_batch=?
       WHERE deleted_at IS NULL AND interview_id IN
         (SELECT id FROM internal_interviews WHERE company_id=? AND deleted_at IS NULL)`
    ).run(batch, id).changes;
    result.interviews = d.prepare(
      `UPDATE internal_interviews SET deleted_at=datetime('now'), delete_batch=?
       WHERE company_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.evaluations = d.prepare(
      `UPDATE evaluations SET deleted_at=datetime('now'), delete_batch=?
       WHERE deleted_at IS NULL AND candidate_id IN
         (SELECT id FROM candidates WHERE company_id=? AND deleted_at IS NULL)`
    ).run(batch, id).changes;
    result.candidates = d.prepare(
      `UPDATE candidates SET deleted_at=datetime('now'), delete_batch=?
       WHERE company_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.roleProfiles = d.prepare(
      `UPDATE role_profiles SET deleted_at=datetime('now'), delete_batch=?
       WHERE deleted_at IS NULL AND role_id IN
         (SELECT id FROM roles WHERE company_id=? AND deleted_at IS NULL)`
    ).run(batch, id).changes;
    result.roles = d.prepare(
      `UPDATE roles SET deleted_at=datetime('now'), delete_batch=?
       WHERE company_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.companyProfiles = d.prepare(
      `UPDATE company_profiles SET deleted_at=datetime('now'), delete_batch=?
       WHERE company_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.company = d.prepare(
      `UPDATE companies SET deleted_at=datetime('now'), delete_batch=?
       WHERE id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
  });
  tx.immediate();
  return { batch, ...result };
}

// ─── Roles ────────────────────────────────────────────────────────────

export function listRoles({ companyId, active } = {}) {
  const where = ['r.deleted_at IS NULL'];
  const params = [];
  if (companyId) { where.push('r.company_id = ?'); params.push(companyId); }
  if (active !== undefined) { where.push('r.active = ?'); params.push(active ? 1 : 0); }
  const whereClause = 'WHERE ' + where.join(' AND ');
  return getDb().prepare(`
    SELECT r.*, (
      SELECT COUNT(*) FROM candidates c WHERE c.role_id = r.id AND c.deleted_at IS NULL
    ) AS candidate_count
    FROM roles r
    ${whereClause}
    ORDER BY r.created_at DESC
  `).all(...params);
}

export function getRole(id) {
  const role = getDb().prepare('SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!role) return null;
  role.profile = getDb().prepare(`
    SELECT * FROM role_profiles WHERE role_id = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1
  `).get(id) || null;
  return role;
}

export function createRole({ companyId, name, description, expected_portrait }) {
  const info = getDb().prepare(`
    INSERT INTO roles (company_id, name, description, expected_portrait) VALUES (?, ?, ?, ?)
  `).run(companyId, name, description || null, expected_portrait || null);
  return getRole(info.lastInsertRowid);
}

export function updateRole(id, { name, description, expected_portrait, eval_prompt, active }) {
  const fields = [];
  const params = [];
  if (typeof name === 'string') { fields.push('name = ?'); params.push(name); }
  if (typeof description === 'string' || description === null) {
    fields.push('description = ?');
    params.push(description);
  }
  if (expected_portrait !== undefined) { fields.push('expected_portrait = ?'); params.push(expected_portrait || null); }
  if (eval_prompt !== undefined) { fields.push('eval_prompt = ?'); params.push(eval_prompt || null); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (fields.length === 0) return getRole(id);
  fields.push(`updated_at = datetime('now')`);
  params.push(id);
  getDb().prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
  return getRole(id);
}

export function updateRoleProfile(roleId, content) {
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM role_profiles WHERE role_id = ? AND deleted_at IS NULL
  `).get(roleId);
  const nextVersion = (row?.v || 0) + 1;
  getDb().prepare(`
    INSERT INTO role_profiles (role_id, version, content) VALUES (?, ?, ?)
  `).run(roleId, nextVersion, content);
  getDb().prepare(`UPDATE roles SET expected_portrait = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(content, roleId);
  return getRole(roleId);
}

export function deleteRole(id) {
  const batch = crypto.randomUUID();
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    result.roleProfiles = d.prepare(
      `UPDATE role_profiles SET deleted_at=datetime('now'), delete_batch=?
       WHERE role_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.role = d.prepare(
      `UPDATE roles SET deleted_at=datetime('now'), delete_batch=?
       WHERE id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
  });
  tx.immediate();
  return { batch, ...result };
}

// ─── Candidates ───────────────────────────────────────────────────────

export function listCandidates({ companyId, roleId, state } = {}) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  if (companyId) { where.push('c.company_id = ?'); params.push(companyId); }
  if (roleId)    { where.push('c.role_id = ?');    params.push(roleId); }
  if (state)     { where.push('c.state = ?');      params.push(state); }
  const whereClause = 'WHERE ' + where.join(' AND ');
  const rows = getDb().prepare(`
    SELECT c.*, r.name AS role_name
    FROM candidates c
    LEFT JOIN roles r ON r.id = c.role_id
    ${whereClause}
    ORDER BY c.updated_at DESC
  `).all(...params);

  const stmtAi = getDb().prepare(`
    SELECT verdict, meta FROM evaluations
    WHERE candidate_id = ? AND kind = 'resume_ai' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `);
  const stmtInterview = getDb().prepare(`
    SELECT verdict FROM evaluations
    WHERE candidate_id = ? AND kind = 'interview' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `);
  for (const row of rows) {
    const ai = stmtAi.get(row.id);
    if (ai) {
      row.last_ai_verdict = ai.verdict;
      try { row.last_ai_score = JSON.parse(ai.meta)?.score ?? null; } catch { row.last_ai_score = null; }
    }
    const iv = stmtInterview.get(row.id);
    if (iv) row.last_interview_verdict = iv.verdict;
  }
  return rows;
}

export function getCandidate(id) {
  const cand = getDb().prepare(`
    SELECT c.*, r.name AS role_name
    FROM candidates c
    LEFT JOIN roles r ON r.id = c.role_id
    WHERE c.id = ? AND c.deleted_at IS NULL
  `).get(id);
  if (!cand) return null;
  cand.evaluations = getDb().prepare(`
    SELECT * FROM evaluations WHERE candidate_id = ? AND deleted_at IS NULL ORDER BY created_at DESC
  `).all(id);
  return cand;
}

export function createCandidate(data) {
  const { companyId, name, role_id, email, phone, source, brief, extra_info } = data;
  if (role_id) {
    const role = getDb().prepare('SELECT company_id FROM roles WHERE id = ? AND deleted_at IS NULL').get(role_id);
    if (!role) throw new Error('role not found');
    if (role.company_id !== companyId) throw new Error('role belongs to a different company');
  }
  const info = getDb().prepare(`
    INSERT INTO candidates (company_id, name, role_id, email, phone, source, brief, extra_info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(companyId, name, role_id || null, email || null, phone || null, source || null, brief || null, extra_info || null);
  return getCandidate(info.lastInsertRowid);
}

const UPDATABLE = new Set(['name', 'role_id', 'email', 'phone', 'source', 'brief', 'extra_info', 'resume_path']);

export function updateCandidate(id, updates) {
  const keys = Object.keys(updates).filter(k => UPDATABLE.has(k));
  if (keys.length === 0) return getCandidate(id);
  if (updates.role_id) {
    const cand = getDb().prepare('SELECT company_id FROM candidates WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cand) return null;
    const role = getDb().prepare('SELECT company_id FROM roles WHERE id = ? AND deleted_at IS NULL').get(updates.role_id);
    if (!role) throw new Error('role not found');
    if (role.company_id !== cand.company_id) throw new Error('role belongs to a different company');
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  getDb().prepare(`
    UPDATE candidates SET ${setClause}, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
  `).run(...values, id);
  return getCandidate(id);
}

export function moveCandidate(id, state) {
  if (!STATES.includes(state)) throw new Error(`invalid state: ${state}`);
  getDb().prepare(`
    UPDATE candidates SET state = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
  `).run(state, id);
  return getCandidate(id);
}

export function addEvaluation(candidateId, { kind, author, verdict, content, meta }) {
  const d = getDb();
  const cand = d.prepare('SELECT id FROM candidates WHERE id = ? AND deleted_at IS NULL').get(candidateId);
  if (!cand) throw new Error('candidate not found');
  d.prepare(`
    INSERT INTO evaluations (candidate_id, kind, author, verdict, content, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, kind || null, author || null, verdict || null, content || null, meta || null);
  d.prepare(`UPDATE candidates SET updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(candidateId);
  return getCandidate(candidateId);
}

export function deleteCandidate(id) {
  const batch = crypto.randomUUID();
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    result.evaluations = d.prepare(
      `UPDATE evaluations SET deleted_at=datetime('now'), delete_batch=?
       WHERE candidate_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.candidate = d.prepare(
      `UPDATE candidates SET deleted_at=datetime('now'), delete_batch=?
       WHERE id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
  });
  tx.immediate();
  return { batch, ...result };
}

// ─── Internal Interviews ─────────────────────────────────────────────

export function listInternalInterviews({ companyId, status, limit = 20, offset = 0 } = {}) {
  const where = ['ii.deleted_at IS NULL'];
  const params = [];
  if (companyId) { where.push('ii.company_id = ?'); params.push(companyId); }
  if (status) { where.push('ii.status = ?'); params.push(status); }
  const whereClause = 'WHERE ' + where.join(' AND ');
  const rows = getDb().prepare(`
    SELECT ii.*, (
      SELECT COUNT(*) FROM internal_interview_messages m WHERE m.interview_id = ii.id AND m.deleted_at IS NULL
    ) AS message_count
    FROM internal_interviews ii
    ${whereClause}
    ORDER BY ii.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = getDb().prepare(`
    SELECT COUNT(*) AS cnt FROM internal_interviews ii ${whereClause}
  `).get(...params);
  return { interviews: rows, total: total.cnt };
}

export function getInternalInterview(id) {
  return getDb().prepare('SELECT * FROM internal_interviews WHERE id = ? AND deleted_at IS NULL').get(id);
}

export function getInternalInterviewByToken(token) {
  return getDb().prepare('SELECT * FROM internal_interviews WHERE token = ? AND deleted_at IS NULL').get(token);
}

export function createInternalInterview({ companyId, intervieweeName, token, runtimeType, model, effort }) {
  const info = getDb().prepare(`
    INSERT INTO internal_interviews (company_id, interviewee_name, token, runtime_type, model, effort)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companyId, intervieweeName, token, runtimeType || null, model || null, effort || null);
  return getInternalInterview(info.lastInsertRowid);
}

export function updateInternalInterview(id, updates) {
  const fields = [];
  const params = [];
  if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
  if (updates.runtime_type !== undefined) { fields.push('runtime_type = ?'); params.push(updates.runtime_type); }
  if (updates.model !== undefined) { fields.push('model = ?'); params.push(updates.model); }
  if (updates.effort !== undefined) { fields.push('effort = ?'); params.push(updates.effort); }
  if (updates.session_id !== undefined) { fields.push('session_id = ?'); params.push(updates.session_id); }
  if (updates.summary !== undefined) { fields.push('summary = ?'); params.push(updates.summary); }
  if (updates.completed_at !== undefined) { fields.push('completed_at = ?'); params.push(updates.completed_at); }
  if (fields.length === 0) return getInternalInterview(id);
  params.push(id);
  getDb().prepare(`UPDATE internal_interviews SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
  return getInternalInterview(id);
}

export function deleteInternalInterview(id) {
  const batch = crypto.randomUUID();
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    result.messages = d.prepare(
      `UPDATE internal_interview_messages SET deleted_at=datetime('now'), delete_batch=?
       WHERE interview_id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
    result.interview = d.prepare(
      `UPDATE internal_interviews SET deleted_at=datetime('now'), delete_batch=?
       WHERE id=? AND deleted_at IS NULL`
    ).run(batch, id).changes;
  });
  tx.immediate();
  return { batch, ...result };
}

// ─── Internal Interview Messages ─────────────────────────────────────

export function listInterviewMessages(interviewId) {
  return getDb().prepare(`
    SELECT * FROM internal_interview_messages WHERE interview_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
  `).all(interviewId);
}

export function addInterviewMessage(interviewId, { role, content }) {
  const d = getDb();
  const ii = d.prepare('SELECT id FROM internal_interviews WHERE id = ? AND deleted_at IS NULL').get(interviewId);
  if (!ii) throw new Error('interview not found');
  d.prepare(`
    INSERT INTO internal_interview_messages (interview_id, role, content) VALUES (?, ?, ?)
  `).run(interviewId, role, content);
}

// ─── Restore (Soft Delete Recovery) ─────────────────────────────────

export function restoreCandidate(id) {
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    const row = d.prepare('SELECT * FROM candidates WHERE id = ? AND deleted_at IS NOT NULL').get(id);
    if (!row) throw new Error('candidate not found or not deleted');

    const batch = row.delete_batch;
    result.candidate = d.prepare(
      'UPDATE candidates SET deleted_at=NULL, delete_batch=NULL WHERE id=?'
    ).run(id).changes;

    if (batch) {
      result.evaluations = d.prepare(
        'UPDATE evaluations SET deleted_at=NULL, delete_batch=NULL WHERE candidate_id=? AND delete_batch=?'
      ).run(id, batch).changes;
    }
  });
  tx.immediate();
  return result;
}

export function restoreInternalInterview(id) {
  const d = getDb();
  const result = {};
  const tx = d.transaction(() => {
    const row = d.prepare('SELECT * FROM internal_interviews WHERE id = ? AND deleted_at IS NOT NULL').get(id);
    if (!row) throw new Error('interview not found or not deleted');

    const conflict = d.prepare(
      'SELECT id FROM internal_interviews WHERE token = ? AND deleted_at IS NULL'
    ).get(row.token);
    if (conflict) throw new Error(`token conflict with active interview #${conflict.id}`);

    // Verify parent company is not deleted
    const company = d.prepare('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL').get(row.company_id);
    if (!company) throw new Error('parent company is deleted — restore it first');

    const batch = row.delete_batch;
    result.interview = d.prepare(
      'UPDATE internal_interviews SET deleted_at=NULL, delete_batch=NULL WHERE id=?'
    ).run(id).changes;

    if (batch) {
      result.messages = d.prepare(
        'UPDATE internal_interview_messages SET deleted_at=NULL, delete_batch=NULL WHERE interview_id=? AND delete_batch=?'
      ).run(id, batch).changes;
    }
  });
  tx.immediate();
  return result;
}
