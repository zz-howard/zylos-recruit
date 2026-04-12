# Evaluations API

Two types of evaluations: AI resume screening and human interview feedback.

## AI Resume Evaluation

```
POST /api/candidates/:id/ai-evaluate
```

Triggers an asynchronous AI evaluation. Returns `202` immediately; the evaluation runs in the background.

**Prerequisites:**
- Candidate must have a resume uploaded
- Candidate must have a role assigned

**Response:** `202` with `{ "message": "AI evaluation started", "candidate_id": N }`

**Errors:**
- `400` — no resume uploaded; no role assigned
- `404` — candidate not found
- `409` — evaluation already in progress for this candidate

### AI Evaluation Process

1. Builds prompt from: company profile + role JD + expected portrait + custom eval instructions + extra_info
2. Spawns CLI process (claude/codex/gemini based on settings)
3. Parses JSON response; if parse fails, attempts repair via lightweight model (haiku/gpt-5.3-codex-spark)
4. Stores evaluation + auto-fills candidate contact info (name, email, phone) from resume
5. Timeout: 10 minutes

### AI Evaluation Result Schema

```json
{
  "verdict": "yes|no",
  "score": 0-100,
  "summary": "一句话总结",
  "brief": "候选人一句话简介",
  "contact": { "name": "...", "email": "...", "phone": "..." },
  "analysis": {
    "tech_match": "技术匹配度分析",
    "experience": "经验水平分析",
    "potential": "成长潜力分析",
    "risks": "风险点"
  },
  "recommendation": "给面试官的建议"
}
```

### Verdict Definitions

| Verdict | Label | Meaning |
|---------|-------|---------|
| `yes` | 建议面试 | Recommended for interview, good match |
| `no` | 不建议 | Not recommended, poor match or clear mismatch |

### Polling for Result

After triggering, poll the candidate detail endpoint:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://host/recruit/api/candidates/$ID | jq '.candidate.is_evaluating, .candidate.evaluations[0]'
```

- `is_evaluating: true` → still running
- `is_evaluating: false` + new evaluation in array → complete

## Human Interview Evaluation

```
POST /api/candidates/:id/evaluate
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | no | Evaluation type. Defaults to `"interview"` |
| `author` | string | no | Evaluator name |
| `verdict` | string | no | One of: `pass`, `hold`, `reject` |
| `content` | string | yes | Evaluation notes (markdown) |

**Response:** `{ "candidate": {...} }` with updated evaluations

**Errors:**
- `400` — content missing
- `404` — candidate not found

### Interview Verdict Labels

| Verdict | Label | Meaning |
|---------|-------|---------|
| `pass` | 通过 | Proceed to next stage |
| `hold` | 保留 | On hold, revisit later |
| `reject` | 淘汰 | Not proceeding |

## Evaluation Kinds

| Kind | Source | Description |
|------|--------|-------------|
| `resume_ai` | AI | Automated resume screening |
| `interview` | Human | Interview feedback |

## Database Schema

```sql
evaluations (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER REFERENCES candidates(id),
  kind          TEXT,     -- 'resume_ai' | 'interview'
  author        TEXT,     -- runtime name or person name
  verdict       TEXT,     -- 'yes'/'no' for AI; 'pass'/'hold'/'reject' for interview
  content       TEXT,     -- formatted markdown
  meta          TEXT,     -- JSON string with runtime, score, analysis details (AI only)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
)
```
