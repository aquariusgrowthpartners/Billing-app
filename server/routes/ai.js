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
import {
  extractRaWithAzureDocIntel,
  complete,
  verifyRaDocument,
  RA_TEXT_SYSTEM_PROMPT,
} from '../aiService.js';
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

  // Minnesota RAs often use MM-DD-YY, including concatenated daily dates.
  const dashed = [...text.matchAll(/\b(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\b/g)].map((m) => {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  });
  if (dashed.length) return { start: dashed[0], end: dashed[dashed.length - 1] };

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

/**
 * Vision models sometimes return labels ("PATIENT/CLIENT", "Member ID") while
 * the text path returns snake_case keys. Canonicalize both before comparison.
 */
function normalizeRaRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  const value = (...keys) => {
    const aliases = new Set(keys.map(normalizeKey));
    for (const [key, candidate] of Object.entries(record)) {
      if (
        aliases.has(normalizeKey(key)) &&
        candidate !== undefined &&
        candidate !== null &&
        String(candidate).trim() !== ''
      ) {
        return candidate;
      }
    }
    return undefined;
  };

  return {
    ...record,
    member_id: value('member_id', 'memberId', 'Member ID', 'MemberId', 'member id'),
    client_name: value(
      'client_name',
      'clientName',
      'Client Name',
      'PATIENT/CLIENT',
      'Patient/Client',
      'Patient/Client Name',
      'Patient Name',
      'patient_name',
      'Client'
    ),
    date_of_service: value(
      'date_of_service',
      'dateOfService',
      'Date of Service',
      'Dates of Service',
      'Date(s) of Service',
      'date of service',
      'dates of service',
      'DOS'
    ),
    amount_paid: value('amount_paid', 'amountPaid', 'Amount Paid', 'amount paid', 'Paid Amount'),
  };
}

/**
 * Split a field containing multiple dates mashed together, e.g.
 * "03-20-2603-21-26" -> ["03-20-26", "03-21-26"].
 */
function splitConcatenatedDates(value) {
  const text = String(value ?? '').trim();
  const matches = [...text.matchAll(/(\d{2}-\d{2}-\d{2})/g)].map((m) => m[1]);
  if (matches.length < 2) return [text];
  const compact = text.replace(/[^0-9-]/g, '');
  if (compact !== matches.join('')) return [text];
  return matches;
}

/** Duplicate a record once per individual date before claim matching. */
function expandConcatenatedDateRecords(records) {
  const expanded = [];
  for (const record of records) {
    const normalized = normalizeRaRecord(record);
    const dates = splitConcatenatedDates(normalized.date_of_service);
    if (dates.length > 1) {
      console.log(
        `[PARSER] Split concatenated date "${normalized.date_of_service}" into ${dates.length} records`
      );
      for (const date of dates) {
        expanded.push({ ...normalized, date_of_service: date, dateOfService: date });
      }
    } else {
      expanded.push(normalized);
    }
  }
  return expanded;
}

/** Compare one extracted record with its DB claim. */
function verifyRecord(record, agencyId) {
  record = normalizeRaRecord(record);
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

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Group daily RA records by their DB claim, sum only dates inside the claim
 * period, and compare the aggregate to the claim total.
 */
function groupRecordsByClaim(records, agencyId) {
  const groups = new Map();
  const missing = [];

  for (const input of records) {
    const record = normalizeRaRecord(input);
    const claim = findClaimForRecord(record, agencyId);
    if (!claim) {
      missing.push({
        ra_data: record,
        db_data: null,
        status: 'missing_in_db',
        discrepancy: 'No matching claim found in the database.',
      });
      continue;
    }
    const key = String(claim.id);
    if (!groups.has(key)) groups.set(key, { claim, records: [] });
    groups.get(key).records.push(record);
  }

  const results = [];
  for (const { claim, records: claimRecords } of groups.values()) {
    const periodStart = parseDateRange(claim.period_start).start;
    const periodEnd = parseDateRange(claim.period_end).end;
    const eligible = periodStart && periodEnd
      ? claimRecords.filter((record) => {
          const range = parseDateRange(record.date_of_service);
          const start = range.start;
          const end = range.end || range.start;
          return start && end && start <= periodEnd && end >= periodStart;
        })
      : claimRecords;

    if (periodStart && periodEnd && eligible.length === 0) {
      for (const record of claimRecords) {
        missing.push({
          ra_data: record,
          db_data: claim,
          status: 'missing_in_db',
          discrepancy: 'No RA date falls inside this claim period.',
        });
      }
      continue;
    }

    const amounts = eligible
      .map((record) => parseCurrency(record.amount_paid))
      .filter(Number.isFinite);
    const raTotal = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
    const dbAmount = parseCurrency(claim.paid_amount);
    const primary = eligible[0];
    let status;
    let discrepancy = null;

    if (!amounts.length || !Number.isFinite(dbAmount)) {
      status = 'mismatch';
      discrepancy = 'Could not parse amount';
    } else if (Math.abs(raTotal - dbAmount) < 0.01) {
      status = 'match';
    } else {
      status = 'mismatch';
      discrepancy = `Amount mismatch: RA total ${money(raTotal)}, DB ${money(dbAmount)}.`;
    }

    results.push({
      ra_data: {
        ...primary,
        amount_paid: raTotal,
        date_of_service:
          periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : primary.date_of_service,
        claim_period_start: periodStart,
        claim_period_end: periodEnd,
        daily_records: eligible.map((record) => ({
          date_of_service: record.date_of_service,
          amount_paid: parseCurrency(record.amount_paid),
        })),
      },
      db_data: claim,
      status,
      discrepancy,
    });
  }

  console.log(
    `[RA] Grouped ${records.length} RA record(s) into ${results.length} claim result(s) and ${missing.length} unmatched record(s).`
  );
  return [...results, ...missing];
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

const COVER_MARKER = 'REMITTANCE ADVICE MESSAGE';

/**
 * Minnesota RAs put a "Remittance Advice Message" cover page before the
 * claims. Drop everything through the LAST marker so only claim data reaches
 * the text completion model.
 */
function stripCoverPages(text) {
  const source = String(text ?? '');
  const index = source.toLowerCase().lastIndexOf(COVER_MARKER.toLowerCase());
  if (index === -1) return { text: source.trim(), hadCover: false };
  return {
    text: source.slice(index + COVER_MARKER.length).trim(),
    hadCover: true,
  };
}

function cleanRaText(rawText) {
  if (rawText.length < 400) return { text: rawText, hadCover: false };
  return stripCoverPages(rawText);
}

/**
 * Process one uploaded RA file with the shared single-file/bulk pipeline:
 * Azure Document Intelligence → text completion → claim comparison.
 */
async function processRaFile(file, agencyId) {
  const isPdf =
    file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
  let rawText = '';

  if (isPdf) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: file.buffer });
      try {
        const result = await parser.getText();
        rawText = String(result?.text ?? '').trim();
      } finally {
        await parser.destroy?.();
      }
    } catch (err) {
      const e = new Error(`Could not extract text from this PDF: ${err.message}`);
      e.status = 422;
      throw e;
    }
    console.log(`[PARSER] Extracted raw text length: ${rawText.length} characters`);
    console.log(`[PARSER] Text sample: ${rawText.slice(0, 500)}`);
    if (!rawText) {
      const err = new Error('No extractable text found in this PDF.');
      err.status = 422;
      throw err;
    }
  } else {
    // Doc Intel remains the image-only path; PDFs use pdf-parse above.
    const extracted = await extractRaWithAzureDocIntel(
      file.buffer,
      file.mimetype || 'image/png'
    );
    rawText = String(extracted?.text ?? '').trim();
  }

  const clean = cleanRaText(rawText);
  const claimText = clean.text;
  console.log(
    `[PARSER] Clean text length: ${claimText.length} characters; cover marker found: ${clean.hadCover}`
  );

  if (clean.hadCover && claimText.length < 50) {
    const err = new Error('Document appears to contain only cover pages. No claim data found.');
    err.status = 422;
    throw err;
  }

  // PDFs always go through the parser + completion path. Vision is retained
  // only for image uploads whose Doc Intel text is too short.
  const useVisionFallback = !isPdf && !clean.hadCover && rawText.length < 400;
  console.log(
    `[${isPdf ? 'PARSER' : 'DOC-INTEL'}] Final text length: ${
      claimText.length
    } characters. Triggering Vision fallback: ${useVisionFallback}`
  );

  if (useVisionFallback) {
    console.log('[VISION-FALLBACK] Sending image directly to Azure Vision');
    const vision = await verifyRaDocument(
      file.buffer.toString('base64'),
      file.mimetype || 'image/png',
      agencyId,
      60000,
      'This is an RA letter. Read all text and extract the Patient Name, Member ID, Date of Service, and Amount Paid. Return JSON.'
    );
    if (vision.error) {
      const err = new Error(`Vision fallback failed: ${vision.error}`);
      err.status = vision.error.includes('quota') ? 503 : 502;
      throw err;
    }
    const visionRecords = Array.isArray(vision.records) ? vision.records : [];
    return {
      records: groupRecordsByClaim(
        expandConcatenatedDateRecords(visionRecords),
        agencyId
      ),
      rawText,
    };
  }

  const completion = await complete(
    `Here is the text extracted from an RA letter:\n\n${claimText.slice(
      0,
      15000
    )}\n\nExtract the records.`,
    {
      system: RA_TEXT_SYSTEM_PROMPT,
      timeoutMs: 60000,
      agencyId,
      maxOutputTokens: 4000,
    }
  );

  if (completion.source === 'none') {
    console.warn(
      '[AI-EMPTY-RESPONSE] completion source none:',
      completion.text || '(no response text)'
    );
    const err = new Error(completion.text || 'Azure text completion failed.');
    err.status = 502;
    throw err;
  }

  const records = parseJsonRecords(completion.text);
  if (!records) {
    console.warn('[AI-EMPTY-RESPONSE] Could not parse AI response:', completion.text);
    const err = new Error('Azure text completion returned no JSON records.');
    err.status = 502;
    throw err;
  }
  if (records.length === 0) {
    console.warn('[AI-EMPTY-RESPONSE]', completion.text);
  }

  return {
    records: groupRecordsByClaim(
      expandConcatenatedDateRecords(records),
      agencyId
    ),
    rawText,
  };
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
      const { records, rawText } = await processRaFile(req.file, req.agencyId);
      res.json({
        status: 'success',
        records,
        ...(records.length === 0 ? { raw_text: rawText } : {}),
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[PDF-RENDER-ERROR] unhandled RA verification error:', err?.stack || err);
      return res.status(500).json({ error: err?.message || 'RA verification failed.' });
    }  });
});


/** GET /api/ai/debug-status — whether the optional Doc Intel debug panel is enabled. */
router.get('/debug-status', (req, res) => {
  res.json({ debug_mode: String(process.env.DEBUG_MODE ?? '').toLowerCase() === 'true' });
});

/** POST /api/ai/test-doc-intel — Doc Intel extraction only, no AI call. */
router.post('/test-doc-intel', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'The file could not be uploaded.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or image.' });
    if (!allowedFile(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF or image file.' });
    }
    try {
      const extracted = await extractRaWithAzureDocIntel(
        req.file.buffer,
        req.file.mimetype || 'application/pdf'
      );
      const rawText = String(extracted?.text ?? '').trim();
      res.json({
        raw_text: rawText,
        length: rawText.length,
        tables: Array.isArray(extracted?.tables) ? extracted.tables : [],
        file: req.file.originalname,
      });
    } catch (e) {
      console.error('[DOC-INTEL] test extraction failed:', e?.stack || e);
      res.status(e.status || 500).json({ error: e.message || 'Doc Intel extraction failed.' });
    }
  });
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
            const processed = await processRaFile(
              {
                buffer,
                originalname: file.originalname,
                mimetype: file.mimetype,
              },
              job.agencyId
            );
            entry = {
              file_name: file.originalname,
              status: 'completed',
              records: processed.records,
              ...(processed.records.length === 0 ? { raw_text: processed.rawText } : {}),
            };
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
