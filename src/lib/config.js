/**
 * Configuration loader for zylos-recruit
 *
 * Loads config from ~/zylos/components/recruit/config.json
 * with hot-reload support via file watcher.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/recruit');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const DB_PATH = path.join(DATA_DIR, 'recruit.db');
export const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

export const DEFAULT_CONFIG = {
  enabled: true,
  port: 3465,
  auth: {
    enabled: true,
    password: null,
    api_token: null, // auto-generated on first start; use as Bearer token for API access
  },
  upload: {
    maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['application/pdf'],
  },
  rateLimit: {
    windowMs: 60_000,
    max: 120,
  },
  ai: {
    default: { runtime: 'auto', model: 'auto', effort: 'medium' },
    // Per-scenario overrides (merge onto default):
    // resume_eval: {},
    // auto_match: {},
    // chat: {},
    // chat_summary: {},
    // portrait: {},
  },
};

let config = null;
let configWatcher = null;

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const fileConfig = JSON.parse(content);
      config = deepMerge(DEFAULT_CONFIG, fileConfig);
    } else {
      console.warn(`[recruit] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[recruit] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  if (process.env.RECRUIT_PORT) {
    config.port = parseInt(process.env.RECRUIT_PORT, 10);
  }
  return config;
}

export function watchConfig(onChange) {
  if (configWatcher) configWatcher.close();
  if (fs.existsSync(CONFIG_PATH)) {
    configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[recruit] Config changed, reloading...');
        loadConfig();
        if (onChange) onChange(config);
      }
    });
  }
}

export function saveConfig(updates) {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch { /* start fresh */ }
  // Deep merge updates into file config
  const merged = deepMerge(fileConfig, updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  // Reload in memory
  loadConfig();
  return config;
}

/**
 * Resolve AI config for a given scenario.
 * Merges: default ← scenario override ← legacy flat fields (backward compat).
 * @param {string} scenario - 'resume_eval' | 'auto_match' | 'chat' | 'chat_summary' | 'portrait'
 * @returns {{ runtime: string, model: string, effort: string }}
 */
export function resolveAiConfig(scenario) {
  const cfg = getConfig();
  const ai = cfg.ai || {};

  // Support both new nested format and legacy flat format
  const defaults = ai.default || {
    runtime: ai.runtime || 'auto',
    model: ai.model || 'auto',
    effort: ai.effort || 'medium',
  };
  const override = (scenario && ai[scenario]) || {};

  return {
    runtime: override.runtime || defaults.runtime || 'auto',
    model: override.model || defaults.model || 'auto',
    effort: override.effort || defaults.effort || 'medium',
  };
}

export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}
