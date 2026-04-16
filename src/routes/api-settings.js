/**
 * Settings API routes for zylos-recruit.
 *
 * GET  /api/settings  — current settings + available runtimes
 * PUT  /api/settings  — update settings (writes to config.json)
 */

import express, { Router } from 'express';
import { getConfig, saveConfig, resolveAiConfig } from '../lib/config.js';
import { getAvailableRuntimes, getEnvRuntime, getValidModels, getValidEfforts } from '../lib/ai.js';

const AI_SCENARIOS = ['resume_eval', 'auto_match', 'chat', 'chat_summary', 'portrait'];

function buildResponse() {
  const config = getConfig();
  const available = getAvailableRuntimes();
  const envRt = getEnvRuntime();

  // Build per-scenario resolved config
  const scenarios = {};
  for (const s of AI_SCENARIOS) {
    scenarios[s] = resolveAiConfig(s);
  }

  const aiCfg = config.ai || {};
  return {
    ai: {
      default: resolveAiConfig(),
      scenarios,
      streaming: aiCfg.streaming !== false, // default true
      envRuntime: envRt,
      availableRuntimes: available,
      validModels: getValidModels(),
      validEfforts: getValidEfforts(),
      raw: config.ai || {},
    },
  };
}

function validateAiEntry(entry) {
  const errors = [];
  if (entry.runtime !== undefined) {
    const valid = ['auto', ...Object.keys(getValidModels())];
    if (!valid.includes(entry.runtime)) {
      errors.push(`invalid runtime: ${entry.runtime}`);
    } else if (entry.runtime !== 'auto') {
      const available = getAvailableRuntimes();
      if (!available.includes(entry.runtime)) {
        errors.push(`runtime "${entry.runtime}" is not installed`);
      }
    }
  }
  if (entry.model !== undefined && entry.model !== 'auto') {
    const vm = getValidModels();
    const allModels = [...new Set(Object.values(vm).flat())];
    if (!allModels.includes(entry.model)) {
      errors.push(`invalid model: ${entry.model}`);
    }
  }
  if (entry.effort !== undefined && entry.effort !== '') {
    const ve = getValidEfforts();
    const allEfforts = [...new Set(Object.values(ve).flat())];
    if (!allEfforts.includes(entry.effort)) {
      errors.push(`invalid effort: ${entry.effort}`);
    }
  }
  return errors;
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

    // Validate default
    if (ai.default) {
      const errs = validateAiEntry(ai.default);
      if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    }

    // Validate per-scenario overrides
    for (const s of AI_SCENARIOS) {
      if (ai[s]) {
        const errs = validateAiEntry(ai[s]);
        if (errs.length) return res.status(400).json({ error: `${s}: ${errs.join('; ')}` });
      }
    }

    // Streaming toggle (boolean)
    if (ai.streaming !== undefined) {
      ai.streaming = !!ai.streaming;
    }

    // Backward compat: flat runtime/model/effort → convert to default
    if (!ai.default && (ai.runtime || ai.model || ai.effort)) {
      ai.default = {};
      if (ai.runtime) { ai.default.runtime = ai.runtime; delete ai.runtime; }
      if (ai.model) { ai.default.model = ai.model; delete ai.model; }
      if (ai.effort) { ai.default.effort = ai.effort; delete ai.effort; }
      const errs = validateAiEntry(ai.default);
      if (errs.length) return res.status(400).json({ error: errs.join('; ') });
    }

    saveConfig({ ai });
    res.json(buildResponse());
  });

  return router;
}
