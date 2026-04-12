# Resumes API

Base path: `/api/candidates/:id/resume`

Upload and download candidate resume PDFs.

## Upload Resume

```
POST /api/candidates/:id/resume
Content-Type: multipart/form-data
```

**Form fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | yes | PDF file (max 10 MB) |

Uploading a new resume replaces the previous one (old file is deleted from disk).

**Response:** `{ "candidate": {...} }` with updated `resume_path`

**Errors:**
- `400` — no file; file type not allowed (only `application/pdf`)
- `404` — candidate not found

**Example (curl):**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F file=@/path/to/resume.pdf \
  https://host/recruit/api/candidates/8/resume
```

## Download Resume

```
GET /api/candidates/:id/resume[?dl=1]
```

Streams the PDF file.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `dl` | `1` | Force download with `Content-Disposition: attachment` header |

**Response:** `application/pdf` stream

**Errors:**
- `404` — candidate not found or no resume uploaded

## Storage

- Resumes are stored in `~/zylos/components/recruit/resumes/`
- Filename format: `cand-{id}-{timestamp}-{random}.pdf`
- Path traversal protection: resolved path must stay within the resumes directory
