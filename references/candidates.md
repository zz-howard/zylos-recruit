# Candidates API

Base path: `/api/candidates`

Manage candidates through the recruitment pipeline.

## List Candidates

```
GET /api/candidates?company_id=N[&role_id=N][&state=STATE]
```

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Filter by company |
| `role_id` | number | no | Filter by role |
| `state` | string | no | Filter by pipeline state |

**Response:**

```json
{
  "candidates": [
    {
      "id": 1,
      "company_id": 1,
      "name": "张三",
      "role_id": 2,
      "role_name": "Agent 工程师",
      "email": "z@example.com",
      "phone": "13800138000",
      "source": "telegram",
      "brief": "全栈工程师/本科 @ 某公司",
      "extra_info": "推荐理由...",
      "resume_path": "cand-1-xxx.pdf",
      "state": "pending",
      "last_ai_verdict": "yes",
      "last_ai_score": 92,
      "last_interview_verdict": "pass",
      "is_evaluating": false,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

The list response includes `last_ai_verdict`, `last_ai_score`, and `last_interview_verdict` for displaying on Kanban cards without needing to fetch full evaluations.

## Create Candidate

```
POST /api/candidates
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Company ID |
| `role_id` | number | no | Role ID (required for AI evaluation) |
| `name` | string | no | Candidate name. Defaults to "待识别" — AI auto-extracts from resume |
| `email` | string | no | Email address |
| `phone` | string | no | Phone number |
| `source` | string | no | Source channel (e.g. "telegram", "web", "referral") |
| `brief` | string | no | One-line summary |
| `extra_info` | string | no | Supplementary info injected into AI eval prompt |

**Response:** `201` with `{ "candidate": {...} }`

**Errors:**
- `400` — company_id missing; role not found; role belongs to different company

## Get Candidate (Detail)

```
GET /api/candidates/:id
```

Returns full candidate data including all evaluations.

**Response:**

```json
{
  "candidate": {
    "id": 1,
    "name": "张三",
    "evaluations": [
      {
        "id": 30,
        "candidate_id": 1,
        "kind": "resume_ai",
        "author": "gemini",
        "verdict": "yes",
        "content": "评估内容 markdown...",
        "meta": "{\"runtime\":\"gemini\",\"score\":92,...}",
        "created_at": "..."
      }
    ],
    "is_evaluating": false
  }
}
```

**Errors:** `404` — not found

## Update Candidate

```
PUT /api/candidates/:id
Content-Type: application/json
```

**Body:** Any candidate fields (`name`, `email`, `phone`, `source`, `brief`, `extra_info`, `role_id`).

**Response:** `{ "candidate": {...} }`

**Errors:**
- `400` — role belongs to different company
- `404` — not found

## Delete Candidate

```
DELETE /api/candidates/:id
```

**Response:** `204 No Content`

## Move Candidate

```
POST /api/candidates/:id/move
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | yes | Target state |

**Valid states:** `pending`, `scheduled`, `interviewed`, `passed`, `rejected`

**Response:** `{ "candidate": {...} }`

**Errors:**
- `400` — invalid state
- `404` — not found

## Pipeline States

| State | Label | Description |
|-------|-------|-------------|
| `pending` | 待处理 | New candidate, awaiting screening |
| `scheduled` | 已预约 | Interview scheduled |
| `interviewed` | 已面试 | Interview completed |
| `passed` | 推进中 | Moving forward in process |
| `rejected` | 人才库 | Not proceeding (talent pool) |
