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
 * Sandbox strategy (platform-dependent):
 * - Linux: SRT bwrap (outer) + Codex Landlock (inner, --sandbox read-only).
 *   Both coexist; /tmp write access enables Landlock initialization.
 * - macOS: SRT seatbelt (outer) + Codex sandbox disabled. Nested
 *   sandbox-exec profiles conflict (inner overrides outer allow rules),
 *   so Codex runs with --dangerously-bypass-approvals-and-sandbox and
 *   SRT seatbelt is the sole file-access control layer.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import os from 'node:os';
import { spawnSandboxed, parseSandboxStatusFromStderr } from './sandbox.js';

const ALWAYS_DISABLED = ['image_generation', 'multi_agent', 'computer_use'];
const NEEDS_SHELL = new Set(['resume_eval', 'auto_match', 'interview_questions']);

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

function disabledFeatures(scenario) {
  const features = [...ALWAYS_DISABLED];
  if (!NEEDS_SHELL.has(scenario)) features.push('shell_tool');
  return features;
}

function buildSandbox(readOnlyBinds = [], scenario = 'unknown') {
  return {
    scenario,
    runtime: 'codex',
    authStatePaths: [`${homedir()}/.codex`],
    readOnlyPaths: readOnlyBinds,
  };
}

function spawnCodex(args, opts) {
  return spawnSandboxed('codex', args, opts, buildSandbox(opts._readOnlyBinds, opts._scenario));
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

  async call(prompt, { model, effort, sessionId, readOnlyBinds, scenario }) {
    let args;
    const isDarwin = os.platform() === 'darwin';
    const disableFlags = disabledFeatures(scenario).flatMap((f) => ['--disable', f]);
    // macOS: SRT seatbelt is sole protection; Codex sandbox disabled.
    // Linux: SRT bwrap + Codex Landlock coexist (dual sandbox).
    const sandboxFlags = isDarwin
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'read-only'];
    // `codex exec resume` does not accept --sandbox; only --dangerously-bypass is valid.
    const resumeSandboxFlags = isDarwin
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : [];
    if (sessionId) {
      args = [
        'exec', 'resume', sessionId, prompt,
        ...resumeSandboxFlags,
        '--json',
        '--skip-git-repo-check',
        ...disableFlags,
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        ...sandboxFlags,
        '--json',
        '--skip-git-repo-check',
        ...disableFlags,
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1', TMPDIR: '/tmp' };

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawnCodex(args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        _readOnlyBinds: readOnlyBinds,
        _scenario: scenario,
      });
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
        else resolve({ stdout: out, stderr: err });
      });
    });
    const sandboxStatus = parseSandboxStatusFromStderr(stderr);
    return { ...parseCodexJsonl(stdout), sandboxed: sandboxStatus?.sandboxed ?? true };
  },

  async *stream(prompt, { model, effort, sessionId, readOnlyBinds, scenario }) {
    let args;
    const isDarwin = os.platform() === 'darwin';
    const disableFlags = disabledFeatures(scenario).flatMap((f) => ['--disable', f]);
    const sandboxFlags = isDarwin
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'read-only'];
    const resumeSandboxFlags = isDarwin
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : [];
    if (sessionId) {
      args = [
        'exec', 'resume', sessionId, prompt,
        ...resumeSandboxFlags,
        '--json',
        '--skip-git-repo-check',
        ...disableFlags,
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
      ];
    } else {
      args = [
        'exec',
        ...sandboxFlags,
        '--json',
        '--skip-git-repo-check',
        ...disableFlags,
        '-c', `model="${model}"`,
        '-c', `model_reasoning_effort=${effort}`,
        prompt,
      ];
    }
    const env = { ...process.env, NO_COLOR: '1', TMPDIR: '/tmp' };

    const child = spawnCodex(args, { env, stdio: ['ignore', 'pipe', 'pipe'], _readOnlyBinds: readOnlyBinds, _scenario: scenario });
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
