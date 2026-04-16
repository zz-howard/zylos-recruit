/**
 * AI Gateway — dispatches AI calls to runtime adapters.
 *
 * Decouples scenarios (what to ask) from runtimes (how to call).
 * Each runtime adapter declares its capabilities; the gateway
 * enforces capability requirements before dispatching.
 */

import { resolveAiConfig } from './config.js';
import claudeAdapter from './runtimes/claude.js';
import codexAdapter from './runtimes/codex.js';
import chatgptAdapter from './runtimes/chatgpt.js';
import geminiAdapter from './runtimes/gemini.js';

const adapters = {};
const envRuntime = () => (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();

// Register built-in adapters
for (const a of [claudeAdapter, codexAdapter, chatgptAdapter, geminiAdapter]) {
  adapters[a.name] = a;
}

/**
 * Detect which runtimes are available on this system.
 */
export function detectRuntimes() {
  const available = [];
  for (const a of Object.values(adapters)) {
    if (a.isAvailable()) available.push(a.name);
  }
  console.log(`[recruit] Detected runtimes: [${available.join(', ')}], env: ${envRuntime()}`);
  return { available, envRuntime: envRuntime() };
}

/**
 * Get a registered adapter by name.
 */
export function getAdapter(name) {
  return adapters[name] || null;
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters() {
  return { ...adapters };
}

/**
 * Resolve runtime config for a scenario → { adapter, model, effort }.
 * @param {string} scenario - config scenario name
 * @param {{ runtime?: string, model?: string, effort?: string }} [overrides] -
 *   if provided, bypass config resolution and use these values directly.
 *   Used by interview chat to lock AI config at creation time.
 */
export function resolve(scenario, overrides) {
  const cfg = overrides || resolveAiConfig(scenario);
  const runtimeName = cfg.runtime === 'auto' ? envRuntime() : cfg.runtime;
  const adapter = adapters[runtimeName];
  if (!adapter) throw new Error(`runtime "${runtimeName}" not registered`);

  const model = (!cfg.model || cfg.model === 'auto') ? adapter.defaultModel : cfg.model;
  const effort = cfg.effort || 'medium';
  return { adapter, runtimeName, model, effort };
}

/**
 * Check that an adapter supports all required capabilities.
 * Throws if a capability is missing.
 */
export function checkCapability(adapter, required) {
  for (const cap of required) {
    if (!adapter.capabilities.includes(cap)) {
      throw new Error(
        `runtime "${adapter.name}" does not support "${cap}" — cannot be used for this scenario`
      );
    }
  }
}

/**
 * Non-streaming call. Returns the full response text.
 *
 * @param {string} scenario - config scenario name
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string[]} [opts.required] - required capabilities (default: ['text'])
 * @param {{ runtime?: string, model?: string, effort?: string }} [opts.overrides] - bypass config
 * @param {string} [opts.sessionId] - session ID for conversation resume
 * @returns {Promise<{ text: string, runtime: string, model: string, effort: string, sessionId?: string }>}
 */
export async function call(scenario, prompt, { required = ['text'], overrides, sessionId } = {}) {
  const { adapter, runtimeName, model, effort } = resolve(scenario, overrides);
  checkCapability(adapter, required);

  console.log(`[recruit] AI call: scenario=${scenario}, runtime=${runtimeName}, model=${model}, effort=${effort}${sessionId ? `, resume=${sessionId.slice(0, 8)}…` : ''}`);
  const result = await adapter.call(prompt, { model, effort, capabilities: required, sessionId });
  return { text: result.text || result, runtime: runtimeName, model, effort, sessionId: result.sessionId };
}

/**
 * Streaming call. Yields text chunks as they arrive.
 *
 * @param {string} scenario
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string[]} [opts.required] - required capabilities
 * @param {{ runtime?: string, model?: string, effort?: string }} [opts.overrides] - bypass config
 * @yields {string} text chunks
 */
export async function* stream(scenario, prompt, { required = ['text'], overrides } = {}) {
  const { adapter, runtimeName, model, effort } = resolve(scenario, overrides);
  checkCapability(adapter, required);

  console.log(`[recruit] AI stream: scenario=${scenario}, runtime=${runtimeName}, model=${model}, effort=${effort}`);
  yield* adapter.stream(prompt, { model, effort, capabilities: required });
}
