/**
 * Remittance Advice import.
 *
 * Parsing and matching are read-only. The only endpoint that writes anything is
 * POST /api/import-ra/save, which the UI calls when "Save All" is pressed.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, degrees } from 'pdf-lib';
import { ZipArchive } from 'archiver';
import { storeUpload, readStored, deleteUploadIfUnreferenced, storageUsed } from '../raStore.js';
import { markOrphanedImports } from '../denials.js';
import db from '../db.js';
import { todayISO, round2 } from '../calc.js';
import { parseRemittance, visitTimes, MINUTES_PER_UNIT } from '../raImport.js';
import { buildClaimName } from './claims.js';
import { saveDeniedBlock, runRecovery, ensureRebillTasks } from '../denials.js';
import { resolveStored } from '../pdfStorage.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // One file for the single-file route...
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

// ...and up to 35 for the batch route (30 requested + headroom).
const uploadBatch = multer({
  storage: multer.memoryStorage(),
  // 30 per batch plus headroom, so a stray extra is not the thing that fails.
  limits: { fileSize: 25 * 1024 * 1024, files: 35, fieldSize: 2 * 1024 * 1024 },
});

/**
 * Longest a whole batch may run before the server gives up on it.
 *
 * Files are parsed sequentially, so this is a wall-clock guard rather than a
 * per-file one. The batch loop also watches the clock and stops early with a
 * clear report, which is friendlier than the socket dying mid-response.
 */
export const BATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Leave room to serialise the response before the socket timeout lands. */
const BATCH_DEADLINE_MARGIN_MS = 15 * 1000;

const NOT_AN_RA =
  'Could not extract data from this PDF. Please confirm it is a valid MHCP Remittance Advice file.';

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Normalize sideways/scanned page rotation before the text parser sees it. */
async function rotateImportPdf(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer);
    let changed = false;
    for (const page of pdf.getPages()) {
      const rawAngle = page.getRotation()?.angle ?? 0;
      const angle = ((rawAngle % 360) + 360) % 360;
      if (angle !== 0) {
        console.log(`[IMPORT-ROTATION] Detected rotation: ${angle} degrees. Rotated to 0.`);
        page.setRotation(degrees(0));
        changed = true;
      }
    }
    return changed ? Buffer.from(await pdf.save()) : buffer;
  } catch (err) {
    console.warn(`[IMPORT-ROTATION] Could not normalize PDF: ${err.message}`);
    return buffer;
  }
}

/* --------------------------------------------------------------- matching */

/** Standard edit distance, small inputs only. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Split a patient name from an advice.
 *
 * MHCP prints names as "LASTNAME FIRSTNAME MI" (e.g. "SIMS SARAH E"), but the
 * comma form "SMITH, JOHN A" also turns up, so both are handled. A trailing
 * one- or two-letter token is treated as the middle initial, not a surname.
 */
export function splitPatientName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return { last: '', first: '', middle: '' };

  let lastPart;
  let restPart;
  if (raw.includes(',')) {
    const [before, ...after] = raw.split(',');
    lastPart = before;
    restPart = after.join(' ');
  } else {
    const parts = raw.split(/\s+/).filter(Boolean);
    if (!parts.length) return { last: '', first: '', middle: '' };
    if (parts.length === 1) return { last: norm(parts[0]), first: '', middle: '' };
    // "LASTNAME FIRSTNAME [MI]"
    lastPart = parts[0];
    restPart = parts.slice(1).join(' ');
  }

  const rest = restPart.split(/\s+/).filter(Boolean);
  const first = rest.shift() ?? '';
  let middle = '';
  if (rest.length) {
    const tail = rest[rest.length - 1];
    if (/^[A-Za-z]\.?$/.test(tail) || /^[A-Za-z]{2}$/.test(tail)) middle = norm(tail).replace(/\./g, '');
  }
  return { last: norm(lastPart), first: norm(first), middle };
}

/**
 * Best non-archived client for a name from the PDF.
 *
 * Last name and first name (or first initial) are both required. When the
 * advice carries a middle initial and the client has one on file they must
 * agree; when the advice has one but the client does not, the match is still
 * allowed but reported as lower confidence so it can be eyeballed.
 *
 * Returns null rather than guessing when nothing is close enough.
 */
export function matchClient(name, patientId = null, agencyId = null) {
  const candidates = db
    .prepare(
      `SELECT id, first_name, last_name, middle_initial, ma_number, active
       FROM clients
       WHERE COALESCE(archived, 0) = 0
         AND (? IS NULL OR agency_id = ?)`
    )
    .all(agencyId ?? null, agencyId ?? null);

  /*
   * MA number first.
   *
   * It is the only identifier that survives a legal name change. Sarah's
   * advice still reads "SIMS SARAH E" under the plan while her record here is
   * "NNADIKWE SARAH E"; matching on the name alone dropped $1,432.81 of her
   * money. The MA number ties the two together unambiguously.
   */
  const wantId = String(patientId ?? '').replace(/\D/g, '');
  if (wantId) {
    const byMa = candidates.find(
      (c) => String(c.ma_number ?? '').replace(/\D/g, '') === wantId
    );
    if (byMa) return { ...byMa, matched_by: 'ma_number' };
  }

  const { last, first, middle } = splitPatientName(name);
  if (!last || !first) return null;

  let best = null;
  for (const c of candidates) {
    const cl = norm(c.last_name);
    if (!cl) continue;

    // Last name: exact, or within a single edit (typo tolerance).
    const similarity = 1 - editDistance(last, cl) / Math.max(last.length, cl.length);
    if (similarity < 0.8) continue;

    // First name: exact, or the advice only gave an initial.
    const cf = norm(c.first_name);
    if (!cf) continue;
    const firstExact = cf === first;
    const firstInitial = cf.startsWith(first[0]);
    if (!firstExact && !firstInitial) continue;

    // Middle initial.
    const cm = norm(c.middle_initial).replace(/\./g, '');
    let confidence = 'strong';
    if (middle) {
      if (cm) {
        if (cm[0] !== middle[0]) continue; // both present, and they disagree
      } else {
        confidence = 'possible'; // on the advice but not on file
      }
    }
    if (!firstExact) confidence = 'possible';
    if (similarity < 1) confidence = 'possible';

    const score = similarity * 100 + (firstExact ? 20 : 10) + (middle && cm ? 5 : 0);
    if (!best || score > best.score) best = { client: c, score, confidence };
  }

  if (!best) return null;
  return {
    ...best.client,
    match_score: Math.round(best.score) / 100,
    match_confidence: best.confidence,
  };
}

/**
 * Caretaker whose npi_number matches the remittance's REND PROV ID.
 *
 * The Rend Prov ID on an MHCP advice IS the caregiver's NPI, so this is the
 * join key between the PDF and the caretakers table. Inactive caretakers are
 * only used as a fallback, so a retired-but-still-billing caregiver still
 * resolves while a current one wins ties.
 */
export function caretakerByNpi(npi, agencyId = null) {
  const key = String(npi ?? '').trim();
  if (!key) return null;
  return (
    db
      .prepare(
        `SELECT * FROM caretakers
         WHERE UPPER(TRIM(COALESCE(npi_number, ''))) = UPPER(@npi)
           AND (@agency IS NULL OR agency_id = @agency)
         ORDER BY active DESC, id ASC
         LIMIT 1`
      )
      .get({ npi: key, agency: agencyId ?? null }) ?? null
  );
}

/* ------------------------------------------------------------------ parse */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Keep a file that failed to parse, so it can be looked at later.
 * Marked 'parse_failed' so the audit can single it out.
 */
function recordFailedParse(file, reason, agencyId) {
  if (!file?.buffer) return;
  try {
    const stored = storeUpload(file.buffer);
    db.prepare(
      `INSERT INTO ra_imports
         (imported_at, num_clients, total_payment, file_name, file_hash, pdf_path,
            claim_count, denial_count, status, agency_id)
       VALUES (datetime('now'), 0, 0, @file, @hash, @path, 0, 0, 'parse_failed', @agency)`
    ).run({
      file: file.originalname ?? 'unnamed.pdf',
      hash: stored.hash,
      path: stored.path,
      agency: agencyId ?? null,
    });
    console.log(`[import-ra] parse failed (${reason}) — kept ${stored.path}`);
  } catch {
    /* never let bookkeeping mask the parse error */
  }
}

/** The three header values that identify the same advice even if the bytes differ. */
const headerOf = (header) => ({
  check_eft_number: header?.check_eft_number ?? null,
  prod_date: header?.prod_date ?? null,
  vendor_number: header?.vendor_number ?? null,
});

/** Any ACTIVE import with this exact content hash. */
function importByHash(hash, agencyId) {
  if (!hash) return null;
  return (
    db
      .prepare(
        `SELECT * FROM ra_imports WHERE file_hash = ? AND status = 'active' AND agency_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(hash, agencyId) ?? null
  );
}

/** Any ACTIVE import with all three header identifiers matching. */
function importByHeader(header, agencyId) {
  const h = headerOf(header);
  if (!h.check_eft_number || !h.prod_date) return null;
  return (
    db
      .prepare(
        `SELECT * FROM ra_imports
         WHERE status = 'active' AND agency_id = @agency
             AND check_eft_number = @check AND prod_date = @prod
           AND COALESCE(vendor_number, '') = COALESCE(@vendor, '')
         ORDER BY id DESC LIMIT 1`
      )
      .get({ check: h.check_eft_number, prod: h.prod_date, vendor: h.vendor_number, agency: agencyId }) ?? null
  );
}

/**
 * What a previous import produced — the numbers the warning modal quotes.
 */
function importFootprint(importId, agencyId) {
  const scoped = Number.isInteger(agencyId);
  const and = scoped ? ' AND agency_id = ?' : '';
  const args = (extra) => (scoped ? [...extra, agencyId] : extra);
  const count = (sql, extra) => db.prepare(sql).get(...args(extra)).n;

  return {
    claims: count(`SELECT COUNT(*) AS n FROM claims WHERE ra_import_id = ?${and}`, [importId]),
    day_entries: count(
      `SELECT COUNT(*) AS n FROM day_entries WHERE ra_import_id = ? AND source = 'ra_import'${and}`,
      [importId]
    ),
    denials: count(
      `SELECT COUNT(*) AS n FROM denied_claims WHERE ra_import_id = ?${and}`,
      [importId]
    ),
  };
}

/**
 * Downstream activity that makes an overwrite risky.
 *
 * Anything here means the previous import has already been acted on: a payer
 * processed a claim, a denial was recovered, or a human edited an entry. The
 * overwrite is still allowed, but only behind a stronger confirmation.
 */
function overwriteRisks(importId, agencyId) {
  const scoped = Number.isInteger(agencyId);
  const and = scoped ? ' AND agency_id = ?' : '';
  const args = (extra) => (scoped ? [...extra, agencyId] : extra);
  const count = (sql, extra) => db.prepare(sql).get(...args(extra)).n;

  const paidClaims = count(
    `SELECT COUNT(*) AS n FROM claims
       WHERE ra_import_id = ? AND status = 'Paid' AND paid_date IS NOT NULL${and}`,
    [importId]
  );

  const recoveredDenials = count(
    `SELECT COUNT(*) AS n FROM denied_claims
       WHERE ra_import_id = ? AND recovery_status IN ('recovered', 'partial')${and}`,
    [importId]
  );

  // An RA entry whose numbers no longer match what the import wrote is a sign
  // somebody edited it by hand afterwards.
  const editedEntries = count(
    `SELECT COUNT(*) AS n FROM day_entries
       WHERE ra_import_id = ? AND source = 'ra_import'
         AND (notes IS NULL OR notes <> 'Imported from RA')${and}`,
    [importId]
  );

  return {
    paid_claims: paidClaims,
    recovered_denials: recoveredDenials,
    edited_entries: editedEntries,
    risky: paidClaims + recoveredDenials + editedEntries > 0,
  };
}

/**
 * Remove everything one import created. Never touches a manual row.
 *
 * Order matters: rebill tasks cascade from line items which cascade from the
 * denials, but they are deleted explicitly so the counts are reportable.
 */
function purgeImport(importId, agencyId) {
  const scoped = Number.isInteger(agencyId);
  const and = scoped ? ' AND agency_id = ?' : '';
  const args = (extra) => (scoped ? [...extra, agencyId] : extra);
  const footprint = importFootprint(importId, agencyId);

  db.prepare(
    `DELETE FROM rebill_tasks WHERE denied_line_item_id IN (
       SELECT i.id FROM denied_line_items i
       JOIN denied_claims c ON c.id = i.denied_claim_id
       WHERE c.ra_import_id = ?${scoped ? ' AND c.agency_id = ?' : ''})`
  ).run(...args([importId]));
  db.prepare(
    `DELETE FROM denied_line_items WHERE denied_claim_id IN (
       SELECT id FROM denied_claims WHERE ra_import_id = ?${and})`
  ).run(...args([importId]));
  db.prepare(`DELETE FROM denied_claims WHERE ra_import_id = ?${and}`).run(...args([importId]));
  // ONLY imported entries. A manual entry on the same day survives.
  db.prepare(`DELETE FROM day_entries WHERE ra_import_id = ? AND source = 'ra_import'${and}`).run(
    ...args([importId])
  );
  // ONLY claims this import created. A manual claim survives.
  db.prepare(`DELETE FROM claims WHERE ra_import_id = ?${and}`).run(...args([importId]));
  // The log row stays, marked, so the audit trail survives.
  db.prepare(`UPDATE ra_imports SET status = 'overwritten' WHERE id = ?${and}`).run(
    ...args([importId])
  );
  return footprint;
}

/**
 * Parse one uploaded PDF into reviewable client blocks.
 *
 * Throws with a friendly message rather than answering, so both the single and
 * batch routes can decide what a failure means for them.
 */
export async function parseRaBuffer(buffer, agencyId = null) {
  // The bytes are kept BEFORE any validation, so a file that fails to parse is
  // still on disk to debug later.
  let stored = { hash: null, path: null };
  try {
    stored = storeUpload(buffer);
  } catch {
    /* storage is best-effort; parsing must still work */
  }
  try {
    return await parseRaBufferInner(buffer, stored, agencyId);
  } catch (e) {
    e.stored = stored;
    throw e;
  }
}

async function parseRaBufferInner(buffer, stored, agencyId = null) {
  if (!isPdf(buffer)) throw new Error('That file is not a PDF.');
  buffer = await rotateImportPdf(buffer);
  let text;
  try {
    // pdf-parse is ESM-only with no default export, so it is pulled in here.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result?.text ?? '';
    } finally {
      await parser.destroy?.();
    }
  } catch {
    throw new Error(NOT_AN_RA);
  }

  const { clients, block_count, header } = parseRemittance(text);
  if (!clients.length) throw new Error('No clients detected in this PDF.');

  // Pre-select the fuzzy client match and the NPI-based caretaker match, so the
  // review table opens ready to check.
  const withMatches = clients.map((c) => {
    const suggestedClient = matchClient(c.client_name, c.patient_id, agencyId);
    return {
      ...c,
      suggested_client: suggestedClient,
      suggested_caretaker: caretakerByNpi(c.rendered_provider_id, agencyId),
      // Checked against the fuzzy match; the UI re-checks if the user picks
      // a different client or edits the dates.
      ...existingForPeriod(suggestedClient?.id, c.dos_start, c.dos_end, agencyId),
    };
  });

  return {
    clients: withMatches,
    block_count,
    client_count: withMatches.length,
    merged_count: withMatches.filter((c) => c.merged_pages > 1).length,
    file_hash: stored.hash ?? sha256(buffer),
    stored_path: stored.path,
    raw_char_count: text.length,
    header: header ?? null,
  };
}

/**
 * POST /api/import-ra/check-duplicates  { hashes: [] }
 *
 * Layer 1: the browser hashes the chosen files before anything is uploaded, so
 * an exact re-upload is caught instantly and never leaves the machine.
 */
// accepts: nothing (sha-256 hashes)  [X-Expects-Id: none]
router.post('/check-duplicates', (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes.filter(Boolean) : [];
  if (!hashes.length) return res.json({ matches: [], duplicates_in_batch: [] });

  const find = db.prepare(
    `SELECT id, file_name, imported_at, claim_count, denial_count, file_hash
     FROM ra_imports
     WHERE file_hash = ? AND status = 'active' AND agency_id = ?
     ORDER BY id DESC LIMIT 1`
  );
  const matches = [];
  for (const hash of hashes) {
    const row = find.get(hash, req.agencyId);
    if (row) {
      matches.push({
        hash,
        ra_import_id: row.id,
        file_name: row.file_name,
        imported_at: row.imported_at,
        claim_count: row.claim_count ?? 0,
        denial_count: row.denial_count ?? 0,
      });
    }
  }
  // The same file twice in one selection: only the first is worth processing.
  const seen = new Map();
  const duplicatesInBatch = [];
  hashes.forEach((h, i) => {
    if (seen.has(h)) duplicatesInBatch.push({ hash: h, first_index: seen.get(h), index: i });
    else seen.set(h, i);
  });

  res.json({ matches, duplicates_in_batch: duplicatesInBatch });
});

/** Files whose names mark them as test fixtures rather than real advices. */
const IGNORED_FILE_RE = /(rebill_ra|denied_ra)/i;
const ignoredBy = (name) =>
  IGNORED_FILE_RE.test(name) || /missing/i.test(name) || /\bnotanra\b/i.test(name);

/**
 * GET /api/import-ra/audit
 *
 * ONE ROW PER FILE, earliest check date first, so a single bad file is visible
 * rather than hidden inside a batch. Test fixtures are listed separately.
 */
// accepts: nothing  [X-Expects-Id: none]
router.get('/audit', (req, res) => {
  const rows = db
    .prepare(
      `SELECT f.*, i.status AS import_status, i.pdf_path, i.updated_at AS import_updated_at
       FROM ra_import_files f
       LEFT JOIN ra_imports i ON i.id = f.ra_import_id
         WHERE f.agency_id = @agency
         ORDER BY f.id`
      )
      .all({ agency: req.agencyId });

  const shape = (r) => ({
    id: r.id,
    ra_import_id: r.ra_import_id,
    file_name: r.file_name,
    check_date: r.check_date,
    // the upload date is the fallback when the advice printed no CHK/EFT DT
    fallback_date: String(r.imported_at ?? '').slice(0, 10) || null,
    has_check_date: Boolean(r.check_date),
    prod_date: r.prod_date,
    check_eft_number: r.check_eft_number,
    payment_amount: r.payment_amount,
    forwarding_balance: r.forwarding_balance,
    claim_count: r.claim_count,
    denial_count: r.denial_count,
    client_count: r.client_count,
    stored: Boolean(r.stored_path),
    // Either the per-file path or the import-level copy; a re-parse reads
    // whichever resolves first.
    pdf_path: r.stored_path ?? r.pdf_path ?? null,
    file_on_disk: Boolean(
      (r.stored_path && readStored(r.stored_path)) || (r.pdf_path && readStored(r.pdf_path))
    ),
    status: r.status,
    // 'orphaned' / 'overwritten' live on the import, not the file row.
    // A row whose import is GONE (ra_import_id null) is empty too, even though
    // nothing marked it: there is no import left to delete claims from.
    import_status: r.import_status,
    orphaned: r.import_status === 'orphaned' || r.ra_import_id == null,
    // the advice's text layer was columnar: real money, unreadable service rows
    layout_unrecognised:
      r.status === 'layout_unrecognised' || r.import_status === 'layout_unrecognised',
    live_import: r.ra_import_id != null && r.import_status !== 'orphaned',
    note: r.note,
    // A legacy row has no per-file counts, so "0" there means "unknown", not
    // "the parser failed" — the two must not look the same.
    counts_known: !r.note,
    imported_at: r.imported_at,
    // when the import was last (re-)written; falls back to when it landed
    updated_at: r.import_updated_at ?? r.imported_at,
  });

  const all = rows.map(shape);
  const sortKey = (r) => r.check_date ?? r.fallback_date ?? '';
  // CHK/EFT DT prints as MM-DD-YY; sort on a comparable form.
  const iso = (v) => {
    const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
    return m ? `20${m[3]}-${m[1]}-${m[2]}` : String(v ?? '');
  };
  const files = all
    .filter((r) => !ignoredBy(r.file_name))
    .sort((a, b) => iso(sortKey(a)).localeCompare(iso(sortKey(b))));
  const ignored = all.filter((r) => ignoredBy(r.file_name));

  res.json({
    files,
    ignored,
    totals: {
      files: files.length,
      claims: files.reduce((s, r) => s + r.claim_count, 0),
      // files that produced nothing are the ones to look at
      unknown: files.filter((r) => !r.counts_known).length,
      empty: files.filter((r) => r.counts_known && r.claim_count === 0 && r.denial_count === 0).length,
      orphaned: files.filter((r) => r.orphaned).length,
    },
  });
});

// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
/**
 * Resolve audit-ROW ids (what the table shows) into the imports they belong to
 * plus the rows that have no import at all.
 *
 * One id space for the whole feature: the table lists ra_import_files rows, and
 * an empty row has no import id to offer, so file-row ids are the only values
 * that can address every row. Everything below is keyed on them.
 */
function resolveAuditRows(fileRowIds, agencyId) {
  if (!fileRowIds.length) return { rows: [], imports: [], emptyFileRows: [], missing: [] };
  const q = fileRowIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, ra_import_id FROM ra_import_files WHERE id IN (${q}) AND agency_id = ?`)
    .all(...fileRowIds, agencyId);
  const found = new Set(rows.map((r) => r.id));
  return {
    rows,
    imports: [...new Set(rows.filter((r) => r.ra_import_id != null).map((r) => r.ra_import_id))],
    emptyFileRows: rows.filter((r) => r.ra_import_id == null).map((r) => r.id),
    missing: fileRowIds.filter((id) => !found.has(id)),
  };
}

// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
/**
 * What deleting these audit rows would remove. Empty rows contribute 0 to every
 * count but still count toward `imports`, so the modal's title matches the
 * number of ticked rows.
 */
function bulkFootprint(fileRowIds, agencyId) {
  const { imports, emptyFileRows, rows } = resolveAuditRows(fileRowIds, agencyId);
  const deniedClaims = imports.length
    ? db
        .prepare(
          `SELECT id FROM denied_claims WHERE ra_import_id IN (${imports.map(() => '?').join(',')}) AND agency_id = ?`
        )
        .all(...imports, agencyId)
        .map((r) => r.id)
    : [];
  const lines = deniedClaims.length
    ? db
        .prepare(
          `SELECT id FROM denied_line_items WHERE denied_claim_id IN (${deniedClaims.map(() => '?').join(',')}) AND agency_id = ?`
        )
        .all(...deniedClaims, agencyId)
        .map((r) => r.id)
    : [];
  const tasks = lines.length
    ? db
        .prepare(
          `SELECT COUNT(*) n FROM rebill_tasks WHERE denied_line_item_id IN (${lines.map(() => '?').join(',')}) AND agency_id = ?`
        )
        .get(...lines, agencyId).n
    : 0;
  const pdfs = imports.length
    ? db
        .prepare(
          `SELECT pdf_path FROM ra_imports WHERE id IN (${imports.map(() => '?').join(',')}) AND agency_id = ? AND pdf_path IS NOT NULL`
        )
        .all(...imports, agencyId)
        .filter((r) => readStored(r.pdf_path)).length
    : 0;

  return {
    // the number the title quotes: every ticked row, live or empty
    imports: rows.length,
    live_imports: imports.length,
    empty_rows: emptyFileRows.length,
    claims: imports.length
      ? db
          .prepare(`SELECT COUNT(*) n FROM claims WHERE ra_import_id IN (${imports.map(() => '?').join(',')}) AND agency_id = ?`)
          .get(...imports, agencyId).n
      : 0,
    // ONLY imported entries: a manual entry on the same day always survives.
    day_entries: imports.length
      ? db
          .prepare(
            `SELECT COUNT(*) n FROM day_entries WHERE ra_import_id IN (${imports.map(() => '?').join(',')}) AND source = 'ra_import' AND agency_id = ?`
          )
          .get(...imports, agencyId).n
      : 0,
    denied_claims: deniedClaims.length,
    denied_line_items: lines.length,
    rebill_tasks: tasks,
    pdfs,
  };
}

// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
/* ------------------------------------------------------------------------
 * ID CONTRACT
 *   /import/<id>...  -> ra_imports.id
 *   /file/<id>...    -> ra_import_files.id  (the id the audit table shows)
 *   bulk arrays      -> file-row ids, because an empty row has no import id
 * Every response carries X-Expects-Id so a mismatch is visible in devtools.
 * --------------------------------------------------------------------- */

// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
router.post('/bulk-delete-preview', (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row-array');
  const ids = requireIdArray(req.body?.ids, 'file-row-array', res);
  if (!ids) return;
  res.json(bulkFootprint(ids, req.agencyId));
});

// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
/**
 * Delete every selected audit row in ONE transaction.
 *
 * Live rows take their whole import with them (claims, imported day entries,
 * denials, line items, rebill tasks). Empty rows simply disappear — 0 of
 * everything is a valid deletion, which is why there is no second endpoint and
 * no branching on row type.
 */
router.post('/bulk-delete', (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row-array');
  const ids = requireIdArray(req.body?.ids, 'file-row-array', res);
  if (!ids) return;
  if (req.body?.confirm !== 'DELETE') {
    return res
      .status(409)
      .json({ error: 'Type DELETE to confirm.', needs_confirmation: true, preview: bulkFootprint(ids, req.agencyId) });
  }

  const { rows, imports, emptyFileRows, missing } = resolveAuditRows(ids, req.agencyId);
  if (!rows.length) return res.status(404).json({ error: 'None of those audit rows exist', missing });

  const preview = bulkFootprint(ids, req.agencyId);
  const paths = [];

  db.transaction(() => {
    if (imports.length) {
      const q = imports.map(() => '?').join(',');
      const scopedArgs = [...imports, req.agencyId];
      const deniedClaims = db
        .prepare(`SELECT id FROM denied_claims WHERE ra_import_id IN (${q}) AND agency_id = ?`)
        .all(...scopedArgs)
        .map((r) => r.id);
      if (deniedClaims.length) {
        const dq = deniedClaims.map(() => '?').join(',');
        const dArgs = [...deniedClaims, req.agencyId];
        const lines = db
          .prepare(`SELECT id FROM denied_line_items WHERE denied_claim_id IN (${dq}) AND agency_id = ?`)
          .all(...dArgs)
          .map((r) => r.id);
        if (lines.length) {
          const lq = lines.map(() => '?').join(',');
          const lArgs = [...lines, req.agencyId];
          db.prepare(`DELETE FROM rebill_tasks WHERE denied_line_item_id IN (${lq}) AND agency_id = ?`).run(...lArgs);
          db.prepare(`DELETE FROM denied_line_items WHERE id IN (${lq}) AND agency_id = ?`).run(...lArgs);
        }
        db.prepare(`DELETE FROM denied_claims WHERE id IN (${dq}) AND agency_id = ?`).run(...dArgs);
      }
      db.prepare(`DELETE FROM day_entries WHERE ra_import_id IN (${q}) AND source = 'ra_import' AND agency_id = ?`).run(...scopedArgs);
      db.prepare(`DELETE FROM claims WHERE ra_import_id IN (${q}) AND agency_id = ?`).run(...scopedArgs);
      // every file row of a purged import goes, not only the ticked one
      for (const r of db.prepare(`SELECT pdf_path FROM ra_imports WHERE id IN (${q}) AND agency_id = ?`).all(...scopedArgs)) {
        if (r.pdf_path) paths.push(r.pdf_path);
      }
      db.prepare(`DELETE FROM ra_import_files WHERE ra_import_id IN (${q}) AND agency_id = ?`).run(...scopedArgs);
      db.prepare(`DELETE FROM ra_imports WHERE id IN (${q}) AND agency_id = ?`).run(...scopedArgs);
    }
    // empty rows: nothing to purge, just the audit row
    if (emptyFileRows.length) {
      const eq = emptyFileRows.map(() => '?').join(',');
      const eArgs = [...emptyFileRows, req.agencyId];
      for (const r of db.prepare(`SELECT stored_path FROM ra_import_files WHERE id IN (${eq}) AND agency_id = ?`).all(...eArgs)) {
        if (r.stored_path) paths.push(r.stored_path);
      }
      db.prepare(`DELETE FROM ra_import_files WHERE id IN (${eq}) AND agency_id = ?`).run(...eArgs);
    }

    // A deletion record cannot point at a row that no longer exists.
    db.prepare(
      `INSERT INTO ra_import_history
         (ra_import_id, deleted_at, import_ids, claim_count_purged,
          day_entry_count_purged, denial_count_purged, notes, agency_id)
       VALUES (NULL, datetime('now'), @ids, @claims, @entries, @denials, @note, @agency)`
    ).run({
      ids: imports.join(',') || '(none)',
      agency: req.agencyId,
      claims: preview.claims,
      entries: preview.day_entries,
      denials: preview.denied_claims,
      note: `bulk delete of ${imports.length} import(s) and ${emptyFileRows.length} empty row(s)`,
    });
  })();

  let pdfsRemoved = 0;
  for (const rel of new Set(paths)) {
    let stillReferenced = true;
    try {
      const abs = resolveStored(rel);
      stillReferenced = db.prepare(`SELECT COUNT(*) n FROM ra_imports WHERE pdf_path = ?`).get(rel).n > 0
        || db.prepare(`SELECT COUNT(*) n FROM ra_import_files WHERE stored_path = ?`).get(rel).n > 0
        || !fs.existsSync(abs);
    } catch {
      stillReferenced = true;
    }
    if (deleteUploadIfUnreferenced(rel, stillReferenced)) pdfsRemoved += 1;
  }

  console.log(
    `[import-ra] bulk delete: ${imports.length} import(s) [${imports.join(',') || '-'}] + ` +
      `${emptyFileRows.length} empty row(s) — claims=${preview.claims} entries=${preview.day_entries} ` +
      `denials=${preview.denied_claims} pdfs=${pdfsRemoved}`
  );
  res.json({
    deleted_rows: rows.length,
    deleted_imports: imports.length,
    deleted_empty_rows: emptyFileRows.length,
    ...preview,
    pdfs: pdfsRemoved,
  });
});

// accepts: nothing (malformed ids are rejected, never silently ignored)
/**
 * Guard the id contract.
 *
 * Four bugs in four rounds came from a caller sending one id shape and the
 * endpoint expecting another. Rather than no-op on a bad value, say what was
 * expected and what arrived.
 */
function requireIdArray(value, expects, res) {
  if (!Array.isArray(value)) {
    res.status(400).json({
      error: `endpoint expects ${expects}, got ${value === undefined ? 'undefined' : typeof value}`,
      got: value ?? null,
      expects,
    });
    return null;
  }
  const ids = value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (value.length && !ids.length) {
    res.status(400).json({ error: `endpoint expects ${expects}, got no usable ids`, got: value, expects });
    return null;
  }
  if (!ids.length) {
    res.status(400).json({ error: 'ids[] is required', got: value, expects });
    return null;
  }
  return ids;
}

/**
 * POST /api/import-ra/file/:id/reparse
 *
 * Re-reads the STORED PDF and returns the rows the UI should save, together
 * with a report of anything downstream that the re-import would destroy.
 *
 * The work is deliberately not done here: the caller passes the returned rows
 * to /save with `overwrite_import_id`, so the purge and the re-import happen in
 * one transaction and a failure leaves the old data untouched.
 */
// accepts: file-row id array (ra_import_files.id)  [X-Expects-Id: file-row-array]
/**
 * Zip the stored PDFs for the chosen audit rows.
 * Files missing from disk are listed in MISSING.txt rather than silently skipped.
 */
router.get('/bulk-pdfs', (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row-array');
  const ids = String(req.query.ids ?? '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger);
  if (!ids.length) {
    return res.status(400).json({ error: 'endpoint expects file-row-array, got no usable ids', expects: 'file-row-array' });
  }
  const rows = db
    .prepare(
      `SELECT f.file_name, f.stored_path, i.pdf_path
       FROM ra_import_files f
       LEFT JOIN ra_imports i ON i.id = f.ra_import_id AND i.agency_id = f.agency_id
       WHERE f.id IN (${ids.map(() => '?').join(',')}) AND f.agency_id = ?`
    )
    .all(...ids, req.agencyId);

  const available = [];
  const missing = [];
  const used = new Set();
  for (const r of rows) {
    const buffer = readStored(r.stored_path) ?? readStored(r.pdf_path);
    if (!buffer) { missing.push(r.file_name); continue; }
    let name = r.file_name || 'advice.pdf';
    let n = 2;
    while (used.has(name)) name = name.replace(/\.pdf$/i, '') + ` (${n++}).pdf`;
    used.add(name);
    available.push({ name, buffer });
  }
  if (!available.length) {
    return res.status(404).json({ error: 'None of the selected imports have a stored PDF.' });
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="RA_pdfs_${stamp}.zip"`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[import-ra] zip error:', err); res.end(); });
  archive.pipe(res);
  for (const f of available) archive.append(f.buffer, { name: f.name });
  if (missing.length) {
    archive.append(`These files had no stored PDF and are not in the zip:\n\n${missing.join('\n')}\n`, { name: 'MISSING.txt' });
  }
  archive.finalize();
});

// accepts: file-row id (ra_import_files.id)  [X-Expects-Id: file-row]
/**
 * Delete ONE audit row.
 *
 * Its import goes too, but only once no other file row still points at it;
 * an import that still has sibling rows keeps them.
 */
router.delete('/file/:id', (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'endpoint expects file-row, got a bad path id', got: req.params.id, expects: 'file-row' });
  }
  const file = db.prepare(`SELECT * FROM ra_import_files WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!file) return res.status(404).json({ error: 'Import file not found' });

  const importId = file.ra_import_id;
  const claims = importId ? db.prepare(`SELECT COUNT(*) n FROM claims WHERE ra_import_id = ? AND agency_id = ?`).get(importId, req.agencyId).n : 0;
  const denials = importId ? db.prepare(`SELECT COUNT(*) n FROM denied_claims WHERE ra_import_id = ? AND agency_id = ?`).get(importId, req.agencyId).n : 0;
  if (claims || denials) {
    return res.status(409).json({
      error: `This row still has ${claims} claim(s) and ${denials} denial(s). Use Purge instead.`,
      has_data: true, claims, denials, expects: 'file-row',
    });
  }

  const paths = [];
  db.transaction(() => {
    if (file.stored_path) paths.push(file.stored_path);
    db.prepare(`DELETE FROM ra_import_files WHERE id = ? AND agency_id = ?`).run(id, req.agencyId);
    if (importId) {
      const still = db.prepare(`SELECT COUNT(*) n FROM ra_import_files WHERE ra_import_id = ? AND agency_id = ?`).get(importId, req.agencyId).n;
      if (still === 0) {
        const row = db.prepare(`SELECT pdf_path FROM ra_imports WHERE id = ? AND agency_id = ?`).get(importId, req.agencyId);
        if (row?.pdf_path) paths.push(row.pdf_path);
        db.prepare(`DELETE FROM ra_import_history WHERE ra_import_id = ? AND agency_id = ?`).run(importId, req.agencyId);
        db.prepare(`DELETE FROM ra_imports WHERE id = ? AND agency_id = ?`).run(importId, req.agencyId);
      }
    }
  })();

  let removedFile = false;
  for (const rel of new Set(paths)) {
    let stillReferenced = true;
    try {
      stillReferenced =
        db.prepare(`SELECT COUNT(*) n FROM ra_imports WHERE pdf_path = ?`).get(rel).n > 0 ||
        db.prepare(`SELECT COUNT(*) n FROM ra_import_files WHERE stored_path = ?`).get(rel).n > 0 ||
        !fs.existsSync(resolveStored(rel));
    } catch { stillReferenced = true; }
    if (deleteUploadIfUnreferenced(rel, stillReferenced)) removedFile = true;
  }
  console.log(`[import-ra] deleted audit row ${id} "${file.file_name}" import=${importId ?? 'none'} pdf_removed=${removedFile}`);
  res.json({ deleted_rows: 1, deleted_import: importId ? 1 : 0, removed_pdf: removedFile });
});

// accepts: nothing  [X-Expects-Id: none]
/**
 * The one lookup both the preview and the live cleanup use, so they can never
 * disagree about scope.
 *
 * Scoped by flagged FILE, never by import: import 3 is a 19-file batch in which
 * only two files are unreadable, so flagging the import would sweep 17 good
 * files into the cleanup.
 *
 * A "phantom denial" is a denial with ZERO line items — a claim whose header
 * parsed but whose service rows did not. A denial that parsed real line items
 * is real money and is never in scope.
 */
function cleanupScope(agencyId) {
  const imports = db
    .prepare(
      `SELECT DISTINCT i.id, i.file_name, i.status
       FROM ra_imports i
       WHERE i.agency_id = ?
         AND (i.status = 'layout_unrecognised'
          OR EXISTS (SELECT 1 FROM ra_import_files f
                     WHERE f.ra_import_id = i.id AND f.agency_id = i.agency_id
                       AND f.status = 'layout_unrecognised'))`
    )
    .all(agencyId);
  const items = imports.map((imp) => {
    const denials = db
      .prepare(
        `SELECT d.id FROM denied_claims d
         WHERE d.ra_import_id = ? AND d.agency_id = ?
           AND NOT EXISTS (SELECT 1 FROM denied_line_items li
                           WHERE li.denied_claim_id = d.id AND li.agency_id = d.agency_id)`
      )
      .all(imp.id, agencyId)
      .map((r) => r.id);
    const lines = denials.length
      ? db
          .prepare(
            `SELECT id FROM denied_line_items WHERE denied_claim_id IN (${denials.map(() => '?').join(',')}) AND agency_id = ?`
          )
          .all(...denials, agencyId)
          .map((r) => r.id)
      : [];
    const tasks = lines.length
      ? db
          .prepare(
            `SELECT COUNT(*) n FROM rebill_tasks WHERE denied_line_item_id IN (${lines.map(() => '?').join(',')}) AND agency_id = ?`
          )
          .get(...lines, agencyId).n
      : 0;
    // claims from the same import that have no day entries: half-parsed, kept
    const toFlag = db
      .prepare(
        `SELECT id FROM claims c
         WHERE c.ra_import_id = ? AND c.agency_id = ?
           AND c.parse_status <> 'layout_incomplete'
           AND c.id NOT IN (SELECT DISTINCT claim_id FROM day_entries WHERE claim_id IS NOT NULL AND agency_id = ?)`
      )
      .all(imp.id, agencyId, agencyId)
      .map((r) => r.id);
    return {
      ra_import_id: imp.id,
      file_name: imp.file_name,
      denial_ids: denials,
      line_ids: lines,
      rebill_tasks: tasks,
      flag_ids: toFlag,
      denials: denials.length,
      line_items: lines.length,
      claims_to_flag: toFlag.length,
    };
  });
  return {
    items,
    totals: {
      denials: items.reduce((s, i) => s + i.denials, 0),
      line_items: items.reduce((s, i) => s + i.line_items, 0),
      rebill_tasks: items.reduce((s, i) => s + i.rebill_tasks, 0),
      claims_to_flag: items.reduce((s, i) => s + i.claims_to_flag, 0),
    },
  };
}

/**
 * Stable preview payload.
 *
 * The UI calls this endpoint as `raCleanupPreview()` and reads `imports`.
 * `cleanupScope()` names the same array `items` for the POST cleanup route.
 * Return both keys so a server-side rename can never blank the Settings page.
 */
function cleanupPreviewPayload(agencyId) {
  const scope = cleanupScope(agencyId);
  return { dry_run: true, imports: scope.items, items: scope.items, totals: scope.totals };
}

// accepts: nothing  [X-Expects-Id: none]
/** POST /api/import-ra/cleanup-preview — same scope, no writes. */
router.post('/cleanup-preview', (req, res) => res.json(cleanupPreviewPayload(req.agencyId)));

// accepts: nothing  [X-Expects-Id: none]
/**
 * POST /api/import-ra/cleanup  { confirm: "DELETE" }
 *
 * Removes the phantom denials only. Every claim is kept — the 10 half-parsed
 * claims are real MHCP money and are flagged, never deleted. The ra_imports and
 * ra_import_files rows survive as the audit trail of what was attempted.
 */
router.post('/cleanup', (req, res) => {
  if (req.body?.confirm !== 'DELETE') {
    // case-sensitive on purpose: "delete" is a slip, not a decision
    return res.status(400).json({ error: 'confirmation required' });
  }
  const scope = cleanupScope(req.agencyId);
  const denialIds = scope.items.flatMap((i) => i.denial_ids);
  const lineIds = scope.items.flatMap((i) => i.line_ids);
  const flagIds = scope.items.flatMap((i) => i.flag_ids);
  let tasks = 0;

  db.transaction(() => {
    if (lineIds.length) {
      const lq = lineIds.map(() => '?').join(',');
      const lArgs = [...lineIds, req.agencyId];
      tasks = db
        .prepare(`DELETE FROM rebill_tasks WHERE denied_line_item_id IN (${lq}) AND agency_id = ?`)
        .run(...lArgs).changes;
      db.prepare(`DELETE FROM denied_line_items WHERE id IN (${lq}) AND agency_id = ?`).run(...lArgs);
    }
    if (denialIds.length) {
      const dArgs = [...denialIds, req.agencyId];
      db.prepare(
        `DELETE FROM denied_claims WHERE id IN (${denialIds.map(() => '?').join(',')}) AND agency_id = ?`
      ).run(...dArgs);
    }
    // idempotent: anything already stamped is skipped by the query itself
    for (const id of flagIds) {
      db.prepare(`UPDATE claims SET parse_status = 'layout_incomplete' WHERE id = ? AND agency_id = ?`).run(
        id,
        req.agencyId
      );
    }
  })();

  console.log(
    `[import-ra] cleanup — denied_claims=${denialIds.length} line_items=${lineIds.length} ` +
      `rebill_tasks=${tasks} flagged_claims=${flagIds.length}`
  );
  res.json({
    deleted_denials: denialIds.length,
    deleted_line_items: lineIds.length,
    deleted_rebill_tasks: tasks,
    flagged_claims: flagIds.length,
  });
});

// accepts: nothing  [X-Expects-Id: none]
/**
 * DRY RUN ONLY. What "Clean Up Unparseable Imports" would do.
 *
 * Never deletes anything — it reports, so the decision stays with the operator.
 * Only zero-line-item denials are in scope: a claim that parsed its header is
 * real money and is flagged, never removed.
 */
router.get('/cleanup-preview', (req, res) => res.json(cleanupPreviewPayload(req.agencyId)));

// accepts: file-row id (ra_import_files.id)  [X-Expects-Id: file-row]
router.post('/file/:id/reparse', async (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row');
  const row = db
    .prepare(`SELECT * FROM ra_import_files WHERE id = ? AND agency_id = ?`)
    .get(Number(req.params.id), req.agencyId);
  if (!row) return res.status(404).json({ error: 'Import file not found' });

  const parent = row.ra_import_id
    ? db
        .prepare(`SELECT pdf_path, claim_count FROM ra_imports WHERE id = ? AND agency_id = ?`)
        .get(row.ra_import_id, req.agencyId)
    : null;
  const buffer = readStored(row.stored_path) ?? readStored(parent?.pdf_path);
  if (!buffer) {
    return res.status(409).json({
      error: 'Original file not stored. Please re-upload manually.',
      needs_upload: true,
    });
  }

  const importId = row.ra_import_id;
  const touched = importId
    ? overwriteRisks(importId, req.agencyId)
    : { paid_claims: 0, recovered_denials: 0, edited_entries: 0, risky: false };
  const footprint = importId ? importFootprint(importId, req.agencyId) : null;

  // Anything already acted on needs an explicit confirmation before we proceed.
  if (touched.risky && req.body?.confirm !== true) {
    return res.status(409).json({
      error: 'This import has downstream activity. Confirm to re-parse anyway.',
      needs_confirmation: true,
      touched,
      footprint,
      import_id: importId,
    });
  }

  try {
    const parsed = await parseRaBuffer(buffer, req.agencyId);
    console.log(
      `[import-ra] reparse file=${row.id} "${row.file_name}" ` +
        `claims=${parsed.clients.length} blocks=${parsed.block_count} ` +
        `purge_import=${importId ?? 'none'} risky=${touched.risky}`
    );
    res.json({
      file: row,
      import_id: importId,
      touched,
      footprint,
      header: parsed.header,
      file_hash: parsed.file_hash,
      stored_path: parsed.stored_path,
      clients: parsed.clients.map((c) => ({
        ...c,
        source_file: row.file_name,
      })),
      client_count: parsed.client_count,
      block_count: parsed.block_count,
    });
  } catch (e) {
    res.status(400).json({ error: `Could not re-parse the stored PDF: ${e.message}` });
  }
});

/**
 * GET /api/import-ra/file/:id/diagnostic
 *
 * The raw text the PDF produced plus what the parser made of it, so a bad file
 * can be debugged without guessing.
 */
// accepts: file-row id (ra_import_files.id)  [X-Expects-Id: file-row]
router.get('/file/:id/diagnostic', async (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row');
  const row = db
    .prepare(`SELECT * FROM ra_import_files WHERE id = ? AND agency_id = ?`)
    .get(Number(req.params.id), req.agencyId);
  if (!row) return res.status(404).json({ error: 'Import file not found' });

  const parent = row.ra_import_id
    ? db
        .prepare(`SELECT pdf_path FROM ra_imports WHERE id = ? AND agency_id = ?`)
        .get(row.ra_import_id, req.agencyId)
    : null;
  const buffer = readStored(row.stored_path) ?? readStored(parent?.pdf_path);
  if (!buffer) {
    return res.status(409).json({
      error: 'Original file not stored. Please re-upload manually.',
      needs_upload: true,
    });
  }

  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    let text = '';
    try {
      text = (await parser.getText())?.text ?? '';
    } finally {
      await parser.destroy?.();
    }
    const parsed = parseRemittance(text);
    const patients = (text.match(/PATIENT\s*:/gi) || []).length;
    const clms = (text.match(/CLM\s*#\s*:/gi) || []).length;
    const payAmounts = (text.match(/PAYMENT\s+AMOUNT\s*:/gi) || []).length;

    res.json({
      file: row,
      raw_text: text,
      raw_char_count: text.length,
      counts: { patients, claims_in_text: clms, payment_amount_lines: payAmounts },
      header: parsed.header,
      block_count: parsed.block_count,
      claims: parsed.clients.map((c) => ({
        client_name: c.client_name,
        claim_number: c.claim_number,
        claim_status: c.claim_status,
        paid: c.paid,
        dos_start: c.dos_start,
        dos_end: c.dos_end,
        total_charge: c.total_charge,
        total_payment: c.total_payment,
        line_item_count: c.line_items.length,
      })),
      // anything the parse produced that carries no money or no dates
      warnings: parsed.clients
        .filter((c) => !c.dos_start || c.total_payment == null)
        .map(
          (c) =>
            `${c.claim_number ?? '(no CLM #)'} — ${
              !c.dos_start ? 'no DOS found' : 'no payment amount found'
            }`
        ),
    });
  } catch (e) {
    res.status(500).json({ error: `Could not read the stored PDF: ${e.message}` });
  }
});

/** GET /api/import-ra/file/:id/pdf — the stored original, for download. */
// accepts: file-row id (ra_import_files.id)  [X-Expects-Id: file-row]
router.get('/file/:id/pdf', (req, res) => {
  res.setHeader('X-Expects-Id', 'file-row');
  const row = db
    .prepare(`SELECT * FROM ra_import_files WHERE id = ? AND agency_id = ?`)
    .get(Number(req.params.id), req.agencyId);
  if (!row) return res.status(404).json({ error: 'Import file not found' });
  const parent = row.ra_import_id
    ? db
        .prepare(`SELECT pdf_path FROM ra_imports WHERE id = ? AND agency_id = ?`)
        .get(row.ra_import_id, req.agencyId)
    : null;
  const buffer = readStored(row.stored_path) ?? readStored(parent?.pdf_path);
  if (!buffer) {
    return res.status(404).json({ error: 'Original file not stored. Please re-upload manually.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(buffer);
});

/**
 * DELETE /api/import-ra/import/:id
 *
 * Removes an import and everything it created, then deletes its stored PDF —
 * but only when no OTHER import still points at the same file hash.
 */
// accepts: import id (ra_imports.id)  [X-Expects-Id: import]
router.delete('/import/:id', (req, res) => {
  res.setHeader('X-Expects-Id', 'import');
  const id = Number(req.params.id);
  const row = db
    .prepare(`SELECT * FROM ra_imports WHERE id = ? AND agency_id = ?`)
    .get(id, req.agencyId);
  if (!row) return res.status(404).json({ error: 'Import not found' });
  if (req.body?.confirm !== 'DELETE' && req.query.confirm !== 'DELETE') {
    const footprint = importFootprint(id, req.agencyId);
    const risks = overwriteRisks(id, req.agencyId);
    return res.status(409).json({
      error: 'Type DELETE to confirm. This removes the import record and its claims.',
      needs_confirmation: true,
      footprint,
      risks,
    });
  }

  const counts = { claims: 0, day_entries: 0, denials: 0 };
  db.transaction(() => {
    const f = purgeImport(id, req.agencyId);
    counts.claims = f.claims;
    counts.day_entries = f.day_entries;
    counts.denials = f.denials;
    db.prepare(`DELETE FROM ra_import_files WHERE ra_import_id = ? AND agency_id = ?`).run(id, req.agencyId);
    db.prepare(`DELETE FROM ra_imports WHERE id = ? AND agency_id = ?`).run(id, req.agencyId);
  })();

  // Only unlink the file when nothing else references the same bytes.
  let removedFile = false;
  if (row.pdf_path) {
    const others = db
      .prepare(`SELECT COUNT(*) AS n FROM ra_imports WHERE pdf_path = ?`)
      .get(row.pdf_path).n;
    removedFile = deleteUploadIfUnreferenced(row.pdf_path, others > 0);
  }

  console.log(
    `[import-ra] deleted import ${id} "${row.file_name}" — ` +
      `claims=${counts.claims} entries=${counts.day_entries} denials=${counts.denials} ` +
      `pdf_removed=${removedFile}`
  );
  res.json({ deleted_import: 1, ...counts, removed_pdf: removedFile });
});

// REMOVED: DELETE /orphaned/:id took ra_import_files.id while looking up
// ra_imports.id. Superseded by DELETE /file/:id, which matches its name.

// accepts: nothing  [X-Expects-Id: none]
router.get('/storage', (req, res) => {
  /*
   * The uploads folder is shared by every agency, so a raw directory size
   * would report other tenants' files. Count only rows this agency owns.
   */
  const rows = db
    .prepare(
      `SELECT stored_path FROM ra_import_files WHERE agency_id = ? AND stored_path IS NOT NULL
       UNION
       SELECT pdf_path AS stored_path FROM ra_imports WHERE agency_id = ? AND pdf_path IS NOT NULL`
    )
    .all(req.agencyId, req.agencyId);
  /*
   * Row paths are repo-relative ("data/ra_uploads/x.pdf"), and the two UNION
   * arms can name the same file, so de-duplicate before summing.
   */
  const seen = new Set();
  let bytes = 0;
  for (const r of rows) {
    const p = String(r.stored_path);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      bytes += fs.statSync(path.isAbsolute(p) ? p : path.join(process.cwd(), p)).size;
    } catch {
      /* file pruned outside the app; ignore */
    }
  }
  res.json({
    files: seen.size,
    bytes,
    megabytes: Math.round((bytes / (1024 * 1024)) * 100) / 100,
  });
});

/** GET /api/import-ra/import/:id/overwrite-check — what an overwrite would cost. */
// accepts: import id (ra_imports.id)  [X-Expects-Id: import]
router.get('/import/:id/overwrite-check', (req, res) => {
  res.setHeader('X-Expects-Id', 'import');
  const id = Number(req.params.id);
  const row = db
    .prepare(`SELECT * FROM ra_imports WHERE id = ? AND agency_id = ?`)
    .get(id, req.agencyId);
  if (!row) return res.status(404).json({ error: 'Import not found' });
  res.json({
    import: row,
    footprint: importFootprint(id, req.agencyId),
    risks: overwriteRisks(id, req.agencyId),
  });
});

/**
 * POST /api/import-ra/batch — up to 15 PDFs, parsed SEQUENTIALLY.
 *
 * Deliberately not parallel: each advice can be large, and one at a time keeps
 * memory flat and means a single bad file cannot take the batch down with it.
 * The result reports per-file outcomes so the UI can show what failed.
 */
// accepts: multipart files  [X-Expects-Id: none]
router.post('/batch', (req, res) => {
  // A whole batch of ten can legitimately take minutes.
  req.setTimeout(BATCH_TIMEOUT_MS);
  res.setTimeout(BATCH_TIMEOUT_MS);

  uploadBatch.array('files', 35)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: `Upload failed: ${err.message}` });
    const files = req.files ?? [];
    if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

    const succeeded = [];
    const failed = [];
    const clients = [];
    const startedAt = Date.now();
    const deadline = startedAt + BATCH_TIMEOUT_MS - BATCH_DEADLINE_MARGIN_MS;
    let timedOut = false;

    for (const file of files) {
      // Stop cleanly rather than letting the socket time out mid-response: the
      // files already parsed are still returned and saved.
      if (Date.now() > deadline) {
        timedOut = true;
        const remaining = files.length - succeeded.length - failed.length;
        console.warn(
          `[import-ra] batch hit the ${Math.round(BATCH_TIMEOUT_MS / 60000)}-minute limit after ` +
            `${succeeded.length + failed.length} of ${files.length} files; ` +
            `${remaining} not processed. Re-run the batch for the rest.`
        );
        break;
      }
      const name = file.originalname ?? 'unnamed.pdf';
      try {
        const parsed = await parseRaBuffer(file.buffer, req.agencyId);
        succeeded.push(name);
        // Layer 2: a regenerated copy of the same advice has a different hash
        // but the same header, so the identifiers are checked too.
        const byHash = importByHash(parsed.file_hash, req.agencyId);
        const byHeader = byHash ? null : importByHeader(parsed.header, req.agencyId);
        const match = byHash ?? byHeader ?? null;
        for (const c of parsed.clients) {
          clients.push({
            ...c,
            source_file: name,
            file_hash: parsed.file_hash,
            stored_path: parsed.stored_path,
            raw_char_count: parsed.raw_char_count,
            file_header: parsed.header,
            file_layout_unrecognised: Boolean(parsed.layout_unrecognised),
            file_layout_reason: parsed.layout_reason ?? null,
            duplicate: match
              ? {
                  kind: byHash ? 'exact' : 'batch',
                  ra_import_id: match.id,
                  file_name: match.file_name,
                  imported_at: match.imported_at,
                  claim_count: match.claim_count ?? 0,
                  denial_count: match.denial_count ?? 0,
                  footprint: importFootprint(match.id, req.agencyId),
                  risks: overwriteRisks(match.id, req.agencyId),
                }
              : null,
          });
        }
      } catch (e) {
        failed.push({ filename: name, error: e.message });
        // Keep the file visible in the audit even though it produced nothing.
        try {
          const stored = e.stored ?? storeUpload(file.buffer);
          db.prepare(
            `INSERT INTO ra_imports
               (imported_at, num_clients, total_payment, file_name, file_hash, pdf_path,
            claim_count, denial_count, status, agency_id)
             VALUES (datetime('now'), 0, 0, @file, @hash, @path, 0, 0, 'parse_failed', @agency)`
          ).run({ file: name, hash: stored.hash, path: stored.path, agency: req.agencyId });
        } catch {
          /* the failure report matters more than the record */
        }
      }
    }

    res.json({
      file_count: files.length,
      processed: succeeded.length + failed.length,
      timed_out: timedOut,
      elapsed_ms: Date.now() - startedAt,
      succeeded,
      failed,
      clients,
      client_count: clients.length,
    });
  });
});

// accepts: multipart file  [X-Expects-Id: none]
router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    if (!isPdf(req.file.buffer)) {
      return res.status(400).json({ error: 'That file is not a PDF.' });
    }

    let text;
    try {
      const rotated = await rotateImportPdf(req.file.buffer);
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: rotated });
      try {
        const result = await parser.getText();
        text = result?.text ?? '';
      } finally {
        await parser.destroy?.();
      }
    } catch {
      recordFailedParse(req.file, 'Could not extract any text from this PDF.', req.agencyId);
      return res.status(400).json({ error: NOT_AN_RA });
    }

    const { clients, block_count } = parseRemittance(text);
    if (!clients.length) {
      return res.status(400).json({ error: 'No clients detected in this PDF.' });
    }

    // Pre-select the fuzzy client match and the NPI-based caretaker match, so
    // the review table opens ready to check.
    const withMatches = clients.map((c) => {
      const suggestedClient = matchClient(c.client_name, c.patient_id, req.agencyId);
      return {
        ...c,
        suggested_client: suggestedClient,
        suggested_caretaker: caretakerByNpi(c.rendered_provider_id, req.agencyId),
        // Checked against the fuzzy match; the UI re-checks if the user picks
        // a different client or edits the dates.
        ...existingForPeriod(suggestedClient?.id, c.dos_start, c.dos_end, req.agencyId),
      };
    });

    res.json({
      clients: withMatches,
      block_count,
      client_count: withMatches.length,
      merged_count: withMatches.filter((c) => c.merged_pages > 1).length,
      // identity for duplicate detection (Layers 1 and 2)
      // the detector's verdict must reach the client on BOTH parse paths
      layout_unrecognised: Boolean(parseRemittance(text).layout_unrecognised),
      layout_reason: parseRemittance(text).layout_reason ?? null,
      file_hash: (() => {
        try {
          return storeUpload(req.file.buffer).hash;
        } catch {
          return sha256(req.file.buffer);
        }
      })(),
      stored_path: (() => {
        try {
          return storeUpload(req.file.buffer).path;
        } catch {
          return null;
        }
      })(),
      raw_char_count: text.length,
      header: parseRemittance(text).header ?? null,
      filename: req.file.originalname ?? null,
    });
  });
});

/**
 * What already exists for a client over a DOS range.
 *
 * `existing_claim` is an earlier RA import (the one a re-upload can safely
 * replace). `manual_claim` is one the user created or generated by hand, which
 * is never touched. Archived claims are ignored: they have already been dealt
 * with, so they should not prompt again.
 */
export function existingForPeriod(clientId, dosStart, dosEnd, agencyId = null) {
  const empty = { existing_claim: null, manual_claim: null, ra_import_entries: 0 };
  if (!clientId || !dosStart || !dosEnd) return empty;

  const overlap = `period_start IS NOT NULL AND period_end IS NOT NULL
                   AND period_start <= @end AND period_end >= @start`;
  const params = { client: Number(clientId), start: dosStart, end: dosEnd };

  const pick = (clause) =>
    db
      .prepare(
        `SELECT id, claim_name, status, paid_amount, paid_date, period_start, period_end, source
         FROM claims
         WHERE client_id = @client AND COALESCE(archived, 0) = 0 AND ${overlap} AND ${clause}
             ${Number.isInteger(agencyId) ? 'AND agency_id = @agency' : ''}
         ORDER BY period_start DESC, id DESC
         LIMIT 1`
      )
      .get(Number.isInteger(agencyId) ? { ...params, agency: agencyId } : params) ?? null;

  return {
    existing_claim: pick(`source = 'ra_import'`),
    manual_claim: pick(`source <> 'ra_import'`),
    ra_import_entries: db
      .prepare(
        `SELECT COUNT(*) AS n FROM day_entries
         WHERE client_id = @client AND source = 'ra_import'
           AND work_date >= @start AND work_date <= @end
           ${Number.isInteger(agencyId) ? 'AND agency_id = @agency' : ''}`
      )
      .get(Number.isInteger(agencyId) ? { ...params, agency: agencyId } : params).n,
  };
}

/** POST /api/import-ra/existing  { client_id, dos_start, dos_end } */
router.post('/existing', (req, res) => {
  const { client_id: clientId, dos_start: start, dos_end: end } = req.body ?? {};
  res.json(existingForPeriod(Number(clientId) || null, start, end, req.agencyId));
});

/** POST /api/import-ra/match  { client_name } */
router.post('/match', (req, res) => {
  const name = req.body?.client_name;
  if (typeof name !== 'string') {
    return res.status(400).json({ error: 'client_name is required' });
  }
  res.json({ client: matchClient(name, null, req.agencyId) });
});

/* ------------------------------------------------------------------- save */


/**
 * POST /api/import-ra/save
 * Body: { rows: [{ client_id, action, dos_start, dos_end, total_charge,
 *                  total_payment, line_items: [...] }] }
 */
/**
 * Bind named parameters safely.
 *
 * better-sqlite3 fails with a famously unhelpful "Too few parameter values were
 * provided" when a statement mixes "?" with "@name", or when a value is
 * `undefined`. This compares the SQL's named parameters against the object
 * being bound and turns either mistake into a message that names the culprit.
 * `undefined` is normalised to `null` so optional columns can never blow up.
 */
export function bindNamed(sql, params) {
  const required = [...sql.matchAll(/@(\w+)/g)].map((m) => m[1]);
  const positional = (sql.match(/\?/g) || []).length;
  if (positional) {
    throw new Error(
      `statement mixes ${positional} positional "?" placeholder(s) with named parameters`
    );
  }
  const missing = required.filter((k) => !(k in params));
  if (missing.length) throw new Error(`missing SQL parameter(s): ${missing.join(', ')}`);
  const unused = Object.keys(params).filter((k) => !required.includes(k));
  if (unused.length) console.warn(`[import-ra] ignoring unused parameter(s): ${unused.join(', ')}`);

  const bound = {};
  for (const key of required) bound[key] = params[key] === undefined ? null : params[key];
  return bound;
}

/** Echo the statement and its bound values, as requested for troubleshooting. */
function logStatement(label, sql, params) {
  console.log(`[import-ra] ${label}`);
  console.log(`[import-ra]   sql   : ${sql.replace(/\s+/g, ' ').trim()}`);
  console.log(`[import-ra]   bound : ${JSON.stringify(params)}`);
}

/** The client's agreement for a date: one that covers it, else the latest. */
function agreementFor(clientId, date, agencyId) {
  return db
    .prepare(
      // All parameters are named: better-sqlite3 refuses to mix "?" with "@name".
      `SELECT * FROM agreements
       WHERE client_id = @clientId AND agency_id = @agency
       ORDER BY
         CASE WHEN (start_date IS NULL OR start_date <= @date)
               AND (end_date IS NULL OR end_date >= @date) THEN 0 ELSE 1 END,
         start_date DESC, id DESC
       LIMIT 1`
    )
    .get({ clientId, date, agency: agencyId });
}

const CLAIM_INSERT_SQL = `INSERT INTO claims
    (claim_name, client_id, agreement_id, period_start, period_end,
     total_units, total_dollars, status, paid_date, paid_amount, source, ra_import_id,
     ra_claim_number, client_name_raw, member_id, date_of_service, charge_amount,
     procedure_code, agency_id)
  VALUES
    (@claim_name, @client_id, @agreement_id, @period_start, @period_end,
     @total_units, @total_dollars, 'Paid', @paid_date, @paid_amount, 'ra_import', @ra_import_id,
     @ra_claim_number, @client_name_raw, @member_id, @date_of_service, @charge_amount,
     @procedure_code, @agency)`;

const DAY_ENTRY_INSERT_SQL = `INSERT INTO day_entries
    (client_id, agreement_id, caretaker_id, work_date, minutes_worked, units,
     rate_per_unit, dollars, notes, claim_id, start_time, source, ra_import_id,
     service_code, modifier, agency_id)
  VALUES
    (@client_id, @agreement_id, @caretaker_id, @work_date, @minutes_worked, @units,
     @rate_per_unit, @dollars, @notes, @claim_id, @start_time, 'ra_import', @ra_import_id,
     @service_code, @modifier, @agency)`;

/**
 * POST /api/import-ra/save
 * Body: { rows: [{ client_id, action, dos_start, dos_end, total_charge,
 *                  total_payment, line_items: [...] }] }
 *
 * Everything runs inside one transaction: any throw rolls the whole import back.
 */
router.post('/save', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'rows[] is required' });

  const ACTIONS = new Set(['mark_paid', 'create_claim', 'skip', 'save_denials']);
  for (const [i, row] of rows.entries()) {
    const action = row.action ?? 'skip';
    if (!ACTIONS.has(action)) {
      return res.status(400).json({ error: `Row ${i + 1}: unknown action "${action}".` });
    }
    /*
     * Every row that will be written needs a client — including denials.
     *
     * Denials used to be exempt on the reasoning that they are archived rather
     * than billed. But a denial saved with a null client is invisible in the
     * client's own view and can never be matched for recovery, so the money is
     * effectively lost while the import reports success. Hold it instead.
     */
    if (action !== 'skip' && !Number(row.client_id)) {
      return res.status(400).json({
        error:
          `Row ${i + 1} (${row.client_name ?? 'unnamed'}) has no client selected. ` +
          `Nothing was saved — resolve it and try again.`,
        unmatched_rows: [i + 1],
        needs_review: true,
      });
    }
  }

  const today = todayISO();
  // PDF paths from overwritten claims; unlinked only once the transaction holds.
  const orphanedPdfs = [];
  // Log the import up front so every claim it creates can point back at it.
  // The whole save is transactional, so a failure rolls this back too.
  let raImportId = null;
  try {
    const distinct = new Set(
      rows.map((r) => Number(r.client_id)).filter((n) => Number.isInteger(n) && n > 0)
    );
    const info = db
      .prepare(
        `INSERT INTO ra_imports (imported_at, num_clients, total_payment, file_name, agency_id)
           VALUES (datetime('now'), @clients, @total, @file, @agency)`
      )
      .run({
        clients: distinct.size,
        total: round2(rows.reduce((sum, r) => sum + (Number(r.total_payment) || 0), 0)),
        file: (req.body?.file_name ?? '').toString().trim() || null,
          agency: req.agencyId,
      });
    raImportId = Number(info.lastInsertRowid);
  } catch {
    /* logging must never fail the save itself */
  }

  const summary = {
    updated_claims: 0,
    created_claims: 0,
    added_entries: 0,
    skipped_entries: 0,
    linked_entries: 0,
    archived_claims: 0,
    overwritten_claims: 0,
    skipped_rows: 0,
    denied_claims: 0,
    denied_line_items: 0,
    reversed_claims: 0,
    overwritten_imports: 0,
    purged_claims: 0,
    purged_day_entries: 0,
    purged_denials: 0,
    recovered_denials: 0,
    warnings: [],
  };

  // Files the user chose to overwrite: their previous import is purged inside
  // this same transaction, so a re-import that fails takes the deletion with it.
  // Files whose layout the parser could not read: their claims are real money
  // but have no DOS or line items, so they are kept and flagged, never dropped.
  let denyGateSkipped = 0;
  const flaggedFiles = new Set(
    (Array.isArray(req.body?.files) ? req.body.files : [])
      .filter((f) => f.layout_unrecognised)
      .map((f) => f.file_name)
  );

  const overwriteIds = [
    ...new Set(
      rows
        .map((r) => Number(r.overwrite_import_id))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== raImportId)
    ),
  ];

  const run = db.transaction(() => {
    for (const oldId of overwriteIds) {
      const before = db
        .prepare(`SELECT claim_count FROM ra_imports WHERE id = ? AND agency_id = ?`)
        .get(oldId, req.agencyId)?.claim_count ?? 0;
      const footprint = purgeImport(oldId, req.agencyId);
      summary.overwritten_imports += 1;
      summary.purged_claims += footprint.claims;
      summary.purged_day_entries += footprint.day_entries;
      summary.purged_denials += footprint.denials;
      // Every re-parse is logged, so a changed import is never silent.
      db.prepare(
        `INSERT INTO ra_import_history (ra_import_id, old_claim_count, new_claim_count, notes, agency_id)
         VALUES (@id, @old, @new, @note, @agency)`
      ).run({
        id: oldId,
        agency: req.agencyId,
        old: before,
        new: summary.created_claims + summary.updated_claims,
        note:
          `purged ${footprint.claims} claims, ${footprint.day_entries} day entries, ` +
          `${footprint.denials} denials`,
      });
    }

    for (const row of rows) {
      const action = row.action ?? 'skip';
      const clientId = Number(row.client_id);
      const lineItems = Array.isArray(row.line_items) ? row.line_items : [];

      if (action === 'skip') continue;

      /* ------------------------------------------------- denials */
      // A denied, reversed or otherwise unpaid advice is archived here and
      // stops: no claim, no day entries, so it can never reach a revenue total.
      if (action === 'save_denials' || row.paid === false) {
        /*
         * Deny gate: a file whose text layer could not be read produced header
         * money but no service rows, so its "denials" are parsing artefacts, not
         * real unpaid claims. The file row records what was attempted
         * (denial_count) and carries the badge; no denial is written.
         */
        const srcName = String(row.source_file ?? '').trim();
        if (srcName && flaggedFiles.has(srcName)) {
          denyGateSkipped += 1;
          continue;
        }
        const caretaker = caretakerByNpi(row.rendered_provider_id, req.agencyId);
        const original =
          row.original_claim_number || row.claim_number
            ? db
                .prepare(`SELECT id FROM claims WHERE ra_claim_number = ? AND agency_id = ?`)
                .get(row.original_claim_number || row.claim_number, req.agencyId)
            : null;

        // The fallback stays as a safety net, but it now says so: a silently
        // fabricated status is how every reversal became a denial.
        if (row.claim_status == null) {
          console.warn(
            `[deny-gate] row ${i + 1} (${row.claim_number ?? 'no CLM #'}) has no claim_status; defaulting to DENIED`
          );
        }
        saveDeniedBlock({
          raImportId,
          block: {
            ...row,
            claim_status: row.claim_status ?? 'DENIED',
            line_items: lineItems,
          },
          sourceFilename: (req.body?.file_name ?? '').toString().trim() || null,
          // A denied row may have no client matched; that is fine, it is only
          // used for the recovery match later.
          clientId: Number.isInteger(clientId) && clientId > 0 ? clientId : null,
          caretakerId: caretaker?.id ?? null,
          originalClaimId: original?.id ?? null,
          agencyId: req.agencyId,
        });

        // A reversal flags the claim it reversed, but never alters it.
        if (original?.id) {
          db.prepare(
            `UPDATE claims SET reversal_flag = 1, denial_status = 'reversed'
               WHERE id = ? AND agency_id = ?`
            ).run(original.id, req.agencyId);
          summary.reversed_claims += 1;
        }
        summary.denied_claims += 1;
        summary.denied_line_items += lineItems.length;
        continue;
      }

      const client = db
        .prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`)
        .get(clientId, req.agencyId);
      if (!client) {
        summary.warnings.push(`Row for ${row.client_name ?? clientId}: client not found.`);
        continue;
      }

      const dosStart = row.dos_start ?? null;
      const dosEnd = row.dos_end ?? null;

      /* ------------------------------------------ duplicate resolution */
      // Only ever touches records the import itself created.
      const found = existingForPeriod(clientId, dosStart, dosEnd, req.agencyId);
      const resolution = row.resolution ?? 'skip';

      if (found.manual_claim) {
        // A hand-made claim overlaps. Never modified, whatever is asked.
        summary.warnings.push(
          `${client.first_name} ${client.last_name}: the manually-created claim ` +
            `"${found.manual_claim.claim_name}" overlaps this period and was left untouched.`
        );
      }

      if (found.existing_claim) {
        if (resolution === 'skip') {
          summary.skipped_rows += 1;
          continue;
        }

        // Free the dates: day_entries allows one row per client per date, so any
        // surviving RA entry would block the fresh import.
        const cleared = db
          .prepare(
            `DELETE FROM day_entries
             WHERE client_id = @client AND source = 'ra_import'
                 AND work_date >= @start AND work_date <= @end AND agency_id = @agency`
          )
            .run({ client: clientId, start: dosStart, end: dosEnd, agency: req.agencyId })

        if (resolution === 'archive_old') {
          db.prepare(`UPDATE claims SET archived = 1 WHERE id = ? AND agency_id = ?`).run(found.existing_claim.id, req.agencyId);
          summary.archived_claims += 1;
        } else if (resolution === 'overwrite') {
          const old = db
            .prepare(`SELECT local_pdf_path, generated_pdf_path FROM claims WHERE id = ? AND agency_id = ?`)
            .get(found.existing_claim.id, req.agencyId);
          db.prepare(`DELETE FROM claims WHERE id = ? AND agency_id = ?`).run(found.existing_claim.id, req.agencyId);
          // PDFs are files, so they are removed after the transaction commits.
          for (const path of [old?.local_pdf_path, old?.generated_pdf_path]) {
            if (path) orphanedPdfs.push(path);
          }
          summary.overwritten_claims += 1;
        }

        console.log(
          `[import-ra] ${resolution} on claim ${found.existing_claim.id} ` +
            `(${found.existing_claim.claim_name}); cleared ${cleared} RA entr${cleared === 1 ? 'y' : 'ies'}`
        );
      }

      // The Rend Prov ID is the caregiver's NPI: the look-up key for caretakers.
      const providerNpi = row.rendered_provider_id
        ? String(row.rendered_provider_id).trim()
        : null;
      const npiCaretaker = caretakerByNpi(providerNpi, req.agencyId);
      let warnedMissingNpi = false;
      const paidAmount =
        row.total_payment === null || row.total_payment === undefined || row.total_payment === ''
          ? null
          : Number(row.total_payment);

      const lineDates = [
        ...new Set(lineItems.map((item) => item.date).filter(Boolean)),
      ].sort();
      const procedureCodes = [
        ...new Set(lineItems.map((item) => item.procedure_code).filter(Boolean)),
      ];
      const calculatedCharge = round2(
        lineItems.reduce((sum, item) => sum + (Number(item.billed) || 0), 0)
      );
      const chargeAmount =
        lineItems.length > 0
          ? calculatedCharge
          : row.total_charge === null || row.total_charge === undefined || row.total_charge === ''
            ? null
            : Number(row.total_charge);
      const dateOfService =
        lineDates.length === 1
          ? lineDates[0]
          : lineDates.length === 0 && dosStart && dosStart === dosEnd
            ? dosStart
            : null;
      const procedureCode =
        procedureCodes.length > 0
          ? procedureCodes.join(', ')
          : row.procedure_code ?? null;

      /* ---------------------------------------------------------- claims */
      let claimId = null;

      if (action === 'mark_paid' && dosStart && dosEnd) {
        // Most recent claim whose period overlaps the DOS range.
        const existing = db
          .prepare(
            `SELECT * FROM claims
             WHERE client_id = ? AND period_start IS NOT NULL AND period_end IS NOT NULL
               AND period_start <= ? AND period_end >= ?
             ORDER BY period_start DESC, id DESC
             LIMIT 1`
          )
          .get(clientId, dosEnd, dosStart);

        if (existing) {
          // Name and submitted_date are deliberately preserved.
          db.prepare(
            `UPDATE claims
                SET status = 'Paid', paid_date = ?, paid_amount = ?,
                    client_name_raw = ?, member_id = ?, date_of_service = ?,
                    charge_amount = ?, procedure_code = ?
              WHERE id = ? AND agency_id = ?`
          ).run(
            today,
            paidAmount,
            row.client_name ?? `${client.first_name} ${client.last_name}`,
            row.member_id ?? client.ma_number ?? null,
            dateOfService,
            chargeAmount,
            procedureCode,
            existing.id,
            req.agencyId
          );
          claimId = existing.id;
          summary.updated_claims += 1;
        }
      }

      if (!claimId) {
        // "Create New Claim", and "Mark as Paid" when nothing overlapped.
        const periodStart = dosStart;
        const periodEnd = dosEnd;
        const { claim_name } = buildClaimName(client, periodStart, periodEnd);
        const totalUnits = lineItems.reduce((sum, i) => sum + (Number(i.units) || 0), 0);
        const totalDollars = round2(
          lineItems.reduce((sum, i) => sum + (Number(i.billed) || 0), 0)
        );
        // May legitimately be null when the client has no agreement yet.
        const agreement = agreementFor(clientId, periodStart ?? today, req.agencyId);

        const params = bindNamed(CLAIM_INSERT_SQL, {
          claim_name,
          client_id: clientId,
          agreement_id: agreement?.id ?? null,
          period_start: periodStart,
          period_end: periodEnd,
          total_units: totalUnits,
          total_dollars: totalDollars,
          paid_date: today,
          paid_amount: paidAmount,
          ra_import_id: raImportId,
          ra_claim_number: row.claim_number ?? null,
          client_name_raw: row.client_name ?? `${client.first_name} ${client.last_name}`,
          member_id: row.member_id ?? client.ma_number ?? null,
          date_of_service: dateOfService,
          charge_amount: chargeAmount,
          procedure_code: procedureCode,
            agency: req.agencyId,
        });
        logStatement('INSERT claim', CLAIM_INSERT_SQL, params);

        const info = db.prepare(CLAIM_INSERT_SQL).run(params);
        claimId = Number(info.lastInsertRowid);
        summary.created_claims += 1;
      }

      /* ------------------------------------------------ schedule entries */
      for (const item of lineItems) {
        if (!item?.date) continue;

        const already = db
          .prepare(`SELECT id FROM day_entries WHERE client_id = ? AND work_date = ? AND agency_id = ?`)
          .get(clientId, item.date, req.agencyId);
        if (already) {
          // Never overwrite a manual calendar entry.
          summary.skipped_entries += 1;
          continue;
        }

        const agreement = agreementFor(clientId, item.date, req.agencyId);
        if (!agreement || !agreement.id) {
          // Log the offending row and carry on with the rest of the import.
          const who = `${client.first_name} ${client.last_name}`;
          console.error(
            `[import-ra] skipped ${item.date} for ${who} (client ${clientId}): no agreement on file`
          );
          summary.warnings.push(
            `${who} has no agreement, so the ${item.date} entry was not created. ` +
              'Add an agreement for them and import again.'
          );
          continue;
        }

        // Caretaker: an explicit pick from the review screen wins, otherwise the
        // Rend Prov ID (NPI) is used. Absent both, the entry is left unassigned.
        const hasPick =
          item.caretaker_id !== undefined && item.caretaker_id !== null && item.caretaker_id !== '';
        const caretakerId = hasPick ? Number(item.caretaker_id) : npiCaretaker?.id ?? null;

        if (
          !npiCaretaker &&
          providerNpi &&
          !hasPick &&
          !warnedMissingNpi
        ) {
          warnedMissingNpi = true;
          console.warn(
            `[import-ra] no caretaker has NPI ${providerNpi} (${row.rendered_provider_name ?? 'REND PROV'})`
          );
          summary.warnings.push(
            `No caretaker is linked to NPI ${providerNpi} (${row.rendered_provider_name ?? 'rendering provider'}), ` +
              'so those entries are unassigned. Add the NPI to the caretaker and import again.'
          );
        }

        // Units come from the remittance; the rate comes from the agreement.
        const units = Number(item.units) || 0;
        const minutes = units * MINUTES_PER_UNIT;
        const rate = Number(agreement.rate_per_unit) || 0;
        // end_time is DERIVED, not stored: day_entries has no end_time column.
        const times = visitTimes(minutes);

        const params = bindNamed(DAY_ENTRY_INSERT_SQL, {
          client_id: clientId,
          agreement_id: agreement.id,
          caretaker_id: caretakerId,
          work_date: item.date,
          minutes_worked: minutes,
          units,
          rate_per_unit: rate,
          dollars: round2(units * rate),
          notes: 'Imported from RA',
          claim_id: null, // linked below, once the claim is known
          start_time: times.start_time,
          ra_import_id: raImportId,
          // carried forward so a visit can be resolved against the agreement
          // line that authorised its date, not just its stored agreement_id
          service_code: item.procedure_code ?? null,
          modifier: item.modifier ?? null,
            agency: req.agencyId,
        });
        logStatement(
          `INSERT day_entry ${item.date} (${times.start_time}-${times.end_time})` +
            (caretakerId ? ` caretaker=${caretakerId}` : ' caretaker=none'),
          DAY_ENTRY_INSERT_SQL,
          params
        );

        db.prepare(DAY_ENTRY_INSERT_SQL).run(params);
        summary.added_entries += 1;
      }

      /* --------------------------------------------- link to the claim */
      if (claimId) {
        const claim = db
          .prepare(`SELECT * FROM claims WHERE id = ? AND agency_id = ?`)
          .get(claimId, req.agencyId);
        if (claim?.period_start && claim?.period_end) {
          // Only entries this import created are linked: attaching a manual
          // entry to a claim would be modifying user-entered data.
          const linked = db
            .prepare(
              `UPDATE day_entries SET claim_id = ?
               WHERE client_id = ? AND claim_id IS NULL AND source = 'ra_import'
                   AND work_date >= ? AND work_date <= ? AND agency_id = ?`
            )
            .run(claimId, clientId, claim.period_start, claim.period_end, req.agencyId);
          summary.linked_entries += linked.changes;
        }
      }
    }
  });

  try {
    run();
    // One row per FILE, which is the grain the audit screen needs.
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const insert = db.prepare(
      `INSERT INTO ra_import_files
         (ra_import_id, file_name, stored_path, file_hash, check_date, prod_date,
          vendor_number, check_eft_number, payment_amount, forwarding_balance,
          claim_count, denial_count, client_count, raw_char_count, status, note, agency_id)
       VALUES
         (@import_id, @file_name, @stored_path, @file_hash, @check_date, @prod_date,
          @vendor, @check_nbr, @amount, @fwd, @claims, @denials, @clients, @raw,
          @status, @note, @agency)`
    );
    // Idempotent: re-importing the same batch must not duplicate file rows.
    const drop = db.prepare(
      `DELETE FROM ra_import_files
       WHERE ra_import_id = @id AND file_name = @name
           AND COALESCE(file_hash, '') = COALESCE(@hash, '')
           AND agency_id = @agency`
    );
    for (const f of files) {
      drop.run({ id: raImportId, name: f.file_name ?? 'unnamed.pdf', hash: f.file_hash ?? null, agency: req.agencyId });
      insert.run({
        import_id: raImportId,
        file_name: f.file_name ?? 'unnamed.pdf',
        stored_path: f.stored_path ?? null,
        file_hash: f.file_hash ?? null,
        check_date: f.check_date ?? null,
        prod_date: f.prod_date ?? null,
        vendor: f.vendor_number ?? null,
        check_nbr: f.check_eft_number ?? null,
        amount: f.payment_amount ?? null,
        fwd: f.forwarding_balance ?? null,
        claims: f.claim_count ?? 0,
        denials: f.denial_count ?? 0,
        clients: f.client_count ?? 0,
        raw: f.raw_char_count ?? null,
        // the detector's verdict rides the payload; the row must record it
        status: f.layout_unrecognised ? 'layout_unrecognised' : 'active',
        note: f.note ?? null,
      });
    }
  } catch (e) {
    console.warn('[import-ra] could not record the per-file audit rows:', e.message);
  }

  // Identity is written after the fact because the counts are only known now.
    db.prepare(
      `UPDATE ra_imports
       SET file_hash = @hash, check_eft_number = @check, prod_date = @prod,
           vendor_number = @vendor, claim_count = @claims, denial_count = @denials,
           status = 'active', pdf_path = COALESCE(@pdf, pdf_path),
           updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      id: raImportId,
      hash: (req.body?.file_hash ?? '').toString().trim() || null,
      check: (req.body?.check_eft_number ?? '').toString().trim() || null,
      prod: (req.body?.prod_date ?? '').toString().trim() || null,
      vendor: (req.body?.vendor_number ?? '').toString().trim() || null,
      claims: summary.created_claims + summary.updated_claims,
      denials: summary.denied_claims,
      pdf: req.body?.stored_path ?? req.body?.files?.[0]?.stored_path ?? null,
    });

    /*
     * A file whose layout we could not read still produced real money in its
     * header. The import is flagged and those claims are marked incomplete —
     * kept, never dropped, because deleting them would remove real revenue.
     */
    if (flaggedFiles.size) {
      db.prepare(`UPDATE ra_imports SET status = 'layout_unrecognised' WHERE id = ? AND agency_id = ?`).run(raImportId, req.agencyId);
      // No service lines means no day entries: the precise signature of a
      // half-parsed claim, and it leaves a mixed batch's good claims alone.
      db.prepare(
        `UPDATE claims SET parse_status = 'layout_incomplete'
         WHERE ra_import_id = ?
             AND id NOT IN (SELECT DISTINCT claim_id FROM day_entries WHERE claim_id IS NOT NULL)
             AND agency_id = ?`
        ).run(raImportId, req.agencyId);
      console.log(
        `[import-ra] layout_unrecognised on import ${raImportId} — ${[...flaggedFiles].join(', ')}`
      );
    }
    markOrphanedImports(req.agencyId);
  } catch (e) {
    console.error('[import-ra] save failed:', e.stack || e.message);
    return res.status(500).json({ error: `Import failed: ${e.message}` });
  }

  // Claims are the source of truth for both the Home YTD card and each client's
  // profile totals; recompute here so a successful save is observable in logs.
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const ytd = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(paid_amount), 0) AS total
         FROM claims
        WHERE agency_id = ? AND status = 'Paid' AND paid_date >= ?`
    )
    .get(req.agencyId, yearStart);
  console.log(
    `[PROPAGATION] Updated YTD for Agency ${req.agencyId}. ` +
      `claims=${ytd.count} total=$${round2(ytd.total).toFixed(2)}`
  );

  // The rows are gone for good now, so their PDF files can go too.
  for (const rel of orphanedPdfs) {
    try {
      fs.unlinkSync(resolveStored(rel));
    } catch {
      /* already gone */
    }
  }

  // A new paid import may be the rebill that clears an older denial, and a new
  // denial may already have been paid, so both directions are retried.
  try {
    summary.recovered_denials = runRecovery(req.agencyId);
    ensureRebillTasks(req.agencyId);
  } catch (e) {
    summary.warnings.push(`Recovery pass failed: ${e.message}`);
  }

  res.json({ summary });
});

export default router;
