import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createInterviewQuestionDocument,
  updateInterviewQuestionDocument,
  getInterviewQuestionDocument,
  getCandidate,
  getCompany,
  getRole,
} from './db.js';
import { DATA_DIR, RESUMES_DIR } from './config.js';
import { call as aiCall } from './ai-gateway.js';
import { registerWithPages, unregisterFromPages } from './pages-integration.js';

const DOCS_DIR = path.join(DATA_DIR, 'interview-questions');

function latestByKind(evaluations, kind) {
  return (evaluations || []).find((e) => e.kind === kind) || null;
}

function evaluationsByKind(evaluations, kind) {
  return (evaluations || []).filter((e) => e.kind === kind);
}

function safeTitlePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|#\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownEscapeYaml(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function relativeDocPath(filename) {
  return path.join('interview-questions', filename);
}

export function resolveDocumentPath(doc) {
  if (!doc?.file_path) throw new Error('document has no file path');
  const abs = path.resolve(DATA_DIR, doc.file_path);
  const root = path.resolve(DATA_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('document path escapes recruit data directory');
  }
  return abs;
}

function parseEvalMeta(evaluation) {
  if (!evaluation?.meta) return null;
  try { return JSON.parse(evaluation.meta); } catch { return null; }
}

function buildContext({ candidate, role, company, customPrompt }) {
  const latestResumeEval = latestByKind(candidate.evaluations, 'resume_ai');
  const resumeMeta = parseEvalMeta(latestResumeEval);
  const interviewEvals = evaluationsByKind(candidate.evaluations, 'interview').slice(0, 3);

  const sections = [];
  sections.push(`# Interview Question Generation Context`);

  sections.push(`## Company
Name: ${company?.name || 'Unknown'}

${company?.profile?.content || '(company profile not provided)'}

${company?.eval_prompt ? `### Company Evaluation Instructions\n${company.eval_prompt}` : ''}`);

  sections.push(`## Role
Name: ${role?.name || 'Unknown'}

### Job Description
${role?.description || '(role JD not provided)'}

### Expected Portrait
${role?.expected_portrait || '(role expected portrait not provided)'}

${role?.eval_prompt ? `### Role Evaluation Instructions\n${role.eval_prompt}` : ''}`);

  sections.push(`## Candidate
Name: ${candidate.name}
Source: ${candidate.source || '(not provided)'}
Pipeline State: ${candidate.state || '(not provided)'}
Brief: ${candidate.brief || '(not provided)'}
Extra Info: ${candidate.extra_info || '(not provided)'}`);

  if (candidate.resume_path) {
    sections.push(`## Resume File
Read this file when the selected runtime supports file access:
${path.resolve(RESUMES_DIR, candidate.resume_path)}`);
  }

  if (latestResumeEval) {
    sections.push(`## Latest Resume AI Evaluation
Verdict: ${latestResumeEval.verdict || '(not provided)'}
Score: ${resumeMeta?.score ?? '(not provided)'}

${latestResumeEval.content || ''}

${resumeMeta?.analysis ? `### Analysis JSON\n${JSON.stringify(resumeMeta.analysis, null, 2)}` : ''}
${resumeMeta?.recommendation ? `### Recommendation\n${resumeMeta.recommendation}` : ''}`);
  }

  if (interviewEvals.length > 0) {
    sections.push(`## Previous Human Interview Feedback
${interviewEvals.map((e) => `### ${e.created_at || ''} ${e.verdict || ''}
${e.content || ''}`).join('\n\n')}`);
  }

  if (customPrompt?.trim()) {
    sections.push(`## Interviewer Preferences For This Generation
${customPrompt.trim()}`);
  }

  return sections.join('\n\n---\n\n');
}

function buildPrompt(ctx) {
  return `${ctx}

---

You are designing a reference interview-question document for Howard Zhou to use in a technical interview.

Write in Chinese unless the candidate or role context clearly requires English.

Use these non-negotiable style rules:
- Write like a real person talking, not like an AI-generated questionnaire.
- Ask one question at a time. Never stack multiple sub-questions inside one numbered question.
- Use concrete examples when they help the candidate understand the expected depth.
- Put a short interviewer-only note after each question using this exact form: "> 考察点：..."
- Use natural follow-up guidance, not long scripted follow-up lists.
- Do not write verbose "意图" or analysis blocks.

Default structure:
1. Opening and representative project warm-up
2. Technical foundation
3. Architecture, engineering habits, and production experience
4. AI-native work habits
5. Closing and reverse questions

Default duration is 60 minutes. If interviewer preferences mention a different duration or round, adapt the number and depth of questions accordingly.

Ground questions in the candidate evidence above. If the resume file is available to you, read it before finalizing the questions. Use prior resume evaluation as evidence, but do not blindly repeat it.

Return Markdown only. Include frontmatter with title, description, date, and tags. At the end, include:
- evaluation dimension coverage table
- pacing reminder
- 2-3 most revealing questions for this candidate`;
}

function ensureFrontmatter(markdown, { title, roleName }) {
  const trimmed = stripFrontmatter(stripMarkdownFence(String(markdown || '').trim()));
  const today = new Date().toISOString().slice(0, 10);
  return `---
title: "${markdownEscapeYaml(title)}"
description: "${markdownEscapeYaml(roleName || 'Interview guide')}"
date: "${today}"
tags: [recruit, interview-questions]
---

${trimmed}
`;
}

function stripMarkdownFence(markdown) {
  const match = markdown.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  return match ? match[1].trim() : markdown;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim();
}

function inferMarkdownTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return safeTitlePart(match?.[1] || fallback);
}

export async function generateInterviewQuestions(candidateId, { customPrompt } = {}) {
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (!candidate.role_id) throw new Error('candidate has no assigned role');

  const role = getRole(candidate.role_id);
  if (!role) throw new Error('role not found');
  if (!role.description && !role.expected_portrait) {
    throw new Error('role requirements missing');
  }

  const company = getCompany(candidate.company_id);
  if (!company) throw new Error('company not found');

  const resumeAbsPath = candidate.resume_path ? path.resolve(RESUMES_DIR, candidate.resume_path) : null;
  const hasResume = !!(resumeAbsPath && fs.existsSync(resumeAbsPath));
  const hasFallbackContext = !!(candidate.brief || candidate.extra_info || latestByKind(candidate.evaluations, 'resume_ai'));
  if (!hasResume && !hasFallbackContext) {
    throw new Error('resume or candidate context required');
  }

  const context = buildContext({ candidate, role, company, customPrompt });
  const prompt = buildPrompt(context);
  const required = hasResume ? ['text', 'read_file'] : ['text'];
  const readOnlyBinds = hasResume ? [RESUMES_DIR] : undefined;
  const { text, runtime, model, effort } = await aiCall('interview_questions', prompt, { required, readOnlyBinds });

  const body = stripFrontmatter(stripMarkdownFence(String(text || '').trim()));
  const title = inferMarkdownTitle(body, `Reference Interview Questions - ${safeTitlePart(candidate.name || 'Candidate')}`);
  const markdown = ensureFrontmatter(body, { title, roleName: role.name });

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const token = crypto.randomBytes(5).toString('hex');
  const filename = `cand-${candidate.id}-${Date.now()}-${token}.md`;
  const relPath = relativeDocPath(filename);
  const absPath = path.join(DATA_DIR, relPath);
  fs.writeFileSync(absPath, markdown, 'utf8');

  let doc = createInterviewQuestionDocument({
    candidateId: candidate.id,
    roleId: role.id,
    companyId: company.id,
    title,
    filePath: relPath,
    generationStatus: 'ready',
    generatorRuntime: runtime,
    generatorModel: model,
    generatorEffort: effort,
  });

  const slug = `recruit/interview-questions/cand-${candidate.id}-doc-${doc.id}`;
  const pages = await registerWithPages({ sourcePath: absPath, slug });
  if (pages?.ok) {
    doc = updateInterviewQuestionDocument(doc.id, {
      pagesSlug: pages.slug || slug,
      pagesUrl: pages.url || `/pages/${slug}`,
      pagesRegisteredAt: new Date().toISOString(),
      errorMessage: null,
    });
  } else {
    doc = updateInterviewQuestionDocument(doc.id, {
      pagesSlug: slug,
      errorMessage: pages?.error || 'pages registration unavailable',
    });
  }

  return doc;
}

export async function retryPagesRegistration(docId) {
  const doc = getInterviewQuestionDocument(docId);
  if (!doc) throw new Error('document not found');
  const absPath = resolveDocumentPath(doc);
  if (!fs.existsSync(absPath)) throw new Error('document file missing');
  const slug = doc.pages_slug || `recruit/interview-questions/cand-${doc.candidate_id}-doc-${doc.id}`;
  const pages = await registerWithPages({ sourcePath: absPath, slug });
  if (!pages?.ok) {
    updateInterviewQuestionDocument(doc.id, { errorMessage: pages?.error || 'pages registration failed' });
    throw new Error(pages?.error || 'pages registration failed');
  }
  return updateInterviewQuestionDocument(doc.id, {
    pagesSlug: pages.slug || slug,
    pagesUrl: pages.url || `/pages/${slug}`,
    pagesRegisteredAt: new Date().toISOString(),
    errorMessage: null,
  });
}

export async function unregisterDocumentFromPages(doc) {
  if (!doc?.pages_slug) return { ok: true, skipped: true };
  return unregisterFromPages(doc.pages_slug);
}
