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
