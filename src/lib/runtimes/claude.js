/**
 * Claude CLI runtime adapter.
 *
 * Calls `claude -p` subprocess. Supports read_file via --allowedTools Read.
 * Auth: Max subscription OAuth (~/.claude/).
 *
 * Session resume: uses --output-format json to capture session_id,
 * then --resume <id> on subsequent calls to reuse the conversation
 * and hit the model's KV cache.
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

  async call(prompt, { model, effort, capabilities = [], sessionId }) {
    const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--effort', effort];
    if (sessionId) args.push('--resume', sessionId);
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
      maxBuffer: 2 * 1024 * 1024,
      env,
    });

    try {
      const json = JSON.parse(stdout);
      return { text: (json.result || '').trim(), sessionId: json.session_id || undefined };
    } catch {
      // Fallback: if JSON parse fails, return raw text
      return { text: stdout.trim() };
    }
  },

  async *stream(prompt, { model, effort, capabilities = [], sessionId }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--effort', effort];
    if (sessionId) args.push('--resume', sessionId);
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
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text') yield block.text;
            }
          } else if (evt.type === 'result') {
            // Final result — sessionId available here but stream can't return metadata
            // The caller should use call() if session tracking is needed
          }
        } catch {
          yield line + '\n';
        }
      }
    }
    if (buf) {
      try {
        const evt = JSON.parse(buf);
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text') yield block.text;
          }
        }
      } catch {
        if (buf.trim()) yield buf;
      }
    }

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`claude exited with code ${code}`));
        else resolve();
      });
    });
  },
};
