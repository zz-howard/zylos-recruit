/**
 * Claude CLI runtime adapter.
 *
 * Calls `claude -p` subprocess. Filesystem-level safety is provided by the
 * SRT sandbox in sandbox.js: $HOME and ~/zylos are denied by default, then
 * ~/.claude auth/state and scenario-specific read paths are allowed back.
 *
 * Auth: Max subscription OAuth (~/.claude/).
 *
 * Session resume: uses --output-format json to capture session_id,
 * then --resume <id> on subsequent calls to reuse the conversation
 * and hit the model's KV cache.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { spawnSandboxed, parseSandboxStatusFromStderr } from './sandbox.js';

const SCENARIO_TOOLS = {
  chat:                 'WebFetch',
  chat_summary:         '',
  portrait:             '',
  resume_eval:          'Read,WebFetch',
  auto_match:           'Read',
  interview_questions:  'Read,WebFetch',
};

function buildSandbox(readOnlyBinds = [], scenario = 'unknown') {
  return {
    scenario,
    runtime: 'claude',
    authStatePaths: [`${homedir()}/.claude`],
    readOnlyPaths: readOnlyBinds,
  };
}

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

  async call(prompt, { model, effort, capabilities = [], sessionId, readOnlyBinds, scenario }) {
    const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--effort', effort];
    const tools = SCENARIO_TOOLS[scenario] ?? '';
    args.push('--tools', tools);
    if (tools) args.push('--allowedTools', tools);
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.ANTHROPIC_API_KEY;

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawnSandboxed('claude', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, buildSandbox(readOnlyBinds, scenario));
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('claude call timed out after 600s'));
      }, 600_000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`claude exited with code ${code}: ${err.slice(0, 500)}`));
        else resolve({ stdout: out, stderr: err });
      });
    });

    const sandboxStatus = parseSandboxStatusFromStderr(stderr);
    try {
      const json = JSON.parse(stdout);
      return { text: (json.result || '').trim(), sessionId: json.session_id || undefined, sandboxed: sandboxStatus?.sandboxed ?? true };
    } catch {
      return { text: stdout.trim(), sandboxed: sandboxStatus?.sandboxed ?? true };
    }
  },

  async *stream(prompt, { model, effort, capabilities = [], sessionId, readOnlyBinds, scenario }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--effort', effort];
    const tools = SCENARIO_TOOLS[scenario] ?? '';
    args.push('--tools', tools);
    if (tools) args.push('--allowedTools', tools);
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.ANTHROPIC_API_KEY;

    const child = spawnSandboxed('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }, buildSandbox(readOnlyBinds, scenario));
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text') yield block.text;
            }
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
