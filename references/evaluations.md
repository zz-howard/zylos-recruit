# Evaluations API

Evaluation routes are mounted under `/api/candidates/:id`.

All endpoints require `Authorization: Bearer <api_token>` unless the caller already has a valid UI session cookie.

Evaluation object schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Evaluation ID |
| `candidate_id` | number | Candidate ID |
| `kind` | string|null | `resume_ai` or `interview` |
| `author` | string|null | Runtime name or human evaluator |
| `verdict` | string|null | AI: `yes`/`no`; interview: `pass`/`hold`/`reject` |
| `content` | string|null | Markdown evaluation content |
| `meta` | string|null | JSON string with runtime/score/analysis metadata for AI evals |
| `created_at` | string | SQLite datetime string |

## Start AI Resume Evaluation

```http
POST /api/candidates/:id/ai-evaluate
```

Starts asynchronous resume evaluation and returns immediately.

Prerequisites:

- Candidate exists.
- Candidate has a resume uploaded.
- Candidate has an assigned role with enough context for evaluation.
- No evaluation is already in progress for the candidate.

Response `202`:

```json
{ "message": "AI evaluation started", "candidate_id": 8 }
```

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "no resume uploaded — upload a PDF first" }` |
| `404` | `{ "error": "not found" }` |
| `409` | `{ "error": "该候选人正在评估中，请稍候" }` |

Poll `GET /api/candidates/:id` and inspect `candidate.is_evaluating` and `candidate.evaluations`.

## Stream AI Resume Evaluation

```http
POST /api/candidates/:id/ai-evaluate/stream
Accept: text/event-stream
```

Runs evaluation and streams Server-Sent Events. Each event is sent as:

```text
data: {"type":"...","...":"..."}
```

Response status:

| Status | Content-Type | Description |
|--------|--------------|-------------|
| `200` | `text/event-stream` | Stream started |
| `400` | JSON error | Missing resume |
| `404` | JSON error | Candidate not found |
| `409` | JSON error | Evaluation already running |

## Add Human Interview Evaluation

```http
POST /api/candidates/:id/evaluate
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | no | Defaults to `interview` |
| `author` | string | no | Evaluator name |
| `verdict` | string | no | Usually `pass`, `hold`, or `reject` |
| `content` | string | yes | Markdown notes |

Response `200`: `{ "candidate": { ... } }` with updated evaluations.

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "content required" }` |
| `404` | `{ "error": "not found" }` |

## AI Result Schema

AI evaluation content is generated from a structured result with this intended schema:

```json
{
  "verdict": "yes",
  "score": 92,
  "summary": "一句话总结",
  "brief": "候选人一句话简介",
  "contact": { "name": "张三", "email": "z@example.com", "phone": "13800138000" },
  "analysis": {
    "tech_match": "技术匹配度分析",
    "experience": "经验水平分析",
    "potential": "成长潜力分析",
    "risks": "风险点"
  },
  "recommendation": "给面试官的建议"
}
```

The stored `evaluations.meta` field is a JSON string and may include runtime, model, effort, score, and parsed analysis fields.

## Verdicts

## Delete Evaluation

```http
DELETE /api/candidates/:id/evaluations/:evalId
```

Soft-deletes an evaluation that belongs to a candidate. The evaluation remains
in the database with `deleted_at` set and is excluded from candidate detail,
candidate list summary fields, and future candidate-level soft-delete batches.
There is no standalone restore endpoint for an individually deleted evaluation.

Response `200`:

```json
{
  "evaluation": {
    "id": 12,
    "candidate_id": 8,
    "kind": "interview",
    "author": "Howard",
    "verdict": "pass",
    "content": "技术扎实，建议进入下一轮。",
    "meta": null,
    "created_at": "2026-05-06 08:35:00",
    "deleted_at": "2026-05-06 09:10:00",
    "delete_batch": "1f8a4e4b-0d24-4eb6-8614-06efb66c43de"
  }
}
```

Errors:

| Status | Body |
|--------|------|
| `404` | `{ "error": "candidate not found" }` |
| `404` | `{ "error": "evaluation not found" }` |

## Verdicts

| Kind | Verdict | Meaning |
|------|---------|---------|
| `resume_ai` | `yes` | Recommended for interview |
| `resume_ai` | `no` | Not recommended |
| `interview` | `pass` | Proceed |
| `interview` | `hold` | Keep warm / revisit |
| `interview` | `reject` | Do not proceed |
