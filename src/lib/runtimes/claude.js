/**
 * Claude CLI runtime adapter.
 *
 * Calls `claude -p` subprocess. Supports read_file via --allowedTools Read.
 * Auth: Max subscription OAuth (~/.claude/).
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default {
  name: 'claude',
  capabilities: ['text', 'read_file'],
  models: ['opus', 'sonnet', 'haiku'],
  defaultModel: 'sonnet',
  efforts: ['low', 'medium', 'high', 'max'],

  isAvailable() {
    try {
      execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch { return false; }
  },

  async call(prompt, { model, effort, capabilities = [] }) {
    const args = ['-p', prompt, '--model', model, '--effort', effort];
    if (capabilities.includes('read_file')) {
      args.push('--allowedTools', 'Read');
    } else {
      args.push('--tools', '');
    }
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.ANTHROPIC_API_KEY;

    const { stdout } = await execFileAsync('claude', args, {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 1024 * 1024,
      env,
    });
    return stdout.trim();
  },

  async *stream(prompt, { model, effort, capabilities = [] }) {
    const args = ['-p', prompt, '--model', model, '--effort', effort];
    if (capabilities.includes('read_file')) {
      args.push('--allowedTools', 'Read');
    } else {
      args.push('--tools', '');
    }
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        yield line + '\n';
      }
    }
    if (buf) yield buf;

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`claude exited with code ${code}`));
        else resolve();
      });
    });
  },
};
