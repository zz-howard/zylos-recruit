import express from 'express';
import {
  listCandidates, getCandidate, createCandidate, updateCandidate,
  moveCandidate, addEvaluation, deleteCandidate, listRoles, STATES,
} from '../lib/db.js';
import { evaluateResumeAsync, evaluateResumeStream, isEvaluating, autoMatchFromResume } from '../lib/ai.js';
import { runClaude } from '../lib/ai-chat.js';

export function candidatesRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (!companyId) {
      return res.status(400).json({ error: 'company_id required' });
    }
    const roleId = req.query.role_id ? Number(req.query.role_id) : undefined;
    const state = req.query.state || undefined;
    const candidates = listCandidates({ companyId, roleId, state }).map(c => {
      c.is_evaluating = isEvaluating(c.id);
      return c;
    });
    res.json({ candidates });
  });

  router.post('/', (req, res) => {
    const { company_id, name, role_id, email, phone, source, brief, extra_info } = req.body || {};
    if (!company_id) {
      return res.status(400).json({ error: 'company_id required' });
    }
    try {
      const cand = createCandidate({
        companyId: Number(company_id),
        name: (name && typeof name === 'string') ? name.trim() : '待识别',
        role_id: role_id ? Number(role_id) : null,
        email, phone, source, brief, extra_info,
      });
      res.status(201).json({ candidate: cand });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('different company') || msg.includes('role not found')) {
        return res.status(400).json({ error: err.message });
      }
      if (msg.includes('FOREIGN KEY')) {
        return res.status(400).json({ error: 'company not found' });
      }
      throw err;
    }
  });

  router.get('/:id', (req, res) => {
    const cand = getCandidate(Number(req.params.id));
    if (!cand) return res.status(404).json({ error: 'not found' });
    cand.is_evaluating = isEvaluating(cand.id);
    res.json({ candidate: cand });
  });

  router.put('/:id', (req, res) => {
    try {
      const cand = updateCandidate(Number(req.params.id), req.body || {});
      if (!cand) return res.status(404).json({ error: 'not found' });
      res.json({ candidate: cand });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('different company') || msg.includes('role not found')) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  router.delete('/:id', (req, res) => {
    deleteCandidate(Number(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/move', (req, res) => {
    const { state } = req.body || {};
    if (!STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${STATES.join(', ')}` });
    }
    const cand = moveCandidate(Number(req.params.id), state);
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  // Add human evaluation (interview feedback)
  router.post('/:id/evaluate', (req, res) => {
    const { kind, author, verdict, content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }
    const cand = addEvaluation(Number(req.params.id), {
      kind: kind || 'interview',
      author,
      verdict,
      content,
    });
    if (!cand) return res.status(404).json({ error: 'not found' });
    res.json({ candidate: cand });
  });

  // Auto-match candidate to best role based on resume content (no prior eval needed)
  router.post('/:id/auto-match-resume', async (req, res) => {
    const candidateId = Number(req.params.id);
    const cand = getCandidate(candidateId);
    if (!cand) return res.status(404).json({ error: 'not found' });
    if (!cand.resume_path) return res.status(400).json({ error: 'no resume uploaded' });

    try {
      const match = await autoMatchFromResume(candidateId);
      res.json(match);
    } catch (err) {
      console.error(`[recruit] Auto-match-resume error (candidate #${candidateId}):`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-match candidate to active roles based on resume evaluation
  router.post('/:id/auto-match', async (req, res) => {
    const candidateId = Number(req.params.id);
    const cand = getCandidate(candidateId);
    if (!cand) return res.status(404).json({ error: 'not found' });

    // Gather candidate info: latest AI eval + brief
    const aiEval = (cand.evaluations || []).find(e => e.kind === 'resume_ai');
    const candidateInfo = [];
    if (cand.name && cand.name !== '待识别') candidateInfo.push(`姓名：${cand.name}`);
    if (cand.brief) candidateInfo.push(`简介：${cand.brief}`);
    if (aiEval?.content) candidateInfo.push(`AI 评估：\n${aiEval.content}`);
    if (candidateInfo.length === 0) {
      return res.status(400).json({ error: '候选人暂无评估信息，请先进行 AI 评估' });
    }

    // Get all active roles for this company
    const activeRoles = listRoles({ companyId: cand.company_id, active: true });
    if (activeRoles.length === 0) {
      return res.status(400).json({ error: '当前没有活跃角色' });
    }

    const rolesText = activeRoles.map((r, i) => {
      const parts = [`### 角色 ${i + 1}: ${r.name} (ID: ${r.id})`];
      if (r.expected_portrait) parts.push(r.expected_portrait);
      else if (r.description) parts.push(r.description);
      else parts.push('（无详细描述）');
      return parts.join('\n');
    }).join('\n\n---\n\n');

    const prompt = `你是一位资深招聘专家。请根据候选人信息，对以下活跃岗位进行匹配度评估。

## 候选人信息

${candidateInfo.join('\n\n')}

## 可匹配的岗位

${rolesText}

---

请以 JSON 数组格式输出匹配结果，按匹配度从高到低排序。每个元素包含：
- role_id: 角色 ID（数字）
- role_name: 角色名称
- score: 匹配度分数（0-100）
- reason: 一句话说明匹配/不匹配的原因

只输出 JSON，不要其他文字。示例：
[{"role_id":1,"role_name":"xxx","score":85,"reason":"xxx"}]`;

    try {
      console.log(`[recruit] Auto-match: candidate #${candidateId} against ${activeRoles.length} active roles...`);
      const { text: raw } = await runClaude(prompt, 'auto_match');

      // Parse JSON from response (handle markdown code blocks)
      let jsonStr = raw.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      const matches = JSON.parse(jsonStr);
      console.log(`[recruit] Auto-match: candidate #${candidateId} — ${matches.length} results`);
      res.json({ matches });
    } catch (err) {
      console.error(`[recruit] Auto-match error (candidate #${candidateId}):`, err.message);
      res.status(500).json({ error: 'auto-match failed: ' + err.message });
    }
  });

  // AI resume evaluation (async — returns 202 immediately, processes in background)
  router.post('/:id/ai-evaluate', (req, res) => {
    const candidateId = Number(req.params.id);
    const cand = getCandidate(candidateId);
    if (!cand) return res.status(404).json({ error: 'not found' });
    if (!cand.resume_path) return res.status(400).json({ error: 'no resume uploaded — upload a PDF first' });
    if (isEvaluating(candidateId)) return res.status(409).json({ error: '该候选人正在评估中，请稍候' });

    evaluateResumeAsync(candidateId);
    res.status(202).json({ message: 'AI evaluation started', candidate_id: candidateId });
  });

  // AI resume evaluation with SSE streaming — real-time AI output
  router.post('/:id/ai-evaluate/stream', async (req, res) => {
    const candidateId = Number(req.params.id);
    const cand = getCandidate(candidateId);
    if (!cand) return res.status(404).json({ error: 'not found' });
    if (!cand.resume_path) return res.status(400).json({ error: 'no resume uploaded — upload a PDF first' });
    if (isEvaluating(candidateId)) return res.status(409).json({ error: '该候选人正在评估中，请稍候' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const send = (event) => {
      if (!closed) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      }
    };

    try {
      await evaluateResumeStream(candidateId, send);
    } catch (err) {
      console.error(`[recruit] AI stream evaluation failed for candidate #${candidateId}:`, err.message);
      send({ type: 'error', message: err.message });
    }

    if (!closed) res.end();
  });

  return router;
}
