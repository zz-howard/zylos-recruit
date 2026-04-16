/**
 * AI evaluation module for zylos-recruit.
 *
 * Uses ai-gateway to dispatch AI calls to runtime adapters.
 * CLI runtimes can natively read PDFs, so no text extraction needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCandidate, getRole, getCompany, addEvaluation, updateCandidate, listRoles } from './db.js';
import { RESUMES_DIR, getConfig, resolveAiConfig } from './config.js';
import {
  detectRuntimes as gwDetectRuntimes,
  call as gwCall,
  stream as gwStream,
  resolve as gwResolve,
  getAllAdapters,
  getAdapter,
} from './ai-gateway.js';

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'resume-eval.md');

// Delegate to gateway
let cachedRuntimes = { available: [], envRuntime: 'claude' };

export function detectRuntimes() {
  cachedRuntimes = gwDetectRuntimes();
  return cachedRuntimes;
}

export function getAvailableRuntimes() {
  return cachedRuntimes.available;
}

export function getEnvRuntime() {
  return cachedRuntimes.envRuntime;
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

// Derive VALID_MODELS and VALID_EFFORTS from registered adapters
function buildValidMaps() {
  const models = {};
  const efforts = {};
  for (const [name, a] of Object.entries(getAllAdapters())) {
    models[name] = a.models;
    efforts[name] = a.efforts;
  }
  return { models, efforts };
}

export function getValidModels() {
  return buildValidMaps().models;
}

export function getValidEfforts() {
  return buildValidMaps().efforts;
}

// Backward compat exports (used by api-settings.js)
export const VALID_MODELS = new Proxy({}, {
  get(_, key) { return getAdapter(key)?.models || []; },
  ownKeys() { return Object.keys(getAllAdapters()); },
  getOwnPropertyDescriptor(_, key) {
    if (getAllAdapters()[key]) return { configurable: true, enumerable: true, value: getAdapter(key).models };
  },
});
export const VALID_EFFORTS = new Proxy({}, {
  get(_, key) { return getAdapter(key)?.efforts || []; },
  ownKeys() { return Object.keys(getAllAdapters()); },
  getOwnPropertyDescriptor(_, key) {
    if (getAllAdapters()[key]) return { configurable: true, enumerable: true, value: getAdapter(key).efforts };
  },
});

/**
 * Run a prompt through the gateway. Evaluation scenarios require read_file.
 */
async function runCli(prompt, scenario = 'resume_eval') {
  const needsFile = ['resume_eval', 'auto_match'].includes(scenario);
  const required = needsFile ? ['text', 'read_file'] : ['text'];
  const readOnlyBinds = needsFile ? [RESUMES_DIR] : undefined;
  return gwCall(scenario, prompt, { required, readOnlyBinds });
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
 * Repair malformed AI response using a lightweight model via the gateway.
 */
async function repairAiResponse(rawText) {
  const repairPrompt = `You are a JSON formatter. The following is an AI evaluation output that failed to parse as JSON. Extract the information and return ONLY a valid JSON object matching this schema:\n\n${JSON_SCHEMA}\n\nRaw AI output:\n\n${rawText}\n\nReturn ONLY the JSON object, no markdown, no explanation.`;

  // Use the default runtime with a lightweight model
  const { adapter } = gwResolve('resume_eval');
  const repairModel = adapter.name === 'codex' ? 'gpt-5.3-codex' :
                      adapter.name === 'chatgpt' ? 'gpt-5.3-codex' :
                      adapter.name === 'gemini' ? 'gemini-2.5-flash' : 'haiku';

  console.log(`[recruit] AI response repair: using ${adapter.name}/${repairModel}...`);
  const text = await adapter.call(repairPrompt, { model: repairModel, effort: 'low' });
  return parseAiResponse(text);
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
  const { text } = await runCli(prompt, 'auto_match');

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

/**
 * Streaming AI resume evaluation.
 * Runs the full evaluation pipeline, calling onEvent(event) for each streaming event.
 * The evaluation always runs to completion and saves to DB, even if the caller disconnects.
 *
 * Events:
 *   { type: 'status', text: '...' }  — progress status
 *   { type: 'chunk',  text: '...' }  — streaming AI text
 *   { type: 'done',   candidate: {...} } — evaluation saved
 *   (errors are thrown, caller should catch)
 *
 * @param {number} candidateId
 * @param {function} [onEvent] - callback for streaming events
 * @returns {Promise<object>} the updated candidate
 */
export async function evaluateResumeStream(candidateId, onEvent) {
  if (evaluatingSet.has(candidateId)) {
    throw new Error('evaluation already in progress');
  }
  evaluatingSet.add(candidateId);
  const t0 = Date.now();
  const emit = (evt) => { try { onEvent?.(evt); } catch {} };

  try {
    emit({ type: 'status', text: '准备评估...' });
    console.log(`[recruit] AI stream evaluation started: candidate #${candidateId}`);

    let candidate = getCandidate(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (!candidate.resume_path) throw new Error('no resume uploaded — upload a PDF first');

    // Auto-match role from resume if none assigned
    if (!candidate.role_id) {
      emit({ type: 'status', text: '正在匹配岗位...' });
      console.log(`[recruit] AI stream evaluation: no role assigned, auto-matching first...`);
      await autoMatchFromResume(candidateId);
      candidate = getCandidate(candidateId);
      if (!candidate.role_id) throw new Error('auto-match failed to assign a role');
    }

    const resumeAbsPath = path.resolve(RESUMES_DIR, candidate.resume_path);
    if (!fs.existsSync(resumeAbsPath)) throw new Error('resume file missing on disk');

    const role = getRole(candidate.role_id);
    if (!role) throw new Error('role not found');

    console.log(`[recruit] AI stream evaluation: "${candidate.name}" → role "${role.name}", resume: ${candidate.resume_path}`);

    const company = getCompany(candidate.company_id);
    const companyProfile = company?.profile?.content || null;
    const roleJd = role?.description || null;
    const expectedPortrait = role?.expected_portrait || null;

    const prompt = buildPrompt(resumeAbsPath, role, companyProfile, roleJd, expectedPortrait, company?.eval_prompt, role?.eval_prompt, candidate.extra_info);

    // Get runtime metadata for saving
    const { runtimeName, model, effort } = gwResolve('resume_eval');

    // Stream from gateway
    emit({ type: 'status', text: '正在评估...' });
    let fullText = '';
    const required = ['text', 'read_file'];
    for await (const chunk of gwStream('resume_eval', prompt, { required, readOnlyBinds: [RESUMES_DIR] })) {
      fullText += chunk;
      emit({ type: 'chunk', text: chunk });
    }

    console.log(`[recruit] AI stream evaluation: stream complete (${((Date.now() - t0) / 1000).toFixed(1)}s), parsing response...`);

    // Parse AI response (same logic as evaluateResume)
    let parsed;
    try {
      parsed = parseAiResponse(fullText);
    } catch (parseErr) {
      console.warn(`[recruit] AI stream evaluation: JSON parse failed (${parseErr.message}), attempting repair...`);
      if (!fullText || fullText.trim().length < 20) {
        throw new Error(`AI returned empty/unusable output (${fullText.length} chars)`);
      }
      parsed = await repairAiResponse(fullText);
      console.log(`[recruit] AI stream evaluation: repair successful`);
    }
    console.log(`[recruit] AI stream evaluation result: verdict=${parsed.verdict}, score=${parsed.score}`);

    // Save metadata
    const meta = JSON.stringify({
      runtime: runtimeName,
      role_profile_version: role?.profile?.version || null,
      company_profile_version: company?.profile?.version || null,
      score: parsed.score,
      analysis: parsed.analysis,
      recommendation: parsed.recommendation,
    });

    // Write back extracted contact info
    const contact = parsed.contact || {};
    const contactUpdate = {};
    if (contact.name && (!candidate.name || candidate.name === '待识别')) contactUpdate.name = contact.name;
    if (parsed.brief && !candidate.brief) contactUpdate.brief = parsed.brief;
    if (contact.email && !candidate.email) contactUpdate.email = contact.email;
    if (contact.phone && !candidate.phone) contactUpdate.phone = contact.phone;
    if (Object.keys(contactUpdate).length > 0) {
      updateCandidate(candidateId, contactUpdate);
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
      author: runtimeName,
      verdict,
      content,
      meta,
    });

    console.log(`[recruit] AI stream evaluation complete: candidate #${candidateId} "${candidate.name}" → ${verdict} (${((Date.now() - t0) / 1000).toFixed(1)}s total)`);
    emit({ type: 'done', candidate: result });
    return result;
  } finally {
    evaluatingSet.delete(candidateId);
  }
}
