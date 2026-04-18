# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
