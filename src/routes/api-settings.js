/**
 * Settings API routes for zylos-recruit.
 *
 * GET  /api/settings  — current settings + available runtimes
 * PUT  /api/settings  — update settings (writes to config.json)
 */

import express, { Router } from 'express';
import { getConfig, saveConfig } from '../lib/config.js';
import { getAvailableRuntimes, getEnvRuntime } from '../lib/ai.js';

export function settingsRouter() {
  const router = Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const config = getConfig();
    const available = getAvailableRuntimes();
    const envRt = getEnvRuntime();
    const setting = config.ai?.runtime || 'auto';
    const effective = setting === 'auto' ? envRt : setting;

    res.json({
      ai: {
        runtime: setting,
        effective,
        envRuntime: envRt,
        availableRuntimes: available,
      },
    });
  });

  router.put('/', (req, res) => {
    const { ai } = req.body || {};
    if (!ai || typeof ai !== 'object') {
      return res.status(400).json({ error: 'missing ai settings' });
    }

    if (ai.runtime !== undefined) {
      const valid = ['auto', 'claude', 'codex'];
      if (!valid.includes(ai.runtime)) {
        return res.status(400).json({ error: `invalid runtime: ${ai.runtime}. Must be one of: ${valid.join(', ')}` });
      }
      // If not 'auto', check the runtime is actually available
      if (ai.runtime !== 'auto') {
        const available = getAvailableRuntimes();
        if (!available.includes(ai.runtime)) {
          return res.status(400).json({ error: `runtime "${ai.runtime}" is not installed on this system` });
        }
      }
    }

    saveConfig({ ai });

    const config = getConfig();
    const available = getAvailableRuntimes();
    const envRt = getEnvRuntime();
    const setting = config.ai?.runtime || 'auto';
    const effective = setting === 'auto' ? envRt : setting;

    res.json({
      ai: {
        runtime: setting,
        effective,
        envRuntime: envRt,
        availableRuntimes: available,
      },
    });
  });

  return router;
}
