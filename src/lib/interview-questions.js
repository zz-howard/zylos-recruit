import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-html';
import {
  createInterviewQuestionDocument,
  updateInterviewQuestionDocument,
  getInterviewQuestionDocument,
  getCandidate,
  getCompany,
  getRole,
} from './db.js';
import { DATA_DIR, KNOWLEDGE_DIR, RESUMES_DIR } from './config.js';
import { call as aiCall, resolve as resolveRuntime } from './ai-gateway.js';
import { registerWithPages, unregisterFromPages } from './pages-integration.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, 'interview-questions-template.html');
const SANDBOX_TMP = path.join(os.tmpdir(), 'zylos-recruit-sandbox');
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

export function prepareSandboxTemplate(candidateId) {
  fs.mkdirSync(SANDBOX_TMP, { recursive: true });
  const filename = `iq-${candidateId}-${Date.now()}.html`;
  const dest = path.join(SANDBOX_TMP, filename);
  fs.copyFileSync(TEMPLATE_PATH, dest);
  return dest;
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

export function buildPrompt(ctx, { duration = 60, templatePath } = {}) {
  const normalizedDuration = normalizeInterviewDuration(duration);
  const questionCap = normalizedDuration <= 30 ? 6 : 10;
  const questionTarget = normalizedDuration <= 30 ? '4-5' : '6-8';
  const mustAskCount = normalizedDuration <= 30 ? '2-3' : '3-4';
  return `${ctx}

---

You are designing a reference interview-question document for Howard Zhou to use in a technical interview.

Write in Chinese unless the candidate or role context clearly requires English.

Before writing the interview guide, do a structured pre-analysis (include it in the hypotheses section):
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
- Put a short interviewer-only note after each question (in the interviewer-note div).
- Use 1-2 natural follow-up directions per main question (in the followup div), not separate numbered questions.
- Do not write verbose "意图" or analysis blocks.
- Anchor questions in specific evidence from the candidate resume/context: company names, projects, time periods, systems, model techniques, incidents, or career transitions. Avoid generic textbook questions.
- Recency rule (hard constraint): all questions must anchor to the candidate's most recent 2-3 years of experience. Do NOT ask about projects or roles from earlier periods. If the candidate has 10+ years of experience, older experience may appear in interviewer background notes but must NEVER be the subject of a question. If a skill or pattern needs verification, find evidence from a recent role — do not reach back to an old company just because the resume describes it in more detail.
- For each core technical question, add one natural follow-up sentence. The follow-up should force concrete details, not invite a broad second answer.
- Evidence-anchored verification: when a question verifies a resume claim, the follow-up must force a falsifiable specific — how a number was computed (denominator, sample size), a before/after comparison, or named specifics (which system, which incident). Distinguish three evidence levels in the interviewer note: narrative only (会说), concrete mechanism (会做), numbers with their calculation basis (对结果负责).
- Never ask the candidate to produce documents, logs, schemas, or dashboards during the live interview — those are unanswerable in conversation and reward confident improvisation. Keep evidence-forcing within what the candidate personally did; do not ask them to recite enterprise gate checklists (coverage thresholds, SAST, etc.) they may never have owned.
- Make the document directly usable by Howard in the interview: write question text as something he can read aloud, and keep interviewer guidance separate.
- Related evaluation dimensions should be merged into a single main question with follow-up angles, not split into separate questions.
- No-overlap rule: before finalizing, scan every question for shared underlying signal. If two main questions verify the same core competency (e.g. two separate questions both probing "quality / validation / eval"), merge them or cut the weaker one. No two main questions may test the same thing.
- No leading questions: never write a question that telegraphs the answer you want or invites the candidate to agree with a framing (e.g. "we don't want someone who rebuilds everything from scratch — how would you fit in?"). Attitude, culture-fit, and alignment topics must be probed through concrete past behavior ("describe a time you had to work inside an existing framework you disagreed with — what specifically did you do?"), never through forward-looking promises. In the interviewer note for such a question, state explicitly that a stated attitude or promise is weak signal, and the falsifiable past example is the real signal.

Default structure for question sections:
1. Opening warm-up: you (the question designer) pick the single most revealing project or claim from the resume and anchor the opening question to it by name. Never ask the candidate to choose which project to present — "pick a project that best represents you" style openers are forbidden. State in the interviewer note why this project was chosen.
2. Role-critical technical deep dive: focus on the role's hardest real requirements, not generic fundamentals.
3. Transfer to this company/role: give one concrete company-relevant scenario and ask how the candidate would handle it. If the company profile or role instructions state current engineering focus areas, active projects, or tech stack, anchor at least one question to a real, current problem the hiring team is actually working on — matched to a relevant strength in the candidate's background — instead of a generic hypothetical.
4. Execution plan and leadership: for senior/lead roles, ask about first week, first month, and 3-month verifiable outcomes.
5. Risk checks: career gaps, short tenures, motivation, scope ownership, or other risks from the resume/evaluation.
6. Closing and reverse questions.

Role-specific depth rules:
- For LLM post-training, model training, or AI research leadership roles, include questions that probe: data construction, instruction/preference/reward signal design, SFT vs DPO/RL/GRPO tradeoffs, eval design, failure attribution, negative samples, reward hacking, online/offline metric mismatch, and deployment/cost/latency constraints.
- For Agent / Tool Use / Planning roles, include one realistic enterprise task scenario. Ask which part should be trained, what ground truth looks like, how wrong tool calls/parameters/permissions are represented, and what not to train.
- For product engineering roles, focus on user workflow, data model, permissions/multi-tenancy, end-to-end delivery, debugging, code review, and AI-assisted engineering habits.
- For DevOps/SRE roles, focus on incident handling, observability, deployment safety, cloud cost, security boundaries, and rollback.
- For QA roles, focus on risk-based test design, automation, regression suites, AI/Agent evaluation, and release gates.
- For security roles, focus on threat modeling, authz/authn boundaries, data leakage, cloud IAM, incident response, and embedding security into engineering workflow.

Pacing and prioritization:
- Interview duration: ${normalizedDuration} minutes.
- Target ${questionTarget} main questions; never exceed ${questionCap}. A real ${normalizedDuration}-minute interview with proper follow-ups can only cover a handful of questions in depth — design for that reality, do not produce an exhaustive checklist.
- A main question can include 1-2 natural follow-up directions.
- Mark a mandatory must-ask set ("必问集") of ${mustAskCount} questions with the must-ask badge. These are the questions that, on their own, would let Howard make a decision. Every other question is 机动 (optional), to be asked only if time remains.
- The pacing note is required and must explicitly: (a) list the 必问集; (b) say which questions to cut or shorten first when time runs short; (c) name a "floor" fallback question to fall back on if an early core answer is weak.
- Anti-anchoring: the document must include a visible reminder (in the pacing note or the judgment framework) that the AI resume match score is a prior, not a verdict — Howard should judge on live interview evidence and be ready to override the AI score in either direction.
- If any single tenure exceeds 5 years, include a motivation/change question about why they are leaving now and what changed.
- Identify which past role or experience is closest to the target role. Include one question that bridges that experience to the current opportunity.

Custom instructions from the generation context override these defaults only when they are more specific and compatible with the role requirements.

Ground questions in the candidate evidence above. If the resume file is available to you, read it before finalizing the questions. Use prior resume evaluation as evidence, but do not blindly repeat it.

## Output Format

${templatePath ? `You have an HTML template file at: ${templatePath}

Your task:
1. Read the template file to see its CSS and structure
2. Edit the template file: replace the line \`<!-- CONTENT_PLACEHOLDER -->\` with the full interview content HTML
3. Also edit the \`<title>\` tag to match the candidate name and role

Use a SINGLE Edit call to replace \`<!-- CONTENT_PLACEHOLDER -->\` with ALL the interview content at once. Do NOT make multiple Edit calls.

The template already has all the CSS. You only need to provide the HTML content that goes inside \`<div class="page">...</div>\`.` : `Return a COMPLETE, self-contained HTML page. No markdown, no JSON, no preamble — output ONLY the HTML starting with <!DOCTYPE html> and ending with </html>.

Use the CSS and layout structure from the reference template below. The key layout requirement is **side-by-side question/answer**: each .question-block is a CSS grid with .q-left (question text, interviewer notes, follow-up) and .q-right (reference answers). The page uses --content-width: 1260px to accommodate this two-column layout.

Copy the CSS verbatim from the template.`}

### Available HTML components

- Page header: \`<header class="page-header"><h1>Name 面试参考题</h1><div class="subtitle">Role &mdash; 60 分钟</div></header>\`
- Meta card (2-col grid): \`<div class="meta-card"><div><div class="meta-label">Label</div><div class="meta-value">Value</div></div>...</div>\`
- Hypothesis box (yellow): \`<div class="hypothesis-box"><h3>核心验证假设</h3><ol><li>...</li></ol></div>\`
- Red flags (red): \`<div class="red-flags"><h3>风险信号</h3><ul><li>...</li></ul></div>\`
- Prior round summary (blue, for 二面): \`<div class="round1-summary"><h3>一面结论</h3>...</div>\`
- Pacing note: \`<div class="pacing-note"><strong>节奏提示：</strong>...</div>\`
- Question block (side-by-side): \`<div class="question-block"><h3><span class="q-num">N</span> Title</h3><div class="q-left"><div class="question-text">Q</div><div class="interviewer-note"><strong>考察点：</strong>...</div><div class="followup"><strong>追问：</strong>...</div></div><div class="q-right"><h4>参考答案</h4><p class="ref-good">&#10003; Good</p><ul><li>...</li></ul><p class="ref-bad">&#10007; Bad</p><ul><li>...</li></ul></div></div>\`
- Section: \`<section><h2>一、Title <span class="badge">核心必考</span></h2>...question-blocks...</section>\`
- Judgment table: \`<div class="judgment-table"><h3>面试判断框架</h3><table><thead><tr><th>结果</th><th>条件</th></tr></thead><tbody><tr><td class="verdict-pass">强推进</td><td>...</td></tr><tr><td class="verdict-lean">推进</td><td>...</td></tr><tr><td class="verdict-hold">搁置</td><td>...</td></tr><tr><td class="verdict-fail">不推进</td><td>...</td></tr></tbody></table></div>\`
- Footer: \`<footer class="page-footer">Generated by Luna &mdash; Date</footer>\`
- Badges: \`.badge\` (must-ask, red), \`.badge-optional\` (bonus, blue)

### Key layout rules
- Each .question-block uses a two-column grid: .q-left (question, notes, follow-up) and .q-right (reference answers)
- The h3 title spans both columns via grid-column: 1 / -1
- In .q-right, use ref-good/ref-bad classes for answer quality markers
- For 二面, add a .round1-summary box before the hypothesis box
- You may add any additional sections (evaluation dimension table, key questions summary, record template, dynamic adjustment strategies, etc.) as needed`;
}

const SANITIZE_OPTIONS = {
  allowedTags: sanitize.defaults.allowedTags.concat([
    'html', 'head', 'body', 'meta', 'title', 'style', 'link',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'img', 'figure', 'figcaption', 'details', 'summary',
    'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
    'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'caption',
    'sup', 'sub', 'mark', 'small', 'abbr', 'cite', 'time',
  ]),
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'lang', 'dir', 'title', 'role', 'aria-*', 'data-*'],
    meta: ['charset', 'name', 'content'],
    link: ['rel', 'href', 'type', 'media'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    a: ['href', 'target', 'rel'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    ol: ['start', 'type', 'reversed'],
    time: ['datetime'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowVulnerableTags: true,
  disallowedTagsMode: 'discard',
};

export function sanitizeGeneratedHtml(html) {
  return sanitize(html, SANITIZE_OPTIONS);
}

export function cleanGeneratedHtml(text) {
  let cleaned = String(text || '').trim();

  // Strip markdown code fences wrapping the HTML (```html ... ``` or ``` ... ```)
  const fenceMatch = cleaned.match(/^```(?:html)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Strip any preamble text before <!DOCTYPE or <html
  const doctypeIdx = cleaned.indexOf('<!DOCTYPE');
  const htmlIdx = cleaned.indexOf('<html');
  const startIdx = doctypeIdx >= 0 ? doctypeIdx : htmlIdx;
  if (startIdx > 0) {
    cleaned = cleaned.slice(startIdx);
  }

  // Strip any trailing text after </html>
  const endIdx = cleaned.lastIndexOf('</html>');
  if (endIdx >= 0) {
    cleaned = cleaned.slice(0, endIdx + '</html>'.length);
  }

  if (!cleaned.includes('<html') || !cleaned.includes('</html>')) {
    throw new Error('Generated output is not valid HTML — missing <html> tags');
  }

  cleaned = sanitizeGeneratedHtml(cleaned);

  return cleaned;
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
  const readOnlyBinds = [
    ...(fs.existsSync(KNOWLEDGE_DIR) ? [KNOWLEDGE_DIR] : []),
    ...(hasResume ? [resumeAbsPath] : []),
  ];

  const { adapter } = resolveRuntime('interview_questions');
  const useTemplateEdit = adapter.capabilities.includes('edit_file');

  let templatePath;
  if (useTemplateEdit) {
    templatePath = prepareSandboxTemplate(candidate.id);
  }

  const prompt = buildPrompt(context, { duration, templatePath });
  const required = hasResume
    ? ['text', 'read_file', ...(useTemplateEdit ? ['edit_file'] : [])]
    : ['text', ...(useTemplateEdit ? ['edit_file'] : [])];

  const startTime = Date.now();
  const result = await aiCall('interview_questions', prompt, { required, readOnlyBinds });
  const { runtime, model, effort, sandboxed } = result;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[recruit] Interview questions generated for candidate #${candidate.id} "${candidate.name || ''}" (${elapsed}s, ${runtime}/${model}, sandboxed=${sandboxed ?? 'unknown'})`);
  if (sandboxed === false) {
    console.warn(`[recruit] WARNING: interview questions for candidate #${candidate.id} generated WITHOUT sandbox isolation`);
  }

  let html;
  if (useTemplateEdit) {
    const editedHtml = fs.readFileSync(templatePath, 'utf8');
    try { fs.unlinkSync(templatePath); } catch { /* best-effort cleanup */ }
    if (editedHtml.includes('<!-- CONTENT_PLACEHOLDER -->')) {
      console.warn(`[recruit] Template edit failed for candidate #${candidate.id}, retrying with direct HTML output`);
      const directPrompt = buildPrompt(context, { duration });
      const directRequired = hasResume ? ['text', 'read_file'] : ['text'];
      const fallback = await aiCall('interview_questions', directPrompt, { required: directRequired, readOnlyBinds });
      html = cleanGeneratedHtml(fallback.text);
    } else {
      html = sanitizeGeneratedHtml(editedHtml);
    }
  } else {
    html = cleanGeneratedHtml(result.text);
  }
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = safeTitlePart(titleMatch?.[1] || `${candidate.name || 'Candidate'} 面试参考题`);

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const token = crypto.randomBytes(5).toString('hex');
  const filename = `cand-${candidate.id}-${Date.now()}-${token}.html`;
  const relPath = relativeDocPath(filename);
  const absPath = path.join(DATA_DIR, relPath);
  fs.writeFileSync(absPath, html, 'utf8');

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
    sandboxed: sandboxed ?? true,
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
