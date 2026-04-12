# Roles API

Base path: `/api/roles`

Manage job roles within a company. Each role can have a JD profile and an expected candidate portrait used by AI evaluation.

## List Roles

```
GET /api/roles?company_id=N
```

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Filter by company |

**Response:**

```json
{
  "roles": [
    {
      "id": 1,
      "company_id": 1,
      "name": "Agent 工程师",
      "description": "JD markdown...",
      "expected_portrait": "理想候选人画像...",
      "eval_prompt": null,
      "created_at": "..."
    }
  ]
}
```

## Create Role

```
POST /api/roles
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `company_id` | number | yes | Company ID |
| `name` | string | yes | Role name (unique per company) |
| `description` | string | no | Job description markdown |
| `expected_portrait` | string | no | Ideal candidate portrait for AI eval |

**Response:** `201` with `{ "role": {...} }`

**Errors:**
- `400` — company_id or name missing; company not found
- `409` — role name already exists in this company

## Get Role

```
GET /api/roles/:id
```

**Response:** `{ "role": {...} }`

**Errors:** `404` — not found

## Update Role

```
PUT /api/roles/:id
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | New role name |
| `description` | string | no | Updated JD |
| `expected_portrait` | string | no | Updated candidate portrait |
| `eval_prompt` | string | no | Custom evaluation instructions for this role |

**Response:** `{ "role": {...} }`

**Errors:**
- `400` — name empty
- `404` — not found
- `409` — name already exists

## Update Role Profile (JD)

```
PUT /api/roles/:id/profile
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Role JD profile markdown |

**Response:** `{ "role": {...} }`

**Errors:**
- `400` — content missing or empty
- `404` — not found

## Delete Role

```
DELETE /api/roles/:id
```

**Response:** `204 No Content`

**Errors:** `404` — not found
