# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
