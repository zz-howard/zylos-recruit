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
- **Interview evaluations** — per-stage notes with author and verdict
- **Password-protected** — cookie-based session auth (scrypt)

## Usage

```bash
# Install
zylos add recruit

# Access
# Open https://<your-domain>/recruit/
# Password is printed during post-install; also in ~/zylos/components/recruit/config.json
```

## API

- `GET /api/roles`, `POST /api/roles`, `PUT /api/roles/:id/profile`
- `GET /api/candidates`, `POST /api/candidates`, `PUT /api/candidates/:id`
- `POST /api/candidates/:id/move` `{ state }`
- `POST /api/candidates/:id/evaluate` `{ stage, author, verdict, content }`
- `POST /api/candidates/:id/resume` (multipart)
- `GET  /api/candidates/:id/resume` (PDF stream)
