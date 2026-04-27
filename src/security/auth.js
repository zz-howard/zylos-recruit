// Cookie-based session authentication for zylos-recruit.
// Adapted from zylos-pages/src/security/auth.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG_PATH, saveConfig } from '../lib/config.js';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = '__Host-zylos_recruit_session';
const SESSION_ABSOLUTE_MS = 86_400_000;   // 24 hours
const SESSION_IDLE_MS = 3_600_000;        // 60 minutes
const CLEANUP_INTERVAL_MS = 300_000;      // 5 minutes

const sessions = new Map();

const failedAttempts = new Map();
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 600_000;
let globalFailures = { count: 0, resetAt: Date.now() + 60_000 };
const GLOBAL_MAX_PER_MIN = 30;

setInterval(() => {
  const now = Date.now();
  for (const [hash, session] of sessions) {
    if (now - session.createdAt > SESSION_ABSOLUTE_MS ||
        now - session.lastActivityAt > SESSION_IDLE_MS) {
      sessions.delete(hash);
    }
  }
}, CLEANUP_INTERVAL_MS).unref?.();

// ─── Password hashing ────────────────────────────────────────────────

export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(plaintext, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function isPlaintext(password) {
  return typeof password === 'string' && !password.startsWith('scrypt:');
}

export function migratePasswordIfNeeded(authConfig) {
  if (!authConfig.password || !isPlaintext(authConfig.password)) return;
  const hashed = hashPassword(authConfig.password);
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config.auth.password = hashed;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    authConfig.password = hashed;
    console.log('[recruit] Auth: migrated plaintext password to scrypt hash');
  } catch (err) {
    console.error('[recruit] Auth: failed to migrate password:', err.message);
  }
}

// ─── Session management ──────────────────────────────────────────────

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = sha256(token);
  const now = Date.now();
  sessions.set(hash, { createdAt: now, lastActivityAt: now });
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const hash = sha256(token);
  const session = sessions.get(hash);
  if (!session) return false;
  const now = Date.now();
  if (now - session.createdAt > SESSION_ABSOLUTE_MS ||
      now - session.lastActivityAt > SESSION_IDLE_MS) {
    sessions.delete(hash);
    return false;
  }
  session.lastActivityAt = now;
  return true;
}

function destroySession(token) {
  if (!token) return;
  sessions.delete(sha256(token));
}

// ─── Cookie helpers ──────────────────────────────────────────────────

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

function getSessionCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

// ─── Brute-force protection ──────────────────────────────────────────

function getClientIp(req) {
  const remoteIp = req.socket.remoteAddress || '';
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp;
}

function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;
  const now = Date.now();
  if (record.count >= MAX_FAILURES) {
    if (now - record.firstFailAt < LOCKOUT_MS) return true;
    failedAttempts.delete(ip);
    return false;
  }
  if (now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return false;
}

function isGlobalLimited() {
  const now = Date.now();
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 0, resetAt: now + 60_000 };
  }
  return globalFailures.count >= GLOBAL_MAX_PER_MIN;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record || now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstFailAt: now });
  } else {
    record.count++;
  }
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 1, resetAt: now + 60_000 };
  } else {
    globalFailures.count++;
  }
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

// ─── Redirect safety ─────────────────────────────────────────────────

function isSafeRedirect(p) {
  if (!p || typeof p !== 'string') return false;
  return p.startsWith('/') && !p.startsWith('//') && !p.includes('://')
    && !p.includes('\\') && !/[\x00-\x1f]/.test(p);
}

// ─── Login template ──────────────────────────────────────────────────

import { loginPageHtml } from '../templates/login.js';

// ─── Main middleware ─────────────────────────────────────────────────

/**
 * Set up cookie-based session auth on an Express app.
 * @param {import('express').Express} app
 * @param {object} authConfig - { enabled, password }
 * @param {string} baseUrl - e.g. '/recruit'
 */
function validateApiToken(req, authConfig) {
  const token = authConfig.api_token;
  if (!token) return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    provided,
    expected,
  );
}

export function setupAuth(app, authConfig, baseUrl) {
  migratePasswordIfNeeded(authConfig);

  // Auto-generate API token if not set
  if (!authConfig.api_token) {
    const token = 'zr_' + crypto.randomBytes(24).toString('hex');
    authConfig.api_token = token;
    saveConfig({ auth: { api_token: token } });
    console.log('[recruit] Auth: API token generated');
  }

  // Parse URL-encoded body only for login
  app.use('/login', (req, res, next) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        req.body = Object.fromEntries(new URLSearchParams(body));
        next();
      });
    } else {
      next();
    }
  });

  app.get('/login', (req, res) => {
    if (validateSession(getSessionCookie(req))) {
      return res.redirect(baseUrl + '/');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.send(loginPageHtml(baseUrl, null, req.query.next));
  });

  app.post('/login', (req, res) => {
    const ip = getClientIp(req);

    if (isLockedOut(ip) || isGlobalLimited()) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).send(loginPageHtml(baseUrl, 'Too many attempts. Try again later.', req.body?.next));
    }

    const password = req.body?.password || '';

    if (!verifyPassword(password, authConfig.password)) {
      recordFailure(ip);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(loginPageHtml(baseUrl, 'Incorrect password.', req.body?.next));
    }

    clearFailures(ip);
    const token = createSession();
    setSessionCookie(res, token);

    const next = req.body?.next;
    const redirectTo = (next && isSafeRedirect(next)) ? next : baseUrl + '/';
    res.redirect(302, redirectTo);
  });

  app.post('/logout', (req, res) => {
    console.log(`[recruit] Logout: host=${req.headers.host}, x-fwd-host=${req.headers['x-forwarded-host']}, origin=${req.headers.origin}, referer=${req.headers.referer}`);
    const expectedHost = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    function extractHost(urlOrOrigin) {
      try { return new URL(urlOrOrigin).host; } catch { return null; }
    }

    // Validate origin/referer when present; allow null/missing since logout
    // is non-destructive (only destroys the caller's own session cookie)
    if (origin && origin !== 'null' && extractHost(origin) !== expectedHost) {
      console.log(`[recruit] Logout CSRF fail: origin host=${extractHost(origin)} != expected=${expectedHost}`);
      return res.status(403).send('Forbidden');
    }
    if (!origin && referer && extractHost(referer) !== expectedHost) {
      console.log(`[recruit] Logout CSRF fail: referer host=${extractHost(referer)} != expected=${expectedHost}`);
      return res.status(403).send('Forbidden');
    }

    destroySession(getSessionCookie(req));
    clearSessionCookie(res);
    res.redirect(302, baseUrl + '/login');
  });

  // Auth gate for everything else
  app.use((req, res, next) => {
    if (!authConfig.enabled || !authConfig.password) return next();

    const isApiPath = req.path.startsWith('/api/') || req.path.startsWith(baseUrl + '/api/');

    if (req.path.startsWith('/_assets') || req.path === '/login' || req.path === '/logout'
        || req.path.startsWith('/chat/') || req.path.startsWith('/api/chat/')) {
      return next();
    }

    if (validateSession(getSessionCookie(req))) {
      res.setHeader('Cache-Control', 'no-store');
      return next();
    }

    // API token (Bearer) bypass for programmatic access
    if (isApiPath && validateApiToken(req, authConfig)) {
      return next();
    }

    // API → 401 JSON, others → redirect
    if (isApiPath) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const rawNext = req.originalUrl || req.url;
    const next_url = rawNext === '/' ? baseUrl + '/' : baseUrl + rawNext;
    const safeNext = isSafeRedirect(next_url) ? `?next=${encodeURIComponent(next_url)}` : '';
    res.redirect(302, `${baseUrl}/login${safeNext}`);
  });
}
