import express from 'express';
import {
  listRoles, getRole, createRole, updateRole, updateRoleProfile, deleteRole,
} from '../lib/db.js';

export function rolesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (!companyId) {
      return res.status(400).json({ error: 'company_id required' });
    }
    const active = req.query.active !== undefined ? req.query.active === '1' : undefined;
    res.json({ roles: listRoles({ companyId, active }) });
  });

  router.post('/', (req, res) => {
    const { company_id, name, description, expected_portrait } = req.body || {};
    if (!company_id) {
      return res.status(400).json({ error: 'company_id required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    try {
      const role = createRole({
        companyId: Number(company_id),
        name: name.trim(),
        description,
        expected_portrait,
      });
      res.status(201).json({ role });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'role name already exists in this company' });
      }
      if (String(err.message).includes('FOREIGN KEY')) {
        return res.status(400).json({ error: 'company not found' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const role = getRole(Number(req.params.id));
    if (!role) return res.status(404).json({ error: 'not found' });
    res.json({ role });
  });

  router.put('/:id', (req, res) => {
    const { name, description, expected_portrait, eval_prompt, active } = req.body || {};
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    const id = Number(req.params.id);
    const existing = getRole(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    try {
      const role = updateRole(id, {
        name: name !== undefined ? name.trim() : undefined,
        description: description !== undefined ? (description || null) : undefined,
        expected_portrait,
        eval_prompt,
        active,
      });
      res.json({ role });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'role name already exists in this company' });
      }
      throw err;
    }
  });

  router.put('/:id/profile', (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content required' });
    }
    const role = updateRoleProfile(Number(req.params.id), content);
    if (!role) return res.status(404).json({ error: 'not found' });
    res.json({ role });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = getRole(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    deleteRole(id);
    res.status(204).end();
  });

  return router;
}
