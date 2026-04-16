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
 */
export function resolve(scenario) {
  const cfg = resolveAiConfig(scenario);
  const runtimeName = cfg.runtime === 'auto' ? envRuntime() : cfg.runtime;
  const adapter = adapters[runtimeName];
  if (!adapter) throw new Error(`runtime "${runtimeName}" not registered`);

  const model = cfg.model === 'auto' ? adapter.defaultModel : cfg.model;
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
 * @returns {Promise<{ text: string, runtime: string, model: string, effort: string }>}
 */
export async function call(scenario, prompt, { required = ['text'] } = {}) {
  const { adapter, runtimeName, model, effort } = resolve(scenario);
  checkCapability(adapter, required);

  console.log(`[recruit] AI call: scenario=${scenario}, runtime=${runtimeName}, model=${model}, effort=${effort}`);
  const text = await adapter.call(prompt, { model, effort, capabilities: required });
  return { text, runtime: runtimeName, model, effort };
}

/**
 * Streaming call. Yields text chunks as they arrive.
 *
 * @param {string} scenario
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string[]} [opts.required] - required capabilities
 * @yields {string} text chunks
 */
export async function* stream(scenario, prompt, { required = ['text'] } = {}) {
  const { adapter, runtimeName, model, effort } = resolve(scenario);
  checkCapability(adapter, required);

  console.log(`[recruit] AI stream: scenario=${scenario}, runtime=${runtimeName}, model=${model}, effort=${effort}`);
  yield* adapter.stream(prompt, { model, effort, capabilities: required });
}
