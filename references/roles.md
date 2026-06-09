# Roles API

Base path: `/api/roles`

All endpoints require `Authorization: Bearer <api_token>` unless the caller already has a valid UI session cookie.

Role object schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Role ID |
| `company_id` | number | Owning company |
| `name` | string | Unique per company |
| `description` | string|null | Job description markdown |
| `expected_portrait` | string|null | Ideal candidate portrait |
| `eval_prompt` | string|null | Role-specific evaluation instructions |
| `interview_prompt` | string|null | Role-specific interview-question generation instructions |
| `active` | 0\|1 | Whether role is active; active filter uses `1`/`0` |
| `created_at` | string | SQLite datetime string |
| `updated_at` | string | SQLite datetime string |
| `candidate_count` | number | Present on list responses |
| `profile` | object|null | Latest role profile, present on detail responses |

## List Roles

```http
GET /api/roles?company_id=N[&active=1|0]
```

Query parameters:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Company filter |
| `active` | `1` or `0` | no | Filter active/inactive roles |

Response `200`:

```json
{
  "roles": [
    {
      "id": 2,
      "company_id": 1,
      "name": "Agent Engineer",
      "description": "JD markdown",
      "expected_portrait": "Ideal profile",
      "eval_prompt": null,
      "interview_prompt": null,
      "active": 1,
      "candidate_count": 3
    }
  ]
}
```

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "company_id required" }` |

## Create Role

```http
POST /api/roles
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Existing company ID |
| `name` | string | yes | Non-empty role name |
| `description` | string | no | Job description markdown |
| `expected_portrait` | string | no | Ideal candidate portrait |
| `interview_prompt` | string | no | Interview-question generation instructions |

Response `201`: `{ "role": { ... } }`

Errors:

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{ "error": "company_id required" }` | Missing company |
| `400` | `{ "error": "name required" }` | Missing name |
| `400` | `{ "error": "company not found" }` | Foreign key failure |
| `409` | `{ "error": "role name already exists in this company" }` | Duplicate name |

## Get Role

```http
GET /api/roles/:id
```

Response `200`: `{ "role": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `404` | `{ "error": "not found" }` |

## Update Role

```http
PUT /api/roles/:id
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | New non-empty role name |
| `description` | string|null | no | Job description markdown |
| `expected_portrait` | string|null | no | Ideal candidate portrait |
| `eval_prompt` | string|null | no | Role-specific evaluation instructions |
| `interview_prompt` | string|null | no | Role-specific interview-question generation instructions |
| `active` | boolean | no | Stored as `1` or `0` |

Response `200`: `{ "role": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "name must be a non-empty string" }` |
| `404` | `{ "error": "not found" }` |
| `409` | `{ "error": "role name already exists in this company" }` |

## Update Role Profile

```http
PUT /api/roles/:id/profile
Content-Type: application/json
```

Request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Non-empty expected portrait markdown |

Response `200`: `{ "role": { ... } }`

Errors:

| Status | Body |
|--------|------|
| `400` | `{ "error": "content required" }` |
| `404` | `{ "error": "not found" }` |

## Delete Role

```http
DELETE /api/roles/:id
```

Soft-deletes the role, soft-deletes role profiles, unlinks active candidates, and unlinks interview-question documents.

Response `200`:

```json
{
  "batch": "uuid",
  "roleProfiles": 1,
  "candidatesUnlinked": 3,
  "interviewQuestionDocumentsUnlinked": 0,
  "role": 1
}
```

Errors:

| Status | Body |
|--------|------|
| `404` | `{ "error": "not found" }` |
