<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-recruit</h1>

<p align="center">
  Recruitment management (ATS) component for zylos.<br>
  Kanban board · role library · resume storage · interview evaluations.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Role library** — create roles with versioned markdown job profiles
- **Candidate Kanban** — 5-column board (pending · scheduled · interviewed · passed · talent pool)
- **Resume storage** — upload PDF, preview inline via `pdf.js`
- **Interview evaluations** — per-stage notes, verdict, author
- **Password-protected** — cookie-based session auth (scrypt + brute-force lockout)
- **SQLite single-file** — zero external DB, fully self-contained

## Install

```bash
zylos add recruit
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zz-howard/zylos-recruit.git recruit
cd recruit && npm install
node hooks/post-install.js
pm2 start ecosystem.config.cjs
```

After install, the generated password is printed once and also saved
(hashed) in `~/zylos/components/recruit/config.json`. Open the plaintext
printed in the console and save it somewhere safe — it cannot be recovered.

## Configuration

`~/zylos/components/recruit/config.json`:

```json
{
  "enabled": true,
  "port": 3465,
  "auth": {
    "enabled": true,
    "password": "scrypt:..."
  }
}
```

Override port via `RECRUIT_PORT` env var.

## Access

Visit `https://<your-domain>/recruit/` (Caddy reverse_proxy auto-wired
via `http_routes` in SKILL.md).

## API

| Method | Path | Body |
|---|---|---|
| `GET`  | `/api/roles` | — |
| `POST` | `/api/roles` | `{ name, description? }` |
| `GET`  | `/api/roles/:id` | — |
| `PUT`  | `/api/roles/:id/profile` | `{ content }` |
| `GET`  | `/api/candidates` | `?role_id=&state=` |
| `POST` | `/api/candidates` | `{ name, role_id, email?, phone?, source?, brief? }` |
| `GET`  | `/api/candidates/:id` | — |
| `PUT`  | `/api/candidates/:id` | `{ ...fields }` |
| `POST` | `/api/candidates/:id/move` | `{ state }` |
| `POST` | `/api/candidates/:id/evaluate` | `{ stage, author, verdict, content }` |
| `POST` | `/api/candidates/:id/resume` | multipart `file` |
| `GET`  | `/api/candidates/:id/resume` | — |

## State Machine

```
pending → scheduled → interviewed → passed
                                  ↘ rejected (talent pool)
```

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
