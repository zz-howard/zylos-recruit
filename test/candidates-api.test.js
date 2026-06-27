import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.HOME = path.join(os.tmpdir(), `zylos-recruit-candidates-test-${process.pid}`);

const {
  createCandidate,
  createCompany,
  createRole,
  updateCandidate,
  upsertRoleMatches,
} = await import('../src/lib/db.js');
const { candidatesRouter } = await import('../src/routes/api-candidates.js');

async function makeServer(routerOptions) {
  const app = express();
  app.use('/api/candidates', candidatesRouter(routerOptions));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function fetchCandidates(origin, companyId, query) {
  const params = new URLSearchParams({ company_id: String(companyId) });
  if (query != null) params.set('q', query);
  const response = await fetch(`${origin}/api/candidates?${params}`);
  assert.equal(response.status, 200);
  return (await response.json()).candidates;
}

test('GET /api/candidates searches candidate and role fields within company scope', async () => {
  const company = createCompany({ name: `Search Company ${Date.now()}` });
  const otherCompany = createCompany({ name: `Other Search Company ${Date.now()}` });
  const engineer = createRole({ companyId: company.id, name: 'Platform Engineer' });
  const designer = createRole({ companyId: company.id, name: 'Product Designer' });
  const otherRole = createRole({ companyId: otherCompany.id, name: 'Platform Engineer' });

  createCandidate({
    companyId: company.id,
    name: 'Ava Chen',
    role_id: engineer.id,
    email: 'ava@example.com',
    phone: '+65 8123 4567',
    source: 'Referral',
    brief: 'Strong backend systems background',
    extra_info: 'Kubernetes and SQLite experience',
  });
  createCandidate({
    companyId: company.id,
    name: 'Bo Lin',
    role_id: designer.id,
    email: 'bo@example.com',
    phone: '+65 9000 1111',
    source: 'LinkedIn',
    brief: 'Portfolio review pending',
    extra_info: 'Design systems',
  });
  createCandidate({
    companyId: otherCompany.id,
    name: 'Cora Wang',
    role_id: otherRole.id,
    email: 'cora@example.com',
    phone: '+65 7000 2222',
    source: 'Referral',
    brief: 'Should stay out of company-scoped search',
    extra_info: 'Kubernetes',
  });

  const { server, origin } = await makeServer();
  try {
    assert.deepEqual((await fetchCandidates(origin, company.id, 'ava')).map((c) => c.name), ['Ava Chen']);
    assert.deepEqual((await fetchCandidates(origin, company.id, '8123')).map((c) => c.name), ['Ava Chen']);
    assert.deepEqual((await fetchCandidates(origin, company.id, 'platform')).map((c) => c.name), ['Ava Chen']);
    assert.deepEqual((await fetchCandidates(origin, company.id, 'design systems')).map((c) => c.name), ['Bo Lin']);
    assert.deepEqual((await fetchCandidates(origin, company.id, 'kubernetes')).map((c) => c.name), ['Ava Chen']);
    assert.deepEqual((await fetchCandidates(origin, company.id, 'no-match')).map((c) => c.name), []);
  } finally {
    server.close();
  }
});

test('candidate search treats LIKE wildcards as literal characters', async () => {
  const company = createCompany({ name: `Wildcard Company ${Date.now()}` });
  createCandidate({
    companyId: company.id,
    name: 'Percent Marker',
    email: 'percent@example.com',
    phone: null,
    source: '100% match',
    brief: null,
    extra_info: 'literal underscore a_b',
  });
  createCandidate({
    companyId: company.id,
    name: 'Plain Marker',
    email: 'plain@example.com',
    phone: null,
    source: 'ordinary match',
    brief: null,
    extra_info: 'literal text',
  });

  const { server, origin } = await makeServer();
  try {
    assert.deepEqual((await fetchCandidates(origin, company.id, '%')).map((c) => c.name), ['Percent Marker']);
    assert.deepEqual((await fetchCandidates(origin, company.id, 'a_b')).map((c) => c.name), ['Percent Marker']);
  } finally {
    server.close();
  }
});

test('GET /api/candidates/:id/auto-match returns empty cache shape and 404 for missing candidate', async () => {
  const company = createCompany({ name: `Auto Match Cache Company ${Date.now()}` });
  const candidate = createCandidate({ companyId: company.id, name: 'Cache Miss Candidate' });
  const { server, origin } = await makeServer();
  try {
    const empty = await fetch(`${origin}/api/candidates/${candidate.id}/auto-match`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { matches: [], cached_at: null });

    const missing = await fetch(`${origin}/api/candidates/999999/auto-match`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not found' });
  } finally {
    server.close();
  }
});

test('POST /api/candidates/:id/auto-match persists matches readable by GET', async () => {
  const company = createCompany({ name: `Auto Match Persist Company ${Date.now()}` });
  const role = createRole({ companyId: company.id, name: 'Persisted Role' });
  const candidate = createCandidate({ companyId: company.id, name: 'Persisted Match Candidate' });
  updateCandidate(candidate.id, { resume_path: 'resume.pdf' });
  const matches = [
    { role_id: role.id, role_name: role.name, score: 88, reason: 'Endpoint contract match' },
  ];
  const { server, origin } = await makeServer({
    rankRoles: async (candidateId) => {
      upsertRoleMatches(candidateId, matches);
      return matches;
    },
  });
  try {
    const response = await fetch(`${origin}/api/candidates/${candidate.id}/auto-match`, {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { matches });

    const cached = await fetch(`${origin}/api/candidates/${candidate.id}/auto-match`);
    assert.equal(cached.status, 200);
    const body = await cached.json();
    assert.deepEqual(body.matches, matches);
    assert.ok(body.cached_at);
  } finally {
    server.close();
  }
});
