# Settings API

Base path: `/api/settings`

Configure AI evaluation runtime, model, and effort level.

## Get Settings

```
GET /api/settings
```

**Response:**

```json
{
  "ai": {
    "runtime": "auto",
    "effective": "claude",
    "envRuntime": "claude",
    "availableRuntimes": ["claude", "codex", "gemini"],
    "model": "auto",
    "validModels": {
      "claude": ["opus", "sonnet", "haiku"],
      "codex": ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
      "gemini": ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"]
    },
    "effort": "high",
    "validEfforts": {
      "claude": ["low", "medium", "high", "max"],
      "codex": ["none", "low", "medium", "high", "xhigh"],
      "gemini": []
    }
  }
}
```

### Field Descriptions

| Field | Description |
|-------|-------------|
| `runtime` | Configured runtime setting (`auto` or specific) |
| `effective` | Actually used runtime after resolving `auto` |
| `envRuntime` | Value of `ZYLOS_RUNTIME` env var |
| `availableRuntimes` | Runtimes detected as installed on the system |
| `model` | Configured model (`auto` or specific) |
| `validModels` | Available model choices per runtime |
| `effort` | Configured effort level |
| `validEfforts` | Available effort choices per runtime (empty array = not supported) |

## Update Settings

```
PUT /api/settings
Content-Type: application/json
```

**Body:**

```json
{
  "ai": {
    "runtime": "gemini",
    "model": "gemini-2.5-flash",
    "effort": ""
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ai.runtime` | string | `auto`, `claude`, `codex`, or `gemini` |
| `ai.model` | string | `auto` or a specific model from `validModels` |
| `ai.effort` | string | Effort level from `validEfforts`. Empty string for runtimes without effort support |

All fields are optional — only provided fields are updated.

**Response:** Updated settings (same format as GET)

**Errors:**
- `400` — invalid runtime/model/effort value; runtime not installed

### Default Models

| Runtime | Default Model |
|---------|--------------|
| claude | sonnet |
| codex | gpt-5.4 |
| gemini | gemini-2.5-flash |

`gpt-5.5` is available for Codex CLI when `codex --version` is `0.124.0` or newer.

### Runtime-Effort Mapping

| Runtime | Effort Options | Default |
|---------|---------------|---------|
| claude | low, medium, high, max | high |
| codex | none, low, medium, high, xhigh | high |
| gemini | _(not supported)_ | — |
