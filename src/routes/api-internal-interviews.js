import crypto from 'node:crypto';
import express from 'express';
import { jsonrepair } from 'jsonrepair';
import {
  listInternalInterviews, getInternalInterview, createInternalInterview,
  deleteInternalInterview, listInterviewMessages,
} from '../lib/db.js';
import { runClaude } from '../lib/ai-chat.js';
import { resolveAiConfig } from '../lib/config.js';
import { summaryInProgress } from './api-chat.js';

function parsePortraitsResponse(raw) {
  if (typeof raw !== 'string') return [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const bracket = raw.match(/\[[\s\S]*\]/);
  const candidate = (fence ? fence[1] : bracket ? bracket[0] : raw).trim();
  let data;
  try {
    data = JSON.parse(candidate);
  } catch {
    try { data = JSON.parse(jsonrepair(candidate)); } catch { return []; }
  }
  if (!Array.isArray(data)) data = [data];
  return data
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      name: typeof x.name === 'string' ? x.name.trim() : '',
      portrait: typeof x.portrait === 'string' ? x.portrait.trim() : '',
    }))
    .filter(x => x.portrait);
}

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
    // Annotate interviews with generating status
    if (result.interviews) {
      for (const iv of result.interviews) {
        iv.summary_generating = summaryInProgress.has(iv.id);
      }
    }
    res.json(result);
  });

  router.post('/', (req, res) => {
    const { company_id, interviewee_name } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    if (!interviewee_name || typeof interviewee_name !== 'string') {
      return res.status(400).json({ error: 'interviewee_name required' });
    }
    const token = crypto.randomBytes(16).toString('hex');
    // Lock current AI config (chat scenario) into the interview record
    const aiConfig = resolveAiConfig('chat');
    try {
      const interview = createInternalInterview({
        companyId: Number(company_id),
        intervieweeName: interviewee_name.trim(),
        token,
        runtimeType: aiConfig.runtime,
        model: aiConfig.model,
        effort: aiConfig.effort,
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

    const prompt = `你是一位资深招聘专家。以下是多位团队成员关于岗位需求的访谈记录/汇总。请综合输入，生成岗位画像（expected portrait）。

${parts.join('\n\n---\n\n')}

---

**多岗位判断**：先判断访谈内容是否涉及多个**明显不同**的岗位。判定"明显不同"的标准（需同时满足至少两条）：
- 岗位名称/职级方向完全不同（如"产品总监" vs "运营专员"）
- 核心职责没有显著重叠
- 汇报线或协作对象不同

如果不满足，就合成一份画像，不要过度拆分。同一岗位的不同侧面（例如"对内沟通"和"对外协调"）属于一份画像内的不同能力项。

**输出格式**：严格输出 JSON 数组，放在 \`\`\`json 代码块中，不要有任何其它文字：

\`\`\`json
[
  {
    "name": "岗位名称",
    "portrait": "完整的岗位画像 Markdown 内容（包含下列所有 section）"
  }
]
\`\`\`

每个 portrait 字段内必须包含以下 Markdown sections（不要写 \`## 岗位名称\`，name 已独立成字段）：

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
1. 如果不同访谈者意见矛盾，在对应 section 指出并给出你的建议
2. 务实——不堆砌不切实际的要求
3. 输出具体可操作，能直接用于候选人筛选
4. JSON 必须合法、可解析；portrait 字段中的换行用 \\n 转义`;

    try {
      console.log(`[recruit] Portrait generation: ${interview_ids.length} interviews selected...`);
      const { text: raw } = await runClaude(prompt, 'portrait');
      console.log(`[recruit] Portrait generated (${raw.length} chars)`);

      const portraits = parsePortraitsResponse(raw);
      if (!portraits.length) {
        return res.status(500).json({ error: 'portrait generation returned empty result', raw });
      }

      res.json({ portraits });
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
