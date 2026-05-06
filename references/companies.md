# Companies API

Base path: `/api/companies`

All endpoints require `Authorization: Bearer <api_token>` unless the caller already has a valid UI session cookie.

Company object schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Company ID |
| `name` | string | Unique company name |
| `eval_prompt` | string|null | Company-level evaluation instructions |
| `created_at` | string | SQLite datetime string |
| `updated_at` | string | SQLite datetime string |
| `role_count` | number | Present on list responses |
| `candidate_count` | number | Present on list responses |
| `profile` | object|null | Latest company profile, present on detail responses |

Profile schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Profile version ID |
| `company_id` | number | Company ID |
| `version` | number | Monotonic profile version |
| `content` | string | Markdown profile content |
| `created_at` | string | SQLite datetime string |

## List Companies

```http
GET /api/companies
```

Response `200`:

```json
{
  "companies": [
    {
      "id": 1,
      "name": "COCO",
      "eval_prompt": null,
      "created_at": "2026-05-06 10:00:00",
      "updated_at": "2026-05-06 10:00:00",
      "role_count": 2,
      "candidate_count": 12
    }
  ]
}
```

## Create Company

```http
POST /api/companies
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique non-empty company name |

Response `201`:

```json
{ "company": { "id": 1, "name": "COCO" } }
```

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{ "error": "name required" }` | Missing or empty name |
| `409` | `{ "error": "company name already exists" }` | Duplicate name |

## Get Company

```http
GET /api/companies/:id
```

Response `200`:

```json
{ "company": { "id": 1, "name": "COCO", "profile": null } }
```

Errors:

| Status | Body |
|--------|------|
| `404` | `{ "error": "not found" }` |

## Update Company

```http
PUT /api/companies/:id
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | New unique company name |
| `eval_prompt` | string|null | no | Evaluation instructions appended to AI prompts |

Response `200`: `{ "company": { ... } }`

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{ "error": "name must be a non-empty string" }` | Empty provided name |
| `404` | `{ "error": "not found" }` | Company does not exist |
| `409` | `{ "error": "company name already exists" }` | Duplicate name |

## Update Company Profile

```http
PUT /api/companies/:id/profile
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Non-empty Markdown profile content |

Response `200`: `{ "company": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "content required" }` |
| `404` | `{ "error": "not found" }` |

## Delete Company

```http
DELETE /api/companies/:id
```

Soft-deletes the company and related rows.

Response `200`:

```json
{
  "batch": "uuid",
  "messages": 0,
  "interviews": 0,
  "evaluations": 0,
  "interviewQuestionDocuments": 0,
  "candidates": 0,
  "roleProfiles": 0,
  "roles": 0,
  "companyProfiles": 0,
  "company": 1
}
```
