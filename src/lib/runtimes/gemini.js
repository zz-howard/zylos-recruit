/**
 * Gemini CLI runtime adapter.
 *
 * Calls `gemini -p` subprocess. Supports read_file natively.
 * Auth: GEMINI_API_KEY (configured in the CLI).
 *
 * Session resume: uses `-o json` to capture session_id,
 * then `--resume <id>` on subsequent calls.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default {
  name: 'gemini',
  capabilities: ['text', 'read_file'],
  models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  defaultModel: 'gemini-2.5-flash',
  efforts: [],  // Gemini CLI does not support effort levels

  isAvailable() {
    try {
      execFileSync('which', ['gemini'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch { return false; }
  },

  async call(prompt, { model, sessionId }) {
    const args = ['-p', prompt, '--model', model, '-y', '-o', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, NO_COLOR: '1' };

    const { stdout } = await execFileAsync('gemini', args, {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 2 * 1024 * 1024,
      env,
    });

    try {
      const json = JSON.parse(stdout);
      return { text: (json.response || '').trim(), sessionId: json.session_id || undefined };
    } catch {
      return { text: stdout.trim() };
    }
  },

  async *stream(prompt, { model, sessionId }) {
    const args = ['-p', prompt, '--model', model, '-y', '-o', 'text'];
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, NO_COLOR: '1' };

    const child = spawn('gemini', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        yield line + '\n';
      }
    }
    if (buf) yield buf;

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`gemini exited with code ${code}`));
        else resolve();
      });
    });
  },
};
