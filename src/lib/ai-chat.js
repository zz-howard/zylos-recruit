/**
 * Shared AI chat helper — runs a prompt through the configured runtime.
 *
 * Security: interview prompts include user-controlled content (prompt injection
 * risk). All runtimes guarantee zero tool access:
 *   - CLI runtimes (Claude/Codex/Gemini): tools disabled via CLI flags
 *   - HTTP runtimes (ChatGPT): no tools defined in request body
 *
 * This module no longer handles runtime-specific logic — that lives in
 * the adapter layer (runtimes/*.js) dispatched via ai-gateway.
 */

import { call, stream } from './ai-gateway.js';

/**
 * Run a prompt through the configured AI runtime (non-streaming).
 * @param {string} prompt
 * @param {string} [scenario] - AI scenario name for config resolution
 * @returns {Promise<string>} response text
 */
export async function runClaude(prompt, scenario) {
  const { text } = await call(scenario || 'chat', prompt);
  return text;
}

/**
 * Stream a prompt through the configured AI runtime.
 * @param {string} prompt
 * @param {string} [scenario]
 * @yields {string} text chunks
 */
export async function* streamChat(prompt, scenario) {
  yield* stream(scenario || 'chat', prompt);
}
