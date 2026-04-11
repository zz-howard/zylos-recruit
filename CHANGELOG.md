# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
