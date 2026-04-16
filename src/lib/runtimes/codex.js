/**
 * Codex CLI runtime adapter.
 *
 * Calls `codex exec` subprocess with read-only sandbox.
 * Supports read_file natively (sandbox can read local files).
 * Auth: ~/.codex/auth.json (OAuth) or OPENAI_API_KEY.
 *
 * Session resume: uses --json to capture thread_id from JSONL output,
 * then `codex exec resume <id> <prompt>` on subsequent calls.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Parse Codex JSONL output. Returns { text, sessionId }.
 * Format: one JSON object per line with types: thread.started, item.completed, turn.completed
 */
function parseCodexJsonl(output) {
  let text = '';
  let sessionId;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'thread.started' && evt.thread_id) {
      sessionId = evt.thread_id;
    } else if (evt.type === 'item.completed' && evt.item?.text) {
      text += evt.item.text;
    }
  }
  return { text: text.trim(), sessionId };
}

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

  async call(prompt, { model, effort, sessionId }) {
    let args;
    if (sessionId) {
      // Resume: `codex exec resume <id> <prompt> --json -c model=...`
      // Note: resume subcommand doesn't support --sandbox
      args = [
        'exec', 'resume', sessionId, prompt,
        '--json',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        '--sandbox', 'read-only',
        '--json',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1' };

    const { stdout } = await execFileAsync('codex', args, {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 2 * 1024 * 1024,
      env,
    });
    return parseCodexJsonl(stdout);
  },

  async *stream(prompt, { model, effort, sessionId }) {
    let args;
    if (sessionId) {
      args = [
        'exec', 'resume', sessionId, prompt,
        '--json',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        '--sandbox', 'read-only',
        '--json',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1' };

    const child = spawn('codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'item.completed' && evt.item?.text) {
            yield evt.item.text;
          }
        } catch {
          yield line + '\n';
        }
      }
    }
    if (buf?.trim()) {
      try {
        const evt = JSON.parse(buf);
        if (evt.type === 'item.completed' && evt.item?.text) {
          yield evt.item.text;
        }
      } catch {
        yield buf;
      }
    }

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`codex exited with code ${code}`));
        else resolve();
      });
    });
  },
};
