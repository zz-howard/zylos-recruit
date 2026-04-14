#!/usr/bin/env node
/**
 * zylos-recruit
 *
 * Recruitment management (ATS) for zylos — Kanban board + REST API.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, DATA_DIR, LOGS_DIR, RESUMES_DIR } from './lib/config.js';
import { getDb } from './lib/db.js';
import { setupAuth } from './security/auth.js';
import { uiRoute } from './routes/ui.js';
import { companiesRouter } from './routes/api-companies.js';
import { rolesRouter } from './routes/api-roles.js';
import { candidatesRouter } from './routes/api-candidates.js';
import { resumesRouter } from './routes/api-resumes.js';
import { settingsRouter } from './routes/api-settings.js';
import { internalInterviewsRouter } from './routes/api-internal-interviews.js';
import { chatRouter } from './routes/api-chat.js';
import { chatPageRoute } from './routes/ui-chat.js';
import { detectRuntimes } from './lib/ai.js';

const BASE_URL = '/recruit';

console.log('[recruit] Starting...');
console.log('[recruit] Data directory:', DATA_DIR);

let config = getConfig();
console.log('[recruit] Config loaded, enabled:', config.enabled);
console.log('[recruit] Port:', config.port);
console.log('[recruit] Auth:', config.auth?.enabled && config.auth?.password ? 'enabled' : 'disabled');

if (!config.enabled) {
  console.log('[recruit] Component disabled in config, exiting.');
  process.exit(0);
}

// Ensure data dirs
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(RESUMES_DIR, { recursive: true });

// Initialize DB (runs migrations)
getDb();
console.log('[recruit] Database initialized');

// Detect available AI runtimes
const runtimeInfo = detectRuntimes();
console.log('[recruit] Available runtimes:', runtimeInfo.available.join(', ') || 'none');
console.log('[recruit] Env runtime (ZYLOS_RUNTIME):', runtimeInfo.envRuntime);

let server = null;

watchConfig((newConfig) => {
  console.log('[recruit] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[recruit] Component disabled, stopping...');
    shutdown();
  }
});

async function main() {
  const app = express();

  // Trust first proxy hop (Caddy on localhost)
  app.set('trust proxy', 'loopback');

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Chat pages use Deep Chat web component which needs 'unsafe-inline' for scripts
    const isChatPage = req.path.startsWith('/chat/');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      isChatPage ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '));
    next();
  });

  // Static assets (before auth so login page can load CSS)
  const assetsDir = path.join(import.meta.dirname, '..', 'assets');
  const staticOpts = { maxAge: '1h' };
  app.use('/_assets', express.static(assetsDir, staticOpts));
  // Also mount at BASE_URL/_assets so it works without a reverse proxy
  app.use(BASE_URL + '/_assets', express.static(assetsDir, staticOpts));

  // Chat routes (token-based, no login required — mounted before auth gate)
  const chat = chatRouter();
  app.use('/api/chat', chat);
  app.use(BASE_URL + '/api/chat', chat);
  app.get('/chat/:token', chatPageRoute(BASE_URL));
  app.get(BASE_URL + '/chat/:token', chatPageRoute(BASE_URL));

  // Auth (login/logout + gate)
  setupAuth(app, config.auth || {}, BASE_URL);

  // Routes (authenticated)
  app.get('/', uiRoute(BASE_URL));
  const companies = companiesRouter();
  const roles = rolesRouter();
  const candidates = candidatesRouter();
  const resumes = resumesRouter(config.upload);
  const settings = settingsRouter();
  app.use('/api/companies', companies);
  app.use('/api/roles', roles);
  app.use('/api/candidates', candidates);
  app.use('/api/candidates', resumes);
  app.use('/api/settings', settings);
  const interviews = internalInterviewsRouter();
  app.use('/api/internal-interviews', interviews);
  // Also mount at BASE_URL/api/* so it works without a reverse proxy
  app.use(BASE_URL + '/api/companies', companies);
  app.use(BASE_URL + '/api/roles', roles);
  app.use(BASE_URL + '/api/candidates', candidates);
  app.use(BASE_URL + '/api/candidates', resumes);
  app.use(BASE_URL + '/api/settings', settings);
  app.use(BASE_URL + '/api/internal-interviews', interviews);

  // Error handler
  app.use((err, req, res, _next) => {
    console.error('[recruit] error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  const port = config.port;
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`[recruit] Server listening on 127.0.0.1:${port}`);
  });
}

function shutdown() {
  console.log('[recruit] Shutting down...');
  if (server) {
    server.close(() => {
      console.log('[recruit] Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => {
  console.error('[recruit] Fatal error:', err);
  process.exit(1);
});
