---
name: recruit
version: 0.2.4
description: >
  Recruitment management (ATS) component for zylos. Provides a web Kanban
  board for managing candidates through interview stages, with SQLite-backed
  role library, job profiles, resume storage, and interview evaluations.
  Use when the user mentions recruiting, hiring, candidates, resumes,
  interview scheduling, ATS, 招聘, 候选人, 简历, 面试, or asks to add /
  move / evaluate a candidate.
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-recruit
    entry: src/index.js
  data_dir: ~/zylos/components/recruit
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - recruit.db
    - resumes/

upgrade:
  repo: zz-howard/zylos-recruit
  branch: main

config:
  optional:
    - name: RECRUIT_PORT
      description: HTTP port for the recruit service
      default: "3465"

http_routes:
  - path: /recruit/*
    type: reverse_proxy
    target: localhost:3465
    strip_prefix: /recruit

dependencies: []
---

# Zylos Recruit

Web-based ATS (Applicant Tracking System) for managing candidates through
interview stages. Kanban board UI + REST API + SQLite storage.

## Features

- **Role library** — create roles, attach versioned job profiles
- **Candidate Kanban** — 5 columns: pending / scheduled / interviewed / passed / talent pool
- **Resume storage** — upload PDF, preview in-browser via pdf.js
- **AI resume evaluation** — multi-runtime (Claude/Codex/Gemini), configurable model & effort
- **Interview evaluations** — notes with author and verdict (yes/no for AI, pass/hold/reject for interview)
- **Authentication** — cookie-based session auth (scrypt) + API token for programmatic access

## Usage

```bash
# Install
zylos add recruit

# Access
# Open https://<your-domain>/recruit/
# Password is printed during post-install; also in ~/zylos/components/recruit/config.json
```

## Authentication

Two authentication methods, both active simultaneously:

### Web UI (Cookie)
Login at `/recruit/login` with password → session cookie, 24h expiry.

### API Token (Bearer)
For programmatic/agent access. Auto-generated on first start, stored in config.json.

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
curl -H "Authorization: Bearer $TOKEN" https://host/recruit/api/candidates?company_id=1
```

## API Reference

### Roles

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/roles?company_id=N` | — | List roles |
| POST | `/api/roles` | `{ company_id, name }` | Create role |
| PUT | `/api/roles/:id` | `{ name?, description?, ... }` | Update role |
| DELETE | `/api/roles/:id` | — | Delete role |
| PUT | `/api/roles/:id/profile` | `{ content }` | Update role JD profile |

### Candidates

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/candidates?company_id=N` | — | List all candidates |
| POST | `/api/candidates` | `{ company_id, role_id, name?, extra_info? }` | Create candidate |
| GET | `/api/candidates/:id` | — | Get candidate detail (with evaluations) |
| PUT | `/api/candidates/:id` | `{ name?, email?, ... }` | Update candidate |
| DELETE | `/api/candidates/:id` | — | Delete candidate |
| POST | `/api/candidates/:id/move` | `{ state }` | Move to column (pending/scheduled/interviewed/passed/rejected) |

### Resumes

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/candidates/:id/resume` | multipart `file` (PDF) | Upload resume |
| GET | `/api/candidates/:id/resume` | — | Download resume PDF |

### Evaluations

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/candidates/:id/ai-evaluate` | — | Trigger AI resume evaluation (async, returns 202) |
| POST | `/api/candidates/:id/evaluate` | `{ kind?, author, verdict, content }` | Add human interview evaluation |

### Settings

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/settings` | — | Get AI settings |
| PUT | `/api/settings` | `{ ai: { runtime, model, effort } }` | Update AI settings |

## Agent Workflow: Submit & Evaluate a Candidate

For programmatic access (AI agents, scripts, etc.), the full flow requires 3 sequential API calls:

```bash
TOKEN="zr_..."
HOST="https://host/recruit"

# Step 1: Create candidate (name can be omitted — AI will extract from resume)
CAND_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"company_id":1, "role_id":2, "extra_info":"推荐理由..."}' \
  $HOST/api/candidates | jq '.candidate.id')

# Step 2: Upload resume PDF
curl -H "Authorization: Bearer $TOKEN" \
  -F file=@/path/to/resume.pdf \
  $HOST/api/candidates/$CAND_ID/resume

# Step 3: Trigger AI evaluation (async — returns 202 immediately)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  $HOST/api/candidates/$CAND_ID/ai-evaluate

# (Optional) Poll for result
curl -s -H "Authorization: Bearer $TOKEN" \
  $HOST/api/candidates/$CAND_ID | jq '.candidate.evaluations[0]'
```

The web UI does the same 3 steps automatically when a user submits the "New Candidate" form.
