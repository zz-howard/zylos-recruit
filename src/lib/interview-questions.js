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
import { DATA_DIR, KNOWLEDGE_DIR, RESUMES_DIR } from './config.js';
import { call as aiCall } from './ai-gateway.js';
import { registerWithPages, unregisterFromPages } from './pages-integration.js';

const DOCS_DIR = path.join(DATA_DIR, 'interview-questions');
const generatingSet = new Set();
const generationErrors = new Map();

export function isGeneratingInterviewQuestions(candidateId) {
  return generatingSet.has(Number(candidateId));
}

export function getInterviewQuestionGenerationError(candidateId) {
  return generationErrors.get(Number(candidateId)) || null;
}

export function normalizeInterviewDuration(duration) {
  const minutes = Number(duration);
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;
  return minutes <= 30 ? 30 : 60;
}

function formatGenerationDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();
  const dayOfMonth = d.getDate();
  const iso = [
    year,
    String(month + 1).padStart(2, '0'),
    String(dayOfMonth).padStart(2, '0'),
  ].join('-');
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
  }).format(d);
  const quarter = Math.floor(month / 3) + 1;
  return `${iso} (${day}), Q${quarter} ${year}`;
}

export function generateInterviewQuestionsAsync(candidateId, { customPrompt, duration } = {}) {
  const id = Number(candidateId);
  if (generatingSet.has(id)) {
    throw new Error('参考面试题正在生成中，请稍候');
  }
  generatingSet.add(id);
  generationErrors.delete(id);
  generateInterviewQuestions(id, { customPrompt, duration }).catch((err) => {
    generationErrors.set(id, err.message || 'generation failed');
    console.error(`[recruit] interview question generation failed for candidate #${id}:`, err.message);
  }).finally(() => {
    generatingSet.delete(id);
  });
}

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

export function buildContext({ candidate, role, company, customPrompt, generatedAt = new Date() }) {
  const latestResumeEval = latestByKind(candidate.evaluations, 'resume_ai');
  const resumeMeta = parseEvalMeta(latestResumeEval);
  const interviewEvals = evaluationsByKind(candidate.evaluations, 'interview').slice(0, 3);

  const sections = [];
  sections.push(`# Interview Question Generation Context`);

  sections.push(`## Generation Context
Today: ${formatGenerationDate(generatedAt)}`);

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

  if (role?.interview_prompt?.trim()) {
    sections.push(`## Role Interview Instructions
${role.interview_prompt.trim()}`);
  }

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

export function buildPrompt(ctx, { duration = 60 } = {}) {
  const normalizedDuration = normalizeInterviewDuration(duration);
  const questionCap = normalizedDuration <= 30 ? 8 : 12;
  return `${ctx}

---

You are designing a reference interview-question document for Howard Zhou to use in a technical interview.

Write in Chinese unless the candidate or role context clearly requires English.

Before writing the interview guide, do a structured pre-analysis in the final Markdown:
- What is unusual in this resume/context?
- What important evidence is missing or weak?
- What is the strongest signal for this role?
- What is the weakest signal for this role?
- What is the biggest role-specific risk to verify?

Use that pre-analysis to choose the questions. Do not generate an evenly weighted questionnaire.

Use these non-negotiable style rules:
- Write like a real person talking, not like an AI-generated questionnaire.
- Ask one question at a time. Never stack multiple sub-questions inside one numbered question.
- Use concrete examples when they help the candidate understand the expected depth.
- Put a short interviewer-only note after each question using this exact form: "> 考察点：..."
- Use 1-2 natural follow-up directions per main question, not separate numbered questions.
- Do not write verbose "意图" or analysis blocks.
- Anchor questions in specific evidence from the candidate resume/context: company names, projects, time periods, systems, model techniques, incidents, or career transitions. Avoid generic textbook questions.
- For each core technical question, add one natural follow-up sentence after the 考察点 line. The follow-up should force concrete details, not invite a broad second answer.
- Evidence-anchored verification: when a question verifies a resume claim, the follow-up must force a falsifiable specific — how a number was computed (denominator, sample size), a before/after comparison, or named specifics (which system, which incident). Distinguish three evidence levels in the interviewer note: narrative only (会说), concrete mechanism (会做), numbers with their calculation basis (对结果负责).
- Never ask the candidate to produce documents, logs, schemas, or dashboards during the live interview — those are unanswerable in conversation and reward confident improvisation. Keep evidence-forcing within what the candidate personally did; do not ask them to recite enterprise gate checklists (coverage thresholds, SAST, etc.) they may never have owned.
- Make the document directly usable by Howard in the interview: write question text as something he can read aloud, and keep interviewer guidance separate.
- Related evaluation dimensions should be merged into a single main question with follow-up angles, not split into separate questions.

Default structure:
1. Resume gap analysis: what is unusual, missing, strongest, weakest, and riskiest for this role.
2. Pre-interview judgment: summarize the 2-3 core hypotheses to verify for this candidate and role.
3. Opening warm-up: you (the question designer) pick the single most revealing project or claim from the resume and anchor the opening question to it by name. Never ask the candidate to choose which project to present — "pick a project that best represents you" style openers are forbidden. State in the interviewer note why this project was chosen.
4. Role-critical technical deep dive: focus on the role's hardest real requirements, not generic fundamentals.
5. Transfer to this company/role: give one concrete company-relevant scenario and ask how the candidate would handle it.
6. Execution plan and leadership: for senior/lead roles, ask about first week, first month, and 3-month verifiable outcomes.
7. Risk checks: career gaps, short tenures, motivation, scope ownership, or other risks from the resume/evaluation.
8. Closing and reverse questions.

Role-specific depth rules:
- For LLM post-training, model training, or AI research leadership roles, include questions that probe: data construction, instruction/preference/reward signal design, SFT vs DPO/RL/GRPO tradeoffs, eval design, failure attribution, negative samples, reward hacking, online/offline metric mismatch, and deployment/cost/latency constraints.
- For Agent / Tool Use / Planning roles, include one realistic enterprise task scenario. Ask which part should be trained, what ground truth looks like, how wrong tool calls/parameters/permissions are represented, and what not to train.
- For product engineering roles, focus on user workflow, data model, permissions/multi-tenancy, end-to-end delivery, debugging, code review, and AI-assisted engineering habits.
- For DevOps/SRE roles, focus on incident handling, observability, deployment safety, cloud cost, security boundaries, and rollback.
- For QA roles, focus on risk-based test design, automation, regression suites, AI/Agent evaluation, and release gates.
- For security roles, focus on threat modeling, authz/authn boundaries, data leakage, cloud IAM, incident response, and embedding security into engineering workflow.

Pacing and prioritization:
- Interview duration: ${normalizedDuration} minutes.
- Generate at most ${questionCap} main questions for this interview. A main question can include 1-2 natural follow-up directions.
- For 30-minute interviews, stay within 8 main questions. For 60-minute interviews, stay within 12 main questions.
- Identify the few questions that matter most for this candidate.
- Include a "最关键的三道题" section and explain why those questions are most revealing.
- Include a pacing note explaining what to skip or shorten if an early answer is weak.
- If any single tenure exceeds 5 years, include a motivation/change question about why they are leaving now and what changed.
- Identify which past role or experience is closest to the target role. Include one question that bridges that experience to the current opportunity.

Custom instructions from the generation context override these defaults only when they are more specific and compatible with the role requirements.

Ground questions in the candidate evidence above. If the resume file is available to you, read it before finalizing the questions. Use prior resume evaluation as evidence, but do not blindly repeat it.

Return Markdown only. Include frontmatter with title, description, date, and tags. At the end, include:
- evaluation dimension coverage table
- pacing reminder
- 2-3 most revealing questions for this candidate
- interviewer note-taking template
- optional take-home task section (include only when artifact-level evidence matters for a key dimension that cannot be verified live): 1-2 tasks, each with a concrete deliverable, acceptance criteria, and a ~48h time box

Do not wrap the response in a Markdown code fence.`;
}

function ensureFrontmatter(markdown, { title, roleName }) {
  const trimmed = cleanGeneratedMarkdown(markdown);
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

function stripFirstMarkdownFenceBlock(markdown) {
  const match = markdown.match(/```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/i);
  if (!match) return markdown;

  const before = markdown.slice(0, match.index).trim();
  const looksLikePreamble =
    !before ||
    /^(我会|我将|下面|以下|Here|I'll|I will|Let me)\b/i.test(before) ||
    !/[#|>*[\]-]/.test(before);

  return match.index < 1200 && looksLikePreamble ? match[1].trim() : markdown;
}

function stripLeadingGeneratedPreamble(markdown) {
  const firstHeading = markdown.search(/^#{1,3}\s+\S/m);
  if (firstHeading <= 0) return markdown;

  const preamble = markdown.slice(0, firstHeading).trim();
  if (!preamble) return markdown.slice(firstHeading).trim();

  const looksLikeModelNarration =
    /^(我会|我将|下面|以下|Here|I'll|I will|Let me)\b/i.test(preamble) ||
    !/[#|>*`[\]-]/.test(preamble);

  return looksLikeModelNarration ? markdown.slice(firstHeading).trim() : markdown;
}

function stripFirstTopMatterBlock(markdown) {
  const firstHeading = markdown.search(/^#{1,3}\s+\S/m);
  const match = markdown.match(/---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return markdown;

  const matchStart = match.index;
  const before = markdown.slice(0, matchStart).trim();
  const isBeforeDocument = firstHeading === -1 || matchStart <= firstHeading || matchStart < 1200;
  if (!isBeforeDocument) return markdown;

  const looksLikePreamble =
    !before ||
    /^(我会|我将|下面|以下|Here|I'll|I will|Let me)\b/i.test(before) ||
    !/[#|>*`[\]-]/.test(before);

  return looksLikePreamble ? markdown.slice(match.index + match[0].length).trim() : markdown;
}

export function cleanGeneratedMarkdown(markdown) {
  let cleaned = String(markdown || '').trim();
  for (let i = 0; i < 5; i += 1) {
    const next = stripLeadingGeneratedPreamble(
      stripFirstTopMatterBlock(
        stripFrontmatter(
          stripFirstMarkdownFenceBlock(
            stripMarkdownFence(cleaned),
          ),
        ),
      ),
    ).trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function inferMarkdownTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return safeTitlePart(match?.[1] || fallback);
}

export async function generateInterviewQuestions(candidateId, { customPrompt, duration } = {}) {
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
  const prompt = buildPrompt(context, { duration });
  const required = hasResume ? ['text', 'read_file'] : ['text'];
  const readOnlyBinds = [
    ...(fs.existsSync(KNOWLEDGE_DIR) ? [KNOWLEDGE_DIR] : []),
    ...(hasResume ? [resumeAbsPath] : []),
  ];
  const startTime = Date.now();
  const { text, runtime, model, effort } = await aiCall('interview_questions', prompt, { required, readOnlyBinds });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[recruit] Interview questions generated for candidate #${candidate.id} "${candidate.name || ''}" (${elapsed}s, ${runtime}/${model})`);

  const body = cleanGeneratedMarkdown(text);
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
