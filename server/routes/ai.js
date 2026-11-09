/**
 * AI-adjacent file endpoints.
 *
 * RA verification is vision-first: PDFs are rasterised (first page) and sent
 * to Azure with the image, because RA letters are commonly scanned sideways.
 * The text completion functions in aiService.js are untouched.
 */
import express from 'express';
import multer from 'multer';
import { verifyRaDocument, complete } from '../aiService.js';
import db from '../db.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

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
      const isPdf =
        req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname);
      let records = null;

      if (!isPdf) {
        const result = await verifyRaDocument(
          req.file.buffer.toString('base64'),
          req.file.mimetype || 'image/png',
          req.agencyId
        );
        if (result.error) {
          const status = result.error.includes('quota provisioning') ? 503 : 502;
          return res.status(status).json({ error: result.error });
        }
        records = Array.isArray(result.records) ? result.records : [];
      } else {
        let renderError = null;
        try {
          const pngBuffer = await pdfFirstPagePng(req.file.buffer);
          const result = await verifyRaDocument(
            pngBuffer.toString('base64'),
            'image/png',
            req.agencyId
          );
          if (result.error) {
            const status = result.error.includes('quota provisioning') ? 503 : 502;
            return res.status(status).json({ error: result.error });
          }
          records = Array.isArray(result.records) ? result.records : [];
        } catch (err) {
          renderError = err;
          console.error('[PDF-RENDER-ERROR]', err?.stack || err?.message || String(err));
        }

        if (records === null) {
          // Canvas/pdfjs failed — fall back to text extraction and a text-only
          // Azure completion. This keeps the endpoint usable on hosts where
          // the native canvas binary is unavailable.
          try {
            const rawText = await extractPdfText(req.file.buffer);
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
                agencyId: req.agencyId,
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
            return res.status(500).json({
              error: `Could not process RA. Render error: ${renderMessage}. Fallback error: ${
                fallbackError?.message || String(fallbackError)
              }`,
            });
          }
        }
      }

      const compared = (records ?? []).map((record) => verifyRecord(record, req.agencyId));
      res.json({ status: 'success', records: compared });
    } catch (err) {
      console.error('[PDF-RENDER-ERROR] unhandled RA verification error:', err?.stack || err);
      return res.status(500).json({ error: err?.message || 'RA verification failed.' });
    }
  });
});

export default router;
