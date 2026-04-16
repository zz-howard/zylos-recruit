/**
 * ChatGPT runtime adapter.
 *
 * Calls ChatGPT backend Responses API via Codex OAuth token.
 * Consumes the user's ChatGPT Pro subscription — zero API cost.
 * No CLI available — HTTP only. Cannot read local files.
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * Auth: Bearer access_token from ~/.codex/auth.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AUTH_PATH = path.join(process.env.HOME || '/root', '.codex/auth.json');
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_LEEWAY_SEC = 60 * 60;

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('invalid JWT');
  const pad = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
  const b64 = pad.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function readAuth() {
  return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
}

function writeAuthAtomic(auth) {
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_PATH);
}

async function curlRaw(url, body, headers = {}) {
  const args = ['-sS', '-m', '320', url, '-H', 'Content-Type: application/json'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
  const { stdout } = await execFileAsync('curl', args, {
    encoding: 'utf8',
    timeout: 330_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function curlForm(url, form) {
  const encoded = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const { stdout } = await execFileAsync('curl', [
    '-sS', '-m', '30', url,
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-H', 'Accept: application/json',
    '-d', encoded,
  ], { encoding: 'utf8', timeout: 35_000, maxBuffer: 512 * 1024 });
  return stdout;
}

async function refreshTokenIfNeeded(auth) {
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error('auth.json missing access_token');
  const payload = decodeJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp - now > REFRESH_LEEWAY_SEC) return auth;

  const refresh = auth?.tokens?.refresh_token;
  if (!refresh) throw new Error('token expired and no refresh_token');

  const resp = await curlForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CLIENT_ID,
    scope: 'openid profile email offline_access',
  });
  let data;
  try { data = JSON.parse(resp); } catch { throw new Error(`refresh: non-JSON: ${resp.slice(0, 200)}`); }
  if (!data.access_token) throw new Error(`refresh failed: ${resp.slice(0, 300)}`);

  const updated = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      id_token: data.id_token || auth.tokens.id_token,
      refresh_token: data.refresh_token || refresh,
    },
    last_refresh: new Date().toISOString(),
  };
  writeAuthAtomic(updated);
  return updated;
}

function buildRequestBody(prompt, model, effort) {
  const body = {
    model,
    instructions: 'You are a helpful assistant. Respond in plain text.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    stream: true,
    store: false,
  };
  if (effort && effort !== 'medium') {
    body.reasoning = { effort };
  }
  return body;
}

function buildHeaders(token, accountId) {
  return {
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    Accept: 'text/event-stream',
  };
}

async function getTokenAndAccount() {
  let auth = readAuth();
  auth = await refreshTokenIfNeeded(auth);
  const token = auth.tokens.access_token;
  const payload = decodeJwtPayload(token);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw new Error('JWT missing chatgpt_account_id');
  return { token, accountId };
}

function parseResponsesSSE(body) {
  const out = [];
  const errors = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let evt;
    try { evt = JSON.parse(raw); } catch { continue; }
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      out.push(evt.delta);
    } else if (evt.type === 'response.failed' || evt.type === 'error') {
      errors.push(JSON.stringify(evt));
    }
  }
  if (errors.length && !out.length) {
    throw new Error(`responses failed: ${errors.join(' | ')}`);
  }
  return out.join('');
}

export default {
  name: 'chatgpt',
  capabilities: ['text'],  // no read_file — HTTP only, no local file access
  models: ['gpt-5.4', 'gpt-5.3-codex'],
  defaultModel: 'gpt-5.4',
  efforts: ['none', 'low', 'medium', 'high', 'xhigh'],

  isAvailable() {
    try {
      const auth = readAuth();
      return !!auth?.tokens?.access_token;
    } catch { return false; }
  },

  async call(prompt, { model, effort }) {
    const { token, accountId } = await getTokenAndAccount();
    const body = buildRequestBody(prompt, model, effort);
    const headers = buildHeaders(token, accountId);

    const raw = await curlRaw(RESPONSES_URL, body, headers);

    // Check for JSON error response
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        if (j.detail || j.error) throw new Error(`chatgpt error: ${j.detail || JSON.stringify(j.error)}`);
      } catch (e) { if (e.message.startsWith('chatgpt')) throw e; }
    }

    const text = parseResponsesSSE(raw);
    if (!text) throw new Error(`chatgpt returned empty; raw=${raw.slice(0, 400)}`);
    return text.trim();
  },

  async *stream(prompt, { model, effort }) {
    // For now, call() collects full SSE then we yield it.
    // TODO: true streaming with chunked curl when needed.
    const { token, accountId } = await getTokenAndAccount();
    const body = buildRequestBody(prompt, model, effort);
    const headers = buildHeaders(token, accountId);

    const raw = await curlRaw(RESPONSES_URL, body, headers);
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        if (j.detail || j.error) throw new Error(`chatgpt error: ${j.detail || JSON.stringify(j.error)}`);
      } catch (e) { if (e.message.startsWith('chatgpt')) throw e; }
    }

    // Parse SSE and yield deltas
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        yield evt.delta;
      }
    }
  },
};
