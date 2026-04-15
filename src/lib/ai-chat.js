/**
 * Shared AI chat helper — runs a prompt through AI runtimes.
 *
 * Security: interview prompts include user-controlled content (prompt injection
 * risk). All runtimes must have tool/shell access fully disabled:
 *   - Claude: uses CLI with --tools "" (no tools available)
 *   - Codex (OpenAI): uses Chat Completions API directly (no tools defined)
 *   - Gemini: uses Generative Language API directly (no tools defined)
 *
 * Claude uses CLI because it needs Max subscription OAuth auth.
 * Codex/Gemini use HTTP API to guarantee zero tool access.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAiConfig } from './config.js';

const execFileAsync = promisify(execFile);

// Default models per runtime
const DEFAULT_MODELS = { claude: 'sonnet', codex: 'gpt-4.1', gemini: 'gemini-2.5-flash' };

// Model name mapping for API calls
const OPENAI_MODELS = {
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1-nano': 'gpt-4.1-nano',
  'gpt-5.4': 'gpt-5.4',
  'o3': 'o3',
  'o4-mini': 'o4-mini',
};

const GEMINI_MODELS = {
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.0-flash': 'gemini-2.0-flash',
};

/**
 * Call OpenAI Chat Completions API directly (no tools, pure text).
 */
async function callOpenAI(prompt, model, effort) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const modelId = OPENAI_MODELS[model] || model;
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: prompt }],
  };
  if (effort && effort !== 'medium') {
    body.reasoning_effort = effort;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

/**
 * Call Gemini Generative Language API directly (no tools, pure text).
 */
async function callGemini(prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const modelId = GEMINI_MODELS[model] || model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

/**
 * Call Claude CLI in print mode with all tools disabled.
 */
async function callClaude(prompt, model, effort) {
  const args = ['-p', prompt, '--model', model, '--effort', effort, '--tools', ''];
  const childEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv.ANTHROPIC_API_KEY;

  const { stdout } = await execFileAsync('claude', args, {
    env: childEnv,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Run a prompt through the configured AI runtime and return the response text.
 * @param {string} prompt
 * @param {string} [scenario] - AI scenario name for config resolution
 */
export async function runClaude(prompt, scenario) {
  const aiCfg = resolveAiConfig(scenario);
  const envRuntime = (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();
  const runtime = aiCfg.runtime === 'auto' ? envRuntime : aiCfg.runtime;
  const model = aiCfg.model === 'auto' ? (DEFAULT_MODELS[runtime] || 'sonnet') : aiCfg.model;
  const effort = aiCfg.effort || 'medium';

  try {
    if (runtime === 'codex') {
      return await callOpenAI(prompt, model, effort);
    } else if (runtime === 'gemini') {
      return await callGemini(prompt, model);
    } else {
      return await callClaude(prompt, model, effort);
    }
  } catch (err) {
    console.error(`[recruit] runClaude(${scenario || 'default'}, ${runtime}/${model}): ${err.message}`);
    throw err;
  }
}
