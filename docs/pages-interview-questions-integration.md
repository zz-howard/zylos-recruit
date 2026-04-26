# Pages Integration for Reference Interview Questions

## Purpose

zylos-recruit should support generating reference interview-question documents
for candidates and roles, while avoiding a duplicate implementation of the
zylos-pages Markdown viewer.

Recruit remains useful without pages installed. When pages is available,
recruit can offer a richer document viewing experience by registering generated
Markdown files with pages.

## Design Logic

Recruit owns the recruiting workflow and the generated document content.
Reference interview-question Markdown files should be stored in the recruit
data directory as canonical source files.

Pages owns rendered document viewing. Recruit should not copy a document into
pages as the source of truth, and pages should not need to understand recruit's
candidate or role schema.

The integration is progressive enhancement:

- Recruit generates and stores a Markdown document in its own data directory.
- Recruit records document metadata needed for its own workflow.
- If pages is installed and supports external-file registration, recruit asks
  pages to register the Markdown file under a stable pages slug.
- Recruit stores the returned pages viewer URL.
- Users can open the document from recruit and view it through pages
  authentication.
- If pages is unavailable, recruit provides an authenticated raw Markdown view
  and suggests installing pages for the richer viewer.

## Source of Truth

The source of truth for generated reference interview questions is always the
Markdown file in recruit's data directory.

Recruit may store metadata such as:

- candidate
- role
- company
- title
- generator runtime/model
- created timestamp
- updated timestamp
- pages viewer URL, when registered

Pages should not store this business metadata. Pages only needs enough
registration information to manage the symlink and viewer slug.

## Permissions Model

Before a document is registered with pages, access is controlled by recruit.
This includes document generation, document listing, raw Markdown fallback, and
any edits made inside recruit.

After a document is registered with pages, viewing the rendered pages URL is
controlled by pages. This is an intentional domain transition: publishing a
document to pages makes it visible to users who can authenticate to pages.

Recruit should make that transition clear in the UI. The action should read as
opening or publishing to pages rather than implying that pages is enforcing
candidate-specific recruit permissions.

## Recruit Behavior

Recruit should add a document concept for reference interview questions without
turning into a general-purpose publishing system.

Expected behavior:

- Generate a Markdown reference interview-question document for a candidate and
  role.
- Store the Markdown under recruit's data directory.
- Keep the document associated with the candidate and role in recruit.
- Detect whether pages integration is available.
- Register the document with pages when possible.
- Show a pages viewer link when registration succeeds.
- Provide an authenticated raw Markdown fallback when pages is absent or
  registration has not happened.
- Show a clear tip that installing pages enables the richer rendered view.

Recruit should not write directly into pages internals. It should use the pages
registration surface so pages remains responsible for symlink ownership, slug
conflict handling, and source path validation.

## Concurrent Generation and Registration

Recruit may generate reference interview-question documents concurrently for
multiple candidates. Document generation remains recruit-owned and can proceed
in parallel.

Pages registration is different: it should be treated as a pages-owned
serialized operation. Recruit should call the pages registration surface for
each generated Markdown file and rely on pages to lock and atomically maintain
its external-file registry.

Recruit should make registration requests idempotent by using stable slugs for
the same recruit document. If registration is retried for the same document and
source file, the operation should be safe to repeat. If pages reports a slug
conflict or registration failure, recruit should keep the recruit-owned raw
Markdown document available and surface the pages integration error without
blocking the candidate workflow.

Recruit should not attempt to repair or rewrite pages' registry. Recovery and
cleanup of pages-managed symlinks belong to pages.

## Technical Plan

### Data Directory Layout

Add a Recruit-owned document directory under the component data directory:

```text
~/zylos/components/recruit/
  interview-questions/
    cand-<candidateId>-role-<roleId>-<docId>.md
```

This directory contains the canonical Markdown source files. Pages only receives
a symlink registration request pointing back to these files.

### Database Schema

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

### API Surface

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

### AI Generation

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
title: "Reference Interview Questions — Candidate Name"
description: "Role Name interview guide"
date: "2026-04-26"
tags: [recruit, interview-questions]
---
```

The prompt should follow the updated interview-question style standard:
human interviewer language, one point at a time, clear intended angle, and no
multi-question stacking.

### Pages Integration Adapter

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

### Fallback Viewer

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

### UI Placement

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

### Failure Handling

Generation and Pages registration should be decoupled:

- If Markdown generation fails, no ready document should be shown as generated;
  store the failure only if useful for diagnostics.
- If Markdown generation succeeds but Pages registration fails, keep the
  document and expose raw fallback.
- If Pages registration later succeeds, update `pages_slug`, `pages_url`, and
  `pages_registered_at`.
- If unregister fails during delete, keep enough metadata to retry cleanup
  later, but do not delete unrelated Pages files manually.

### Test Plan

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

## Acceptance Criteria

- A user can generate a reference interview-question Markdown document from a
  recruit candidate/role context.
- The generated Markdown file is stored under the recruit data directory and is
  treated as the canonical source.
- Recruit records enough metadata to list the document from the candidate or
  role context.
- When pages integration is available, recruit registers the Markdown file with
  pages and stores the returned viewer URL.
- Concurrent document generations do not corrupt pages registration state;
  recruit can issue multiple registration requests and pages serializes registry
  writes.
- Opening the pages URL takes the user to the pages domain and requires pages
  authentication according to pages configuration.
- Editing or regenerating the recruit-owned Markdown file is reflected in pages
  without creating a second canonical copy.
- When pages is not installed or registration is unavailable, recruit still lets
  authenticated recruit users view the raw Markdown content.
- The fallback view clearly suggests installing pages for the full rendered
  reading experience.
- Recruit does not create or mutate files inside the pages content directory
  directly.
- Removing a recruit document does not accidentally delete unrelated pages
  documents. If the document was registered with pages, recruit requests
  unregistering through the pages integration surface.
- Existing resume evaluation, candidate management, and role management flows
  continue to work unchanged.
