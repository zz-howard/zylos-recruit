/**
 * Chat API routes for internal interview chatbot.
 * Token-based authentication — no login required.
 *
 * GET  /api/chat/:token       — get interview info + message history
 * POST /api/chat/:token       — send a message, get AI response
 * POST /api/chat/:token/end   — end the interview, trigger summary
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  getInternalInterviewByToken, updateInternalInterview,
  listInterviewMessages, addInterviewMessage,
} from '../lib/db.js';
import { runClaude } from '../lib/ai-chat.js';

const PROMPT_PATH = path.join(import.meta.dirname, '..', 'prompts', 'internal-interview.md');

function loadSystemPrompt() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

/**
 * Build a full conversation prompt including system instructions + all prior messages.
 */
function buildConversationPrompt(systemPrompt, messages, newUserMessage) {
  let prompt = systemPrompt + '\n\n';

  if (messages.length > 0) {
    prompt += '--- 以下是此前的对话记录 ---\n\n';
    for (const msg of messages) {
      const label = msg.role === 'user' ? '被访谈人' : '你（AI访谈专家）';
      prompt += `${label}：${msg.content}\n\n`;
    }
    prompt += '--- 对话记录结束 ---\n\n';
  }

  prompt += `被访谈人：${newUserMessage}\n\n`;
  prompt += '请作为AI访谈专家回复。注意：只回复你的回答内容，不要加角色标签前缀。';

  return prompt;
}

/**
 * Build a summary prompt to generate a structured interview summary.
 */
function buildSummaryPrompt(messages) {
  let prompt = '请根据以下访谈对话内容，生成结构化的岗位需求汇总。\n\n';
  prompt += '对话记录：\n\n';
  for (const msg of messages) {
    const label = msg.role === 'user' ? '被访谈人' : 'AI访谈专家';
    prompt += `${label}：${msg.content}\n\n`;
  }
  prompt += `请输出以下格式的结构化汇总（纯文本，不要JSON）：

## 岗位定位
（岗位在团队中的位置和汇报关系）

## 核心职责
（每天要做的最重要的事）

## 必备能力
（缺了就做不了的硬技能和软技能）

## 加分项
（有则更好但不强制的能力和经历）

## 减分项 / 红线
（什么样的候选人不考虑）

## 工作风格偏好
（自驱/协作/沟通等）

## 其他关键信息
（访谈中提到的其他重要信息）

如果某些维度在对话中没有涉及，标注"（未提及）"。`;

  return prompt;
}

// In-flight lock to prevent concurrent messages on the same interview
const chatLocks = new Set();

export function chatRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Get interview info + message history
  router.get('/:token', (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    const messages = listInterviewMessages(interview.id);
    res.json({
      interview: {
        id: interview.id,
        interviewee_name: interview.interviewee_name,
        status: interview.status,
        summary: interview.summary,
        created_at: interview.created_at,
        completed_at: interview.completed_at,
      },
      messages: messages.map(m => ({ role: m.role, text: m.content, created_at: m.created_at })),
    });
  });

  // Send a message
  router.post('/:token', async (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    if (interview.status !== 'active') {
      return res.status(400).json({ error: 'interview has ended' });
    }

    const userMessage = req.body.text || (req.body.messages && req.body.messages[req.body.messages.length - 1]?.text);
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'text required' });
    }

    if (chatLocks.has(interview.id)) {
      return res.status(429).json({ error: 'previous message still processing' });
    }
    chatLocks.add(interview.id);

    try {
      // Store user message
      addInterviewMessage(interview.id, { role: 'user', content: userMessage });

      // Build conversation and get AI response
      const allMessages = listInterviewMessages(interview.id);
      // allMessages includes the just-added user message; exclude it for the history
      const history = allMessages.slice(0, -1);
      const systemPrompt = loadSystemPrompt();
      const prompt = buildConversationPrompt(systemPrompt, history, userMessage);

      console.log(`[recruit] Chat: interview #${interview.id} — sending to claude (${allMessages.length} messages total)...`);
      const aiResponse = await runClaude(prompt);
      console.log(`[recruit] Chat: interview #${interview.id} — AI responded (${aiResponse.length} chars)`);

      // Store AI response
      addInterviewMessage(interview.id, { role: 'assistant', content: aiResponse });

      // Update runtime_type if not set
      if (!interview.runtime_type) {
        updateInternalInterview(interview.id, { runtime_type: 'claude' });
      }

      res.json({ text: aiResponse });
    } catch (err) {
      console.error(`[recruit] Chat error (interview #${interview.id}):`, err.message);
      res.status(500).json({ error: 'AI service error: ' + err.message });
    } finally {
      chatLocks.delete(interview.id);
    }
  });

  // End interview — trigger summary generation
  router.post('/:token/end', async (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    if (interview.status !== 'active') {
      return res.status(400).json({ error: 'interview already ended' });
    }

    const messages = listInterviewMessages(interview.id);
    if (messages.length === 0) {
      // No messages — just mark completed, no summary
      updateInternalInterview(interview.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      return res.json({ interview: getInternalInterviewByToken(req.params.token) });
    }

    try {
      console.log(`[recruit] Chat: ending interview #${interview.id} — generating summary...`);
      const summaryPrompt = buildSummaryPrompt(messages);
      const summary = await runClaude(summaryPrompt);
      console.log(`[recruit] Chat: interview #${interview.id} — summary generated (${summary.length} chars)`);

      updateInternalInterview(interview.id, {
        status: 'completed',
        summary,
        completed_at: new Date().toISOString(),
      });

      res.json({ interview: getInternalInterviewByToken(req.params.token) });
    } catch (err) {
      console.error(`[recruit] Chat summary error (interview #${interview.id}):`, err.message);
      // Still mark as completed even if summary fails
      updateInternalInterview(interview.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      res.status(500).json({ error: 'summary generation failed', interview: getInternalInterviewByToken(req.params.token) });
    }
  });

  return router;
}
