# Companies API

Base path: `/api/companies`

Manage companies (tenants). Each company has its own roles and candidates with full data isolation.

## List Companies

```
GET /api/companies
```

**Response:**

```json
{
  "companies": [
    { "id": 1, "name": "COCO", "eval_prompt": null, "created_at": "..." }
  ]
}
```

## Create Company

```
POST /api/companies
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Company name (must be unique) |

**Response:** `201` with `{ "company": {...} }`

**Errors:**
- `400` — name missing or empty
- `409` — company name already exists

## Get Company

```
GET /api/companies/:id
```

**Response:** `{ "company": {...} }`

**Errors:** `404` — not found

## Update Company

```
PUT /api/companies/:id
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | New company name |
| `eval_prompt` | string | no | Custom evaluation instructions appended to AI eval prompt |

**Response:** `{ "company": {...} }`

**Errors:**
- `400` — name empty
- `404` — not found
- `409` — name already exists

## Update Company Profile

```
PUT /api/companies/:id/profile
Content-Type: application/json
```

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Company profile markdown (injected into AI eval prompt as context) |

**Response:** `{ "company": {...} }`

**Errors:**
- `400` — content missing or empty
- `404` — not found

## Delete Company

```
DELETE /api/companies/:id
```

**Response:** `204 No Content`
