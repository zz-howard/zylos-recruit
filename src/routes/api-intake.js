import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RESUMES_DIR } from '../lib/config.js';
import {
  createCandidate, updateCandidate, getCandidate, getRole,
  createIntakeJob, updateIntakeJob, getIntakeJob,
} from '../lib/db.js';
import { evaluateResume, rankRolesFromResume } from '../lib/ai.js';

const execFileAsync = promisify(execFile);

function ensureDir() {
  fs.mkdirSync(RESUMES_DIR, { recursive: true });
}

async function convertDocxToPdf(docxPath) {
  const dir = path.dirname(docxPath);
  await execFileAsync('libreoffice', [
    '--headless', '--convert-to', 'pdf', '--outdir', dir, docxPath,
  ], { timeout: 60_000 });
  const pdfPath = docxPath.replace(/\.docx$/i, '.pdf');
  if (!fs.existsSync(pdfPath)) throw new Error('DOCX to PDF conversion failed');
  try { fs.unlinkSync(docxPath); } catch { /* ignore */ }
  return pdfPath;
}

export function intakeRouter(uploadConfig) {
  const router = express.Router();

  const ALLOWED_MIMES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir();
      cb(null, RESUMES_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.pdf').toLowerCase();
      const rand = crypto.randomBytes(6).toString('hex');
      cb(null, `intake-${Date.now()}-${rand}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: uploadConfig?.maxFileSizeBytes || 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = uploadConfig?.allowedMimeTypes || ALLOWED_MIMES;
      if (!allowed.includes(file.mimetype)) {
        return cb(new Error(`file type not allowed: ${file.mimetype}. Accepted: PDF, DOCX`));
      }
      cb(null, true);
    },
  });

  router.post('/intake', (req, res) => {
    upload.single('resume')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'resume file is required' });

      const companyId = Number(req.body.company_id);
      if (!companyId) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        return res.status(400).json({ error: 'company_id is required' });
      }

      const name = (req.body.name && typeof req.body.name === 'string')
        ? req.body.name.trim() : '待识别';
      const source = req.body.source || null;

      let candidate;
      try {
        candidate = createCandidate({ companyId, name, source });
      } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        return res.status(400).json({ error: e.message });
      }

      let finalFilename = req.file.filename;
      if (req.file.filename.toLowerCase().endsWith('.docx')) {
        try {
          const pdfPath = await convertDocxToPdf(req.file.path);
          finalFilename = path.basename(pdfPath);
        } catch (convErr) {
          console.error(`[recruit] intake DOCX conversion failed:`, convErr.message);
          try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
          return res.status(500).json({ error: 'Failed to convert DOCX to PDF' });
        }
      }

      const renamedFilename = `cand-${candidate.id}-${finalFilename}`;
      const oldPath = path.join(RESUMES_DIR, finalFilename);
      const newPath = path.join(RESUMES_DIR, renamedFilename);
      try { fs.renameSync(oldPath, newPath); } catch { /* keep original name */ }
      const resumePath = fs.existsSync(newPath) ? renamedFilename : finalFilename;

      updateCandidate(candidate.id, { resume_path: resumePath });
      createIntakeJob(candidate.id);

      // Async pipeline — fire and forget
      (async () => {
        try {
          // Step 1: Rank all roles (more accurate than autoMatch) and assign the top one
          const rankings = await rankRolesFromResume(candidate.id);
          if (rankings.length > 0) {
            const best = rankings[0];
            updateCandidate(candidate.id, { role_id: best.role_id });
            console.log(`[recruit] intake: ranked match → "${best.role_name}" (score: ${best.score})`);
          }

          // Step 2: Evaluate (role already assigned, so evaluateResume skips autoMatch)
          await evaluateResume(candidate.id);
          const cand = getCandidate(candidate.id);
          const role = cand.role_id ? getRole(cand.role_id) : null;
          const latestEval = cand.evaluations?.[0] || null;
          updateIntakeJob(candidate.id, {
            status: 'completed',
            result: JSON.stringify({
              matched_role: role ? { id: role.id, name: role.name } : null,
              evaluation: latestEval ? {
                score: latestEval.meta ? JSON.parse(latestEval.meta)?.score : null,
                verdict: latestEval.verdict,
                summary: latestEval.content,
              } : null,
            }),
          });
          console.log(`[recruit] intake pipeline completed for candidate #${candidate.id}`);
        } catch (e) {
          updateIntakeJob(candidate.id, { status: 'failed', error: e.message });
          console.error(`[recruit] intake pipeline failed for candidate #${candidate.id}:`, e.message);
        }
      })();

      res.status(201).json({
        candidate_id: candidate.id,
        message: '简历已收到，正在进行智能匹配和 AI 评估，预计 10 分钟内完成。届时可通过查询接口获取结果。',
        poll_url: `/api/candidates/${candidate.id}/intake-result`,
      });
    });
  });

  router.get('/:id/intake-result', (req, res) => {
    const candidateId = Number(req.params.id);
    if (!candidateId) return res.status(400).json({ error: 'invalid candidate id' });

    const job = getIntakeJob(candidateId);
    if (!job) return res.status(404).json({ error: 'no intake job found for this candidate' });

    if (job.status === 'processing') {
      return res.status(202).json({
        status: 'processing',
        message: '评估仍在进行中，请 5 分钟后再来查看。',
      });
    }

    if (job.status === 'failed') {
      return res.json({
        status: 'failed',
        candidate_id: candidateId,
        error: job.error,
      });
    }

    // completed
    let result = {};
    try { result = JSON.parse(job.result); } catch { /* ignore */ }
    return res.json({
      status: 'completed',
      candidate_id: candidateId,
      matched_role: result.matched_role || null,
      evaluation: result.evaluation || null,
    });
  });

  return router;
}
