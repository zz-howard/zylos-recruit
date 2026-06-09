# Dev Plan: Improve Interview Question Generator (#42)

## Summary

Upgrade the interview question generator from a fixed-template system to a smarter, configurable one. Part 1 rewrites the system prompt with question capping, resume gap analysis, date awareness, tenure probes, and cross-role bridging. Part 2 adds persistent per-role interview prompt templates stored in the database.

## Scope

**In scope (from issue):**
- Rewrite `buildPrompt()` with structured pre-analysis step and question caps
- Inject current date into generation context
- Add tenure-based and cross-role bridging logic
- Add `interview_prompt` column to `roles` table for per-role prompt templates
- API + UI for editing per-role interview prompts
- Persist `custom_prompt` is NOT in scope (it stays as a request parameter — the issue says "per-role or global prompt template", not per-generation persistence)

**Out of scope:**
- Changing the AI gateway or runtime selection logic
- Changing the document storage or Pages integration
- Global company-level interview prompt (company already has `eval_prompt` which feeds into context)

## Development Checklist

### Part 1: System Prompt Optimization

- [ ] **1.1 Date injection**: In `buildContext()`, add a `## Generation Context` section at the top with current date (`YYYY-MM-DD`), day of week, and quarter (e.g., "Today: 2026-06-09 (Monday), Q2 2026")
- [ ] **1.2 Rewrite `buildPrompt()` system instructions**: Replace the current monolithic prompt with a structured flow:
  1. **Pre-analysis step** (new): Before writing questions, the LLM must produce a resume gap analysis — what's unusual, what's missing, strongest signal, weakest signal, biggest risk for this role. This analysis drives question selection.
  2. **Question cap**: "8 questions max for 30-min interviews, 12 for 60-min. Each question has a main question + 1-2 natural follow-up directions, NOT separate numbered questions."
  3. **Tenure probes**: "If any single tenure exceeds 5 years, include a question about why they're leaving and what changed."
  4. **Cross-role bridging**: "Identify which past role/experience is closest to the target role. Generate one question that bridges that experience to the current opportunity."
  5. **Question merging rule**: "Related evaluation dimensions should be combined into a single main question with follow-up angles, not split into separate questions."
- [ ] **1.3 Duration parameter**: Add `duration` (minutes) to `generateInterviewQuestions()` options. Default 60. Pass into the prompt so the LLM knows the time budget. The route handler reads `req.body.duration` (number, optional).

### Part 2: Per-Role Interview Prompt Templates

- [ ] **2.1 DB migration**: Add `interview_prompt TEXT` column to `roles` table via `ALTER TABLE`. Also update `migrateSoftDelete()` in `db.js` (lines 269-328): the `roles_new` CREATE TABLE and INSERT...SELECT must include `interview_prompt`, otherwise the rebuild drops the column. Update `db.js` schema init to include the column for fresh installs.
- [ ] **2.2 Update `getRole()` / role CRUD**: Ensure `interview_prompt` is read/written in all role operations (`createRole`, `updateRole`, `getRole`).
- [ ] **2.3 Feed into context**: In `buildContext()`, if `role.interview_prompt` exists, add it as a `## Role Interview Instructions` section. **Compatibility**: `role.eval_prompt` is already injected into interview question context as "Role Evaluation Instructions" (lines 96-105 of `interview-questions.js`). This behavior is preserved — `eval_prompt` continues to appear. `interview_prompt` is additive, placed after `eval_prompt` in the context. If both exist, both appear. No silent breakage of existing behavior.
- [ ] **2.4 Priority chain**: built-in system prompt < role `eval_prompt` (existing, preserved) < role `interview_prompt` (new, interview-specific) < per-request `custom_prompt`. Later sources can override earlier ones.
- [ ] **2.5 API endpoint**: `PUT /api/roles/:id` (not PATCH — current route is PUT, `src/routes/api-roles.js` lines 52-68) — ensure it accepts `interview_prompt` in the body.
- [ ] **2.6 UI**: Add an "Interview Prompt" textarea to the role edit modal (alongside the existing eval_prompt field). Label: "面试题生成提示词" with placeholder explaining usage.

## Test Checklist

- [ ] Unit test: `buildContext()` includes date section with correct format
- [ ] Unit test: `buildPrompt()` output includes pre-analysis instruction, question cap, tenure probe, cross-role bridging rules
- [ ] Unit test: duration parameter flows through to prompt (30min → "8 questions", 60min → "12 questions")
- [ ] Unit test: `interview_prompt` from role feeds into context under correct section
- [ ] Unit test: priority chain — when both `interview_prompt` and `custom_prompt` exist, both appear in context in correct order
- [ ] Integration test: `POST /api/candidates/:id/interview-questions` with `duration` parameter
- [ ] Integration test: `PUT /api/roles/:id` with `interview_prompt` field persists and reads back
- [ ] Manual: Generate questions for an existing candidate, verify output has pre-analysis section and respects question cap
- [ ] Manual: UI role edit modal shows interview_prompt textarea

## Assumptions

- [ ] `roles.eval_prompt` is ALREADY used in both resume evaluation AND interview question generation — it's injected as "Role Evaluation Instructions" in `buildContext()` (lines 96-105). Adding `interview_prompt` does NOT replace `eval_prompt` in interview context; both coexist. `eval_prompt` = general role evaluation guidance (used everywhere), `interview_prompt` = interview-specific overrides (used only in question generation). **Corrected after R1 review.**
- [ ] The `custom_prompt` request parameter already works and is tested — it's appended as "Interviewer Preferences For This Generation". **Guaranteed by code (lines 137-140).**
- [ ] `ALTER TABLE roles ADD COLUMN interview_prompt TEXT` is safe on SQLite with existing data — columns default to NULL. **Guaranteed by SQLite spec.**
- [ ] The AI gateway `aiCall()` is a black box for this change — we only modify what goes into the prompt string, not how it's dispatched. **Guaranteed by architecture.**

## Acceptance Checklist

- [ ] Generate interview questions for an existing candidate — output includes pre-analysis and respects question count limits
- [ ] Date appears in generated context (not just frontmatter)
- [ ] `duration` parameter works via API (30 vs 60 minutes produces different question caps)
- [ ] Role edit UI shows interview_prompt field
- [ ] Saving interview_prompt via UI persists to DB and appears in generated questions
- [ ] `npm test` passes
- [ ] No regressions in existing question generation (test with a candidate that has no role interview_prompt)
