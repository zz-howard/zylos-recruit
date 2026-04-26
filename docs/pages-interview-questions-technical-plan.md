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
  - company profile
  - product and technical architecture summary
  - AI-native work style
  - what this role would work on at COCO
- Role context:
  - role title and JD
  - expected portrait
  - role `eval_prompt`
  - assessment dimensions and weight hints
  - role-specific red flags
- Candidate context:
  - structured resume summary
  - years of experience and seniority signal
  - education and career trajectory
  - tech stack and domain experience
  - representative projects
  - highlights and risk signals
- Existing evaluation context:
  - latest resume AI evaluation conclusion
  - score or verdict when available
  - main evidence supporting the conclusion
  - concerns that should be tested in interview
- Interview context:
  - interview round
  - interviewer
  - target duration
  - desired depth and seniority calibration
- Custom instruction context:
  - per-generation custom prompt
  - areas to emphasize or avoid
  - must-ask or must-not-ask topics
- Evidence snippets:
  - short, relevant excerpts or facts from the resume/evaluation that support
    tailored questions
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
