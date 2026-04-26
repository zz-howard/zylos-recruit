# Pages Interview Questions Technical Plan

This document contains the implementation plan for
[Pages Integration for Reference Interview Questions](pages-interview-questions-integration.md).

## Data Directory Layout

Add a Recruit-owned document directory under the component data directory:

```text
~/zylos/components/recruit/
  interview-questions/
    cand-<candidateId>-role-<roleId>-<docId>.md
```

This directory contains the canonical Markdown source files. Pages only receives
a symlink registration request pointing back to these files.

## Database Schema

Add a new table for generated reference interview-question documents:

```sql
CREATE TABLE IF NOT EXISTS interview_question_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id      INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  role_id           INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  pages_slug        TEXT,
  pages_url         TEXT,
  pages_registered_at TEXT,
  generation_status TEXT NOT NULL DEFAULT 'ready'
                    CHECK (generation_status IN ('ready','failed')),
  generator_runtime TEXT,
  generator_model   TEXT,
  generator_effort  TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_iq_docs_candidate
  ON interview_question_documents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_iq_docs_role
  ON interview_question_documents(role_id);
```

`file_path` should be relative to the Recruit data directory, not an arbitrary
absolute path. Runtime code resolves it under `DATA_DIR` and verifies it does
not escape.

`pages_url` is optional. A document without `pages_url` is still valid and can
be viewed through Recruit's raw Markdown fallback.

## API Surface

Add a dedicated router such as `src/routes/api-interview-questions.js`, mounted
under both normal API prefixes:

```text
GET    /api/candidates/:id/interview-questions
POST   /api/candidates/:id/interview-questions
GET    /api/interview-questions/:docId
GET    /api/interview-questions/:docId/raw
POST   /api/interview-questions/:docId/register-pages
DELETE /api/interview-questions/:docId
```

Expected behavior:

- `POST /api/candidates/:id/interview-questions`
  - validates candidate exists and has a role
  - generates Markdown using the configured AI runtime for a new
    `interview_questions` scenario
  - writes the Markdown file under `interview-questions/`
  - creates a DB row
  - attempts Pages registration if available
  - returns document metadata, including `pages_url` when present
  - may accept optional generation preferences if approved in the pending
    decisions below
- `GET /api/candidates/:id/interview-questions`
  - lists non-deleted documents for that candidate, newest first
- `GET /api/interview-questions/:docId/raw`
  - returns `text/markdown; charset=utf-8`
  - remains behind Recruit auth/API token
- `POST /api/interview-questions/:docId/register-pages`
  - retries Pages registration for an existing document
  - useful when Pages was installed after the document was generated
- `DELETE /api/interview-questions/:docId`
  - soft-deletes the Recruit document record
  - asks Pages to unregister if `pages_slug` is present and registration is
    available
  - does not delete unrelated Pages documents

## AI Generation

Add an AI scenario key:

```json
{
  "ai": {
    "interview_questions": {}
  }
}
```

The settings API currently enumerates known AI scenarios in
`src/routes/api-settings.js`; implementation must add `interview_questions` to
that list so the runtime/model/effort can be configured independently.

### Prompt Configuration Model

Reference interview-question generation should use layered prompts rather than
a single free-form prompt.

The built-in system prompt should contain stable quality rules that apply to
all generated interview-question documents:

- write questions like a human interviewer, not an AI-generated questionnaire
- ask one question at a time and avoid stacked multi-part questions
- include concrete examples when they help anchor expected answer depth
- keep interviewer-only notes short, using `> 考察点：...`
- use natural follow-up guidance instead of long scripted follow-up lists
- avoid verbose "intent" or "analysis" blocks in the candidate-facing question
  flow
- default to a 60-minute structure: opening, technical foundation,
  architecture and engineering, AI-native habits, and closing
- include a short summary section with evaluation dimensions, pacing guidance,
  and the most revealing questions for this candidate

The role-level prompt should contain role-specific evaluation criteria and can
override the default evaluation emphasis. Examples:

- DevOps / SRE roles should emphasize business-driven infrastructure
  architecture, not only cloud administration.
- LLM algorithm roles should emphasize whether the candidate can move LLM work
  from demo to production, including evaluation, deployment, cost, and
  monitoring.
- Engineering IC roles may emphasize code taste, module boundaries,
  production incidents, and AI-native delivery habits.

The per-generation custom prompt should represent Howard's current interview
intent. It should support:

- focus areas to emphasize
- areas to avoid
- candidate-specific concerns or red flags
- interview round or seniority expectations
- time allocation changes
- must-ask topics or must-not-ask topics

The default behavior should be additive: custom prompt content is appended as
"interviewer preferences" and receives higher priority for focus, exclusions,
weights, and time allocation. It should not replace the built-in quality rules.

This avoids a common failure mode where a custom prompt accidentally removes
the style constraints that make the generated questions useful. A future
advanced mode could allow replacing the role prompt, but the first version
should not allow replacing the built-in system prompt.

Recommended precedence:

1. Built-in system prompt: non-overridable quality and output rules.
2. Role `eval_prompt`: role-specific criteria and weighting.
3. Per-generation custom prompt: highest-priority interview intent, appended
   as preferences and constraints for this generation.

Generation input should include:

- company profile / company eval prompt
- role description
- role expected portrait
- role eval prompt
- candidate basic fields
- candidate extra info
- latest resume AI evaluation summary when available
- resume file path when available and safe for the selected runtime

### Pending Context Decisions

The following items are not all required for the first version. They should be
approved before adding fields or extra workflow logic.

| Item | What it is | How to get it | If omitted | Recommendation |
|------|------------|---------------|------------|----------------|
| Per-generation custom prompt | One-off interviewer instructions for this document, such as focus areas, exclusions, candidate-specific concerns, or must-ask topics. | Request body on `POST /api/candidates/:id/interview-questions`; the UI can expose a textarea. | Generation uses built-in prompt plus company/role prompts only. | Support as an optional request parameter. Persist only if auditability is needed. |
| Prompt mode | Whether custom prompt is appended or replaces other prompts. | System-controlled constant for the first version. | Code always appends custom instructions. | Do not add a DB field in v1; fixed `append` behavior is enough. |
| Interview round | Whether this is first round, second round, final round, or a focused technical screen. | User-selected/input request field, or written inside `custom_prompt`. Candidate state is not specific enough to infer this reliably. | Default to a general 60-minute technical interview. | Do not add a separate field in v1; use `custom_prompt` if needed. |
| Target duration | Desired interview length such as 30, 45, or 60 minutes. | User-provided request field, or written inside `custom_prompt`. | Default to 60 minutes. | Do not persist in v1; fixed 60 minutes is acceptable unless UI needs a duration control. |
| Structured resume summary | Parsed resume facts such as education, career trajectory, tech stack, representative projects, highlights, and risks. | Not stored today. Build at generation time from `candidate.brief`, latest `resume_ai` evaluation, and/or reading the resume PDF. | Questions may rely more on resume AI evaluation and direct PDF reading. | Do not add a field in v1. |
| Evidence snippets | Short facts or excerpts used to ground tailored questions. | Extract at generation time from resume PDF and evaluation content/meta. | Questions may be less anchored to specific candidate evidence. | Do not add a field in v1. |
| `interview_questions` AI scenario | Independent settings entry for runtime/model/effort selection. | Add `interview_questions` to the Settings scenario enum in code. | Reuse default AI settings. | Optional. Add only if separate model control is useful immediately. |

### Context Source Availability

The context plan should be constrained to data that exists in Recruit today or
to items explicitly approved from the pending decision table.

| Context | Source | Availability | Notes |
|---------|--------|--------------|-------|
| Company name | `companies.name` | Available | Returned by `getCompany()` / companies API. |
| Company profile | latest `company_profiles.content` | Available when configured | Existing resume evaluation already injects this as `company?.profile?.content`. If absent, use a concise fallback. |
| Company eval prompt | `companies.eval_prompt` | Available when configured | Existing resume evaluation already appends it as company-level custom instructions. |
| Role title | `roles.name` | Available | Candidate must have `role_id`, or generation should fail / ask user to assign a role. |
| Role JD | `roles.description` | Available when configured | Existing code treats it as fallback when `expected_portrait` is absent. Interview-question generation can include both JD and portrait, with trimming. |
| Role expected portrait | `roles.expected_portrait` and latest `role_profiles.content` | Available when configured | Existing role profile API writes latest profile content into `expected_portrait`. |
| Role eval prompt | `roles.eval_prompt` | Available when configured | This is the right source for role-specific interview emphasis. |
| Candidate basic fields | `candidates.name`, `email`, `phone`, `source`, `brief`, `state`, `role_id` | Available | `brief` may be auto-filled from resume AI evaluation. |
| Candidate extra info | `candidates.extra_info` | Available when configured | Existing resume evaluation already injects this. |
| Resume file | `candidates.resume_path` under `RESUMES_DIR` | Available when uploaded | Current runtime path supports PDF reading through CLI runtimes with `read_file`; generation should require a resume or degrade to DB/evaluation-only context. |
| Structured resume summary | Not a dedicated table/column today | Partially available | Use `candidate.brief`, latest `resume_ai` evaluation content/meta, and/or read the PDF during generation. Do not assume parsed fields such as education or career trajectory are stored separately. |
| Latest resume AI verdict/score | latest `evaluations` where `kind = 'resume_ai'`, plus `meta.score` | Available when evaluation has run | Candidate detail already returns all evaluations; list view derives latest verdict/score. |
| Resume AI analysis/recommendation | `evaluations.content` and `evaluations.meta.analysis/recommendation` | Available when evaluation has run | Existing AI eval stores markdown content and JSON meta. |
| Human interview feedback | `evaluations` where `kind = 'interview'` | Available when entered | Useful for later interview rounds; may be absent for first interview. |
| Interview round | Pending decision | Not available today | Can be provided through optional custom prompt instead of a dedicated field. |
| Target duration | Built-in default or pending decision | Default available | Default to 60 minutes unless a field/control is approved. |
| Per-generation custom prompt | Pending decision | Not available today | Can be accepted as a request parameter; persistence is optional. |
| Prompt mode | Built-in constant | Available by implementation | First version should be fixed append behavior. |
| Evidence snippets | Resume PDF + evaluation content/meta | Partially available | Generate snippets at request time from available sources; do not assume snippets are pre-stored. |
| Output constraints | Built-in prompt/template | Available by implementation | These are code-level constants, not user data. |

Unavailable or partial sources must have explicit fallback behavior:

- No company profile: generate with company name and a short "profile not
  provided" note.
- No role portrait: use role JD; if both are absent, generation should fail
  with a clear "role requirements missing" error.
- No resume uploaded: allow generation only if candidate brief, extra info, or
  prior evaluations provide enough signal; otherwise fail with "resume or
  candidate context required".
- No prior resume AI evaluation: read the resume file directly when the runtime
  supports file reading; otherwise generate from DB fields and note limited
  evidence.
- No custom prompt: use built-in system prompt + role/company prompts only.

The output should be Markdown directly. Unlike resume evaluation, it does not
need to produce JSON unless the implementation chooses to wrap metadata
separately. The Markdown should include frontmatter so Pages can infer title,
description, date, and tags:

```markdown
---
title: "Reference Interview Questions - Candidate Name"
description: "Role Name interview guide"
date: "2026-04-26"
tags: [recruit, interview-questions]
---
```

The prompt should follow the updated interview-question style standard:
human interviewer language, one point at a time, clear intended angle, and no
multi-question stacking.

### Context Engineering

High-quality interview questions need structured context, not a raw dump of all
available candidate data.

The generation context should be assembled from these blocks:

- Company context:
  - `companies.name`
  - latest `company_profiles.content`, when configured
  - `companies.eval_prompt`, when configured
- Role context:
  - `roles.name`
  - `roles.description`
  - `roles.expected_portrait`
  - `roles.eval_prompt`
- Candidate context:
  - `candidates.name`, `source`, `brief`, `extra_info`, and assigned role
  - resume PDF path when uploaded and readable by the selected runtime
  - structured resume facts extracted on demand, not assumed to be stored
- Existing evaluation context:
  - latest `resume_ai` evaluation verdict/content/meta
  - previous `interview` evaluations, when present
- Interview context:
  - default target duration of 60 minutes
  - interview round only if explicitly approved as a field or provided in the
    custom prompt
  - role seniority implied by role profile and candidate experience
- Custom instruction context:
  - optional request-level `custom_prompt`, if approved
  - persisted document `custom_prompt` only if auditability is required
- Evidence snippets:
  - short, relevant excerpts or facts extracted from resume/evaluation sources
    during generation
- Output constraints:
  - Markdown frontmatter
  - question count and stage structure
  - language
  - observation-note format
  - summary requirements

The generator should prefer structured summaries plus a small number of
high-value evidence snippets over blindly inserting the full resume and all
historical notes. The useful signal comes from intersecting role expectations,
candidate evidence, and the current interview goal.

When context exceeds the available model budget, trimming priority should be:

1. Remove low-signal long resume prose already captured in the structured
   summary.
2. Remove older or duplicate evaluation notes.
3. Keep role expectations, current custom prompt, candidate risk signals, and
   evidence snippets.
4. Keep output/style constraints even under tight budgets.

## Pages Integration Adapter

Add a small adapter module, for example `src/lib/pages-integration.js`.

Responsibilities:

- detect whether zylos-pages is installed and registration is available
- call the pages external-file CLI with `execFile`
- parse JSON output
- return structured success/failure results
- never mutate the pages content directory directly

Detection should be capability-based rather than only package-based:

1. locate the installed pages component path from known Zylos component layout
   or configuration
2. run `node <pages>/src/cli/external-files.js status --json`
3. require `ok: true` and `enabled: true`

Registration call:

```bash
node <pages>/src/cli/external-files.js register \
  --component recruit \
  --source <absolute markdown path> \
  --slug recruit/interview-questions/<stable-doc-slug> \
  --json
```

The stable slug should be derived from Recruit document identity, not mutable
candidate text. Recommended form:

```text
recruit/interview-questions/cand-<candidateId>-doc-<docId>
```

This makes registration idempotent and avoids URL churn when candidate names or
role names are edited later.

## Fallback Viewer

Recruit should provide an authenticated raw Markdown view. The simplest first
version can be a page or modal that renders escaped raw Markdown in a `<pre>` or
textarea-like block, with actions:

- open Pages URL when `pages_url` exists
- retry Pages registration when Pages is available but registration failed
- copy raw Markdown
- download Markdown

If Pages is unavailable, show a concise tip that installing zylos-pages enables
the rendered reading experience. The document remains fully accessible through
Recruit auth.

## UI Placement

Candidate detail modal is the natural first integration point:

- add a "Reference interview questions" section near evaluations/interview
  actions
- show generated documents with title, created time, status, and primary action
- primary action:
  - `Open in Pages` when `pages_url` exists
  - `View Markdown` otherwise
- secondary action:
  - `Generate`
  - `Retry Pages registration`

The UI should make the domain transition visible: opening Pages means leaving
Recruit and using Pages auth/viewer.

## Failure Handling

Generation and Pages registration should be decoupled:

- If Markdown generation fails, no ready document should be shown as generated;
  store the failure only if useful for diagnostics.
- If Markdown generation succeeds but Pages registration fails, keep the
  document and expose raw fallback.
- If Pages registration later succeeds, update `pages_slug`, `pages_url`, and
  `pages_registered_at`.
- If unregister fails during delete, keep enough metadata to retry cleanup
  later, but do not delete unrelated Pages files manually.

## Test Plan

Server/API tests or smoke tests should cover:

- document generation creates a DB row and Markdown file under Recruit data dir
- generated Markdown has frontmatter suitable for Pages
- raw endpoint returns `text/markdown` and requires Recruit auth/API token
- Pages unavailable: document remains available through raw fallback
- Pages available: adapter calls registration CLI and stores returned URL
- retry registration is idempotent for the same document
- Pages registration failure does not block candidate workflow
- deleting a document soft-deletes the Recruit row and requests unregister
- file path resolution rejects escaped `file_path` values
- existing candidate, role, resume, and evaluation APIs continue to work
