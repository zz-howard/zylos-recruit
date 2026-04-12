# Agent Workflow

End-to-end guide for submitting and evaluating candidates via API.

## Prerequisites

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
HOST="https://host/recruit"
AUTH="Authorization: Bearer $TOKEN"
```

## Full Flow: Submit & Evaluate

### Step 1: Create Candidate

```bash
CAND_ID=$(curl -s -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": 1,
    "role_id": 2,
    "extra_info": "推荐理由或补充信息"
  }' \
  $HOST/api/candidates | jq '.candidate.id')
```

Name is optional — defaults to "待识别", AI auto-extracts from resume.

### Step 2: Upload Resume

```bash
curl -H "$AUTH" \
  -F file=@/path/to/resume.pdf \
  $HOST/api/candidates/$CAND_ID/resume
```

### Step 3: Trigger AI Evaluation

```bash
curl -X POST -H "$AUTH" \
  $HOST/api/candidates/$CAND_ID/ai-evaluate
# Returns 202 immediately
```

### Step 4 (Optional): Poll for Result

```bash
# Wait a bit, then check
curl -s -H "$AUTH" $HOST/api/candidates/$CAND_ID \
  | jq '{
    evaluating: .candidate.is_evaluating,
    verdict: .candidate.evaluations[0].verdict,
    score: (.candidate.evaluations[0].meta | fromjson | .score)
  }'
```

## Batch Import

For importing multiple candidates programmatically:

```bash
for pdf in /path/to/resumes/*.pdf; do
  # Create
  CAND_ID=$(curl -s -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "{\"company_id\":1, \"role_id\":2}" \
    $HOST/api/candidates | jq '.candidate.id')

  # Upload
  curl -s -H "$AUTH" -F file=@"$pdf" \
    $HOST/api/candidates/$CAND_ID/resume

  # Evaluate (fire-and-forget)
  curl -s -X POST -H "$AUTH" \
    $HOST/api/candidates/$CAND_ID/ai-evaluate

  echo "Submitted: $pdf → candidate #$CAND_ID"
done
```

## Other Operations

### Move Candidate to Next Stage

```bash
curl -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"state": "scheduled"}' \
  $HOST/api/candidates/$CAND_ID/move
```

### Add Interview Feedback

```bash
curl -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
    "author": "Howard",
    "verdict": "pass",
    "content": "技术扎实，沟通能力强，建议进入下一轮。"
  }' \
  $HOST/api/candidates/$CAND_ID/evaluate
```

### List Candidates with Filters

```bash
# All candidates for company 1
curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1" | jq '.candidates[] | {id, name, state, last_ai_verdict, last_ai_score}'

# Filter by role
curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1&role_id=2"

# Filter by state
curl -s -H "$AUTH" "$HOST/api/candidates?company_id=1&state=pending"
```
