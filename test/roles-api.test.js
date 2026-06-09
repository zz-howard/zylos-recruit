import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import express from 'express';
import Database from 'better-sqlite3';

process.env.HOME = path.join(os.tmpdir(), `zylos-recruit-roles-test-${process.pid}`);
const execFileAsync = promisify(execFile);

const {
  createCompany,
} = await import('../src/lib/db.js');
const { rolesRouter } = await import('../src/routes/api-roles.js');

async function makeServer() {
  const app = express();
  app.use('/api/roles', rolesRouter());
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('PUT /api/roles/:id persists interview_prompt', async () => {
  const company = createCompany({ name: `Role Prompt Company ${Date.now()}` });
  const { server, origin } = await makeServer();
  try {
    const created = await fetch(`${origin}/api/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_id: company.id,
        name: 'AI Engineer',
      }),
    });
    assert.equal(created.status, 201);
    const { role } = await created.json();

    const saved = await fetch(`${origin}/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interview_prompt: 'Ask role-specific interview questions.',
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).role.interview_prompt, 'Ask role-specific interview questions.');

    const readBack = await fetch(`${origin}/api/roles/${role.id}`);
    assert.equal(readBack.status, 200);
    assert.equal((await readBack.json()).role.interview_prompt, 'Ask role-specific interview questions.');
  } finally {
    server.close();
  }
});

test('legacy soft-delete migration preserves interview_prompt on roles rebuild', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-recruit-migration-'));
  const dataDir = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'recruit.db');
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    CREATE TABLE companies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      eval_prompt TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE company_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, version)
    );
    CREATE TABLE roles (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      description        TEXT,
      expected_portrait  TEXT,
      eval_prompt        TEXT,
      interview_prompt   TEXT,
      active             INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, name)
    );
    CREATE TABLE role_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(role_id, version)
    );
    CREATE TABLE candidates (
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
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      extra_info     TEXT
    );
    CREATE TABLE evaluations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      kind          TEXT,
      author        TEXT,
      verdict       TEXT,
      content       TEXT,
      meta          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE internal_interviews (
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
    CREATE TABLE internal_interview_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_id    INTEGER NOT NULL REFERENCES internal_interviews(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  oldDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Legacy Co');
  oldDb.prepare(`
    INSERT INTO roles (id, company_id, name, description, expected_portrait, eval_prompt, interview_prompt, active)
    VALUES (1, 1, 'Legacy Role', 'JD', 'Portrait', 'Eval prompt', 'Interview prompt survives', 1)
  `).run();
  oldDb.close();

  const script = `
    import assert from 'node:assert/strict';
    import { getDb, getRole } from ${JSON.stringify(new URL('../src/lib/db.js', import.meta.url).href)};
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(roles)').all().map((c) => c.name);
    assert.ok(columns.includes('interview_prompt'));
    assert.ok(columns.includes('deleted_at'));
    assert.equal(getRole(1).interview_prompt, 'Interview prompt survives');
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home },
  });
});
