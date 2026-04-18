/**
 * ChatGPT runtime adapter.
 *
 * Calls ChatGPT backend Responses API via OpenAI Node SDK + Codex OAuth token.
 * Consumes the user's ChatGPT Pro subscription — zero API cost.
 * HTTP only — cannot read local files.
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * Auth: Bearer access_token from ~/.codex/auth.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const execFileAsync = promisify(execFile);

const AUTH_PATH = path.join(process.env.HOME || '/root', '.codex/auth.json');
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
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

function buildProxiedFetch() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return undefined;
  const dispatcher = new ProxyAgent(proxy);
  return (url, init) => undiciFetch(url, { ...init, dispatcher });
}

async function createClient() {
  let auth = readAuth();
  auth = await refreshTokenIfNeeded(auth);
  const token = auth.tokens.access_token;
  const payload = decodeJwtPayload(token);
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw new Error('JWT missing chatgpt_account_id');

  const opts = {
    apiKey: token,
    baseURL: BASE_URL,
    defaultHeaders: {
      'chatgpt-account-id': accountId,
      originator: 'codex_cli_rs',
    },
  };

  const proxiedFetch = buildProxiedFetch();
  if (proxiedFetch) opts.fetch = proxiedFetch;

  return new OpenAI(opts);
}

function buildParams(prompt, model, effort, conversation) {
  const params = {
    model,
    stream: true,
    store: false,
  };

  if (conversation) {
    params.instructions = conversation.systemPrompt;
    params.input = conversation.messages.map(m =>
      m.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'output_text', text: m.content }] }
        : { role: 'user', content: [{ type: 'input_text', text: m.content }] }
    );
  } else {
    params.instructions = 'You are a helpful assistant. Respond in plain text.';
    params.input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }];
  }

  if (effort && effort !== 'medium') {
    params.reasoning = { effort };
  }
  return params;
}

export default {
  name: 'chatgpt',
  capabilities: ['text'],
  models: ['gpt-5.4', 'gpt-5.3-codex'],
  defaultModel: 'gpt-5.4',
  efforts: ['none', 'low', 'medium', 'high', 'xhigh'],

  isAvailable() {
    try {
      const auth = readAuth();
      return !!auth?.tokens?.access_token;
    } catch { return false; }
  },

  async call(prompt, { model, effort, conversation }) {
    const client = await createClient();
    const stream = await client.responses.create(buildParams(prompt, model, effort, conversation));

    let text = '';
    let usage = null;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'response.completed') usage = event.response?.usage;
      if (event.type === 'error') {
        throw new Error(`chatgpt error: ${event.error?.message || JSON.stringify(event)}`);
      }
    }
    if (usage) {
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      console.log(`[recruit] ChatGPT usage: input=${usage.input_tokens}, output=${usage.output_tokens}, cached=${cached}`);
    }
    if (!text) throw new Error('chatgpt returned empty response');
    return { text: text.trim() };
  },

  async *stream(prompt, { model, effort, conversation }) {
    const client = await createClient();
    const stream = await client.responses.create(buildParams(prompt, model, effort, conversation));

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        yield event.delta;
      }
      if (event.type === 'error') {
        throw new Error(`chatgpt error: ${event.error?.message || JSON.stringify(event)}`);
      }
    }
  },
};
