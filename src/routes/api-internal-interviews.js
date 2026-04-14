import crypto from 'node:crypto';
import express from 'express';
import {
  listInternalInterviews, getInternalInterview, createInternalInterview,
  deleteInternalInterview, listInterviewMessages,
} from '../lib/db.js';
import { runClaude } from '../lib/ai-chat.js';

export function internalInterviewsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/', (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : undefined;
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const status = req.query.status || undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const result = listInternalInterviews({ companyId, status, limit, offset });
    res.json(result);
  });

  router.post('/', (req, res) => {
    const { company_id, interviewee_name } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    if (!interviewee_name || typeof interviewee_name !== 'string') {
      return res.status(400).json({ error: 'interviewee_name required' });
    }
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const interview = createInternalInterview({
        companyId: Number(company_id),
        intervieweeName: interviewee_name.trim(),
        token,
      });
      res.status(201).json({ interview });
    } catch (err) {
      if (String(err.message).includes('FOREIGN KEY')) {
        return res.status(400).json({ error: 'company not found' });
      }
      throw err;
    }
  });

  // Generate portrait from selected interviews
  router.post('/generate-portrait', async (req, res) => {
    const { interview_ids } = req.body || {};
    if (!Array.isArray(interview_ids) || interview_ids.length === 0) {
      return res.status(400).json({ error: 'interview_ids required (array)' });
    }

    // Collect summaries from selected interviews
    const parts = [];
    for (const id of interview_ids) {
      const iv = getInternalInterview(Number(id));
      if (!iv) continue;
      if (iv.summary) {
        parts.push(`### ${iv.interviewee_name} 的访谈汇总\n\n${iv.summary}`);
      } else {
        // No summary — reconstruct from messages
        const msgs = listInterviewMessages(iv.id);
        if (msgs.length > 0) {
          let convo = msgs.map(m => {
            const label = m.role === 'user' ? iv.interviewee_name : 'AI';
            return `${label}：${m.content}`;
          }).join('\n\n');
          parts.push(`### ${iv.interviewee_name} 的访谈记录\n\n${convo}`);
        }
      }
    }

    if (parts.length === 0) {
      return res.status(400).json({ error: 'selected interviews have no content' });
    }

    const prompt = `你是一位资深招聘专家。以下是多位团队成员关于同一个岗位需求的访谈记录/汇总。请综合所有人的输入，生成一份完整的岗位画像（expected portrait）。

${parts.join('\n\n---\n\n')}

---

请输出以下格式的岗位画像（Markdown 格式）：

## 岗位名称
（基于访谈内容推断最合适的岗位名称）

## 岗位定位
（在团队中的角色定位、汇报关系、协作对象）

## 核心职责
（按优先级排列的 3-5 项核心职责）

## 必备能力
（硬技能 + 软技能，每条说明为什么是必备的）

## 加分项
（有则更好但不强制的能力和经历）

## 减分项 / 红线
（明确列出不考虑的情况）

## 工作风格偏好
（自驱/协作/沟通风格等）

## 评估建议
（面试时重点验证什么、如何判断候选人是否达标）

注意：
1. 如果不同访谈者的意见有矛盾，指出矛盾并给出你的建议
2. 保持务实——不要堆砌不切实际的要求
3. 输出要具体可操作，能直接用于候选人筛选`;

    try {
      console.log(`[recruit] Portrait generation: ${interview_ids.length} interviews selected...`);
      const portrait = await runClaude(prompt);
      console.log(`[recruit] Portrait generated (${portrait.length} chars)`);

      // Extract suggested role name from the portrait
      const nameMatch = portrait.match(/## 岗位名称\s*\n+([^\n#]+)/);
      const suggestedName = nameMatch ? nameMatch[1].trim() : '';

      res.json({ portrait, suggested_name: suggestedName });
    } catch (err) {
      console.error('[recruit] Portrait generation failed:', err.message);
      res.status(500).json({ error: 'portrait generation failed: ' + err.message });
    }
  });

  router.get('/:id', (req, res) => {
    const interview = getInternalInterview(Number(req.params.id));
    if (!interview) return res.status(404).json({ error: 'not found' });
    res.json({ interview });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = getInternalInterview(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    deleteInternalInterview(id);
    res.status(204).end();
  });

  return router;
}
