# Agent Workflow

End-to-end guide for submitting and evaluating candidates via API.

## API Quick Start

Read the API token from the local component config and pass it with the
standard Bearer header:

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
HOST="https://host/recruit"
AUTH="Authorization: Bearer $TOKEN"
```

All API examples below assume `auth.enabled` is on. Without a valid token,
protected API routes return:

```json
{ "error": "unauthorized" }
```

with status `401 Unauthorized`.

## Core Response Shapes

### Candidate

Candidate responses are wrapped as `{ "candidate": { ... } }`.

```json
{
  "candidate": {
    "id": 8,
    "company_id": 1,
    "name": "待识别",
    "role_id": 2,
    "email": null,
    "phone": null,
    "source": null,
    "brief": null,
    "extra_info": "推荐理由或补充信息",
    "resume_path": "cand-8-1778040000000-a1b2c3d4e5f6.pdf",
    "state": "pending",
    "created_at": "2026-05-06 08:30:00",
    "updated_at": "2026-05-06 08:31:00",
    "role_name": "Backend Engineer",
    "is_evaluating": false,
    "evaluations": []
  }
}
```

Candidate states are `pending`, `scheduled`, `contacted`, `interviewed`, `passed`, and
`rejected`.

### Evaluation

Evaluation objects appear under `candidate.evaluations`.

```json
{
  "id": 12,
  "candidate_id": 8,
  "kind": "resume_ai",
  "author": "ai",
  "verdict": "yes",
  "content": "Candidate has strong backend experience...",
  "meta": "{\"score\":82}",
  "created_at": "2026-05-06 08:35:00"
}
```

AI resume verdicts use `yes` or `no`. Human interview verdicts commonly use
`pass`, `hold`, or `reject`.

## Full Flow: Submit and Evaluate

### Step 1: Create Candidate

```
POST /api/candidates
Content-Type: application/json
Authorization: Bearer <api_token>
```

Minimum body:

```json
{
  "company_id": 1,
  "role_id": 2,
  "extra_info": "推荐理由或补充信息"
}
```

`company_id` is required. `name` is optional and defaults to `待识别`; AI
resume evaluation can later extract the name from the resume.

```bash
CAND_ID=$(curl -s -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": 1,
    "role_id": 2,
    "extra_info": "推荐理由或补充信息"
  }' \
  "$HOST/api/candidates" | jq '.candidate.id')
```

Response: `201 Created` with `{ "candidate": { ... } }`.

Common errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "company_id required" }` | Missing company ID |
| `400` | `{ "error": "company not found" }` | Company foreign key does not exist |
| `400` | `{ "error": "role not found" }` | Role ID does not exist or was deleted |
| `400` | `{ "error": "role belongs to a different company" }` | Role is not scoped to the candidate company |

### Step 2: Upload Resume

```
POST /api/candidates/:id/resume
Content-Type: multipart/form-data
Authorization: Bearer <api_token>
```

The `file` field accepts PDF or DOCX. DOCX uploads are converted to PDF before
the candidate is updated.

```bash
curl -H "$AUTH" \
  -F file=@/path/to/resume.pdf \
  "$HOST/api/candidates/$CAND_ID/resume"
```

Response: `200 OK` with `{ "candidate": { ... } }`.

Common errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "no file" }` | Missing upload field |
| `400` | `{ "error": "file type not allowed: ... Accepted: PDF, DOCX" }` | Unsupported upload MIME type |
| `404` | `{ "error": "candidate not found" }` | Candidate does not exist or was deleted |
| `500` | `{ "error": "Failed to convert DOCX to PDF" }` | DOCX conversion failed |

### Step 3: Trigger AI Evaluation

```
POST /api/candidates/:id/ai-evaluate
Authorization: Bearer <api_token>
```

```bash
curl -X POST -H "$AUTH" \
  "$HOST/api/candidates/$CAND_ID/ai-evaluate"
```

Response: `202 Accepted`

```json
{
  "message": "AI evaluation started",
  "candidate_id": 8
}
```

Common errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "no resume uploaded — upload a PDF first" }` | Candidate has no resume |
| `404` | `{ "error": "not found" }` | Candidate does not exist or was deleted |
| `409` | `{ "error": "该候选人正在评估中，请稍候" }` | Evaluation is already running |

### Step 4: Poll for Result

```
GET /api/candidates/:id
Authorization: Bearer <api_token>
```

```bash
curl -s -H "$AUTH" "$HOST/api/candidates/$CAND_ID" \
  | jq '{
    evaluating: .candidate.is_evaluating,
    verdict: .candidate.evaluations[0].verdict,
    score: (.candidate.evaluations[0].meta | fromjson | .score)
  }'
```

Response: `200 OK` with `{ "candidate": { ... } }`. While the background job
is running, `candidate.is_evaluating` is `true`.

## Optional: Stream AI Evaluation

```
POST /api/candidates/:id/ai-evaluate/stream
Authorization: Bearer <api_token>
Accept: text/event-stream
```

```bash
curl -N -X POST -H "$AUTH" \
  -H "Accept: text/event-stream" \
  "$HOST/api/candidates/$CAND_ID/ai-evaluate/stream"
```

Response: `200 OK` with `Content-Type: text/event-stream`. Each event is sent
as JSON in an SSE `data:` frame. The same `400`, `404`, and `409` errors as
the async endpoint apply before streaming starts.

## Batch Import

For importing multiple candidates programmatically:

```bash
for pdf in /path/to/resumes/*.pdf; do
  CAND_ID=$(curl -s -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "{\"company_id\":1, \"role_id\":2}" \
    "$HOST/api/candidates" | jq '.candidate.id')

  curl -s -H "$AUTH" -F file=@"$pdf" \
    "$HOST/api/candidates/$CAND_ID/resume"

  curl -s -X POST -H "$AUTH" \
    "$HOST/api/candidates/$CAND_ID/ai-evaluate"

  echo "Submitted: $pdf -> candidate #$CAND_ID"
done
```

## Other Operations

### Move Candidate to Another Stage

```
POST /api/candidates/:id/move
Content-Type: application/json
Authorization: Bearer <api_token>
```

```bash
curl -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"state": "scheduled"}' \
  "$HOST/api/candidates/$CAND_ID/move"
```

Response: `200 OK` with `{ "candidate": { ... } }`.

Errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "state must be one of pending, scheduled, contacted, interviewed, passed, rejected" }` | Invalid state |
| `404` | `{ "error": "not found" }` | Candidate does not exist or was deleted |

### Add Interview Feedback

```
POST /api/candidates/:id/evaluate
Content-Type: application/json
Authorization: Bearer <api_token>
```

```bash
curl -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "author": "Howard",
    "verdict": "pass",
    "content": "技术扎实，沟通能力强，建议进入下一轮。"
  }' \
  "$HOST/api/candidates/$CAND_ID/evaluate"
```

Response: `200 OK` with `{ "candidate": { ... } }`.

Errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "content required" }` | Missing or non-string feedback content |
| `404` | `{ "error": "not found" }` | Candidate does not exist or was deleted |

### List Candidates with Filters

```
GET /api/candidates?company_id=1[&role_id=2][&state=pending]
Authorization: Bearer <api_token>
```

```bash
curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1" \
  | jq '.candidates[] | {id, name, state, last_ai_verdict, last_ai_score}'

curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1&role_id=2"

curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1&state=pending"
```

Response: `200 OK`

```json
{
  "candidates": [
    {
      "id": 8,
      "company_id": 1,
      "name": "待识别",
      "role_id": 2,
      "role_name": "Backend Engineer",
      "state": "pending",
      "last_ai_verdict": "yes",
      "last_ai_score": 82,
      "is_evaluating": false
    }
  ]
}
```

Errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "company_id required" }` | Missing company filter |

### Auto-Match Candidate to Roles

Rank active roles by reading the uploaded resume.

```bash
curl -X POST -H "$AUTH" \
  "$HOST/api/candidates/$CAND_ID/auto-match"
```

Response: `200 OK`

```json
{
  "matches": [
    {
      "role_id": 2,
      "role_name": "Backend Engineer",
      "score": 86,
      "reason": "Strong backend and infrastructure match"
    }
  ]
}
```

Common errors:

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "no resume uploaded" }` | Candidate has no resume |
| `404` | `{ "error": "not found" }` | Candidate does not exist or was deleted |
| `500` | `{ "error": "auto-match failed: ..." }` | AI ranking failed |

### Auto-Assign Best Role

Rank roles and update the candidate to the best match.

```bash
curl -X POST -H "$AUTH" \
  "$HOST/api/candidates/$CAND_ID/auto-match-resume"
```

Response: `200 OK`

The response is the match result returned by the AI auto-match flow. Common
errors are `400 no resume uploaded`, `404 not found`, and `500` with the
underlying error message.
