import express from 'express';
import fs from 'node:fs';
import {
  listInterviewQuestionDocuments,
  getInterviewQuestionDocument,
  deleteInterviewQuestionDocument,
} from '../lib/db.js';
import {
  generateInterviewQuestions,
  resolveDocumentPath,
  retryPagesRegistration,
  unregisterDocumentFromPages,
} from '../lib/interview-questions.js';

export function interviewQuestionsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/candidates/:id/interview-questions', (req, res) => {
    const candidateId = Number(req.params.id);
    res.json({ documents: listInterviewQuestionDocuments({ candidateId }) });
  });

  router.post('/candidates/:id/interview-questions', async (req, res) => {
    const candidateId = Number(req.params.id);
    const customPrompt = typeof req.body?.custom_prompt === 'string' ? req.body.custom_prompt : '';
    try {
      const document = await generateInterviewQuestions(candidateId, { customPrompt });
      res.status(201).json({ document });
    } catch (err) {
      console.error(`[recruit] interview question generation failed for candidate #${candidateId}:`, err.message);
      const msg = String(err.message || '');
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      if (
        msg.includes('no assigned role') ||
        msg.includes('role requirements missing') ||
        msg.includes('resume or candidate context required') ||
        msg.includes('does not support "read_file"')
      ) {
        return res.status(400).json({ error: msg });
      }
      res.status(500).json({ error: msg || 'generation failed' });
    }
  });

  router.get('/interview-questions/:docId', (req, res) => {
    const document = getInterviewQuestionDocument(Number(req.params.docId));
    if (!document) return res.status(404).json({ error: 'not found' });
    res.json({ document });
  });

  router.get('/interview-questions/:docId/raw', (req, res) => {
    const document = getInterviewQuestionDocument(Number(req.params.docId));
    if (!document) return res.status(404).json({ error: 'not found' });
    try {
      const abs = resolveDocumentPath(document);
      if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file missing' });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/interview-questions/:docId/register-pages', async (req, res) => {
    try {
      const document = await retryPagesRegistration(Number(req.params.docId));
      res.json({ document });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/interview-questions/:docId', async (req, res) => {
    const document = getInterviewQuestionDocument(Number(req.params.docId));
    if (!document) return res.status(404).json({ error: 'not found' });
    await unregisterDocumentFromPages(document);
    const result = deleteInterviewQuestionDocument(document.id);
    res.json(result);
  });

  return router;
}
