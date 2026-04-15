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

## 被访谈人现状
（目前主要忙什么，哪些事情占了太多精力）

## 需要交出去的工作
（具体有哪些工作希望找人接手或分担，按优先级排列）

## 期望的人选画像
（需要什么样的人——技能、经验、工作风格）

## 招聘优先级
（如果只能先招一个人，最优先解决哪块）

## 团队协作
（新人和谁配合、向谁汇报、日常怎么协作）

## 红线
（什么样的人绝对不合适）

## 其他关键信息
（访谈中提到的其他重要信息）

如果某些维度在对话中没有涉及，标注"（未提及）"。如果被访谈人的需求可能拆分为多个不同角色，请指出。`;

  return prompt;
}

// In-flight lock to prevent concurrent messages on the same interview
const chatLocks = new Set();

// Track in-progress summary generation (exported for use by interview list API)
export const summaryInProgress = new Set();

function generateSummaryAsync(interviewId, messages) {
  if (summaryInProgress.has(interviewId)) return;
  summaryInProgress.add(interviewId);
  console.log(`[recruit] Chat: interview #${interviewId} — generating summary in background...`);

  const summaryPrompt = buildSummaryPrompt(messages);
  runClaude(summaryPrompt, 'chat_summary')
    .then(summary => {
      console.log(`[recruit] Chat: interview #${interviewId} — summary generated (${summary.length} chars)`);
      updateInternalInterview(interviewId, { summary });
    })
    .catch(err => {
      console.error(`[recruit] Chat: interview #${interviewId} — summary failed: ${err.message}`);
    })
    .finally(() => {
      summaryInProgress.delete(interviewId);
    });
}

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
      const aiResponse = await runClaude(prompt, 'chat');
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

  // End interview — mark completed immediately, generate summary in background
  router.post('/:token/end', (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    if (interview.status !== 'active') {
      return res.status(400).json({ error: 'interview already ended' });
    }

    // Mark completed immediately
    updateInternalInterview(interview.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    // Generate summary in background (non-blocking)
    const messages = listInterviewMessages(interview.id);
    if (messages.length > 0) {
      generateSummaryAsync(interview.id, messages);
    }

    res.json({ interview: getInternalInterviewByToken(req.params.token) });
  });

  // Retry summary generation for a completed interview
  router.post('/:token/generate-summary', (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    if (interview.status !== 'completed') {
      return res.status(400).json({ error: 'interview must be completed first' });
    }
    if (summaryInProgress.has(interview.id)) {
      return res.status(409).json({ error: 'summary generation already in progress' });
    }

    const messages = listInterviewMessages(interview.id);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'no messages to summarize' });
    }

    generateSummaryAsync(interview.id, messages);
    res.json({ status: 'generating' });
  });

  // Check summary status
  router.get('/:token/summary-status', (req, res) => {
    const interview = getInternalInterviewByToken(req.params.token);
    if (!interview) return res.status(404).json({ error: 'interview not found' });
    res.json({
      has_summary: !!interview.summary,
      generating: summaryInProgress.has(interview.id),
    });
  });

  return router;
}
