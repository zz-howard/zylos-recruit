import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
- For each core technical question, add one natural follow-up sentence. The follow-up should force concrete details, not invite a broad second answer.
- Evidence-anchored verification: when a question verifies a resume claim, the follow-up must force a falsifiable specific — how a number was computed (denominator, sample size), a before/after comparison, or named specifics (which system, which incident). Distinguish three evidence levels in the interviewer note: narrative only (会说), concrete mechanism (会做), numbers with their calculation basis (对结果负责).
- Never ask the candidate to produce documents, logs, schemas, or dashboards during the live interview — those are unanswerable in conversation and reward confident improvisation. Keep evidence-forcing within what the candidate personally did; do not ask them to recite enterprise gate checklists (coverage thresholds, SAST, etc.) they may never have owned.
- Make the document directly usable by Howard in the interview: write question text as something he can read aloud, and keep interviewer guidance separate.
- Related evaluation dimensions should be merged into a single main question with follow-up angles, not split into separate questions.

Default structure for question sections:
1. Opening warm-up: you (the question designer) pick the single most revealing project or claim from the resume and anchor the opening question to it by name. Never ask the candidate to choose which project to present — "pick a project that best represents you" style openers are forbidden. State in the interviewer note why this project was chosen.
2. Role-critical technical deep dive: focus on the role's hardest real requirements, not generic fundamentals.
3. Transfer to this company/role: give one concrete company-relevant scenario and ask how the candidate would handle it.
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
- Generate at most ${questionCap} main questions for this interview. A main question can include 1-2 natural follow-up directions.
- For 30-minute interviews, stay within 8 main questions. For 60-minute interviews, stay within 12 main questions.
- Identify the few questions that matter most for this candidate.
- Include a pacing note explaining what to skip or shorten if an early answer is weak, and which are the 2-3 most revealing questions for this candidate.
- If any single tenure exceeds 5 years, include a motivation/change question about why they are leaving now and what changed.
- Identify which past role or experience is closest to the target role. Include one question that bridges that experience to the current opportunity.

Custom instructions from the generation context override these defaults only when they are more specific and compatible with the role requirements.

Ground questions in the candidate evidence above. If the resume file is available to you, read it before finalizing the questions. Use prior resume evaluation as evidence, but do not blindly repeat it.

## Output Format

Return a COMPLETE, self-contained HTML page. No markdown, no JSON, no preamble — output ONLY the HTML starting with <!DOCTYPE html> and ending with </html>.

Use the CSS and layout structure from the reference template below. The key layout requirement is **side-by-side question/answer**: each .question-block is a CSS grid with .q-left (question text, interviewer notes, follow-up) and .q-right (reference answers). The page uses --content-width: 1260px to accommodate this two-column layout.

Copy the CSS verbatim from the template. Fill in the content sections with the interview questions you designed. You have full freedom on what content sections to include (hypothesis box, red flags box, prior round summary, pacing notes, evaluation tables, judgment framework, record template, etc.) — the template is a structural reference, not a rigid constraint.

### Reference HTML Template

\`\`\`html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>候选人姓名 面试参考题 — 岗位名称</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --font-size-base: 1rem; --font-size-sm: 0.875rem; --font-size-xs: 0.75rem;
      --font-size-lg: 1.125rem; --font-size-xl: 1.25rem; --font-size-2xl: 1.5rem; --font-size-3xl: 1.875rem;
      --line-height: 1.75; --line-height-tight: 1.3;
      --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
      --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem; --space-12: 3rem;
      --radius: 0.375rem; --radius-lg: 0.5rem;
      --bg: #ffffff; --bg-alt: #f8f9fb; --bg-card: #ffffff;
      --text: #1f2937; --text-secondary: #4b5563; --text-muted: #9ca3af;
      --border: #e5e7eb; --border-strong: #d1d5db;
      --accent: #2563eb; --accent-light: #dbeafe; --accent-text: #1d4ed8;
      --success: #059669; --success-light: #d1fae5;
      --warning: #d97706; --warning-light: #fef3c7;
      --error: #dc2626; --error-light: #fee2e2;
      --info: #0891b2; --info-light: #cffafe;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --content-width: 1260px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a; --bg-alt: #1e293b; --bg-card: #1e293b;
        --text: #e2e8f0; --text-secondary: #94a3b8; --text-muted: #64748b;
        --border: #334155; --border-strong: #475569;
        --accent: #60a5fa; --accent-light: #1e3a5f; --accent-text: #93bbfc;
        --success: #34d399; --success-light: #064e3b;
        --warning: #fbbf24; --warning-light: #451a03;
        --error: #f87171; --error-light: #450a0a;
        --info: #22d3ee; --info-light: #083344;
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
      }
    }
    html { font-size: 16px; }
    body { font-family: var(--font-sans); font-size: var(--font-size-base); line-height: var(--line-height); color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
    h1, h2, h3, h4 { line-height: var(--line-height-tight); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    code { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-alt); padding: 0.15em 0.35em; border-radius: 3px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; margin-bottom: var(--space-6); font-size: var(--font-size-sm); }
    th, td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--text-secondary); font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.05em; }
    ul, ol { padding-left: var(--space-6); margin-bottom: var(--space-4); }
    li { margin-bottom: var(--space-2); }
    p { margin-bottom: var(--space-4); }
    hr { border: none; border-top: 1px solid var(--border); margin: var(--space-8) 0; }
    .page { max-width: var(--content-width); margin: 0 auto; padding: var(--space-8) var(--space-6); }
    .page-header { margin-bottom: var(--space-8); }
    .page-header h1 { font-size: var(--font-size-3xl); margin-bottom: var(--space-3); }
    .page-header .subtitle { font-size: var(--font-size-lg); color: var(--text-secondary); }
    .meta-card { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-6); margin-bottom: var(--space-6); box-shadow: var(--shadow-sm); font-size: var(--font-size-sm); }
    .meta-card .meta-label { color: var(--text-muted); font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.05em; }
    .meta-card .meta-value { color: var(--text); font-weight: 500; margin-bottom: var(--space-3); }
    .hypothesis-box { background: var(--warning-light); border: 1px solid var(--warning); border-radius: var(--radius-lg); padding: var(--space-6); margin-bottom: var(--space-8); }
    .hypothesis-box h3 { color: var(--warning); margin-top: 0; margin-bottom: var(--space-3); font-size: var(--font-size-lg); }
    .hypothesis-box ol { margin-bottom: 0; }
    .red-flags { background: var(--error-light); border: 1px solid var(--error); border-radius: var(--radius-lg); padding: var(--space-6); margin-bottom: var(--space-8); }
    .red-flags h3 { color: var(--error); margin-top: 0; margin-bottom: var(--space-3); font-size: var(--font-size-lg); }
    .red-flags ul { margin-bottom: 0; }
    .round1-summary { background: var(--info-light); border: 1px solid var(--info); border-radius: var(--radius-lg); padding: var(--space-6); margin-bottom: var(--space-6); }
    .round1-summary h3 { color: var(--info); margin-top: 0; margin-bottom: var(--space-3); font-size: var(--font-size-lg); }
    .round1-summary .tag-strength { color: var(--success); font-weight: 600; }
    .round1-summary .tag-weakness { color: var(--error); font-weight: 600; }
    .round1-summary .tag-tbd { color: var(--warning); font-weight: 600; }
    .pacing-note { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4) var(--space-6); margin-bottom: var(--space-8); font-size: var(--font-size-sm); color: var(--text-secondary); }
    .pacing-note strong { color: var(--text); }
    .badge { display: inline-block; font-size: var(--font-size-xs); font-weight: 600; padding: 0.15em 0.6em; border-radius: 9999px; background: var(--error-light); color: var(--error); vertical-align: middle; margin-left: var(--space-2); }
    .badge-optional { background: var(--info-light); color: var(--info); }
    section { margin-bottom: var(--space-8); }
    section > h2 { font-size: var(--font-size-xl); margin-bottom: var(--space-6); padding-bottom: var(--space-2); border-bottom: 2px solid var(--accent); color: var(--accent-text); }
    /* Side-by-side question layout */
    .question-block { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: var(--space-6); box-shadow: var(--shadow-sm); border-left: 4px solid var(--accent); display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .question-block h3 { font-size: var(--font-size-lg); margin-top: 0; margin-bottom: var(--space-4); display: flex; align-items: center; gap: var(--space-2); grid-column: 1 / -1; padding: var(--space-6) var(--space-6) 0 var(--space-6); }
    .question-block .q-num { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: white; font-size: var(--font-size-sm); font-weight: 700; flex-shrink: 0; }
    .q-left { padding: 0 var(--space-6) var(--space-6) var(--space-6); }
    .q-right { padding: 0 var(--space-6) var(--space-6) var(--space-6); border-left: 1px solid var(--border); }
    .q-right h4 { font-size: var(--font-size-sm); color: var(--success); margin-bottom: var(--space-3); text-transform: uppercase; letter-spacing: 0.05em; }
    .q-right ul, .q-right ol { padding-left: var(--space-4); margin-bottom: var(--space-3); }
    .q-right li { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: var(--space-2); }
    .q-right .ref-good { color: var(--success); font-weight: 600; font-size: var(--font-size-xs); }
    .q-right .ref-bad { color: var(--error); font-weight: 600; font-size: var(--font-size-xs); }
    .q-right .ref-note { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: var(--space-2); }
    .question-text { font-size: var(--font-size-base); line-height: var(--line-height); margin-bottom: var(--space-4); }
    .interviewer-note { background: var(--bg-alt); border-left: 3px solid var(--accent); padding: var(--space-3) var(--space-4); border-radius: 0 var(--radius) var(--radius) 0; font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: var(--space-3); }
    .interviewer-note strong { color: var(--accent-text); }
    .followup { font-size: var(--font-size-sm); color: var(--text-secondary); padding-left: var(--space-4); border-left: 2px dashed var(--border); }
    .followup strong { color: var(--text); }
    @media (max-width: 900px) { .question-block { grid-template-columns: 1fr; } .q-right { border-left: none; border-top: 1px solid var(--border); padding-top: var(--space-4); } }
    .judgment-table { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-6); box-shadow: var(--shadow-sm); margin-bottom: var(--space-6); }
    .judgment-table h3 { margin-top: 0; margin-bottom: var(--space-4); }
    .judgment-table table { margin-bottom: 0; }
    .verdict-pass { color: var(--success); font-weight: 600; }
    .verdict-lean { color: var(--accent-text); font-weight: 600; }
    .verdict-hold { color: var(--warning); font-weight: 600; }
    .verdict-fail { color: var(--error); font-weight: 600; }
    .page-footer { margin-top: var(--space-12); padding-top: var(--space-6); border-top: 1px solid var(--border); font-size: var(--font-size-sm); color: var(--text-muted); text-align: center; }
    @media print { body { background: white; color: black; } .page { max-width: none; padding: 0; } .question-block { break-inside: avoid; } }
    @media (max-width: 640px) { .page { padding: var(--space-4); } .meta-card { grid-template-columns: 1fr; } h1 { font-size: var(--font-size-2xl); } }
  </style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <h1>候选人姓名 面试参考题</h1>
      <div class="subtitle">岗位名称 &mdash; 60 分钟</div>
    </header>
    <div class="meta-card"><!-- 2x2 grid: 候选人, 当前职位, 教育背景/一面结论, 面试日期 --></div>
    <!-- Optional: .round1-summary for 二面, .red-flags for resume red flags, .hypothesis-box for verification goals -->
    <div class="pacing-note"><strong>节奏提示：</strong>...</div>
    <section>
      <h2>一、标题 <span class="badge">核心必考</span></h2>
      <div class="question-block">
        <h3><span class="q-num">1</span> 问题短标题</h3>
        <div class="q-left">
          <div class="question-text">问题正文</div>
          <div class="interviewer-note"><strong>考察点：</strong>考察点内容</div>
          <div class="followup"><strong>追问：</strong>追问内容</div>
        </div>
        <div class="q-right">
          <h4>参考答案</h4>
          <p class="ref-good">&#10003; 好的回答（加分）</p>
          <ul><li>好的回答要点</li></ul>
          <p class="ref-bad">&#10007; 差的回答（减分）</p>
          <ul><li>差的回答信号</li></ul>
          <p class="ref-note">补充说明</p>
        </div>
      </div>
    </section>
    <hr>
    <div class="judgment-table">
      <h3>面试判断框架</h3>
      <table>
        <thead><tr><th>结果</th><th>条件</th></tr></thead>
        <tbody>
          <tr><td class="verdict-pass">强推进/发Offer</td><td>条件</td></tr>
          <tr><td class="verdict-lean">推进（加试）</td><td>条件</td></tr>
          <tr><td class="verdict-hold">备选/搁置</td><td>条件</td></tr>
          <tr><td class="verdict-fail">不推进</td><td>条件</td></tr>
        </tbody>
      </table>
    </div>
    <footer class="page-footer">Generated by Luna &mdash; 日期</footer>
  </div>
</body>
</html>
\`\`\`

### Key layout rules
- Copy the CSS verbatim — do not modify colors, spacing, or typography
- Each .question-block uses a two-column grid: .q-left (question, notes, follow-up) and .q-right (reference answers)
- The h3 title spans both columns via grid-column: 1 / -1
- In .q-right, use ref-good/ref-bad classes for answer quality markers
- Use .badge on section headers for must-ask sections, .badge-optional for bonus sections
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
    meta: ['charset', 'name', 'content', 'http-equiv'],
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
  const prompt = buildPrompt(context, { duration });
  const required = hasResume ? ['text', 'read_file'] : ['text'];
  const readOnlyBinds = [
    ...(fs.existsSync(KNOWLEDGE_DIR) ? [KNOWLEDGE_DIR] : []),
    ...(hasResume ? [resumeAbsPath] : []),
  ];
  const startTime = Date.now();
  const { text, runtime, model, effort, sandboxed } = await aiCall('interview_questions', prompt, { required, readOnlyBinds });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[recruit] Interview questions generated for candidate #${candidate.id} "${candidate.name || ''}" (${elapsed}s, ${runtime}/${model}, sandboxed=${sandboxed ?? 'unknown'})`);
  if (sandboxed === false) {
    console.warn(`[recruit] WARNING: interview questions for candidate #${candidate.id} generated WITHOUT sandbox isolation`);
  }

  const html = cleanGeneratedHtml(text);
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
