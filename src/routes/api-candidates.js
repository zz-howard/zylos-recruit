import express from 'express';
import {
  listCandidates, getCandidate, createCandidate, updateCandidate,
  moveCandidate, addEvaluation, deleteCandidate, STATES,
} from '../lib/db.js';
import { evaluateResumeAsync, isEvaluating } from '../lib/ai.js';

export function candidatesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (!companyId) {
      return res.status(400).json({ error: 'company_id required' });
    }
    const roleId = req.query.role_id ? Number(req.query.role_id) : undefined;
    const state = req.query.state || undefined;
    const candidates = listCandidates({ companyId, roleId, state }).map(c => {
      c.is_evaluating = isEvaluating(c.id);
      return c;
    });
    res.json({ candidates });
  });

  router.post('/', (req, res) => {
    const { company_id, name, role_id, email, phone, source, brief } = req.body || {};
    if (!company_id) {
      return res.status(400).json({ error: 'company_id required' });
    }
    try {
      const cand = createCandidate({
        companyId: Number(company_id),
        name: (name && typeof name === 'string') ? name.trim() : '待识别',
        role_id: role_id ? Number(role_id) : null,
        email, phone, source, brief,
      });
      res.status(201).json({ candidate: cand });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('different company') || msg.includes('role not found')) {
        return res.status(400).json({ error: err.message });
      }
      if (msg.includes('FOREIGN KEY')) {
        return res.status(400).json({ error: 'company not found' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const cand = getCandidate(Number(req.params.id));
    if (!cand) return res.status(404).json({ error: 'not found' });
    cand.is_evaluating = isEvaluating(cand.id);
    res.json({ candidate: cand });
  });

  router.put('/:id', (req, res) => {
    try {
      const cand = updateCandidate(Number(req.params.id), req.body || {});
      if (!cand) return res.status(404).json({ error: 'not found' });
      res.json({ candidate: cand });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('different company') || msg.includes('role not found')) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
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

  // Add human evaluation (interview feedback)
  router.post('/:id/evaluate', (req, res) => {
    const { kind, author, verdict, content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }
    const cand = addEvaluation(Number(req.params.id), {
      kind: kind || 'interview',
      author,
      verdict,
      content,
    });
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  // AI resume evaluation (async — returns 202 immediately, processes in background)
  router.post('/:id/ai-evaluate', (req, res) => {
    const candidateId = Number(req.params.id);
    const cand = getCandidate(candidateId);
    if (!cand) return res.status(404).json({ error: 'not found' });
    if (!cand.resume_path) return res.status(400).json({ error: 'no resume uploaded — upload a PDF first' });
    if (!cand.role_id) return res.status(400).json({ error: 'candidate has no assigned role' });
    if (isEvaluating(candidateId)) return res.status(409).json({ error: '该候选人正在评估中，请稍候' });

    evaluateResumeAsync(candidateId);
    res.status(202).json({ message: 'AI evaluation started', candidate_id: candidateId });
  });

  return router;
}
