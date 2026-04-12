import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RESUMES_DIR } from '../lib/config.js';
import { getCandidate, updateCandidate } from '../lib/db.js';

let pdfParse = null;
async function getPdfParse() {
  if (!pdfParse) {
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    pdfParse = mod.default || mod;
  }
  return pdfParse;
}

async function extractPdfText(filePath) {
  try {
    const parse = await getPdfParse();
    const buf = fs.readFileSync(filePath);
    const data = await parse(buf);
    return (data.text || '').trim();
  } catch (err) {
    console.error('[recruit] PDF text extraction failed:', err.message);
    return null;
  }
}

function ensureDir() {
  fs.mkdirSync(RESUMES_DIR, { recursive: true });
}

export function resumesRouter(uploadConfig) {
  const router = express.Router();

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir();
      cb(null, RESUMES_DIR);
    },
    filename: (req, file, cb) => {
      const id = req.params.id || 'unknown';
      const ext = (path.extname(file.originalname) || '.pdf').toLowerCase();
      const rand = crypto.randomBytes(6).toString('hex');
      cb(null, `cand-${id}-${Date.now()}-${rand}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: uploadConfig?.maxFileSizeBytes || 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = uploadConfig?.allowedMimeTypes || ['application/pdf'];
      if (!allowed.includes(file.mimetype)) {
        return cb(new Error(`file type not allowed: ${file.mimetype}`));
      }
      cb(null, true);
    },
  });

  router.post('/:id/resume', (req, res) => {
    const cand = getCandidate(Number(req.params.id));
    if (!cand) return res.status(404).json({ error: 'candidate not found' });

    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'no file' });

      // Remove old resume if present
      if (cand.resume_path) {
        const old = path.join(RESUMES_DIR, cand.resume_path);
        if (fs.existsSync(old)) {
          try { fs.unlinkSync(old); } catch { /* ignore */ }
        }
      }

      // Extract text from PDF
      const filePath = path.join(RESUMES_DIR, req.file.filename);
      const resumeText = await extractPdfText(filePath);

      const updates = { resume_path: req.file.filename };
      if (resumeText) updates.resume_text = resumeText;

      const updated = updateCandidate(Number(req.params.id), updates);
      res.json({ candidate: updated });
    });
  });

  router.get('/:id/resume', (req, res) => {
    const cand = getCandidate(Number(req.params.id));
    if (!cand || !cand.resume_path) {
      return res.status(404).json({ error: 'no resume' });
    }
    const abs = path.join(RESUMES_DIR, cand.resume_path);
    // Path safety: ensure resolved path stays within RESUMES_DIR
    const resolvedResumes = path.resolve(RESUMES_DIR);
    const resolvedFile = path.resolve(abs);
    if (!resolvedFile.startsWith(resolvedResumes + path.sep)) {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (!fs.existsSync(resolvedFile)) {
      return res.status(404).json({ error: 'file missing' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${cand.name}-resume.pdf"`);
    fs.createReadStream(resolvedFile).pipe(res);
  });

  return router;
}
