/**
 * AI evaluation module for zylos-recruit.
 *
 * Shells out to the local CLI (claude or codex) to evaluate resumes.
 * The CLI can natively read PDFs, so no text extraction needed.
 *
 * Runtime detection: reads ZYLOS_RUNTIME env var ('claude' | 'codex').
 * Defaults to 'claude'.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getCandidate, getRole, getCompany, addEvaluation } from './db.js';
import { RESUMES_DIR } from './config.js';

const execFileAsync = promisify(execFile);

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'resume-eval.md');
const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME, '.claude', '.credentials.json');

function getRuntime() {
  return (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();
}

/**
 * Read the Claude OAuth token from ~/.claude/.credentials.json.
 * Returns the access token string or null if unavailable/expired.
 */
function getClaudeApiKey() {
  // Prefer explicit env var
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8'));
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    // Check expiry (ms timestamp)
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      console.warn('[recruit] Claude OAuth token expired');
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

function loadPromptTemplate() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

function buildPrompt(resumeAbsPath, role, companyProfile, roleProfile) {
  let tpl = loadPromptTemplate();
  tpl = tpl.replace('{{company_profile}}', companyProfile || '（未提供公司背景）');
  tpl = tpl.replace('{{role_name}}', role?.name || '未知岗位');
  tpl = tpl.replace('{{role_profile}}', roleProfile || '（未提供岗位描述）');
  tpl = tpl.replace('{{resume_file}}', resumeAbsPath);
  return tpl;
}

async function runCli(prompt) {
  const runtime = getRuntime();
  let cmd, args;

  if (runtime === 'codex') {
    cmd = 'codex';
    args = [
      'exec',
      '--sandbox', 'read-only',
      prompt,
    ];
  } else {
    cmd = 'claude';
    args = [
      '-p', prompt,
      '--model', 'claude-sonnet-4-6',
      '--allowedTools', 'Read',
      '--bare',
    ];
  }

  const childEnv = { ...process.env, NO_COLOR: '1' };
  if (runtime !== 'codex') {
    const apiKey = getClaudeApiKey();
    if (apiKey) childEnv.ANTHROPIC_API_KEY = apiKey;
  }

  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: childEnv,
  });

  return { text: stdout, runtime };
}

function parseAiResponse(text) {
  // Extract JSON from CLI output (may contain markdown code blocks or other text)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1].trim());
  }
  // Try to find a raw JSON object
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return JSON.parse(braceMatch[0]);
  }
  throw new Error('Failed to parse AI response as JSON');
}

/**
 * Run AI resume evaluation for a candidate.
 * @param {number} candidateId
 * @returns {object} The updated candidate with new evaluation
 */
export async function evaluateResume(candidateId) {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (!candidate.resume_path) throw new Error('no resume uploaded — upload a PDF first');
  if (!candidate.role_id) throw new Error('candidate has no assigned role');

  const resumeAbsPath = path.resolve(RESUMES_DIR, candidate.resume_path);
  if (!fs.existsSync(resumeAbsPath)) {
    throw new Error('resume file missing on disk');
  }

  const role = getRole(candidate.role_id);
  if (!role) throw new Error('role not found');

  const company = getCompany(candidate.company_id);
  const companyProfile = company?.profile?.content || null;
  const roleProfile = role?.profile?.content || null;

  const prompt = buildPrompt(resumeAbsPath, role, companyProfile, roleProfile);
  const { text, runtime } = await runCli(prompt);
  const parsed = parseAiResponse(text);

  const meta = JSON.stringify({
    runtime,
    role_profile_version: role?.profile?.version || null,
    company_profile_version: company?.profile?.version || null,
    score: parsed.score,
    analysis: parsed.analysis,
    recommendation: parsed.recommendation,
  });

  const verdict = parsed.verdict || 'maybe';
  const content = [
    parsed.summary || '',
    '',
    '**技术匹配：** ' + (parsed.analysis?.tech_match || ''),
    '**经验水平：** ' + (parsed.analysis?.experience || ''),
    '**成长潜力：** ' + (parsed.analysis?.potential || ''),
    '**风险点：** ' + (parsed.analysis?.risks || ''),
    '',
    '**建议：** ' + (parsed.recommendation || ''),
  ].join('\n');

  return addEvaluation(candidateId, {
    kind: 'resume_ai',
    author: runtime === 'codex' ? 'codex' : 'claude',
    verdict,
    content,
    meta,
  });
}
