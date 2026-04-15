/**
 * Shared AI chat helper — runs a prompt through Claude CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME, '.claude', '.credentials.json');

function getClaudeApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8'));
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * Run a prompt through Claude CLI and return the response text.
 */
export function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['--model', 'sonnet', '--effort', 'medium', '--bare'];
    const childEnv = { ...process.env, NO_COLOR: '1' };
    const apiKey = getClaudeApiKey();
    if (apiKey) {
      childEnv.ANTHROPIC_API_KEY = apiKey;
    } else {
      console.warn('[recruit] runClaude: no API key resolved (env unset, credentials read failed or token expired)');
    }

    const child = spawn('claude', args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
    });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => reject(err));
    child.on('close', code => {
      if (code !== 0) {
        console.error(`[recruit] runClaude: exit ${code}, stdout(200): ${stdout.slice(0, 200)}, stderr(200): ${stderr.slice(0, 200)}, hadKey: ${!!apiKey}`);
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
