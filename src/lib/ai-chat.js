/**
 * Shared AI chat helper — runs a prompt through Claude CLI.
 *
 * Uses `-p` (print mode) instead of `--bare` — bare mode requires
 * API billing auth, while -p works with Claude Max subscription.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a prompt through Claude CLI and return the response text.
 */
export async function runClaude(prompt) {
  const args = ['-p', prompt, '--model', 'sonnet', '--effort', 'medium'];
  const childEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv.ANTHROPIC_API_KEY;

  try {
    const { stdout } = await execFileAsync('claude', args, {
      env: childEnv,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    console.error(`[recruit] runClaude: exit ${err.code}, stdout(200): ${stdout.slice(0, 200)}, stderr(200): ${stderr.slice(0, 200)}`);
    throw new Error(`claude exited with code ${err.code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
}
