<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-recruit</h1>

<p align="center">
  AI-powered recruitment management for zylos.<br>
  Upload a resume, get an AI evaluation in seconds.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/Built%20by-Zylos-orange" alt="Built by Zylos"></a>
</p>

---

## What It Does

zylos-recruit is a lightweight ATS (Applicant Tracking System) that lets you manage candidates through the hiring pipeline — from resume submission to interview decision — with AI doing the heavy lifting on resume screening.

**The core idea:** You define a role (with a job description and ideal candidate portrait), upload a resume, and the system automatically evaluates how well the candidate matches — giving you a verdict (recommend / not recommend), a score, and a structured analysis covering technical fit, experience, potential, and risks.

### Key Capabilities

- **AI Resume Evaluation** — Multi-runtime support (Claude, Codex, Gemini). The AI reads the PDF directly, cross-references it against the role's JD and expected portrait, and returns a structured assessment
- **Kanban Board** — Visual pipeline with 5 columns: Pending → Scheduled → Interviewed → Passed → Talent Pool
- **Role Library** — Create roles with markdown job descriptions and expected candidate portraits that guide AI evaluation
- **Multi-Company** — Manage hiring for multiple companies from one instance, with full data isolation
- **API-First** — Every operation available via REST API with Bearer token auth, making it easy to integrate with agents or scripts

## How It Works

### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│   Web UI     │────▶│  Express Server  │────▶│   SQLite DB   │
│  (Kanban)    │     │   REST API       │     │  (single file)│
└──────────────┘     └────────┬─────────┘     └───────────────┘
                              │
┌──────────────┐     ┌────────▼─────────┐
│  Agent / CI  │────▶│   AI Evaluator   │
│  (API Token) │     │  Claude / Codex  │
└──────────────┘     │  / Gemini CLI    │
                     └──────────────────┘
```

- **Web UI** — Kanban board with drag-free column navigation, PDF preview, and inline evaluation display
- **Express Server** — REST API on a single port, served behind Caddy reverse proxy
- **SQLite** — Zero-config, single-file database. No external DB required
- **AI Evaluator** — Shells out to CLI tools (claude, codex, or gemini) to evaluate resumes. The CLI reads the PDF natively, so no text extraction or OCR is needed

### AI Evaluation Flow

```
                    ┌─────────────────────────────┐
                    │     Build Evaluation Prompt  │
                    │                             │
                    │  Company Profile            │
                    │  + Role JD                  │
                    │  + Expected Portrait        │
                    │  + Custom Instructions      │
                    │  + Candidate Extra Info      │
                    │  + Resume PDF Path          │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │    Spawn CLI Process         │
                    │                             │
                    │  claude -p <prompt> ...      │
                    │  codex exec ...              │
                    │  gemini -p <prompt> ...      │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │    Parse JSON Response       │
                    │                             │
                    │  ✓ Success → store result    │
                    │  ✗ Fail → repair with        │
                    │    lightweight model          │
                    │    (haiku / gpt-5.3-spark)   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │    Store & Auto-Fill         │
                    │                             │
                    │  • Save evaluation to DB     │
                    │  • Extract name/email/phone  │
                    │    from resume               │
                    │  • Update Kanban card        │
                    └─────────────────────────────┘
```

The AI returns a structured verdict:

| Field | Description |
|-------|-------------|
| **verdict** | `yes` (recommend interview) or `no` (not recommended) |
| **score** | 0–100 overall match score |
| **summary** | One-line assessment |
| **analysis** | Technical fit, experience, growth potential, risk factors |
| **recommendation** | What to focus on in interview, or why not to proceed |
| **contact** | Auto-extracted name, email, phone from resume |

### Candidate Lifecycle

```
  Upload Resume          AI Evaluation           Human Decision
 ─────────────  ──▶  ─────────────────  ──▶  ─────────────────
                     
 ┌─────────┐        ┌─────────────┐         ┌──────────────┐
 │ Pending │───────▶│  Scheduled  │────────▶│ Interviewed  │
 └─────────┘        └─────────────┘         └──────┬───────┘
                                                   │
                                          ┌────────┴────────┐
                                          ▼                 ▼
                                    ┌──────────┐     ┌───────────┐
                                    │  Passed  │     │Talent Pool│
                                    └──────────┘     └───────────┘
```

1. **Pending** — Resume uploaded, AI evaluation runs automatically
2. **Scheduled** — Interview scheduled with the candidate
3. **Interviewed** — Interview completed, human feedback recorded
4. **Passed** — Moving forward in the hiring process
5. **Talent Pool** — Not proceeding now, but saved for future consideration

## Quick Start

### Install via Zylos

```bash
zylos add recruit
```

### Manual Install

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zz-howard/zylos-recruit.git recruit
cd recruit && npm install
node hooks/post-install.js
pm2 start ecosystem.config.cjs
```

After install, a password is generated and printed once. Save it — it's stored hashed and cannot be recovered.

### Access

Open `https://<your-domain>/recruit/` and log in with your password.

### For Agents / Scripts

An API token is auto-generated on first start:

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)

# Create candidate → upload resume → trigger AI eval (3 steps)
CAND_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"company_id":1, "role_id":2}' \
  http://localhost:3465/api/candidates | jq '.candidate.id')

curl -H "Authorization: Bearer $TOKEN" \
  -F file=@resume.pdf \
  http://localhost:3465/api/candidates/$CAND_ID/resume

curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3465/api/candidates/$CAND_ID/ai-evaluate
```

See [references/agent-workflow.md](references/agent-workflow.md) for the full guide.

## Configuration

`~/zylos/components/recruit/config.json`:

```json
{
  "enabled": true,
  "port": 3465,
  "auth": { "enabled": true, "password": "scrypt:...", "api_token": "zr_..." },
  "ai": { "runtime": "auto", "model": "auto", "effort": "high" }
}
```

| Setting | Description |
|---------|-------------|
| `auth.password` | Scrypt-hashed web login password |
| `auth.api_token` | Bearer token for API access (auto-generated) |
| `ai.runtime` | `auto` / `claude` / `codex` / `chatgpt` / `gemini` |
| `ai.model` | `auto` or specific model per runtime |
| `ai.effort` | Reasoning effort (`low` / `medium` / `high` / `max`) |

## API Reference

Full documentation in [`references/`](references/):

| Doc | Description |
|-----|-------------|
| [auth](references/auth.md) | Authentication methods |
| [companies](references/companies.md) | Company management |
| [roles](references/roles.md) | Roles and job profiles |
| [candidates](references/candidates.md) | Candidate CRUD and pipeline |
| [resumes](references/resumes.md) | Resume upload/download |
| [evaluations](references/evaluations.md) | AI and human evaluations |
| [settings](references/settings.md) | AI runtime configuration |
| [agent-workflow](references/agent-workflow.md) | Programmatic integration guide |

## Built by Zylos

Part of the [Zylos](https://zylos.ai) ecosystem — autonomous AI agents with persistent memory.

## License

[MIT](./LICENSE)
