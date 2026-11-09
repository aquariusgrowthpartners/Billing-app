/**
 * AI-adjacent file endpoints.
 *
 * RA verification uses Azure Document Intelligence to read the original PDF or
 * image directly, including scanned and sideways documents. The extracted text
 * is then structured by the existing Azure text completion path.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { extractRaWithAzureDocIntel, complete } from '../aiService.js';
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

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const row = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[n];
}

/** 0..1 similarity; sorted tokens make "Last, First" == "First Last". */
function nameSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

const NAME_MATCH_THRESHOLD = 0.8;
const DATE_WINDOW_DAYS = 14;

const DB_CLAIM_SELECT = `
  SELECT cl.id, cl.claim_name, cl.status, cl.period_start, cl.period_end,
         cl.paid_amount, cl.total_dollars,
         cu.id AS client_id, cu.first_name, cu.last_name, cu.ma_number
    FROM claims cl
    JOIN clients cu ON cu.id = cl.client_id AND cu.agency_id = cl.agency_id
`;

/**
 * Find the closest claim for an extracted RA record.
 *
 * The query is a tenant-scoped ±14 day window. The extracted patient name is
 * compared against each database client name with Levenshtein similarity; the
 * best score above 80% wins. Provider/agency names naturally score poorly
 * against patient rows and are rejected.
 */
function findClaimForRecord(record, agencyId) {
  const range = parseDateRange(record?.date_of_service ?? record?.dateOfService);
  if (!range.start) return null;

  const raName = record?.client_name ?? record?.clientName;
  if (!normalizeName(raName)) return null;

  const from = addDays(range.start, -DATE_WINDOW_DAYS);
  const to = addDays(range.end || range.start, DATE_WINDOW_DAYS);
  const candidates = db
    .prepare(
      `${DB_CLAIM_SELECT}
        WHERE cl.agency_id = ?
          AND cl.period_start <= ?
          AND cl.period_end >= ?
        ORDER BY cl.period_start DESC, cl.id DESC`
    )
    .all(agencyId, to, from);

  let best = null;
  let bestScore = 0;
  for (const claim of candidates) {
    const dbName = `${claim.first_name ?? ''} ${claim.last_name ?? ''}`;
    const score = nameSimilarity(raName, dbName);
    if (score > bestScore) {
      best = claim;
      bestScore = score;
    }
  }

  if (!best || bestScore < NAME_MATCH_THRESHOLD) return null;
  return best;
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

/**
 * Process one uploaded RA file with the shared single-file/bulk pipeline:
 * Azure Document Intelligence → text completion → claim comparison.
 */
async function processRaFile(file, agencyId) {
  const extracted = await extractRaWithAzureDocIntel(
    file.buffer,
    file.mimetype || 'application/pdf'
  );
  const rawText = String(extracted?.text ?? '').trim();
  if (!rawText) {
    const err = new Error('Azure Document Intelligence failed to read this file.');
    err.status = 502;
    throw err;
  }

  const completion = await complete(
    `Here is the raw text extracted from an RA letter. Parse it into JSON.\n\n${rawText.slice(
      0,
      16000
    )}`,
    {
      system:
        'You are an expert medical billing auditor. Extract the Member ID, PATIENT/CLIENT name, Date of Service, and Amount Paid from the RA text. Do NOT extract the Provider or Agency name from the top of the letter. You are looking for the PATIENT/CLIENT name and MEMBER ID. If the extracted name matches the Agency name, ignore it and look further down the document. Return ONLY a JSON array using the keys member_id, client_name, date_of_service, amount_paid. If no patient/client records are present, return []. Do not include markdown formatting.',
      timeoutMs: 60000,
      agencyId,
    }
  );

  if (completion.source === 'none') {
    const err = new Error(completion.text || 'Azure text completion failed.');
    err.status = 502;
    throw err;
  }

  const records = parseJsonRecords(completion.text);
  if (!records) {
    const err = new Error('Azure text completion returned no JSON records.');
    err.status = 502;
    throw err;
  }

  return records.map((record) => verifyRecord(record, agencyId));
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
