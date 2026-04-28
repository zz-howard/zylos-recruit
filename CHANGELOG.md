# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.13] - 2026-04-28

### Changed
- **Internal role-discovery opening**: new internal interviews now ask directly
  what kind of person or role is needed, and only fall back to work hand-off
  exploration when the stakeholder is unsure or the role is unclear.
- **README positioning**: project documentation now reflects the current
  reference capabilities: role portrait discovery, portrait generation,
  multi-portrait drafts, Pages-backed reference interview questions, human
  interview feedback, local AI runtime reuse, and bwrap sandboxing.

## [0.2.12] - 2026-04-27

### Changed
- **Async reference interview-question generation**: candidate detail pages now
  start generation in the background, show a generating state after refresh or
  reopening, and poll until the generated document appears.

### Fixed
- **Interview-question generation UX**: the "生成参考面试题" button no longer
  blocks the modal while waiting for the AI run to finish, and failed background
  generations surface their error in the reference-question section.

## [0.2.11] - 2026-04-27

### Added
- **Pages-backed interview questions**: candidate detail pages can generate
  reference interview-question documents from candidate, role, resume, and
  evaluation context, then register the generated Markdown with zylos-pages.

### Changed
- **Candidate detail layout**: on desktop, reference interview questions and
  interview feedback now sit below Resume in the right column, keeping AI resume
  evaluation separate and making the detail view more compact.
- **Interview-question prompt quality**: generated documents now focus on
  interview hypotheses, resume-anchored core questions, natural follow-ups,
  weak-answer handling, and Howard's interview note template.

### Fixed
- **Generated Markdown cleanup**: strips model preambles, extra frontmatter, and
  fenced Markdown wrappers before publishing to Pages, including glued
  `。---`-style frontmatter cases.

## [0.2.10] - 2026-04-26

### Added
- **gpt-5.5 runtime option**: ChatGPT runtime now exposes `gpt-5.5`;
  Codex runtime exposes `gpt-5.5` when the installed Codex CLI is `0.124.0`
  or newer.

### Fixed
- **Scenario AI settings inheritance**: scenario-specific model and effort
  controls are now locked when runtime follows the default settings. Selecting
  an explicit runtime resets model/effort to valid options for that runtime,
  and runtimes without effort support display `N/A`.

## [0.2.9] - 2026-04-20

### Added
- **Migration safety utilities** (`src/lib/migration-safety.js`): `withFkOff(db, fn)`
  wraps a callback with `PRAGMA foreign_keys = OFF` and restores it after;
  `assertFkOff(db)` guard throws if foreign keys are still enabled;
  `schemaDryRun(db, sql)` executes DDL inside a rolled-back transaction to
  validate syntax without applying changes.

## [0.2.8] - 2026-04-19

### Changed
- **Soft delete for all 8 tables**: `DELETE FROM` replaced with `deleted_at`
  timestamp + `delete_batch` UUID. Records are hidden from queries but preserved
  in the database for recovery.
- **Cascade soft delete**: deleting a company/candidate/role/interview
  soft-deletes all child records in a single `BEGIN IMMEDIATE` transaction with
  shared batch ID. Each delete function returns per-table affected row counts.
- **Partial unique indexes**: `companies(name)` and `roles(company_id, name)`
  uniqueness now scoped to active records only — soft-deleted records don't block
  creating new records with the same name.
- **Write-path filtering**: role lookups in `createCandidate`/`updateCandidate`,
  candidate checks in `addEvaluation`, and interview checks in
  `addInterviewMessage` now exclude soft-deleted records.
- Delete API endpoints return batch ID + affected counts instead of 204.

### Added
- **Restore endpoints**: `POST /api/candidates/:id/restore` and
  `POST /api/internal-interviews/:id/restore`. Batch-aware recovery restores
  only same-batch child records. Pre-checks uniqueness conflicts and parent
  record state before restoring.

## [0.2.7] - 2026-04-18

### Added
- **Web search and web fetch tools** for ChatGPT runtime. AI-powered interview
  chats can now search the web (`web_search`) and fetch page content
  (`web_fetch`) when answering questions that require external information.
- **SSRF protection stack** (4 new files, 1024 lines): private IP detection,
  hostname blacklist, DNS pinning, redirect validation, size limits (750KB raw /
  20K chars extracted), content tagging with random marker IDs for prompt
  injection prevention, 15-min LRU cache.
- **Multi-round tool loop**: each round includes full tools; loop continues
  until the model produces text without tool calls. Max 25 rounds as safety
  limit — the last round strips tools to force text output.
- **Parallel web fetch**: multiple URLs within the same round are fetched
  concurrently via `Promise.all`.

### Changed
- **ChatGPT adapter migrated from curl to OpenAI Node SDK** (`openai` npm).
  OAuth token passed as `apiKey`, `baseURL = chatgpt.com/backend-api`.
- **Native multi-turn conversation** via Responses API `instructions` +
  role-based `input` array (replaces single concatenated user message).
- **Prefix cache confirmed working** on HTTP multi-turn mode (91% hit rate).
- **Usage logging** added: input/output/cached tokens + web_searches/web_fetches
  count per request.

## [0.2.6] - 2026-04-17

### Added
- **Multi-portrait generation.** When internal interviews cover multiple
  clearly distinct roles, the AI now returns an array of portraits and the
  suggestion modal renders tabs (one per role). Each tab has its own name
  input, portrait textarea, and "收录为新角色" button, so the user can save
  one, some, or all roles in a single session. Single-role case degrades to
  the previous single-form UI. Conservative split threshold in the prompt
  prevents over-splitting of one role's different facets.

### Changed
- `POST /internal-interviews/generate-portrait` response shape:
  `{ portrait, suggested_name }` → `{ portraits: [{name, portrait}, ...] }`.

## [0.2.5] - 2026-04-17

### Added
- **AI config lock per interview.** Runtime / model / effort are now snapshotted
  into the DB row at interview creation; later model/effort changes in Settings
  no longer retroactively change a running interview.
- **Session resume for all three CLI runtimes** (Claude / Codex / Gemini) via
  `--resume <session_id>`. First call captures the session id from JSON output
  and persists it; subsequent calls reuse the session to hit the model's KV
  cache (~10× token savings verified on long resume-eval flows).
- **Streaming toggle** in Settings (`stream_enabled` per scenario).

### Security
- **Bubblewrap sandbox around every CLI adapter.** All three adapters
  (claude/codex/gemini) now spawn through the shared `sandbox.js` helper in
  **minimalFS mode**: `$HOME` is a tmpfs, only the CLI's own auth/state
  directory is rw-bound, and scenario data (e.g. `resumes/`) is exposed via
  caller-declared `readOnlyBinds` — deny-by-default filesystem.
- **Gateway-level read-only bind declaration.** Scenarios declare what they
  need (`needsFile` → `[RESUMES_DIR]`); the gateway forwards to the adapter,
  which assembles the sandbox. Prompt injection that escapes the CLI's own
  tool allowlist still cannot reach `~/.ssh`, `~/zylos/memory`, other
  components' data, or `~/.env` — the host FS is not in the sandbox's
  mount namespace.
- **Codex CLI stdin hang fix.** Switched from `execFileAsync` to `spawn` with
  `stdio: ['ignore','pipe','pipe']` to prevent Codex blocking on unfixed stdin.

### Changed
- Claude adapter `--allowedTools Read` restored for `read_file` scenarios
  (the bwrap minimalFS layer now provides the hard filesystem boundary;
  the CLI flag is defense-in-depth on top).

### Upgrade

```bash
zylos upgrade recruit
```

Requires `bubblewrap` (bwrap) on the host for sandbox enforcement — the
adapter transparently falls back to direct spawn if bwrap is absent, but
running in production without bwrap means **no filesystem isolation**.
Install via `sudo apt install bubblewrap` on Debian/Ubuntu.

## [0.2.4] - 2026-04-12

### Changed
- **Data model: `expected_portrait` field on roles.** Roles now have three distinct text fields:
  - `description` — public JD (job description)
  - `expected_portrait` — internal candidate portrait (期望画像), the primary basis for AI resume evaluation
  - `eval_prompt` — special evaluation instructions (usually empty, for edge cases only)
- **`role_profiles` table** now stores versioned `expected_portrait` history (each save creates a new version and syncs to the live `expected_portrait` field on the role).
- **AI evaluation prompt** updated: `expected_portrait` is the primary matching criteria; JD serves as supplementary context.
- **Migration:** existing `eval_prompt` content is automatically migrated to `expected_portrait` on first startup.

### Upgrade

```bash
zylos upgrade recruit
```

Auto-migrates schema (adds `expected_portrait` column, moves existing `eval_prompt` data).

## [0.2.1] - 2026-04-11

### Added
- **Role manager** modal (☰ button in top bar): lists all roles in the active company with candidate counts, lets you edit name / description, edit versioned JD / 岗位画像 profile (markdown), or delete the role. Previously role profiles could only be updated via the REST API.
- New REST endpoints: `PUT /api/roles/:id` (update name/description), `DELETE /api/roles/:id`.
- `db.updateRole(id, { name, description })` and `db.deleteRole(id)`.

### Upgrade

```bash
zylos upgrade recruit
```

No schema change.

## [0.2.0] - 2026-04-11

### Added
- **Multi-company support.** Companies are now the first-level entity; roles and candidates are scoped to a company.
- `companies` table + `company_profiles` table (versioned markdown company background).
- `company_id` foreign key added to `roles` and `candidates` (cascading delete).
- New REST API: `/api/companies` (list / get / create / rename / update profile / delete).
- `/api/roles` and `/api/candidates` now require a `company_id` query param (GET) or body field (POST).
- Top-bar **company switcher** dropdown. Active selection cached in `localStorage` under `zylos_recruit_active_company` — on reopen, the last-selected company loads automatically.
- **Company manager** modal (⚙ button): list / rename / edit profile / delete companies; add new companies.
- **Company profile editor**: markdown editor backed by versioned `company_profiles` storage.
- Cross-company isolation: a role created in company A cannot be assigned to a candidate in company B; server rejects such writes with `400 different company`.

### Changed
- `roles` table now has a compound uniqueness constraint `(company_id, name)` instead of global `name` uniqueness — two companies can have a role of the same name.
- Role dropdown and candidate list always filtered to the active company.

### Breaking
- **v0.1.0 → v0.2.0 requires a DB wipe.** The new schema adds NOT NULL `company_id` columns to `roles` and `candidates`. Since v0.1.0 was freshly shipped and had no production data, the upgrade path is: stop service → delete `~/zylos/components/recruit/recruit.db` (+ `-wal`/`-shm`) → restart service. The new schema will be created on first boot.

### Upgrade

```bash
pm2 stop zylos-recruit
rm ~/zylos/components/recruit/recruit.db{,-wal,-shm}
zylos upgrade recruit   # or re-install from GitHub
pm2 start zylos-recruit
```

After restart, open `/recruit/`, click ⚙ to create your first company, then create roles and candidates inside it.

## [0.1.0] - 2026-04-11

### Added
- Initial release.
- Express HTTP server on port 3465 (configurable via `RECRUIT_PORT`).
- SQLite schema: `roles`, `role_profiles`, `candidates`, `interview_stages`, `evaluations`.
- REST API for roles, candidates, state transitions, evaluations, resume upload/download.
- 5-column Kanban web UI with candidate cards and detail modal.
- Inline PDF resume preview via `pdf.js`.
- Cookie-based session auth with scrypt hashing and brute-force lockout.
- Caddy reverse-proxy auto-wiring via `http_routes` in SKILL.md.
- Post-install hook: creates data directories, generates random password, writes `config.json`.

### Upgrade Notes

Initial release — no migration required.

```bash
zylos add recruit
```
