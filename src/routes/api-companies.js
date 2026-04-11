import express from 'express';
import {
  listCompanies, getCompany, createCompany, updateCompany,
  updateCompanyProfile, deleteCompany,
} from '../lib/db.js';

export function companiesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    res.json({ companies: listCompanies() });
  });

  router.post('/', (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    try {
      const company = createCompany({ name: name.trim() });
      res.status(201).json({ company });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'company name already exists' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const company = getCompany(Number(req.params.id));
    if (!company) return res.status(404).json({ error: 'not found' });
    res.json({ company });
  });

  router.put('/:id', (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    try {
      const company = updateCompany(Number(req.params.id), { name: name.trim() });
      if (!company) return res.status(404).json({ error: 'not found' });
      res.json({ company });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'company name already exists' });
      }
      throw err;
    }
  });

  router.put('/:id/profile', (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content required' });
    }
    const company = updateCompanyProfile(Number(req.params.id), content);
    if (!company) return res.status(404).json({ error: 'not found' });
    res.json({ company });
  });

  router.delete('/:id', (req, res) => {
    deleteCompany(Number(req.params.id));
    res.status(204).end();
  });

  return router;
}
