/**
 * Codex CLI runtime adapter.
 *
 * Calls `codex exec` subprocess with read-only sandbox.
 * Supports read_file natively (sandbox can read local files).
 * Auth: ~/.codex/auth.json (OAuth) or OPENAI_API_KEY.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default {
  name: 'codex',
  capabilities: ['text', 'read_file'],
  models: ['gpt-5.4', 'gpt-5.3-codex'],
  defaultModel: 'gpt-5.4',
  efforts: ['none', 'low', 'medium', 'high', 'xhigh'],

  isAvailable() {
    try {
      execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch { return false; }
  },

  async call(prompt, { model, effort }) {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '-c', `model="${model}"`,
      '-c', `model_reasoning_effort=${effort}`,
      prompt,
    ];
    const env = { ...process.env, NO_COLOR: '1' };

    const { stdout } = await execFileAsync('codex', args, {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 1024 * 1024,
      env,
    });
    return stdout.trim();
  },

  async *stream(prompt, { model, effort }) {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '-c', `model="${model}"`,
      '-c', `model_reasoning_effort=${effort}`,
      prompt,
    ];
    const env = { ...process.env, NO_COLOR: '1' };

    const child = spawn('codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (code !== 0) reject(new Error(`codex exited with code ${code}`));
        else resolve();
      });
    });
  },
};
