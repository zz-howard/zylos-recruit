/**
 * Gemini CLI runtime adapter.
 *
 * Calls `gemini -p` subprocess. The -y flag auto-approves tool use; filesystem
 * safety is provided by the bwrap sandbox in sandbox.js (defense-in-depth).
 *
 * Auth: GEMINI_API_KEY (configured in the CLI).
 *
 * Session resume: uses `-o json` to capture session_id,
 * then `--resume <id>` on subsequent calls.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { spawnSandboxed } from './sandbox.js';

const GEMINI_SANDBOX = { rwBinds: [`${homedir()}/.gemini`] };

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

    const stdout = await new Promise((resolve, reject) => {
      const child = spawnSandboxed('gemini', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, GEMINI_SANDBOX);
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('gemini call timed out after 600s'));
      }, 600_000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`gemini exited with code ${code}: ${err.slice(0, 500)}`));
        else resolve(out);
      });
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

    const child = spawnSandboxed('gemini', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }, GEMINI_SANDBOX);
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
