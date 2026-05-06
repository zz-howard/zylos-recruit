import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.HOME = path.join(os.tmpdir(), `zylos-recruit-test-${process.pid}`);

const {
  addEvaluation,
  createCandidate,
  createCompany,
  getCandidate,
} = await import('../src/lib/db.js');
const { candidatesRouter } = await import('../src/routes/api-candidates.js');

async function makeServer() {
  const app = express();
  app.use('/api/candidates', candidatesRouter());
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function makeCandidate(name = 'Candidate') {
  const company = createCompany({ name: `${name} Company ${Date.now()}` });
  return createCandidate({
    companyId: company.id,
    name,
  });
}

test('DELETE /api/candidates/:id/evaluations/:evalId soft-deletes an evaluation', async () => {
  const candidate = makeCandidate('Delete Eval');
  const updated = addEvaluation(candidate.id, {
    kind: 'interview',
    author: 'Howard',
    verdict: 'pass',
    content: 'Good interview.',
  });
  const evaluation = updated.evaluations[0];
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(
      `${origin}/api/candidates/${candidate.id}/evaluations/${evaluation.id}`,
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.evaluation.id, evaluation.id);
    assert.equal(body.evaluation.candidate_id, candidate.id);
    assert.equal(body.evaluation.content, 'Good interview.');
    assert.ok(body.evaluation.deleted_at);
    assert.ok(body.evaluation.delete_batch);

    const after = getCandidate(candidate.id);
    assert.equal(after.evaluations.some((e) => e.id === evaluation.id), false);
  } finally {
    server.close();
  }
});

test('DELETE evaluation returns 404 when candidate is missing', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/api/candidates/999999/evaluations/1`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'candidate not found' });
  } finally {
    server.close();
  }
});

test('DELETE evaluation returns 404 when evaluation is missing or belongs to another candidate', async () => {
  const first = makeCandidate('First Eval Owner');
  const second = makeCandidate('Second Eval Owner');
  const updated = addEvaluation(first.id, {
    kind: 'interview',
    content: 'Belongs to first candidate.',
  });
  const evaluation = updated.evaluations[0];
  const { server, origin } = await makeServer();
  try {
    const missing = await fetch(`${origin}/api/candidates/${first.id}/evaluations/999999`, {
      method: 'DELETE',
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'evaluation not found' });

    const wrongCandidate = await fetch(
      `${origin}/api/candidates/${second.id}/evaluations/${evaluation.id}`,
      { method: 'DELETE' },
    );
    assert.equal(wrongCandidate.status, 404);
    assert.deepEqual(await wrongCandidate.json(), { error: 'evaluation not found' });
  } finally {
    server.close();
  }
});
