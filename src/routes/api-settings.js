/**
 * Settings API routes for zylos-recruit.
 *
 * GET  /api/settings  — current settings + available runtimes
 * PUT  /api/settings  — update settings (writes to config.json)
 */

import express, { Router } from 'express';
import { getConfig, saveConfig } from '../lib/config.js';
import { getAvailableRuntimes, getEnvRuntime, VALID_MODELS, VALID_EFFORTS } from '../lib/ai.js';

function buildResponse() {
  const config = getConfig();
  const available = getAvailableRuntimes();
  const envRt = getEnvRuntime();
  const runtimeSetting = config.ai?.runtime || 'auto';
  const effectiveRuntime = runtimeSetting === 'auto' ? envRt : runtimeSetting;

  return {
    ai: {
      runtime: runtimeSetting,
      effective: effectiveRuntime,
      envRuntime: envRt,
      availableRuntimes: available,
      model: config.ai?.model || 'auto',
      validModels: VALID_MODELS,
      effort: config.ai?.effort || 'medium',
      validEfforts: VALID_EFFORTS,
    },
  };
}

export function settingsRouter() {
  const router = Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    res.json(buildResponse());
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
      if (ai.runtime !== 'auto') {
        const available = getAvailableRuntimes();
        if (!available.includes(ai.runtime)) {
          return res.status(400).json({ error: `runtime "${ai.runtime}" is not installed on this system` });
        }
      }
    }

    if (ai.model !== undefined) {
      if (ai.model !== 'auto') {
        const allModels = [...VALID_MODELS.claude, ...VALID_MODELS.codex];
        if (!allModels.includes(ai.model)) {
          return res.status(400).json({ error: `invalid model: ${ai.model}` });
        }
      }
    }

    if (ai.effort !== undefined) {
      if (!VALID_EFFORTS.includes(ai.effort)) {
        return res.status(400).json({ error: `invalid effort: ${ai.effort}. Must be one of: ${VALID_EFFORTS.join(', ')}` });
      }
    }

    saveConfig({ ai });
    res.json(buildResponse());
  });

  return router;
}
