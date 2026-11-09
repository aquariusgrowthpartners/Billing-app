/**
 * AI-adjacent file endpoints.
 *
 * RA verification is vision-first: PDFs are rasterised (first page) and sent
 * to Azure with the image, because RA letters are commonly scanned sideways.
 * The text completion functions in aiService.js are untouched.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { verifyRaDocument, complete } from '../aiService.js';
import db from '../db.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const BULK_DIR = path.resolve('data', 'ra_bulk_uploads');
fs.mkdirSync(BULK_DIR, { recursive: true });

const bulkUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(BULK_DIR, req.bulkJobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').slice(0, 12);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 300 },
});

/*
 * In-memory queue, intentionally no Redis. The limit is global: at most two
 * files are processed at once across all jobs.
 */
const fileLimit = pLimit(2);

function allowedFile(file) {
  const name = String(file?.originalname ?? '');
  return (
    file?.mimetype === 'application/pdf' ||
    String(file?.mimetype ?? '').startsWith('image/') ||
    /\.(pdf|png|jpe?g|webp|heic|heif)$/i.test(name)
  );
}

async function pdfFirstPagePng(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');

  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await doc.cleanup?.();
  }
}

/**
 * RA values may arrive as numbers, "$1,234.56", " 1234.56 ", etc.
 * Strip whitespace, dollar signs and thousands separators, then parseFloat.
 * NaN is preserved deliberately so the caller can route it to a mismatch.
 */
function parseCurrency(value) {
  if (typeof value === 'number') return value;
  const normalized = String(value ?? '')
    .replace(/\s/g, '')
    .replace(/\$/g, '')
    .replace(/,/g, '');
  return parseFloat(normalized);
}

function money(value) {
  const n = parseCurrency(value);
  return Number.isFinite(n)
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
}

/** Parse ISO or US dates into an inclusive range. */
function parseDateRange(value) {
  const text = String(value ?? '');
  const isos = [...text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map(
    (m) => `${m[1]}-${m[2]}-${m[3]}`
  );
  if (isos.length) return { start: isos[0], end: isos[isos.length - 1] };

  const us = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)].map(
    (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  );
  if (us.length) return { start: us[0], end: us[us.length - 1] };

  return { start: null, end: null };
}

/** "MATTSON, SAMANTHA" or "SAMANTHA MATTSON" -> {last, first}. */
function splitClientName(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes(',')) {
    const [last, ...rest] = text.split(',');
    const first = rest.join(',').trim();
    if (!last.trim()) return null;
    return { last: last.trim(), first };
  }
  const parts = text.split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts.pop();
  return { last, first: parts.join(' ') };
}

const DB_CLAIM_SELECT = `
  SELECT cl.id, cl.claim_name, cl.status, cl.period_start, cl.period_end,
         cl.paid_amount, cl.total_dollars,
         cu.id AS client_id, cu.first_name, cu.last_name, cu.ma_number
    FROM claims cl
    JOIN clients cu ON cu.id = cl.client_id AND cu.agency_id = cl.agency_id
`;

/** Find the claim a single extracted RA record refers to. */
function findClaimForRecord(record, agencyId) {
  const member = String(record?.member_id ?? record?.memberId ?? '').trim();
  const parsedName = splitClientName(record?.client_name ?? record?.clientName);
  const range = parseDateRange(record?.date_of_service ?? record?.dateOfService);

  // The model sometimes returns the claim name in the member_id field.
  if (member) {
    const byName = db
      .prepare(`${DB_CLAIM_SELECT} WHERE cl.agency_id = ? AND lower(cl.claim_name) = lower(?) LIMIT 1`)
      .get(agencyId, member);
    if (byName) return byName;
  }

  let client = null;
  if (member) {
    client = db
      .prepare(
        `SELECT id, first_name, last_name, ma_number
           FROM clients
          WHERE agency_id = ? AND lower(COALESCE(ma_number, '')) = lower(?)
          LIMIT 1`
      )
      .get(agencyId, member);
  }

  if (!client && parsedName?.last) {
    client = db
      .prepare(
        `SELECT id, first_name, last_name, ma_number
           FROM clients
          WHERE agency_id = ?
            AND lower(last_name) = lower(?)
            AND lower(COALESCE(first_name, '')) LIKE lower(?)
          ORDER BY id DESC
          LIMIT 1`
      )
      .get(agencyId, parsedName.last, `%${parsedName.first}%`);
  }

  if (!client) return null;

  const params = [agencyId, client.id];
  let dateSql = '';
  if (range.start && range.end) {
    dateSql = ' AND cl.period_start <= ? AND cl.period_end >= ?';
    params.push(range.end, range.start);
  } else if (range.start) {
    dateSql = ' AND cl.period_start <= ? AND cl.period_end >= ?';
    params.push(range.start, range.start);
  }

  return (
    db
      .prepare(
        `${DB_CLAIM_SELECT}
          WHERE cl.agency_id = ? AND cl.client_id = ?${dateSql}
          ORDER BY cl.period_start DESC
          LIMIT 1`
      )
      .get(...params) ?? null
  );
}

/** Compare one extracted record with its DB claim. */
function verifyRecord(record, agencyId) {
  const claim = findClaimForRecord(record, agencyId);
  if (!claim) {
    return {
      ra_data: record,
      db_data: null,
      status: 'missing_in_db',
      discrepancy: 'No matching claim found in the database.',
    };
  }

  const raAmount = parseCurrency(record?.amount_paid ?? record?.amountPaid);
  const dbAmount = parseCurrency(claim.paid_amount);
  if (!Number.isFinite(raAmount) || !Number.isFinite(dbAmount)) {
    return {
      ra_data: record,
      db_data: claim,
      status: 'mismatch',
      discrepancy: 'Could not parse amount',
    };
  }

  if (Math.abs(raAmount - dbAmount) < 0.01) {
    return { ra_data: record, db_data: claim, status: 'match', discrepancy: null };
  }

  return {
    ra_data: record,
    db_data: claim,
    status: 'mismatch',
    discrepancy: `Amount mismatch: RA says ${money(raAmount)}, DB says ${money(dbAmount)}.`,
  };
}

function parseJsonRecords(text) {
  const cleaned = String(text ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/** Last-resort text extraction when rasterising the PDF fails. */
async function extractPdfText(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text ?? '').trim();
  } finally {
    await parser.cleanup?.();
  }
}

/**
 * Process one uploaded RA file with the exact single-file pipeline:
 * PDF raster → Azure Vision, with pdf-parse/text-completion fallback.
 * Returned records are already compared against the tenant's claims.
 */
async function processRaFile(file, agencyId) {
  const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
  let records = null;

  if (!isPdf) {
    const result = await verifyRaDocument(
      file.buffer.toString('base64'),
      file.mimetype || 'image/png',
      agencyId
    );
    if (result.error) {
      const status = result.error.includes('quota provisioning') ? 503 : 502;
      const err = new Error(result.error);
      err.status = status;
      throw err;
    }
    records = Array.isArray(result.records) ? result.records : [];
  } else {
    let renderError = null;
    try {
      const pngBuffer = await pdfFirstPagePng(file.buffer);
      const result = await verifyRaDocument(pngBuffer.toString('base64'), 'image/png', agencyId);
      if (result.error) {
        const status = result.error.includes('quota provisioning') ? 503 : 502;
        const err = new Error(result.error);
        err.status = status;
        throw err;
      }
      records = Array.isArray(result.records) ? result.records : [];
    } catch (err) {
      renderError = err;
      console.error('[PDF-RENDER-ERROR]', err?.stack || err?.message || String(err));
    }

    if (records === null) {
      try {
        const rawText = await extractPdfText(file.buffer);
        if (!rawText) throw new Error('PDF text extraction returned no text.');

        const completion = await complete(
          `Here is the raw text extracted from an RA letter. Parse it into JSON.\n\n${rawText.slice(
            0,
            16000
          )}`,
          {
            system:
              'You are an expert medical billing auditor. Extract the Member ID, Client Name, Date of Service, and Amount Paid from the RA text. Return ONLY a JSON array using the keys member_id, client_name, date_of_service, amount_paid. Do not include markdown formatting.',
            timeoutMs: 60000,
            agencyId,
          }
        );

        if (completion.source === 'none') {
          throw new Error(completion.text || 'Azure text completion failed.');
        }
        records = parseJsonRecords(completion.text);
        if (!records) throw new Error('Azure text completion returned no JSON records.');
      } catch (fallbackError) {
        console.error(
          '[PDF-RENDER-ERROR] text fallback failed:',
          fallbackError?.stack || fallbackError?.message || String(fallbackError)
        );
        const renderMessage =
          renderError?.message || renderError?.toString() || 'unknown render error';
        const err = new Error(
          `Could not process RA. Render error: ${renderMessage}. Fallback error: ${
            fallbackError?.message || String(fallbackError)
          }`
        );
        err.status = 500;
        throw err;
      }
    }
  }

  return (records ?? []).map((record) => verifyRecord(record, agencyId));
}

/** POST /api/ai/verify-ra — multipart field name: file */
router.post('/verify-ra', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than the 15 MB limit.'
          : 'The file could not be uploaded.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or image to verify.' });
    if (!allowedFile(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF or image file.' });
    }

    try {
      const records = await processRaFile(req.file, req.agencyId);
      res.json({ status: 'success', records });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[PDF-RENDER-ERROR] unhandled RA verification error:', err?.stack || err);
      return res.status(500).json({ error: err?.message || 'RA verification failed.' });
    }  });
});


/* ------------------------------------------------------------------ bulk */

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
console.warn('[bulk] in-memory RA queue enabled (concurrency 2); jobs will be lost on restart.');

function jobIsTimedOut(row) {
  if (!row || !['queued', 'processing'].includes(row.status)) return false;
  const created = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
  return Number.isFinite(created) && Date.now() - created > JOB_TIMEOUT_MS;
}

function markJobTimedOut(jobId) {
  db.prepare(
    `UPDATE ra_verification_jobs
        SET status = 'failed', error = 'Job timed out', updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'processing')`
  ).run(jobId);
}

function parseResults(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function runBulkJob(job) {
  try {
    const row = db
      .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
      .get(job.id);
    if (!row) return;
    if (jobIsTimedOut(row)) {
      markJobTimedOut(job.id);
      return;
    }

    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'processing', updated_at = datetime('now')
        WHERE id = ?`
    ).run(job.id);

    let stopped = false;
    await Promise.all(
      job.files.map((file) =>
        fileLimit(async () => {
          if (stopped) return;

          const current = db
            .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
            .get(job.id);
          if (jobIsTimedOut(current)) {
            stopped = true;
            markJobTimedOut(job.id);
            return;
          }

          let entry;
          try {
            const buffer = fs.readFileSync(file.path);
            const records = await processRaFile(
              {
                buffer,
                originalname: file.originalname,
                mimetype: file.mimetype,
              },
              job.agencyId
            );
            entry = { file_name: file.originalname, status: 'completed', records };
          } catch (err) {
            entry = {
              file_name: file.originalname,
              status: 'error',
              records: [],
              error: err?.message || 'File processing failed.',
            };
          }

          if (stopped) return;
          job.results.push(entry);
          db.prepare(
            `UPDATE ra_verification_jobs
                SET processed_files = processed_files + 1,
                    results_json = ?,
                    updated_at = datetime('now')
              WHERE id = ?`
          ).run(JSON.stringify(job.results), job.id);
        })
      )
    );

    if (stopped) return;

    const finalRow = db
      .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
      .get(job.id);
    if (jobIsTimedOut(finalRow)) {
      markJobTimedOut(job.id);
      return;
    }

    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'completed',
              processed_files = ?,
              results_json = ?,
              error = NULL,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(job.files.length, JSON.stringify(job.results), job.id);

    fs.rm(path.join(BULK_DIR, job.id), { recursive: true, force: true }, () => {});
  } catch (err) {
    console.error('[bulk] job failed:', err?.stack || err);
    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'failed', error = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(err?.message || 'Bulk job failed.', job.id);
  }
}

/** POST /api/ai/verify-ra-bulk — multipart field name: files (max 300). */
router.post(
  '/verify-ra-bulk',
  (req, _res, next) => {
    req.bulkJobId = crypto.randomUUID();
    next();
  },
  (req, res) => {
    bulkUpload.array('files', 300)(req, res, (err) => {
      const dir = path.join(BULK_DIR, req.bulkJobId);
      if (err) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Each file must be 15 MB or smaller.'
            : err.code === 'LIMIT_FILE_COUNT'
              ? 'You can upload at most 300 files at once.'
              : 'The files could not be uploaded.';
        return res.status(400).json({ error: message });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({ error: 'Choose at least one PDF or image.' });
      }
      const invalid = files.find((file) => !allowedFile(file));
      if (invalid) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        return res.status(400).json({ error: `Unsupported file: ${invalid.originalname}` });
      }

      const jobId = req.bulkJobId;
      try {
        db.prepare(
          `INSERT INTO ra_verification_jobs
             (id, agency_id, status, total_files, processed_files, results_json, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, 0, '[]', datetime('now'), datetime('now'))`
        ).run(jobId, req.agencyId, files.length);
      } catch (dbError) {
        console.error('[bulk] could not create job:', dbError);
        fs.rm(dir, { recursive: true, force: true }, () => {});
        return res.status(500).json({ error: 'Could not create the bulk job.' });
      }

      const job = {
        id: jobId,
        agencyId: req.agencyId,
        files: files.map((file) => ({
          path: file.path,
          originalname: file.originalname,
          mimetype: file.mimetype,
        })),
        results: [],
      };

      // Return before processing. The global p-limit(2) controls concurrency.
      res.status(202).json({ jobId, status: 'queued' });
      runBulkJob(job).catch((err) => {
        console.error('[bulk] unhandled worker error:', err?.stack || err);
      });
    });
  }
);

/** GET /api/ai/verify-ra-bulk/:jobId — tenant-scoped progress/results. */
router.get('/verify-ra-bulk/:jobId', (req, res) => {
  let row = db
    .prepare(
      `SELECT id, status, total_files, processed_files, results_json, error, created_at
         FROM ra_verification_jobs
        WHERE id = ? AND agency_id = ?`
    )
    .get(req.params.jobId, req.agencyId);

  if (!row) return res.status(404).json({ error: 'Bulk job not found.' });

  if (jobIsTimedOut(row)) {
    markJobTimedOut(row.id);
    row = db
      .prepare(
        `SELECT id, status, total_files, processed_files, results_json, error, created_at
           FROM ra_verification_jobs
          WHERE id = ? AND agency_id = ?`
      )
      .get(req.params.jobId, req.agencyId);
  }

  res.json({
    status: row.status,
    total_files: row.total_files,
    processed_files: row.processed_files,
    results: parseResults(row.results_json),
    error: row.error,
  });
});

export default router;
