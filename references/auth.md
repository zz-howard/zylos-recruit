# Authentication

Zylos Recruit supports two authentication methods at the same time:

- Cookie sessions for the web UI.
- Bearer API tokens for programmatic `/api/*` access.

## API Token

The API token is stored in the component config:

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
HOST="https://<your-domain>/recruit"
```

Send it with every API request:

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "$HOST/api/companies"
```

Header schema:

| Header | Required | Value |
|--------|----------|-------|
| `Authorization` | yes | `Bearer <auth.api_token>` |
| `Content-Type` | for JSON bodies | `application/json` |

Token details:

| Property | Value |
|----------|-------|
| Config path | `auth.api_token` in `~/zylos/components/recruit/config.json` |
| Format | `zr_` + 48 hex characters |
| Generation | Auto-generated on first service start when missing |
| Scope | `/api/*` routes only |
| Comparison | `crypto.timingSafeEqual` |
| Storage | Plaintext in `config.json`; protect file-system access |

## API Auth Responses

Unauthenticated API requests return:

```json
{ "error": "unauthorized" }
```

Status codes:

| Status | Meaning |
|--------|---------|
| `401` | Missing or invalid Bearer token on `/api/*` when cookie auth is not present |
| `400` | Request validation failed |
| `404` | Resource not found |
| `409` | Conflict, duplicate, or operation already in progress |
| `500` | Server or AI runtime error |

## Cookie Session

Web UI users log in through `/login` with the configured password.

| Property | Value |
|----------|-------|
| Cookie | `__Host-zylos_recruit_session` |
| Absolute expiry | 24 hours |
| Idle expiry | 60 minutes |
| Password storage | scrypt hash in `config.json` |
| Rate limit | 5 failures per IP per minute, 10 minute lockout |
| Global cap | 30 failures per minute |

The API token bypass does not apply to non-API web UI pages.

## Regenerate API Token

Delete `auth.api_token` from `~/zylos/components/recruit/config.json` and restart the service. A new token is generated automatically.
