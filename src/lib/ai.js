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
import { getCandidate, getRole, getCompany, addEvaluation, updateCandidate, listRoles } from './db.js';
import { RESUMES_DIR, getConfig } from './config.js';

const execFileAsync = promisify(execFile);

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'resume-eval.md');
// Available runtimes detected at startup
let availableRuntimes = [];
let envRuntime = (process.env.ZYLOS_RUNTIME || 'claude').toLowerCase();

/**
 * Detect which runtimes are installed on this system.
 * Called once at startup.
 */
export function detectRuntimes() {
  availableRuntimes = [];
  for (const rt of ['claude', 'codex', 'gemini']) {
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

function loadPromptTemplate() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

function buildPrompt(resumeAbsPath, role, companyProfile, roleJd, expectedPortrait, companyEvalPrompt, roleEvalPrompt, extraInfo) {
  let tpl = loadPromptTemplate();
  tpl = tpl.replace('{{company_profile}}', companyProfile || '（未提供公司背景）');
  tpl = tpl.replace('{{role_name}}', role?.name || '未知岗位');
  tpl = tpl.replace('{{role_jd}}', roleJd || '（未提供岗位描述）');
  tpl = tpl.replace('{{expected_portrait}}', expectedPortrait || '');
  tpl = tpl.replace('{{resume_file}}', resumeAbsPath);
  tpl = tpl.replace('{{extra_info_section}}', extraInfo
    ? '## 候选人额外信息\n\n以下是提交者补充的额外信息，请在评估时参考：\n\n' + extraInfo
    : '');

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

// Default models per runtime
const DEFAULT_MODELS = { claude: 'sonnet', codex: 'gpt-5.4', gemini: 'gemini-2.5-flash' };
// Valid model choices per runtime
const VALID_MODELS = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.4', 'gpt-5.3-codex'],
  gemini: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
};
const VALID_EFFORTS = {
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['none', 'low', 'medium', 'high', 'xhigh'],
  gemini: [],
};

export { VALID_MODELS, VALID_EFFORTS };

function resolveModel(runtime) {
  const config = getConfig();
  const setting = config.ai?.model || 'auto';
  if (setting === 'auto') return DEFAULT_MODELS[runtime] || DEFAULT_MODELS.claude;
  return setting;
}

function resolveEffort() {
  const config = getConfig();
  return config.ai?.effort || 'medium';
}

async function runCli(prompt) {
  const runtime = getRuntime();
  const model = resolveModel(runtime);
  const effort = resolveEffort();
  let cmd, args;

  if (runtime === 'codex') {
    cmd = 'codex';
    args = [
      'exec',
      '--sandbox', 'read-only',
      '-c', `model="${model}"`,
      '-c', `model_reasoning_effort=${effort}`,
      prompt,
    ];
  } else if (runtime === 'gemini') {
    cmd = 'gemini';
    args = ['-p', prompt, '--model', model, '-y', '-o', 'text'];
  } else {
    // Claude: use -p (print mode) — --bare requires API billing auth
    cmd = 'claude';
    args = ['-p', prompt, '--model', model, '--effort', effort, '--allowedTools', 'Read'];
  }

  const effortStr = effort && VALID_EFFORTS[runtime]?.length ? `, effort: ${effort}` : '';
  console.log(`[recruit] AI evaluation: spawning CLI (runtime: ${runtime}, model: ${model}${effortStr})...`);

  const childEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv.ANTHROPIC_API_KEY;

  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 1024 * 1024,
    env: childEnv,
  });

  return { text: stdout, runtime, model, effort };
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

const JSON_SCHEMA = `{
  "verdict": "yes|no",
  "score": 0-100,
  "summary": "一句话总结",
  "brief": "候选人一句话简介",
  "contact": { "name": "姓名或null", "email": "邮箱或null", "phone": "电话或null" },
  "analysis": { "tech_match": "...", "experience": "...", "potential": "...", "risks": "..." },
  "recommendation": "给面试官的建议"
}`;

/**
 * Repair malformed AI response using a lightweight model.
 * Uses haiku (claude runtime) or gpt-5.3-codex-spark (codex runtime).
 */
async function repairAiResponse(rawText) {
  const repairPrompt = `You are a JSON formatter. The following is an AI evaluation output that failed to parse as JSON. Extract the information and return ONLY a valid JSON object matching this schema:\n\n${JSON_SCHEMA}\n\nRaw AI output:\n\n${rawText}\n\nReturn ONLY the JSON object, no markdown, no explanation.`;

  let cmd, args;
  if (envRuntime === 'codex') {
    cmd = 'codex';
    args = ['exec', '--sandbox', 'read-only', '-c', 'model="gpt-5.3-codex-spark"', repairPrompt];
  } else {
    cmd = 'claude';
    args = ['-p', repairPrompt, '--model', 'haiku', '--effort', 'low'];
  }

  const childEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv.ANTHROPIC_API_KEY;

  console.log(`[recruit] AI response repair: using ${envRuntime === 'codex' ? 'gpt-5.3-codex-spark' : 'haiku'} to extract JSON...`);
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    env: childEnv,
  });

  return parseAiResponse(stdout);
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

  let candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (!candidate.resume_path) throw new Error('no resume uploaded — upload a PDF first');

  // Auto-match role from resume if none assigned
  if (!candidate.role_id) {
    console.log(`[recruit] AI evaluation: no role assigned, auto-matching first...`);
    await autoMatchFromResume(candidateId);
    candidate = getCandidate(candidateId);
    if (!candidate.role_id) throw new Error('auto-match failed to assign a role');
  }

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

  const prompt = buildPrompt(resumeAbsPath, role, companyProfile, roleJd, expectedPortrait, company?.eval_prompt, role?.eval_prompt, candidate.extra_info);
  const { text, runtime, model, effort } = await runCli(prompt);
  console.log(`[recruit] AI evaluation: CLI returned (${((Date.now() - t0) / 1000).toFixed(1)}s), parsing response...`);

  let parsed;
  try {
    parsed = parseAiResponse(text);
  } catch (parseErr) {
    console.warn(`[recruit] AI evaluation: JSON parse failed (${parseErr.message}), attempting repair...`);
    console.warn(`[recruit] AI evaluation: raw output (first 500 chars): ${text.slice(0, 500)}`);
    if (!text || text.trim().length < 20) {
      throw new Error(`AI returned empty/unusable output (${text.length} chars)`);
    }
    parsed = await repairAiResponse(text);
    console.log(`[recruit] AI evaluation: repair successful`);
  }
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

  const verdict = parsed.verdict === 'yes' ? 'yes' : 'no';
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
    author: runtime,
    verdict,
    content,
    meta,
  });

  console.log(`[recruit] AI evaluation complete: candidate #${candidateId} "${candidate.name}" → ${verdict} (${((Date.now() - t0) / 1000).toFixed(1)}s total)`);
  evaluatingSet.delete(candidateId);
  return result;
}

/**
 * Auto-match a candidate to the best active role based on their resume.
 * Reads the resume, compares against active role portraits, assigns the best match.
 * @param {number} candidateId
 * @returns {object} { role_id, role_name, reason }
 */
export async function autoMatchFromResume(candidateId) {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (!candidate.resume_path) throw new Error('no resume uploaded');

  const resumeAbsPath = path.resolve(RESUMES_DIR, candidate.resume_path);
  if (!fs.existsSync(resumeAbsPath)) throw new Error('resume file missing on disk');

  const activeRoles = listRoles({ companyId: candidate.company_id, active: true });
  if (activeRoles.length === 0) throw new Error('没有活跃的岗位可供匹配');

  // Single active role — assign directly without AI call
  if (activeRoles.length === 1) {
    const role = activeRoles[0];
    updateCandidate(candidateId, { role_id: role.id });
    console.log(`[recruit] Auto-match: candidate #${candidateId} → only active role "${role.name}" (ID: ${role.id})`);
    return { role_id: role.id, role_name: role.name, reason: '唯一活跃岗位，自动分配' };
  }

  const rolesText = activeRoles.map(r => {
    const parts = [`### ${r.name} (ID: ${r.id})`];
    if (r.description) parts.push(r.description);
    if (r.expected_portrait) parts.push(`**岗位画像：**\n${r.expected_portrait}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');

  const prompt = `你是一位资深招聘专家。请阅读以下简历文件，并与可匹配的岗位进行比对，选出最合适的岗位。

请先使用 Read 工具阅读简历文件：${resumeAbsPath}

## 可匹配的岗位

${rolesText}

---

请选出最匹配的岗位，以 JSON 格式输出：
{"role_id": <数字>, "role_name": "<岗位名称>", "reason": "<一句话说明匹配原因>"}

只输出 JSON，不要其他文字。`;

  console.log(`[recruit] Auto-match from resume: candidate #${candidateId} against ${activeRoles.length} active roles...`);
  const { text } = await runCli(prompt);

  let parsed;
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    parsed = JSON.parse(jsonMatch[0]);
  } else {
    throw new Error('Failed to parse auto-match response');
  }

  // Validate — fall back to first active role if AI returned invalid ID
  const matchedRole = activeRoles.find(r => r.id === parsed.role_id);
  if (!matchedRole) {
    parsed.role_id = activeRoles[0].id;
    parsed.role_name = activeRoles[0].name;
  }

  updateCandidate(candidateId, { role_id: parsed.role_id });
  console.log(`[recruit] Auto-match: candidate #${candidateId} → "${parsed.role_name}" (ID: ${parsed.role_id}): ${parsed.reason}`);
  return parsed;
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
