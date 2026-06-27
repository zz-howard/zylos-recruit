import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOME = path.join(os.tmpdir(), `zylos-recruit-role-matches-test-${process.pid}`);

const {
  createCandidate,
  createCompany,
  createRole,
  deleteCandidate,
  getDb,
  getRoleMatches,
  upsertRoleMatches,
} = await import('../src/lib/db.js');

function makeFixture(name = 'Role Match') {
  const company = createCompany({ name: `${name} Company ${Date.now()}` });
  const firstRole = createRole({ companyId: company.id, name: `${name} Engineer` });
  const secondRole = createRole({ companyId: company.id, name: `${name} Designer` });
  const candidate = createCandidate({ companyId: company.id, name: `${name} Candidate` });
  return { candidate, firstRole, secondRole };
}

test('upsertRoleMatches inserts, updates, and preserves one row per candidate role', () => {
  const { candidate, firstRole, secondRole } = makeFixture('Upsert');

  upsertRoleMatches(candidate.id, [
    { role_id: firstRole.id, role_name: firstRole.name, score: 61, reason: 'Initial fit' },
    { role_id: secondRole.id, role_name: secondRole.name, score: 82, reason: 'Strong fit' },
  ]);
  upsertRoleMatches(candidate.id, [
    { role_id: firstRole.id, role_name: firstRole.name, score: 95, reason: 'Updated fit' },
  ]);

  const stored = getRoleMatches(candidate.id);
  assert.equal(stored.matches.length, 2);
  assert.deepEqual(stored.matches.map((m) => m.role_id), [firstRole.id, secondRole.id]);
  assert.equal(stored.matches[0].score, 95);
  assert.equal(stored.matches[0].reason, 'Updated fit');
  assert.ok(stored.cached_at);

  const rowCount = getDb().prepare(`
    SELECT COUNT(*) AS count FROM role_matches WHERE candidate_id = ? AND role_id = ?
  `).get(candidate.id, firstRole.id).count;
  assert.equal(rowCount, 1);
});

test('getRoleMatches returns empty cache shape when no rows exist', () => {
  const { candidate } = makeFixture('Empty');
  assert.deepEqual(getRoleMatches(candidate.id), { matches: [], cached_at: null });
});

test('deleteCandidate hard-deletes disposable role match cache rows', () => {
  const { candidate, firstRole } = makeFixture('Delete');
  upsertRoleMatches(candidate.id, [
    { role_id: firstRole.id, role_name: firstRole.name, score: 72, reason: 'Cached fit' },
  ]);

  const result = deleteCandidate(candidate.id);
  assert.equal(result.candidate, 1);
  assert.equal(result.roleMatches, 1);
  assert.deepEqual(getRoleMatches(candidate.id), { matches: [], cached_at: null });
});
