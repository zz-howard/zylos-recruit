# zylos-recruit Design Document

**Version**: v0.1.0
**Date**: 2026-04-11
**Author**: Zylos Team
**Repository**: https://github.com/zz-howard/zylos-recruit
**Status**: v0.1.0

---

## 1. Overview

`zylos-recruit` is a self-hosted Applicant Tracking System (ATS) delivered
as a zylos `capability` component. It provides a web Kanban board and REST
API for managing candidates through interview stages, backed by a single
SQLite database and filesystem-stored resumes.

Goals:
- Keep Howard's recruiting pipeline (roles, candidates, interviews, resumes)
  in one structured place instead of scattered across chat / email.
- Allow Zylos to read/write the same data via REST API, so chat-driven
  updates and UI-driven updates stay in sync.
- Zero external dependencies — no SaaS, no external DB. Everything in
  `~/zylos/components/recruit/`.

## 2. Architecture

### 2.1 Component Structure

```
zylos-recruit/
  src/
    index.js               — Entry point (Express + lifecycle)
    lib/
      config.js            — Config loader + DATA_DIR paths
      db.js                — better-sqlite3 layer + migrations + DAO
    security/
      auth.js              — Cookie session auth (scrypt + brute-force)
    routes/
      ui.js                — Kanban HTML
      api-roles.js         — /api/roles CRUD
      api-candidates.js    — /api/candidates CRUD + move + evaluate
      api-resumes.js       — multipart upload + PDF stream
    templates/
      login.js             — Login page HTML
      kanban.js             — Kanban board shell
  assets/
    style.css              — Shared theme
    kanban.css             — Board + modal styles
    kanban.js              — Frontend logic (vanilla JS)
  hooks/
    post-install.js        — Generate password + create dirs + seed config
    pre-upgrade.js         — Backup config.json
    post-upgrade.js        — Config migration
  SKILL.md                 — Zylos component manifest
  ecosystem.config.cjs     — PM2 service definition
```

### 2.2 Data Model

```
roles
  id, name(unique), description, created_at, updated_at
role_profiles
  id, role_id → roles, version, content(markdown), created_at
candidates
  id, name, role_id → roles, email, phone, source, brief,
  resume_path, state, screen_verdict, created_at, updated_at
interview_stages
  id, candidate_id → candidates, stage_num, scheduled_at, completed_at, notes
evaluations
  id, candidate_id → candidates, stage_id → interview_stages,
  author, verdict, content, created_at
```

### 2.3 State Machine

```
pending (待处理) ──▶ scheduled (已预约) ──▶ interviewed (已完成) ──▶ passed (可推进)
                                                          └───▶ rejected (人才库)
```

Transitions are not enforced — any state can move to any other state (bugs
happen; the UI needs to support correction).

## 3. Configuration

### 3.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RECRUIT_PORT` | No | HTTP port (default 3465) |

### 3.2 Config File

`~/zylos/components/recruit/config.json`:

```json
{
  "enabled": true,
  "port": 3465,
  "auth": {
    "enabled": true,
    "password": "scrypt:<hex-salt>:<hex-hash>"
  },
  "upload": {
    "maxFileSizeBytes": 10485760,
    "allowedMimeTypes": ["application/pdf"]
  }
}
```

## 4. Integration with Zylos

### 4.1 Lifecycle

- **Start**: PM2 via `ecosystem.config.cjs` → `node src/index.js`
- **Stop**: Graceful shutdown on SIGTERM / SIGINT, server closes all conns
- **Reload config**: `fs.watch` on `config.json` triggers in-place reload

### 4.2 HTTP Routing

`http_routes` in SKILL.md is picked up by `zylos-core` during install to
inject a `reverse_proxy` block into the Caddyfile:

```
handle /recruit/* {
  uri strip_prefix /recruit
  reverse_proxy localhost:3465
}
```

### 4.3 Zylos ↔ Recruit Integration

Zylos (the bot) interacts via the REST API. Typical flows:

- Howard says *"add candidate Li Yongcong to LLM algo role"* → Zylos does
  `POST /api/candidates` with `role_id` resolved from `GET /api/roles`.
- Howard says *"move Wang Jinglin to passed"* → Zylos does
  `POST /api/candidates/:id/move { state: "passed" }`.
- Howard says *"log my evaluation for Chen Yanyu"* → Zylos does
  `POST /api/candidates/:id/evaluate`.

## 5. Security

- **Auth**: cookie-based session (`__Host-zylos_recruit_session`), scrypt
  password hashing, brute-force lockout (5 failures / 60s / 10min lockout),
  global rate limit (30/min).
- **CSP**: `script-src 'self'` — all JS lives in `assets/*.js`, no inline
  `<script>` blocks.
- **CSRF**: `/logout` enforces same-host Origin/Referer.
- **Upload**: `multer` with `fileFilter` (PDF only), 10 MB size cap,
  filenames generated server-side (never trust client filenames).
- **Path safety**: resume download resolves absolute path and verifies
  it stays within `RESUMES_DIR` before streaming.
- **Data**: candidate data contains PII. The component is intended to run
  behind auth on Howard's own Caddy instance. Config file is written with
  mode 0600.

## 6. Error Handling

- API errors return `{ error: string }` JSON with 4xx/5xx status.
- Global Express error handler logs + returns generic 500.
- DB errors are allowed to propagate (better-sqlite3 throws sync).

## 7. Future Improvements

- AI-assisted resume screening against role profile (LLM call from Zylos,
  stored as `screen_verdict`).
- Calendar integration: schedule interview → create `interview_stages` row.
- Candidate history timeline (aggregate all events per candidate).
- Drag-and-drop between Kanban columns (currently click-based).
- Bulk import from CSV / JSON for migrating existing pipelines.
- Versioned role profiles: UI for comparing profile revisions.
- Multi-user support with per-user evaluation attribution.
