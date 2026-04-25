/**
 * Codex CLI runtime adapter.
 *
 * Calls `codex exec` subprocess with read-only sandbox.
 * Supports read_file natively (sandbox can read local files).
 * Auth: ~/.codex/auth.json (OAuth) or OPENAI_API_KEY.
 *
 * Session resume: uses --json to capture thread_id from JSONL output,
 * then `codex exec resume <id> <prompt>` on subsequent calls.
 *
 * Filesystem-level safety is provided by sandbox.js in minimalFS mode:
 * $HOME is tmpfs, only ~/.codex (auth/state) is rw-bound, and caller-
 * supplied roBinds (e.g. resumes/) are the only readable scenario data.
 * This sits on top of codex's own Landlock sandbox; prompt injection
 * that escapes the CLI layer still cannot reach the host filesystem.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { spawnSandboxed } from './sandbox.js';

const BASE_MODELS = ['gpt-5.4', 'gpt-5.3-codex'];
const GPT_55_MIN_CODEX_VERSION = '0.124.0';

function parseVersion(output) {
  const match = String(output || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map((n) => Number(n)) : null;
}

function isAtLeastVersion(actual, minimum) {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > m[i]) return true;
    if (a[i] < m[i]) return false;
  }
  return true;
}

function supportsGpt55() {
  try {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return isAtLeastVersion(version, GPT_55_MIN_CODEX_VERSION);
  } catch {
    return false;
  }
}

function getModels() {
  return supportsGpt55() ? ['gpt-5.5', ...BASE_MODELS] : BASE_MODELS;
}

function buildSandbox(readOnlyBinds = []) {
  return {
    minimalFS: true,
    rwBinds: [`${homedir()}/.codex`],
    roBinds: readOnlyBinds,
  };
}

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
  get models() { return getModels(); },
  defaultModel: 'gpt-5.4',
  efforts: ['none', 'low', 'medium', 'high', 'xhigh'],

  isAvailable() {
    try {
      execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 5000 });
      return true;
    } catch { return false; }
  },

  async call(prompt, { model, effort, sessionId, readOnlyBinds }) {
    let args;
    if (sessionId) {
      // Resume: `codex exec resume <id> <prompt> --json -c model=...`
      // Note: resume subcommand doesn't support --sandbox
      args = [
        'exec', 'resume', sessionId, prompt,
        '--json',
        '--skip-git-repo-check',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        '--sandbox', 'read-only',
        '--json',
        '--skip-git-repo-check',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1' };

    const stdout = await new Promise((resolve, reject) => {
      const child = spawnSandboxed('codex', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, buildSandbox(readOnlyBinds));
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('codex call timed out after 600s'));
      }, 600_000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`codex exited with code ${code}: ${err.slice(0, 500)}`));
        else resolve(out);
      });
    });
    return parseCodexJsonl(stdout);
  },

  async *stream(prompt, { model, effort, sessionId, readOnlyBinds }) {
    let args;
    if (sessionId) {
      args = [
        'exec', 'resume', sessionId, prompt,
        '--json',
        '--skip-git-repo-check',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        '--sandbox', 'read-only',
        '--json',
        '--skip-git-repo-check',
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1' };

    const child = spawnSandboxed('codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }, buildSandbox(readOnlyBinds));
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
