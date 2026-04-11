/**
 * SQLite database layer for zylos-recruit.
 *
 * Tables:
 *   companies          — companies being recruited for (first-level entity)
 *   company_profiles   — versioned markdown company background
 *   roles              — job roles, scoped to a company
 *   role_profiles      — versioned markdown profiles per role
 *   candidates         — individuals (scoped to a company via role.company_id)
 *   interview_stages   — per-candidate interview rounds
 *   evaluations        — interview feedback notes
 *
 * Candidate state machine:
 *   pending → scheduled → interviewed → passed | rejected
 */

import Database from 'better-sqlite3';
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
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
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
      screen_verdict TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_company ON candidates(company_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_role    ON candidates(role_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_state   ON candidates(state);

    CREATE TABLE IF NOT EXISTS interview_stages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      stage_num     INTEGER NOT NULL,
      scheduled_at  TEXT,
      completed_at  TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stages_candidate ON interview_stages(candidate_id);

    CREATE TABLE IF NOT EXISTS evaluations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      stage_id      INTEGER REFERENCES interview_stages(id) ON DELETE SET NULL,
      author        TEXT,
      verdict       TEXT,
      content       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_evals_candidate ON evaluations(candidate_id);
  `);
}

// ─── Companies ────────────────────────────────────────────────────────

export function listCompanies() {
  return getDb().prepare(`
    SELECT c.*, (
      SELECT COUNT(*) FROM roles r WHERE r.company_id = c.id
    ) AS role_count, (
      SELECT COUNT(*) FROM candidates cd WHERE cd.company_id = c.id
    ) AS candidate_count
    FROM companies c
    ORDER BY c.created_at ASC
  `).all();
}

export function getCompany(id) {
  const company = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) return null;
  company.profile = getDb().prepare(`
    SELECT * FROM company_profiles WHERE company_id = ? ORDER BY version DESC LIMIT 1
  `).get(id) || null;
  return company;
}

export function createCompany({ name }) {
  const info = getDb().prepare(`
    INSERT INTO companies (name) VALUES (?)
  `).run(name);
  return getCompany(info.lastInsertRowid);
}

export function updateCompany(id, { name }) {
  getDb().prepare(`
    UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ?
  `).run(name, id);
  return getCompany(id);
}

export function updateCompanyProfile(companyId, content) {
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM company_profiles WHERE company_id = ?
  `).get(companyId);
  const nextVersion = (row?.v || 0) + 1;
  getDb().prepare(`
    INSERT INTO company_profiles (company_id, version, content) VALUES (?, ?, ?)
  `).run(companyId, nextVersion, content);
  getDb().prepare(`UPDATE companies SET updated_at = datetime('now') WHERE id = ?`).run(companyId);
  return getCompany(companyId);
}

export function deleteCompany(id) {
  getDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
}

// ─── Roles ────────────────────────────────────────────────────────────

export function listRoles({ companyId } = {}) {
  const where = [];
  const params = [];
  if (companyId) { where.push('r.company_id = ?'); params.push(companyId); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return getDb().prepare(`
    SELECT r.*, (
      SELECT COUNT(*) FROM candidates c WHERE c.role_id = r.id
    ) AS candidate_count
    FROM roles r
    ${whereClause}
    ORDER BY r.created_at DESC
  `).all(...params);
}

export function getRole(id) {
  const role = getDb().prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return null;
  role.profile = getDb().prepare(`
    SELECT * FROM role_profiles WHERE role_id = ? ORDER BY version DESC LIMIT 1
  `).get(id) || null;
  return role;
}

export function createRole({ companyId, name, description }) {
  const info = getDb().prepare(`
    INSERT INTO roles (company_id, name, description) VALUES (?, ?, ?)
  `).run(companyId, name, description || null);
  return getRole(info.lastInsertRowid);
}

export function updateRoleProfile(roleId, content) {
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM role_profiles WHERE role_id = ?
  `).get(roleId);
  const nextVersion = (row?.v || 0) + 1;
  getDb().prepare(`
    INSERT INTO role_profiles (role_id, version, content) VALUES (?, ?, ?)
  `).run(roleId, nextVersion, content);
  getDb().prepare(`UPDATE roles SET updated_at = datetime('now') WHERE id = ?`).run(roleId);
  return getRole(roleId);
}

// ─── Candidates ───────────────────────────────────────────────────────

export function listCandidates({ companyId, roleId, state } = {}) {
  const where = [];
  const params = [];
  if (companyId) { where.push('c.company_id = ?'); params.push(companyId); }
  if (roleId)    { where.push('c.role_id = ?');    params.push(roleId); }
  if (state)     { where.push('c.state = ?');      params.push(state); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return getDb().prepare(`
    SELECT c.*, r.name AS role_name
    FROM candidates c
    LEFT JOIN roles r ON r.id = c.role_id
    ${whereClause}
    ORDER BY c.updated_at DESC
  `).all(...params);
}

export function getCandidate(id) {
  const cand = getDb().prepare(`
    SELECT c.*, r.name AS role_name
    FROM candidates c
    LEFT JOIN roles r ON r.id = c.role_id
    WHERE c.id = ?
  `).get(id);
  if (!cand) return null;
  cand.stages = getDb().prepare(`
    SELECT * FROM interview_stages WHERE candidate_id = ? ORDER BY stage_num ASC
  `).all(id);
  cand.evaluations = getDb().prepare(`
    SELECT * FROM evaluations WHERE candidate_id = ? ORDER BY created_at DESC
  `).all(id);
  return cand;
}

export function createCandidate(data) {
  const { companyId, name, role_id, email, phone, source, brief } = data;
  // If role_id supplied, verify it belongs to the same company
  if (role_id) {
    const role = getDb().prepare('SELECT company_id FROM roles WHERE id = ?').get(role_id);
    if (!role) throw new Error('role not found');
    if (role.company_id !== companyId) throw new Error('role belongs to a different company');
  }
  const info = getDb().prepare(`
    INSERT INTO candidates (company_id, name, role_id, email, phone, source, brief)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(companyId, name, role_id || null, email || null, phone || null, source || null, brief || null);
  return getCandidate(info.lastInsertRowid);
}

const UPDATABLE = new Set(['name', 'role_id', 'email', 'phone', 'source', 'brief', 'screen_verdict', 'resume_path']);

export function updateCandidate(id, updates) {
  const keys = Object.keys(updates).filter(k => UPDATABLE.has(k));
  if (keys.length === 0) return getCandidate(id);
  // If role_id is being updated, verify it belongs to the candidate's company
  if (updates.role_id) {
    const cand = getDb().prepare('SELECT company_id FROM candidates WHERE id = ?').get(id);
    if (!cand) return null;
    const role = getDb().prepare('SELECT company_id FROM roles WHERE id = ?').get(updates.role_id);
    if (!role) throw new Error('role not found');
    if (role.company_id !== cand.company_id) throw new Error('role belongs to a different company');
  }
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  getDb().prepare(`
    UPDATE candidates SET ${setClause}, updated_at = datetime('now') WHERE id = ?
  `).run(...values, id);
  return getCandidate(id);
}

export function moveCandidate(id, state) {
  if (!STATES.includes(state)) throw new Error(`invalid state: ${state}`);
  getDb().prepare(`
    UPDATE candidates SET state = ?, updated_at = datetime('now') WHERE id = ?
  `).run(state, id);
  return getCandidate(id);
}

export function addEvaluation(candidateId, { stage, author, verdict, content }) {
  const db = getDb();
  let stageId = null;
  if (stage) {
    const existing = db.prepare(`
      SELECT id FROM interview_stages WHERE candidate_id = ? AND stage_num = ?
    `).get(candidateId, stage);
    if (existing) {
      stageId = existing.id;
      db.prepare(`
        UPDATE interview_stages SET completed_at = datetime('now') WHERE id = ?
      `).run(stageId);
    } else {
      const info = db.prepare(`
        INSERT INTO interview_stages (candidate_id, stage_num, completed_at)
        VALUES (?, ?, datetime('now'))
      `).run(candidateId, stage);
      stageId = info.lastInsertRowid;
    }
  }
  db.prepare(`
    INSERT INTO evaluations (candidate_id, stage_id, author, verdict, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(candidateId, stageId, author || null, verdict || null, content || null);
  db.prepare(`UPDATE candidates SET updated_at = datetime('now') WHERE id = ?`).run(candidateId);
  return getCandidate(candidateId);
}

export function deleteCandidate(id) {
  getDb().prepare('DELETE FROM candidates WHERE id = ?').run(id);
}
