/**
 * Shared AI chat helper — runs a prompt through AI runtimes.
 *
 * Security: interview prompts include user-controlled content (prompt injection
 * risk). All runtimes must have tool/shell access fully disabled:
 *   - Claude: uses CLI with --tools "" (no tools available)
 *   - Codex (OpenAI): Chat Completions API via curl with API key (no tools)
 *   - ChatGPT: ChatGPT backend Responses API via curl with Codex OAuth token
 *              — consumes ChatGPT Pro subscription, no API cost (no tools)
 *   - Gemini: Generative Language API via curl with API key (no tools)
 *
 * Claude uses CLI because it needs Max subscription OAuth auth.
 * All others use HTTP (via curl, which respects HTTPS_PROXY) to guarantee
 * zero tool access.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAiConfig } from './config.js';
import { callCodexOAuth } from './codex-oauth-client.js';

const execFileAsync = promisify(execFile);

// Default models per runtime
const DEFAULT_MODELS = {
  claude: 'sonnet',
  codex: 'gpt-4.1',
  chatgpt: 'gpt-5.4',
  gemini: 'gemini-2.5-flash',
};

/**
 * Call OpenAI Chat Completions API directly with an API key.
 */
async function callOpenAI(prompt, model, effort) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
  };
  if (effort && effort !== 'medium') {
    body.reasoning_effort = effort;
  }

  const { stdout } = await execFileAsync('curl', [
    '-s', '-m', '300',
    'https://api.openai.com/v1/chat/completions',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', JSON.stringify(body),
  ], { encoding: 'utf8', timeout: 310_000, maxBuffer: 1024 * 1024 });

  const data = JSON.parse(stdout);
  if (data.error) throw new Error(`OpenAI API: ${data.error.message || JSON.stringify(data.error)}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

/**
 * Call Gemini Generative Language API directly (no tools, pure text).
 */
async function callGemini(prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const { stdout } = await execFileAsync('curl', [
    '-s', '-m', '300',
    url,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  ], { encoding: 'utf8', timeout: 310_000, maxBuffer: 1024 * 1024 });

  const data = JSON.parse(stdout);
  if (data.error) throw new Error(`Gemini API: ${data.error.message || JSON.stringify(data.error)}`);
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
    } else if (runtime === 'chatgpt') {
      return await callCodexOAuth(prompt, model, effort);
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
