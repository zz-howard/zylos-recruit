import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const CANDIDATE_CLI_PATHS = [
  path.join(HOME, 'zylos/.claude/skills/pages/src/cli/external-files.js'),
  path.join(HOME, 'zylos/workspace/zylos-pages/src/cli/external-files.js'),
];

function findPagesCli() {
  return CANDIDATE_CLI_PATHS.find((p) => fs.existsSync(p)) || null;
}

function parseJsonOutput(stdout, stderr) {
  const text = String(stdout || stderr || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }
}

async function runCli(args) {
  const cli = findPagesCli();
  if (!cli) {
    return { ok: false, code: 'pages_cli_missing', error: 'zylos-pages external-files CLI not found' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const data = parseJsonOutput(stdout, stderr);
    return data || { ok: true };
  } catch (err) {
    const data = parseJsonOutput(err.stdout, err.stderr);
    if (data) return data;
    return {
      ok: false,
      code: err.code === 'ETIMEDOUT' ? 'pages_cli_timeout' : 'pages_cli_failed',
      error: err.message,
    };
  }
}

export async function getPagesRegistrationStatus() {
  return runCli(['status', '--json']);
}

export async function registerWithPages({ sourcePath, slug }) {
  return runCli([
    'register',
    '--component', 'recruit',
    '--source', sourcePath,
    '--slug', slug,
    '--json',
  ]);
}

export async function unregisterFromPages(slug) {
  if (!slug) return { ok: true, skipped: true };
  return runCli(['unregister', '--slug', slug, '--json']);
}
