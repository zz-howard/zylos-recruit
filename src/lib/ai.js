/**
 * AI evaluation module for zylos-recruit.
 *
 * Calls the Anthropic Messages API to evaluate a candidate's resume
 * against a target role profile.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCandidate, getRole, getCompany, addEvaluation } from './db.js';

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'resume-eval.md');
const MODEL = 'claude-sonnet-4-6';

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

function loadPromptTemplate() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

function buildPrompt(candidate, role, companyProfile, roleProfile) {
  let tpl = loadPromptTemplate();
  tpl = tpl.replace('{{company_profile}}', companyProfile || '（未提供公司背景）');
  tpl = tpl.replace('{{role_name}}', role?.name || '未知岗位');
  tpl = tpl.replace('{{role_profile}}', roleProfile || '（未提供岗位描述）');
  tpl = tpl.replace('{{resume_text}}', candidate.resume_text || '（简历内容为空）');
  return tpl;
}

async function callClaude(prompt) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured. Add it to ~/zylos/.env');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const usage = data.usage || {};
  return { text, model: data.model || MODEL, usage };
}

function parseAiResponse(text) {
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Fallback: try to find any JSON object
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) return JSON.parse(braceMatch[0]);
    throw new Error('Failed to parse AI response as JSON');
  }
}

/**
 * Run AI resume evaluation for a candidate.
 * @param {number} candidateId
 * @returns {object} The updated candidate with new evaluation
 */
export async function evaluateResume(candidateId) {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (!candidate.resume_text) throw new Error('no resume text — upload a PDF first');
  if (!candidate.role_id) throw new Error('candidate has no assigned role');

  const role = getRole(candidate.role_id);
  if (!role) throw new Error('role not found');

  const company = getCompany(candidate.company_id);
  const companyProfile = company?.profile?.content || null;
  const roleProfile = role?.profile?.content || null;

  const prompt = buildPrompt(candidate, role, companyProfile, roleProfile);
  const { text, model, usage } = await callClaude(prompt);
  const parsed = parseAiResponse(text);

  const meta = JSON.stringify({
    model,
    usage,
    role_profile_version: role?.profile?.version || null,
    company_profile_version: company?.profile?.version || null,
    score: parsed.score,
    analysis: parsed.analysis,
    recommendation: parsed.recommendation,
  });

  // verdict from AI: yes / maybe / no
  const verdict = parsed.verdict || 'maybe';
  // content: summary + recommendation for quick reading
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
    author: model,
    verdict,
    content,
    meta,
  });
}
