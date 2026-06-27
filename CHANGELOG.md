# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.33] - 2026-06-28

### Added
- **Smart match result persistence** (`role_matches` table): `rankRolesFromResume()` now persists scored role matches to a cache table, so the 智能匹配岗位 panel loads instantly from cache instead of waiting on a live AI call. `GET /api/candidates/:id/auto-match` serves the cache (`{matches, cached_at}`, `200` + empty when none, `404` if candidate missing); `POST` re-runs the AI and refreshes the cache. Single persistence point covers both the candidates POST endpoint and the intake pipeline, fail-fast on write failure. (#74, PR #76)
- **Kanban cache-first display**: clicking 智能匹配岗位 reads the cache first (instant render); a 🔄 button re-runs the AI on demand; no cache falls back to auto-POST. (#74, PR #76)

### Fixed
- **Candidate delete clears match cache**: candidates are soft-deleted (so FK cascade never fires), so `deleteCandidate()` now explicitly hard-deletes the candidate's `role_matches` rows (regenerable cache). (#74, PR #76)

## [0.2.32] - 2026-06-27

### Added
- **Async resume intake API** (`POST /api/candidates/intake`): upload resume, create candidate, and run smart matching + AI evaluation asynchronously. Returns candidate ID and poll URL immediately. (#69, PR #70)
- **Intake result polling** (`GET /api/candidates/:id/intake-result`): poll for async pipeline result — processing (202), completed (200), or failed (200). (#69, PR #70)
- **`intake_jobs` SQLite table**: tracks async pipeline status with 24h auto-cleanup of completed/failed jobs. (PR #70)
- **Ranked matching for intake**: intake pipeline uses `rankRolesFromResume()` with scored evaluation and red-line mechanism for more accurate role matching, with deterministic sort by score. (PR #71)

### Fixed
- **`evaluateResume()` lock leak**: moved `evaluatingSet.delete()` into a `finally` block so the lock is always released even when evaluation fails early. Previously, failures left candidates permanently stuck in `isEvaluating=true` until process restart. (PR #70)
- **Kanban column scroll**: columns now scroll internally when there are many candidates, instead of stretching the entire page height. (PR #72)

## [0.2.31] - 2026-06-26

### Added
- **Template-edit flow for interview questions**: LLM edits a pre-styled HTML template (replacing a content placeholder) instead of generating full HTML from scratch, reducing output tokens and generation time by ~22%. Falls back to a second direct-output AI call if template edit fails.
- **Runtime capability gating**: Template-edit path is only used when the runtime supports `edit_file` (Claude). Other runtimes (Codex, Gemini) automatically use direct HTML output.
- **HTML sanitization** (security): All LLM-generated HTML is sanitized via `sanitize-html` allowlist before saving. Blocks script injection, inline event handlers, javascript: URLs (including entity-encoded/obfuscated variants), iframe/srcdoc, object/embed/form, and meta http-equiv refresh redirects.

### Changed
- **Claude runtime timeout**: Increased from 900s to 1200s for template-edit flow.

## [0.2.30] - 2026-06-25

### Changed
- **Interview questions output format**: Switched from JSON intermediate format to direct HTML output. The LLM prompt now includes a full HTML/CSS template as reference and outputs a complete, self-contained HTML page with side-by-side question/answer layout. Eliminates the fragile JSON parsing step that caused generation failures.
- **Claude runtime timeout**: Increased from 600s to 900s to accommodate larger HTML output generation.

### Removed
- `interview-questions-html.js` renderer (replaced by direct HTML output from prompt)
- `parseInterviewJson()`, `cleanGeneratedMarkdown()`, `ensureFrontmatter()`, `inferMarkdownTitle()`, and related markdown helper functions (no longer needed)

## [0.2.29] - 2026-06-24

### Added
- **Sandbox security warning** (#61): When AI execution runs without sandbox (allowUnsandboxed=true), API responses include `sandboxed: false` flag and UI displays a warning badge on interview question cards. Sandbox status flows through sandbox-runner stderr → runtime adapter → ai-gateway → DB → API → UI.

### Fixed
- **Smart matching semantic understanding** (#63): Rewrote role matching prompt from 3 lines to 28 lines. AI now evaluates candidates based on role essence rather than keyword overlap. Supports structured portrait layers (required/bonus/red-lines) with score caps. Fixes issue where unrelated roles (e.g. LLM post-training) scored higher than actual matches.

## [0.2.28] - 2026-06-22

### Fixed
- **Non-ASCII resume download** (#60): Downloading resumes for candidates with non-ASCII names (e.g. Chinese characters) no longer causes `ERR_INVALID_CHAR`. Uses RFC 5987 `filename*=UTF-8''` encoding with ASCII fallback.

## [0.2.27] - 2026-06-17

### Added
- **Interview evaluation deletion UI** (#58): Existing interview evaluation cards now expose a delete action with confirmation, disabled/deleting state, DELETE API integration, and post-delete candidate reload so the Kanban view stays consistent with backend data.

## [0.2.26] - 2026-06-13

### Added
- **Candidate search** (#56): Debounced search box in the Kanban topbar searches across candidate name, email, phone, source, brief, extra info, state, and role name. Server-side LIKE query with wildcard escaping, scoped to the active company. Clear button and Escape key support. Search state resets on company switch.

## [0.2.25] - 2026-06-10

### Changed
- **Interview question generation: opener anchoring** (#53): The opening warm-up question now anchors to a specific project or claim the question designer picks from the resume. "Pick a project that best represents you" style openers are forbidden.
- **Interview question generation: evidence-anchored verification** (#54): Claim-verifying follow-ups must force a falsifiable specific (how a number was computed, before/after comparison, named specifics), with three evidence levels (narrative / mechanism / numbers with calculation basis) noted for the interviewer. Asking for documents/logs/schemas live is forbidden; an optional take-home task section covers artifact-level evidence.

## [0.2.24] - 2026-06-10

### Added
- **Smarter interview question generation** (#42): Adds current-date context, duration-aware question caps, resume gap analysis, tenure probes, cross-role bridging, and role-specific interview prompt instructions.

### Fixed
- **Fresh role dropdown options** (#50): Role selects now refresh role data on open/focus with a short TTL, so roles created externally appear without a full page reload.

## [0.2.23] - 2026-05-07

### Added
- **Evaluation delete API** (#41): `DELETE /api/candidates/:id/evaluations/:evalId` soft-delete endpoint. Evaluations are marked with `deleted_at` timestamp and excluded from default queries. 24 tests pass.

### Changed
- **Expanded API references documentation** (#40): Comprehensive API documentation rewrite covering all endpoints, request/response examples, authentication, error handling, and AI evaluation workflows. 9 files updated (+1175/-335 lines).

## [0.2.22] - 2026-05-06

### Fixed
- **Harden base-path redirect handling** (#38): `login.js` drops independent `isSafeRedirect`, uses shared `isPathWithinBase(next, baseUrl)` from `browser-base.js`. `auth.js` passes `browserBase` consistently. 16 tests pass.
- **Clarify SRT network policy semantics** (#39): Default and explicit opt-out both produce `network: {}` (unrestricted, allows external WebFetch). SRT allow-only network isolation activates only when `allowedDomains` is configured. `deniedDomains` serves as priority-deny exclusions within the allowlist path.

### Changed
- **AI Gateway and SRT Sandbox docs rewritten** (#37): Replaced `sandbox-isolation-guide.md` and `srt-sandbox-runtime-design.md` with new `docs/ai-gateway.md` and `docs/srt-sandbox.md` (Chinese).

## [0.2.21] - 2026-05-05

### Fixed
- **Dynamic base URL with X-Forwarded-Prefix** (#34): Removes hardcoded `BASE_URL = '/recruit'`. New `browser-base.js` module dynamically resolves browser-facing paths from `X-Forwarded-Prefix` header, with relative URL fallback for direct access. Login, logout, and redirect routes all respect the proxy prefix. `isSafeRedirect` hardened against open redirect attacks. 5 new auth route tests added.

### Changed
- **Sandbox network policy assertion aligned** (#35): Test assertion updated to match current disabled network isolation policy for WebFetch scenarios.

## [0.2.20] - 2026-05-04

### Fixed
- **macOS sandbox compatibility for Codex and Gemini** (#32): macOS sandbox-exec (Seatbelt) conflicts with Codex's nested sandbox-exec. Solution: Codex uses `--dangerously-bypass-approvals-and-sandbox` on macOS (SRT seatbelt is sole protection); Linux dual-sandbox unchanged.
- **Codex resume path sandbox flags** (#32): `codex exec resume` does not accept `--sandbox` flag (only `--dangerously-bypass`). macOS resume now passes `--dangerously-bypass`; Linux resume relies on SRT bwrap as outer sandbox.
- **Claude CLI empty stdout on macOS** (#32): SRT seatbelt `subpath "~/.claude"` does not cover `~/.claude.json` (a sibling file, not a child path). Added to `allowRead` via new `runtimeReadOnlyConfigPaths`.
- **Gemini CLI file access on macOS** (#32): Added `--include-directories` for scenario read paths.

### Security
- **`.claude.json` is read-only in sandbox** (#32): Moved from `runtimeAuthStatePaths` (rw) to `runtimeReadOnlyConfigPaths` (ro). Sandboxed CLI can read but not modify global Claude Code config. Regression test added.

## [0.2.19] - 2026-05-04

### Fixed
- **Restore Codex dual-sandbox with /tmp write access** (#31): Codex CLI's Landlock sandbox initialization requires writable `/tmp`. SRT sandbox previously denied this, causing all Codex file-reading scenarios (auto_match, resume_eval) to fail with 0 scores. Fix: add `/tmp` to SRT `allowWrite` and set `TMPDIR=/tmp`. Both SRT bwrap and Codex Landlock now coexist (defense-in-depth).
- **Interview question generation completion logging**: Added timing and runtime info log on successful generation.

### Changed
- **Per-scenario tool restrictions for Claude/Codex/Gemini** (#31): Claude uses `--tools` whitelist per scenario (chat=WebFetch, portrait/summary=none, resume_eval/interview_questions=Read+WebFetch, auto_match=Read). Codex uses `--disable` flags (image_generation/multi_agent/computer_use always; shell_tool for non-file scenarios). Gemini uses TOML admin-policy with per-scenario deny rules.
- **Rename chatgpt runtime to codex-api** (#31): `chatgpt.js` → `codex-api.js`, runtime name `chatgpt` → `codex-api`, UI label updated. Backward-compat alias preserved in ai-gateway.
- **Reduce redundant company context in resume prompts** (#31): `buildResumePrompt` no longer re-injects company background on resumed sessions.

### Security
- **Network isolation disabled for SRT sandbox** (#31): Changed to `network: {}` to fix `parentProxy` undefined crash in SRT network config. Acceptable: SRT still provides filesystem deny-default + seccomp.

## [0.2.18] - 2026-05-03

### Fixed
- **Add SRT vendor directory to allowRead** (#30): SRT's `apply-seccomp` binary lives under `~/zylos/` (in `node_modules/`). The ZYLOS_DIR deny policy blocked it, causing all sandbox scenarios (portrait/chat/summary) to fail with exit 127. Fix: dynamically resolve the SRT vendor directory via `import.meta.resolve` and add to `allowRead`. Only SRT seccomp vendor assets are exposed — no sensitive data.

## [0.2.17] - 2026-05-03

### Fixed
- **Avoid file-level allowRead for HOME-installed CLI binaries** (#29): `commandSupportPaths()` now adds the containing directory instead of the exact executable file, preventing bwrap mount-point failures when CLI is installed under `$HOME` (e.g. `~/.local/bin/claude`) and `$HOME` is tmpfs-masked.

### Security
- **Exclude zylos directory from support path allowRead** (#29): `supportPaths` filter prevents dynamic path resolution from re-exposing `~/zylos/` or its children through `allowRead`, closing a path where CLI installed under `~/zylos/` could bypass the deny-default protection for memory/.env/config.

## [0.2.16] - 2026-05-03

### Security
- **SRT sandbox runtime adoption** (#27): replace old bwrap wrapper with @anthropic-ai/sandbox-runtime. Deny-default file policy (deny $HOME + ~/zylos, allow back only scenario-specific paths). Per-scenario sandbox config: chat/summary/portrait get zero file access; resume_eval gets exact resume file only. Fail-closed on missing dependencies (exit 126). Network allowlist for AI API domains only. Signal forwarding + cleanup-once lifecycle. Shell quoting safety via shell-quote library.

### Fixed
- **Auto-install sandbox dependencies** (#28): post-install hook now auto-installs socat and ripgrep via apt on Linux, ripgrep via brew on macOS (previously warn-only; bwrap already had auto-install).

## [0.2.15] - 2026-05-03

### Added
- Copy-to-clipboard button for AI evaluations on candidate detail page
- bwrap (bubblewrap) detection and auto-install in post-install hook (Linux only; macOS warns unsupported)

### Fixed
- Inject company profile and eval_prompt into internal interview chat, summary generation, and portrait generation (previously only resume eval and interview questions had company context)
- Resumed interview sessions now receive company context reminder

## [0.2.14] - 2026-04-29

### Changed
- Rename pipeline stage label: 推进中/可推进 → 已推进 (已推进 and 人才库 are both terminal states)

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
