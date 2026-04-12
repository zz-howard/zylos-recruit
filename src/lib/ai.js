/**
 * AI evaluation module for zylos-recruit.
 *
 * Shells out to the local CLI (claude or codex) to evaluate resumes.
 * The CLI can natively read PDFs, so no text extraction needed.
 *
 * Runtime detection: reads ZYLOS_RUNTIME env var ('claude' | 'codex').
 * Defaults to 'claude'.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getCandidate, getRole, getCompany, addEvaluation, updateCandidate } from './db.js';
import { RESUMES_DIR, getConfig } from './config.js';

const execFileAsync = promisify(execFile);

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'resume-eval.md');
const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME, '.claude', '.credentials.json');

// Available runtimes detected at startup
let availableRuntimes = [];
let envRuntime = (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();

/**
 * Detect which runtimes are installed on this system.
 * Called once at startup.
 */
export function detectRuntimes() {
  availableRuntimes = [];
  for (const rt of ['claude', 'codex']) {
    try {
      execFileSync('which', [rt], { encoding: 'utf8', timeout: 5000 });
      availableRuntimes.push(rt);
    } catch {
      // not installed
    }
  }
  envRuntime = (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();
  console.log(`[recruit] Detected runtimes: [${availableRuntimes.join(', ')}], env: ${envRuntime}`);
  return { available: availableRuntimes, envRuntime };
}

/**
 * Get the list of available runtimes (detected at startup).
 */
export function getAvailableRuntimes() {
  return availableRuntimes;
}

/**
 * Get the current env runtime (ZYLOS_RUNTIME).
 */
export function getEnvRuntime() {
  return envRuntime;
}

/**
 * Resolve the effective runtime: config.ai.runtime → env fallback → 'claude'.
 */
function getRuntime() {
  const config = getConfig();
  const setting = config.ai?.runtime || 'auto';
  if (setting === 'auto') {
    return envRuntime;
  }
  return setting;
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

function buildPrompt(resumeAbsPath, role, companyProfile, roleJd, expectedPortrait, companyEvalPrompt, roleEvalPrompt) {
  let tpl = loadPromptTemplate();
  tpl = tpl.replace('{{company_profile}}', companyProfile || '（未提供公司背景）');
  tpl = tpl.replace('{{role_name}}', role?.name || '未知岗位');
  tpl = tpl.replace('{{role_jd}}', roleJd || '（未提供岗位描述）');
  tpl = tpl.replace('{{expected_portrait}}', expectedPortrait || '');
  tpl = tpl.replace('{{resume_file}}', resumeAbsPath);

  // Build custom instructions section (eval_prompt — usually empty, for special cases only)
  const parts = [];
  if (companyEvalPrompt) parts.push('### 公司评估要求\n\n' + companyEvalPrompt);
  if (roleEvalPrompt) parts.push('### 岗位评估要求\n\n' + roleEvalPrompt);
  const customBlock = parts.length > 0
    ? '## 补充评估指令\n\n' + parts.join('\n\n')
    : '';
  tpl = tpl.replace('{{custom_instructions}}', customBlock);

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

// In-flight evaluation lock: prevents duplicate evaluations for the same candidate
const evaluatingSet = new Set();

export function isEvaluating(candidateId) {
  return evaluatingSet.has(candidateId);
}

/**
 * Run AI resume evaluation for a candidate.
 * @param {number} candidateId
 * @returns {object} The updated candidate with new evaluation
 */
export async function evaluateResume(candidateId) {
  if (evaluatingSet.has(candidateId)) {
    throw new Error('evaluation already in progress');
  }
  evaluatingSet.add(candidateId);
  const t0 = Date.now();
  console.log(`[recruit] AI evaluation started: candidate #${candidateId}`);

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

  console.log(`[recruit] AI evaluation: "${candidate.name}" → role "${role.name}", resume: ${candidate.resume_path}`);

  const company = getCompany(candidate.company_id);
  const companyProfile = company?.profile?.content || null;
  const roleJd = role?.description || null;
  const expectedPortrait = role?.expected_portrait || null;

  const prompt = buildPrompt(resumeAbsPath, role, companyProfile, roleJd, expectedPortrait, company?.eval_prompt, role?.eval_prompt);
  console.log(`[recruit] AI evaluation: spawning CLI (runtime: ${getRuntime()})...`);
  const { text, runtime } = await runCli(prompt);
  console.log(`[recruit] AI evaluation: CLI returned (${((Date.now() - t0) / 1000).toFixed(1)}s), parsing response...`);

  const parsed = parseAiResponse(text);
  console.log(`[recruit] AI evaluation result: verdict=${parsed.verdict}, score=${parsed.score}`);

  const meta = JSON.stringify({
    runtime,
    role_profile_version: role?.profile?.version || null,
    company_profile_version: company?.profile?.version || null,
    score: parsed.score,
    analysis: parsed.analysis,
    recommendation: parsed.recommendation,
  });

  // Write back extracted contact info (only fill empty fields, or replace placeholder name)
  const contact = parsed.contact || {};
  const contactUpdate = {};
  if (contact.name && (!candidate.name || candidate.name === '待识别')) contactUpdate.name = contact.name;
  if (parsed.brief && !candidate.brief) contactUpdate.brief = parsed.brief;
  if (contact.email && !candidate.email) contactUpdate.email = contact.email;
  if (contact.phone && !candidate.phone) contactUpdate.phone = contact.phone;
  if (Object.keys(contactUpdate).length > 0) {
    updateCandidate(candidateId, contactUpdate);
    console.log(`[recruit] AI evaluation: auto-filled fields: ${Object.keys(contactUpdate).join(', ')}`);
  }

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

  const result = addEvaluation(candidateId, {
    kind: 'resume_ai',
    author: runtime === 'codex' ? 'codex' : 'claude',
    verdict,
    content,
    meta,
  });

  console.log(`[recruit] AI evaluation complete: candidate #${candidateId} "${candidate.name}" → ${verdict} (${((Date.now() - t0) / 1000).toFixed(1)}s total)`);
  evaluatingSet.delete(candidateId);
  return result;
}

/**
 * Run AI evaluation in background (fire-and-forget).
 * Returns immediately so the HTTP response isn't blocked by long CLI execution.
 */
export function evaluateResumeAsync(candidateId) {
  evaluateResume(candidateId).catch(err => {
    evaluatingSet.delete(candidateId);
    console.error(`[recruit] AI evaluation failed for candidate #${candidateId}:`, err.message);
  });
}
