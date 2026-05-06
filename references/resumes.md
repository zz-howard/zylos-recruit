# Resumes API

Base path: `/api/candidates/:id/resume`

Upload and download a candidate resume. API clients must authenticate with a
Bearer token:

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
HOST="https://host/recruit"
AUTH="Authorization: Bearer $TOKEN"
```

## Resume File Schema

The candidate record stores only the server-side file name:

```json
{
  "resume_path": "cand-8-1778040000000-a1b2c3d4e5f6.pdf"
}
```

Accepted upload inputs:

| Input | MIME type | Stored as |
|-------|-----------|-----------|
| PDF | `application/pdf` | PDF |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Converted PDF |

The default upload limit is 10 MB unless overridden by
`upload.maxFileSizeBytes` in `~/zylos/components/recruit/config.json`.

## Upload Resume

```
POST /api/candidates/:id/resume
Content-Type: multipart/form-data
Authorization: Bearer <api_token>
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Candidate ID |

### Form Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes | PDF or DOCX resume file |

Uploading a new resume replaces the previous resume file on disk when one
exists. DOCX uploads are converted to PDF with LibreOffice before the
candidate is updated.

### Response

`200 OK`

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
    "extra_info": null,
    "resume_path": "cand-8-1778040000000-a1b2c3d4e5f6.pdf",
    "state": "pending",
    "created_at": "2026-05-06 08:30:00",
    "updated_at": "2026-05-06 08:31:00",
    "role_name": "Backend Engineer",
    "evaluations": []
  }
}
```

### Errors

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "no file" }` | Request did not include the `file` field |
| `400` | `{ "error": "file type not allowed: ... Accepted: PDF, DOCX" }` | File MIME type is not allowed |
| `404` | `{ "error": "candidate not found" }` | Candidate ID does not exist or was deleted |
| `500` | `{ "error": "Failed to convert DOCX to PDF" }` | LibreOffice conversion failed |

### Example

```bash
curl -H "$AUTH" \
  -F file=@/path/to/resume.pdf \
  "$HOST/api/candidates/8/resume"
```

```bash
curl -H "$AUTH" \
  -F file=@/path/to/resume.docx \
  "$HOST/api/candidates/8/resume"
```

## Download Resume

```
GET /api/candidates/:id/resume[?dl=1]
Authorization: Bearer <api_token>
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | integer | yes | Candidate ID |

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dl` | string | no | Set to `1` to return `Content-Disposition: attachment` |

### Response

`200 OK`

The response body is a PDF stream with `Content-Type: application/pdf`. When
`dl=1` is provided, the server sets an attachment filename based on the
candidate name.

### Errors

| Status | Response | Cause |
|--------|----------|-------|
| `400` | `{ "error": "invalid path" }` | Stored resume path resolves outside the resumes directory |
| `404` | `{ "error": "no resume" }` | Candidate does not exist, was deleted, or has no resume |
| `404` | `{ "error": "file missing" }` | Candidate has `resume_path`, but the file is missing on disk |

### Example

```bash
curl -H "$AUTH" \
  "$HOST/api/candidates/8/resume" \
  -o resume.pdf
```

```bash
curl -H "$AUTH" \
  "$HOST/api/candidates/8/resume?dl=1" \
  -o resume.pdf
```

## Storage

- Resumes are stored in `~/zylos/components/recruit/resumes/`.
- Filename format is `cand-{id}-{timestamp}-{random}.{ext}` during upload.
- DOCX source files are removed after successful conversion.
- The persisted `resume_path` points to the final PDF file.
- Download resolves the file path and rejects paths outside the resumes
  directory.
