# Candidates API

Base path: `/api/candidates`

All endpoints require `Authorization: Bearer <api_token>` unless the caller already has a valid UI session cookie.

Valid pipeline states: `pending`, `scheduled`, `contacted`, `interviewed`, `passed`, `rejected`.

Candidate object schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Candidate ID |
| `company_id` | number | Owning company |
| `name` | string | Candidate name; defaults to `待识别` |
| `role_id` | number|null | Assigned role |
| `role_name` | string|null | Joined role name |
| `email` | string|null | Email |
| `phone` | string|null | Phone |
| `source` | string|null | Source channel |
| `brief` | string|null | One-line summary |
| `extra_info` | string|null | Supplemental AI-evaluation context |
| `resume_path` | string|null | Stored resume filename |
| `state` | string | Pipeline state |
| `created_at` | string | SQLite datetime string |
| `updated_at` | string | SQLite datetime string |
| `is_evaluating` | boolean | Present on list/detail responses |
| `evaluations` | array | Present on detail responses |
| `last_ai_verdict` | string|null | Present on list when AI eval exists |
| `last_ai_score` | number|null | Present on list when AI score exists |
| `last_interview_verdict` | string|null | Present on list when interview eval exists |

## List Candidates

```http
GET /api/candidates?company_id=N[&role_id=N][&state=STATE]
```

Query parameters:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Company filter |
| `role_id` | number | no | Role filter |
| `state` | string | no | Pipeline state filter |

Response `200`:

```json
{
  "candidates": [
    {
      "id": 1,
      "company_id": 1,
      "name": "张三",
      "role_id": 2,
      "role_name": "Agent Engineer",
      "email": "z@example.com",
      "phone": "13800138000",
      "source": "telegram",
      "brief": "Backend engineer",
      "extra_info": "推荐理由",
      "resume_path": "cand-1-1710000000000-abcd.pdf",
      "state": "pending",
      "last_ai_verdict": "yes",
      "last_ai_score": 92,
      "last_interview_verdict": "pass",
      "is_evaluating": false
    }
  ]
}
```

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "company_id required" }` |

## Create Candidate

```http
POST /api/candidates
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Existing company ID |
| `role_id` | number | no | Existing role in the same company |
| `name` | string | no | Defaults to `待识别` |
| `email` | string | no | Email |
| `phone` | string | no | Phone |
| `source` | string | no | Source channel |
| `brief` | string | no | One-line summary |
| `extra_info` | string | no | Supplemental context for AI evaluation |

Response `201`: `{ "candidate": { ... } }`

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{ "error": "company_id required" }` | Missing company |
| `400` | `{ "error": "company not found" }` | Foreign key failure |
| `400` | `{ "error": "role not found" }` | Invalid role |
| `400` | `{ "error": "role belongs to a different company" }` | Cross-company role |

## Get Candidate

```http
GET /api/candidates/:id
```

Response `200`:

```json
{
  "candidate": {
    "id": 1,
    "name": "张三",
    "is_evaluating": false,
    "evaluations": [
      {
        "id": 30,
        "candidate_id": 1,
        "kind": "resume_ai",
        "author": "codex",
        "verdict": "yes",
        "content": "评估内容 markdown",
        "meta": "{\"runtime\":\"codex\",\"score\":92}",
        "created_at": "2026-05-06 10:00:00"
      }
    ]
  }
}
```

Errors:

| Status | Body |
|--------|------|
| `404` | `{ "error": "not found" }` |

## Update Candidate

```http
PUT /api/candidates/:id
Content-Type: application/json
```

Request body accepts any of:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Candidate name |
| `role_id` | number|null | Assigned role; if non-null, must belong to the same company |
| `email` | string|null | Email |
| `phone` | string|null | Phone |
| `source` | string|null | Source |
| `brief` | string|null | Summary |
| `extra_info` | string|null | Supplemental AI context |
| `resume_path` | string|null | Internal resume filename; normally set by the resume upload API |

Response `200`: `{ "candidate": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "role not found" }` |
| `400` | `{ "error": "role belongs to a different company" }` |
| `404` | `{ "error": "not found" }` |

## Delete Candidate

```http
DELETE /api/candidates/:id
```

Soft-deletes the candidate and related evaluations/interview-question documents.

Response `200`:

```json
{
  "batch": "uuid",
  "evaluations": 1,
  "interviewQuestionDocuments": 0,
  "candidate": 1
}
```

## Restore Candidate

```http
POST /api/candidates/:id/restore
```

Response `200`:

```json
{ "candidate": 1, "role_cleared": false, "evaluations": 1, "interviewQuestionDocuments": 0 }
```

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `404` | `{ "error": "candidate not found or not deleted" }` | Candidate is missing or active |
| `409` | `{ "error": "parent company is deleted — restore it first" }` | Parent dependency is still deleted |

## Move Candidate

```http
POST /api/candidates/:id/move
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | yes | One of `pending`, `scheduled`, `contacted`, `interviewed`, `passed`, `rejected` |

Response `200`: `{ "candidate": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "state must be one of pending, scheduled, contacted, interviewed, passed, rejected" }` |
| `404` | `{ "error": "not found" }` |

## Auto-Match Candidate to Roles

```http
POST /api/candidates/:id/auto-match
```

Ranks all active roles in the candidate company from resume content.

Response `200`:

```json
{
  "matches": [
    { "role_id": 2, "role_name": "Agent Engineer", "score": 88, "reason": "..." }
  ]
}
```

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "no resume uploaded" }` |
| `404` | `{ "error": "not found" }` |
| `500` | `{ "error": "auto-match failed: ..." }` |

## Auto-Match Resume to Best Role

```http
POST /api/candidates/:id/auto-match-resume
```

Returns the best match result from resume content.

Response `200`: runtime-generated match JSON.

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "no resume uploaded" }` |
| `404` | `{ "error": "not found" }` |
| `500` | `{ "error": "..." }` |

## Pipeline States

| State | Label | Description |
|-------|-------|-------------|
| `pending` | 待处理 | New candidate |
| `scheduled` | 拟联络 | Planned to contact |
| `contacted` | 已联络 | Contacted |
| `interviewed` | 已约面 | Interview scheduled |
| `passed` | 已推进 | Moving forward |
| `rejected` | 人才库 | Not proceeding; retained for future |
