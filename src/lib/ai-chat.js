/**
 * Shared AI chat helper — runs a prompt through Claude CLI.
 *
 * Uses `-p` (print mode) instead of `--bare` — bare mode requires
 * API billing auth, while -p works with Claude Max subscription.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAiConfig } from './config.js';

const execFileAsync = promisify(execFile);

// Default models per runtime
const DEFAULT_MODELS = { claude: 'sonnet', codex: 'gpt-5.4', gemini: 'gemini-2.5-flash' };

/**
 * Run a prompt through Claude CLI and return the response text.
 * @param {string} prompt
 * @param {string} [scenario] - AI scenario name for config resolution
 */
export async function runClaude(prompt, scenario) {
  const aiCfg = resolveAiConfig(scenario);
  const envRuntime = (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();
  const runtime = aiCfg.runtime === 'auto' ? envRuntime : aiCfg.runtime;
  const model = aiCfg.model === 'auto' ? (DEFAULT_MODELS[runtime] || 'sonnet') : aiCfg.model;
  const effort = aiCfg.effort || 'medium';

  // Security: all runtimes must have tool access disabled or sandboxed.
  // Interview prompts include user-controlled content (prompt injection risk).
  let cmd, args;
  if (runtime === 'codex') {
    cmd = 'codex';
    args = ['exec', '--sandbox', 'read-only', '-c', `model="${model}"`, '-c', `model_reasoning_effort=${effort}`, prompt];
  } else if (runtime === 'gemini') {
    cmd = 'gemini';
    // --sandbox enables sandboxing; removed -y (yolo) to prevent auto-approving tool calls
    args = ['-p', prompt, '--model', model, '-o', 'text', '--sandbox'];
  } else {
    cmd = 'claude';
    // --tools "" disables all tool access (Bash, Read, Write, etc.)
    args = ['-p', prompt, '--model', model, '--effort', effort, '--tools', ''];
  }

  const childEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv.ANTHROPIC_API_KEY;

  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env: childEnv,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    console.error(`[recruit] runClaude(${scenario || 'default'}): exit ${err.code}, stdout(200): ${stdout.slice(0, 200)}, stderr(200): ${stderr.slice(0, 200)}`);
    throw new Error(`claude exited with code ${err.code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
}
