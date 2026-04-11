import express from 'express';
import {
  listCandidates, getCandidate, createCandidate, updateCandidate,
  moveCandidate, addEvaluation, deleteCandidate, STATES,
} from '../lib/db.js';

export function candidatesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const roleId = req.query.role_id ? Number(req.query.role_id) : undefined;
    const state = req.query.state || undefined;
    res.json({ candidates: listCandidates({ roleId, state }) });
  });

  router.post('/', (req, res) => {
    const { name, role_id, email, phone, source, brief } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const cand = createCandidate({
      name: name.trim(),
      role_id: role_id ? Number(role_id) : null,
      email, phone, source, brief,
    });
    res.status(201).json({ candidate: cand });
  });

  router.get('/:id', (req, res) => {
    const cand = getCandidate(Number(req.params.id));
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  router.put('/:id', (req, res) => {
    const cand = updateCandidate(Number(req.params.id), req.body || {});
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  router.delete('/:id', (req, res) => {
    deleteCandidate(Number(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/move', (req, res) => {
    const { state } = req.body || {};
    if (!STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${STATES.join(', ')}` });
    }
    const cand = moveCandidate(Number(req.params.id), state);
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  router.post('/:id/evaluate', (req, res) => {
    const { stage, author, verdict, content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }
    const cand = addEvaluation(Number(req.params.id), {
      stage: stage ? Number(stage) : null,
      author, verdict, content,
    });
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  return router;
}
