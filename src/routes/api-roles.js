import express from 'express';
import {
  listRoles, getRole, createRole, updateRoleProfile,
} from '../lib/db.js';

export function rolesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    res.json({ roles: listRoles() });
  });

  router.post('/', (req, res) => {
    const { name, description } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    try {
      const role = createRole({ name: name.trim(), description });
      res.status(201).json({ role });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'role name already exists' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const role = getRole(Number(req.params.id));
    if (!role) return res.status(404).json({ error: 'not found' });
    res.json({ role });
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

  return router;
}
