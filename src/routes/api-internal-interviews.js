import crypto from 'node:crypto';
import express from 'express';
import {
  listInternalInterviews, getInternalInterview, createInternalInterview,
  deleteInternalInterview,
} from '../lib/db.js';

export function internalInterviewsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const status = req.query.status || undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const result = listInternalInterviews({ companyId, status, limit, offset });
    res.json(result);
  });

  router.post('/', (req, res) => {
    const { company_id, interviewee_name } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    if (!interviewee_name || typeof interviewee_name !== 'string') {
      return res.status(400).json({ error: 'interviewee_name required' });
    }
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const interview = createInternalInterview({
        companyId: Number(company_id),
        intervieweeName: interviewee_name.trim(),
        token,
      });
      res.status(201).json({ interview });
    } catch (err) {
      if (String(err.message).includes('FOREIGN KEY')) {
        return res.status(400).json({ error: 'company not found' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const interview = getInternalInterview(Number(req.params.id));
    if (!interview) return res.status(404).json({ error: 'not found' });
    res.json({ interview });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = getInternalInterview(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    deleteInternalInterview(id);
    res.status(204).end();
  });

  return router;
}
