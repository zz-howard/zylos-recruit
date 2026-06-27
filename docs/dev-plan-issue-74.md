# Dev Plan: Persist smart matching results to database with cache-first display (#74)

## Summary
Persist `rankRolesFromResume()` results into a new `role_matches` table so the "智能匹配岗位"
panel can load instantly from cache, with a 🔄 button to re-run the AI on demand. Eliminates the
2-3 minute / token-costly live AI call on every view and survives page refresh.

## Scope

**In scope** (from issue #74 decisions):
1. New `role_matches` table (upsert on `UNIQUE(candidate_id, role_id)`).
2. `GET /candidates/:id/auto-match` — returns cached `{ matches, cached_at }`.
3. `POST /candidates/:id/auto-match` — runs AI, persists, returns results (existing behavior + persistence).
4. Frontend `assets/kanban.js`: cache-first display + 🔄 manual re-run; auto-POST only when no cache.
5. Cascade-clean `role_matches` when a candidate is deleted.

**Explicitly out of scope:**
- Cleaning stale matches when a role is deactivated/deleted — issue accepts they remain. Note: the next run
  only re-ranks **active** roles, so a stale inactive/deleted role's row may NOT be overwritten. Acceptance
  wording: stale rows **may remain until candidate cleanup / future refresh semantics** — overwrite-on-next-run
  is not a guarantee.
- Soft-delete / restore semantics for `role_matches` — it is regenerable cache (hard delete, see Assumptions).
- Any change to `autoMatchFromResume()` (single-best auto-assign) — different feature, untouched.

## Key Design Decision: single persistence point

`rankRolesFromResume(candidateId)` in `src/lib/ai.js` is called from **two** sites:
- `src/routes/api-candidates.js:153` (the POST `/auto-match` endpoint)
- `src/routes/api-intake.js:112` (the intake pipeline)

→ Persist **inside `rankRolesFromResume()`**, right after the `validated` array is built (ai.js ~L443,
before `return validated`). One write covers both callers (and any future one) — the issue's "intake
pipeline should also persist" requirement is satisfied for free, with no duplicated write logic in routes.
The function already holds `candidate` (→ `candidate.id`) and the `validated` matches in scope.

## Development Checklist

- [ ] **DB schema** (`src/lib/db.js`): add `role_matches` to `initSchema()` with `CREATE TABLE IF NOT EXISTS`
      (runs on every `getDb()` → covers fresh installs *and* existing DBs; no separate migration fn needed —
      matches the project's existing pattern). Columns per issue spec:
      `id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, role_name TEXT NOT NULL,
      score INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(candidate_id, role_id)`. Add `CREATE INDEX idx_role_matches_candidate ON role_matches(candidate_id)`.
- [ ] **DB write fn** (`src/lib/db.js`): `upsertRoleMatches(candidateId, matches)` — wrap in a transaction,
      `INSERT ... ON CONFLICT(candidate_id, role_id) DO UPDATE SET role_name=excluded.role_name,
      score=excluded.score, reason=excluded.reason, created_at=datetime('now')`. Per-role upsert (issue §1).
- [ ] **DB read fn** (`src/lib/db.js`): `getRoleMatches(candidateId)` → `{ matches: [...ordered by score DESC],
      cached_at }` where `cached_at` = MAX(created_at) over the candidate's rows (null if none).
- [ ] **Persist in source** (`src/lib/ai.js`): call `upsertRoleMatches(candidateId, validated)` just before
      `return validated` in `rankRolesFromResume()`. **Fail fast** — if `upsertRoleMatches()` throws, let it
      propagate (do NOT swallow + return). Rationale: the new POST semantics are "run AI + persist cache";
      silently eating a DB-write failure makes the user believe the cache is updated when a refresh would lose
      the result. The intake pipeline (`api-intake.js`) must also surface this failure, otherwise the
      cache-prewarm requirement fails silently. (Both callers already propagate errors from
      `rankRolesFromResume()`, so no route changes are needed to honor fail-fast.)
- [ ] **GET endpoint** (`src/routes/api-candidates.js`): add `router.get('/:id/auto-match', ...)` →
      404 if candidate missing; else `res.json(getRoleMatches(id))` → `{ matches, cached_at }`
      (200 + empty array + `cached_at:null` when no cache — see Assumptions for why not 404).
- [ ] **Cascade cleanup** (`src/lib/db.js` `deleteCandidate()`): candidates are **soft-deleted**, so the FK
      `ON DELETE CASCADE` never fires. Add an explicit `DELETE FROM role_matches WHERE candidate_id=?`
      (hard delete) inside the existing `deleteCandidate` transaction.
- [ ] **Frontend** (`assets/kanban.js` ~L651 handler + L474 button):
      - On click "智能匹配岗位": first `GET /candidates/:id/auto-match`. If `matches.length > 0` → render
        instantly (reuse existing render block, factor it into a `renderMatches(matches)` helper).
      - Render a 🔄 refresh icon in the results header (show `cached_at` as "上次匹配: …"). Click → POST
        (re-run AI), disable/spinner during, re-render on return.
      - If GET returns empty → auto-trigger POST (preserve current behavior).
      - Keep the existing 分配 (assign) per-row button wiring.

## Test Checklist

- [ ] **Unit (`test/` via `node --test`)**: new `test/role-matches.test.js`
      - `upsertRoleMatches` inserts new rows; re-run with changed score updates in place (no dup rows);
        `UNIQUE(candidate_id, role_id)` honored.
      - `getRoleMatches` returns rows score-DESC and correct `cached_at`; empty → `{matches:[], cached_at:null}`.
      - `deleteCandidate` removes the candidate's `role_matches` rows.
      - (use a temp DB file via existing test DB setup pattern — check how `test/*.test.js` bootstrap the DB).
- [ ] **Route / API contract** (the key Issue contract is the endpoint behavior, not just DB upsert): prove the
      endpoints, not only the helpers.
      - `GET /candidates/:id/auto-match` with no cache → 200 `{matches:[], cached_at:null}`.
      - `GET /candidates/:id/auto-match` with a missing/unknown candidate → 404.
      - `POST /candidates/:id/auto-match` → after the AI run, a subsequent `GET` returns the persisted matches
        (cache readable end-to-end). Drive the AI through a controllable seam/mock (or expose the persistence
        boundary so it can be invoked directly) so the test asserts the endpoint contract without a live AI call.
- [ ] **Manual / browser (acceptance)**: see Acceptance Checklist.
- [ ] **Regression**: existing POST `/auto-match` still returns `{ matches }` and assign flow works.
- [ ] `npm test` green; full suite (not just new file).

## Assumptions

- [ ] **Candidate delete is soft (`deleted_at`), not a row delete** — verified in `db.js deleteCandidate()`.
      ∴ FK `ON DELETE CASCADE` to candidates will NOT auto-clean; explicit DELETE required. *(Guaranteed by code.)*
- [ ] **`role_matches` is disposable cache, not user data** → hard delete (not soft) is correct; restoring a
      soft-deleted candidate will NOT restore matches (they regenerate on next AI run). *Acceptable per issue §4.*
      Needs Jinglever sign-off that skipping soft-delete here is fine (departs from the table's soft-delete convention).
- [ ] **Upsert keeps stale rows** for roles not in the latest run (e.g. role since deactivated). Issue §4 says
      acceptable. We do NOT delete-all-then-insert. *(Per spec; flag if reviewer wants freshest-set semantics.)*
- [ ] **GET returns 200 + empty array (not 404)** when no cache — simpler frontend branch (empty → auto-POST).
      Issue says "404 or empty"; choosing empty. *(Design choice, low risk.)*
- [ ] **`rankRolesFromResume` return shape is `Array<{role_id, role_name, score, reason}>`** — verified ai.js.
      `score` is already `Number`, fits `INTEGER`. `role_name` always patched from DB (never null).
- [ ] **`initSchema` IF-NOT-EXISTS is the project's migration idiom for additive tables** — verified (it runs
      every `getDb()`); no destructive table rebuild needed, so no `withFkOff` dance.

## Acceptance Checklist

- [ ] **Functional**:
  - [ ] First match on a candidate with no cache → auto-runs AI, results render, row persisted (verify in DB).
  - [ ] Reopen candidate / refresh page → results load **instantly** from GET (no AI call, no 2-3 min wait).
  - [ ] 🔄 refresh → re-runs AI, updates display and DB row (same role → updated in place, no duplicates).
  - [ ] Assign (分配) still works from cached results.
  - [ ] Delete candidate → their `role_matches` rows are gone.
  - [ ] Intake pipeline run (`api-intake.js`) also populates `role_matches` (cache pre-warmed without a UI click).
- [ ] **UI verification**: browser screenshots (cache-first instant load + 🔄 button) sent to Howard.
      Dashboard login per preferences.md; ask Howard if credentials needed.
- [ ] No regressions in existing match / assign / candidate-delete flows.
- [ ] `npm test` passes; lint clean.

## Roles & Flow
- Plan review: **Jinglever**. Implementation: **Jinglever** per this checklist. Code review: **zylos0t + zylos01**.
  Acceptance + browser verification: **zylos01**. Final sign-off: **Howard**.
- No new product decisions for Howard — all settled in issue #74. The only judgment calls (hard-delete cache,
  upsert-keeps-stale, GET-empty-not-404) are implementation nuances captured in Assumptions for Jinglever review.
