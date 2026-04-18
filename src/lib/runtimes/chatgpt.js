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
import { WEB_FETCH_TOOL_DEFINITION, executeWebFetch } from '../tools/web-fetch.js';

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

function buildParams(prompt, model, effort, conversation, tools) {
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

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  return params;
}

function buildTools() {
  return [
    { type: 'web_search', search_context_size: 'medium' },
    WEB_FETCH_TOOL_DEFINITION,
  ];
}

/**
 * Consume a streaming response, collecting text and function calls.
 * /codex/responses returns empty response.output, so we capture function
 * calls from stream events instead.
 */
async function consumeStream(stream) {
  let text = '';
  let usage = null;
  let webSearchCount = 0;
  const functionCalls = [];
  let currentFnCall = null;

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      text += event.delta || '';
    }
    if (event.type === 'response.web_search_call.completed') {
      webSearchCount++;
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      currentFnCall = { id: event.item.id, name: event.item.name, args: '' };
    }
    if (event.type === 'response.function_call_arguments.delta') {
      if (!currentFnCall) currentFnCall = { id: event.item_id, name: '', args: '' };
      currentFnCall.args += event.delta || '';
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (currentFnCall) {
        currentFnCall.name = event.item.name || currentFnCall.name;
        currentFnCall.args = event.item.arguments || currentFnCall.args;
        functionCalls.push(currentFnCall);
        currentFnCall = null;
      }
    }
    if (event.type === 'response.completed') {
      usage = event.response?.usage;
    }
    if (event.type === 'error') {
      throw new Error(`chatgpt error: ${event.error?.message || JSON.stringify(event)}`);
    }
  }

  return { text, usage, functionCalls, webSearchCount };
}

function logUsage(usage, webSearchCount, webFetchCount) {
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const parts = [`input=${usage.input_tokens}`, `output=${usage.output_tokens}`, `cached=${cached}`];
  if (webSearchCount) parts.push(`web_searches=${webSearchCount}`);
  if (webFetchCount) parts.push(`web_fetches=${webFetchCount}`);
  console.log(`[recruit] ChatGPT usage: ${parts.join(', ')}`);
}

/**
 * Execute web_fetch calls and build a context block with the results.
 * Returns a formatted string to inject into the follow-up request.
 */
async function executeAndFormatFetchResults(functionCalls) {
  const fetches = functionCalls
    .filter(fc => fc.name === 'web_fetch')
    .map(fc => {
      const params = typeof fc.args === 'string' ? JSON.parse(fc.args) : fc.args;
      console.log(`[recruit] web_fetch: ${params.url}`);
      return executeWebFetch(params).then(result => {
        if (result.error) return `[web_fetch ${params.url}]: Error — ${result.error}`;
        return `[web_fetch ${params.url}]:\n${result.text}`;
      });
    });
  const results = await Promise.all(fetches);
  return results.join('\n\n');
}

export default {
  name: 'chatgpt',
  capabilities: ['text', 'web_search', 'web_fetch'],
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
    const MAX_ROUNDS = 25;
    const client = await createClient();
    const tools = buildTools();
    const params = buildParams(prompt, model, effort, conversation, tools);

    let currentInstructions = params.instructions || '';
    let totalWebSearches = 0;
    let totalWebFetches = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const isLastRound = round === MAX_ROUNDS;
      const roundParams = {
        model,
        stream: true,
        store: false,
        instructions: currentInstructions,
        input: params.input,
        tools: isLastRound ? undefined : tools,
      };
      if (effort && effort !== 'medium') {
        roundParams.reasoning = { effort };
      }

      const stream = await client.responses.create(round === 1 ? params : roundParams);
      const result = await consumeStream(stream);
      totalWebSearches += result.webSearchCount;

      const fetchCalls = result.functionCalls.filter(fc => fc.name === 'web_fetch');

      if (fetchCalls.length === 0 || isLastRound) {
        logUsage(result.usage, totalWebSearches, totalWebFetches);
        if (!result.text) throw new Error('chatgpt returned empty response');
        return { text: result.text.trim() };
      }

      totalWebFetches += fetchCalls.length;
      console.log(`[recruit] Round ${round}: ${fetchCalls.length} web_fetch call(s), continuing...`);
      const fetchContext = await executeAndFormatFetchResults(fetchCalls);
      currentInstructions += '\n\n' + fetchContext;
    }
  },

  async *stream(prompt, { model, effort, conversation }) {
    const MAX_ROUNDS = 25;
    const client = await createClient();
    const tools = buildTools();
    const params = buildParams(prompt, model, effort, conversation, tools);

    let currentInstructions = params.instructions || '';

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const isLastRound = round === MAX_ROUNDS;
      const roundParams = round === 1 ? params : {
        model,
        stream: true,
        store: false,
        instructions: currentInstructions,
        input: params.input,
        tools: isLastRound ? undefined : tools,
        ...(effort && effort !== 'medium' ? { reasoning: { effort } } : {}),
      };

      const apiStream = await client.responses.create(roundParams);
      const functionCalls = [];
      let currentFnCall = null;

      for await (const event of apiStream) {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          yield event.delta;
        }
        if (event.type === 'response.web_search_call.searching') {
          yield '\n[搜索中...]\n';
        }
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          currentFnCall = { id: event.item.id, name: event.item.name, args: '' };
        }
        if (event.type === 'response.function_call_arguments.delta') {
          if (!currentFnCall) currentFnCall = { id: event.item_id, name: '', args: '' };
          currentFnCall.args += event.delta || '';
        }
        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          if (currentFnCall) {
            currentFnCall.name = event.item.name || currentFnCall.name;
            currentFnCall.args = event.item.arguments || currentFnCall.args;
            functionCalls.push(currentFnCall);
            currentFnCall = null;
          }
        }
        if (event.type === 'error') {
          throw new Error(`chatgpt error: ${event.error?.message || JSON.stringify(event)}`);
        }
      }

      const fetchCalls = functionCalls.filter(fc => fc.name === 'web_fetch');
      if (fetchCalls.length === 0 || isLastRound) return;

      console.log(`[recruit] Round ${round}: ${fetchCalls.length} web_fetch call(s), continuing...`);
      yield '\n[获取网页内容...]\n';
      const fetchContext = await executeAndFormatFetchResults(fetchCalls);
      currentInstructions += '\n\n' + fetchContext;
    }
  },
};
