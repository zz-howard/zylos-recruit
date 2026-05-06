# Settings API

Base path: `/api/settings`

Configure AI runtime, model, effort, streaming, and per-scenario overrides.
API clients must authenticate with a Bearer token:

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
HOST="https://host/recruit"
AUTH="Authorization: Bearer $TOKEN"
```

## AI Settings Schema

The active config is stored under `ai` in
`~/zylos/components/recruit/config.json`.

```json
{
  "ai": {
    "default": {
      "runtime": "auto",
      "model": "auto",
      "effort": "medium"
    },
    "resume_eval": {
      "runtime": "claude",
      "model": "sonnet",
      "effort": "high"
    },
    "auto_match": {
      "runtime": "codex",
      "model": "gpt-5.4",
      "effort": "medium"
    },
    "streaming": false
  }
}
```

Supported scenario keys:

| Scenario | Used for |
|----------|----------|
| `resume_eval` | AI resume evaluation |
| `auto_match` | Candidate-to-role ranking |
| `chat` | AI chat |
| `chat_summary` | Chat summary generation |
| `portrait` | Role portrait generation |
| `interview_questions` | Interview question document generation |

Scenario settings override `ai.default` only for fields they provide.

## Get Settings

```
GET /api/settings
Authorization: Bearer <api_token>
```

### Response

`200 OK`

```json
{
  "ai": {
    "default": {
      "runtime": "auto",
      "model": "auto",
      "effort": "medium"
    },
    "scenarios": {
      "resume_eval": {
        "runtime": "claude",
        "model": "sonnet",
        "effort": "high"
      },
      "auto_match": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      },
      "chat": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      },
      "chat_summary": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      },
      "portrait": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      },
      "interview_questions": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      }
    },
    "streaming": false,
    "envRuntime": "codex",
    "availableRuntimes": ["claude", "codex", "chatgpt", "gemini"],
    "validModels": {
      "claude": ["opus", "sonnet", "haiku"],
      "codex": ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
      "chatgpt": ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
      "gemini": ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"]
    },
    "validEfforts": {
      "claude": ["low", "medium", "high", "max"],
      "codex": ["none", "low", "medium", "high", "xhigh"],
      "chatgpt": ["none", "low", "medium", "high", "xhigh"],
      "gemini": []
    },
    "raw": {
      "default": {
        "runtime": "auto",
        "model": "auto",
        "effort": "medium"
      },
      "streaming": false
    }
  }
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `ai.default` | object | Resolved default AI config |
| `ai.scenarios` | object | Resolved config for every supported scenario after merging defaults and overrides |
| `ai.streaming` | boolean | Whether streaming AI evaluation output is enabled by default |
| `ai.envRuntime` | string or null | Value of `ZYLOS_RUNTIME` used when resolving `auto` |
| `ai.availableRuntimes` | string[] | Runtimes detected as installed on the system |
| `ai.validModels` | object | Available model choices by runtime |
| `ai.validEfforts` | object | Available effort choices by runtime; empty array means unsupported |
| `ai.raw` | object | Raw `ai` config as stored in `config.json` |

## Update Settings

```
PUT /api/settings
Content-Type: application/json
Authorization: Bearer <api_token>
```

### Request Body

```json
{
  "ai": {
    "default": {
      "runtime": "auto",
      "model": "auto",
      "effort": "medium"
    },
    "resume_eval": {
      "runtime": "claude",
      "model": "sonnet",
      "effort": "high"
    },
    "auto_match": {
      "runtime": "codex",
      "model": "gpt-5.4",
      "effort": "medium"
    },
    "streaming": true
  }
}
```

### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ai` | object | yes | Settings update payload |
| `ai.default` | object | no | Default runtime/model/effort for all scenarios |
| `ai.<scenario>` | object | no | Override for one supported scenario |
| `ai.streaming` | boolean | no | Enables or disables SSE-style AI output where supported |
| `runtime` | string | no | `auto`, `claude`, `codex`, `chatgpt`, or `gemini` |
| `model` | string | no | `auto` or a model from `validModels` |
| `effort` | string | no | Effort from `validEfforts`, or empty string for runtimes without effort support |

All fields inside `ai.default` and `ai.<scenario>` are optional. Unknown keys
inside `ai` are preserved in `config.json`, but only documented scenario keys
are validated and returned as resolved scenarios.

Flat legacy updates are still accepted and converted to `ai.default`:

```json
{
  "ai": {
    "runtime": "gemini",
    "model": "gemini-2.5-flash",
    "effort": ""
  }
}
```

### Response

`200 OK`

Returns the same schema as `GET /api/settings`, after saving and reloading
`config.json`.

### Errors

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "missing ai settings" }` | Request body omitted `ai` or `ai` was not an object |
| `400` | `{ "error": "invalid runtime: ..." }` | Runtime is not one of the supported runtime keys |
| `400` | `{ "error": "runtime \"...\" is not installed" }` | Runtime is valid but not available on this host |
| `400` | `{ "error": "invalid model: ..." }` | Model is not present in any `validModels` list |
| `400` | `{ "error": "invalid effort: ..." }` | Effort is not present in any `validEfforts` list |
| `400` | `{ "error": "resume_eval: invalid model: ..." }` | Scenario-specific validation failed |

## Examples

Set the default runtime:

```bash
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"ai":{"default":{"runtime":"codex","model":"gpt-5.4","effort":"high"}}}' \
  "$HOST/api/settings"
```

Set a resume-evaluation override and leave other scenarios on the default:

```bash
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"ai":{"resume_eval":{"runtime":"claude","model":"sonnet","effort":"high"}}}' \
  "$HOST/api/settings"
```

Enable streaming:

```bash
curl -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"ai":{"streaming":true}}' \
  "$HOST/api/settings"
```

## Defaults

| Runtime | Default model | Effort support |
|---------|---------------|----------------|
| `claude` | `sonnet` | `low`, `medium`, `high`, `max` |
| `codex` | `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` |
| `chatgpt` | `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gemini` | `gemini-2.5-flash` | none |

`gpt-5.5` is available for Codex CLI when `codex --version` is `0.124.0`
or newer. `gpt-5.5` is also available for the ChatGPT subscription runtime
via the ChatGPT Codex backend.
