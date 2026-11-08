import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { importFactors, netPaid } from '../paidMath.js';
import { markOrphanedImports } from '../denials.js';
import { round2, daysBetween, todayISO, addDays } from '../calc.js';
import { buildClaimPdf } from '../claimPdf.js';
import { getSetting } from '../settings.js';
import {
  ensureClaimsDir,
  safeFileName,
  resolveStored,
  isPdfBuffer,
  relativePathFor,
} from '../pdfStorage.js';

const router = express.Router();

/* ------------------------------------------------------------------ naming */

/** Strip anything that would be awkward in a filename (these become PDFs). */
function slug(value, fallback = '') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9]/g, '');
  return cleaned || fallback;
}

/** '2026-01-05' -> '20260105' */
function compactDate(iso) {
  return String(iso ?? '').replace(/-/g, '');
}

/**
 * Next sequence number for a client + period.
 * Derived from the highest suffix already used, so deleting a claim never
 * causes a name collision.
 */
function nextSeq(clientId, periodStart, periodEnd) {
  const rows = db
    .prepare(
      `SELECT claim_name FROM claims
       WHERE client_id = ? AND period_start = ? AND period_end = ?`
    )
    .all(clientId, periodStart, periodEnd);

  let max = 0;
  for (const r of rows) {
    const m = /_(\d+)$/.exec(r.claim_name ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  const seq = max + 1;
  return { seq, label: String(seq).padStart(2, '0') };
}

/**
 * Render a claim name from the template stored in Settings.
 * Values are slugged before substitution; the template's own separators are
 * left exactly as the user typed them.
 */
export function renderClaimName(template, parts) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    key in parts ? parts[key] : match
  );
}

/**
 * Exported so the RA import creates claims with exactly the same naming
 * convention this route uses — one implementation, one convention.
 */
export function buildClaimName(client, periodStart, periodEnd) {
  const { seq, label } = nextSeq(client.id, periodStart, periodEnd);
  const template = getSetting('claim_name_template') || '{last}_{ma}_{dos_start}_{dos_end}_{seq}';

  const name = renderClaimName(template, {
    last: slug(client.last_name, 'Client'),
    first: slug(client.first_name, 'Client'),
    ma: slug(client.ma_number, 'noMA'),
    dos_start: compactDate(periodStart),
    dos_end: compactDate(periodEnd),
    seq: label,
  });

  return { claim_name: name, seq, template };
}

/* ------------------------------------------------------------- decorating */

/**
 * Adds derived fields for the UI. Everything here is computed from stored
 * columns; nothing is invented.
 */
/**
 * The amount this claim actually brought in.
 *
 * Exposed so the Dashboard's Paid card can SUM the same field Reports uses.
 * Summing `paid_amount` here was the bug: it is the billed-adjacent per-claim
 * header figure, not money received, and it does not net a forwarding balance.
 */
let __factors = null;
let __factorsAt = 0;
function netPaidFactors(agencyId) {
  // Import totals change only on import, so a short cache is plenty.
  if (!__factors || Date.now() - __factorsAt > 5000) {
    __factors = importFactors(agencyId);
    __factorsAt = Date.now();
  }
  return __factors;
}

function decorate(row, agencyId) {
  if (!row) return row;
  const paidLag =
    row.paid_date && row.submitted_date ? daysBetween(row.submitted_date, row.paid_date) : null;
  const vsExpected =
    row.paid_date && row.expected_pay_date
      ? daysBetween(row.expected_pay_date, row.paid_date)
      : null;

  const overdue =
    !row.paid_date &&
    Boolean(row.expected_pay_date) &&
    row.expected_pay_date < todayISO() &&
    row.status !== 'Draft' &&
    row.status !== 'Denied';

  return {
    ...row,
    // money actually received, so the Dashboard can SUM what Reports sums
    net_paid_amount: netPaid(row, netPaidFactors(agencyId)),
    paid_lag_days: paidLag,
    days_vs_expected: vsExpected,
    is_overdue: overdue,
  };
}

/* ------------------------------------------------------------ attachments */

ensureClaimsDir();

const MAX_PDF_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf';
    if (!ok) {
      const err = new Error('Only PDF files are accepted.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Where a claim's PDF lives on disk. Deterministic from the claim name, and
 * disambiguated with the claim id in the unlikely event two claims collide.
 *
 * Generated and uploaded files get different suffixes so they never clobber
 * each other — a manual upload can sit alongside the generated document.
 */
function storedPdfPath(claim, kind) {
  const base = safeFileName(claim.claim_name, `claim-${claim.id}`);
  const suffix = kind === 'generated' ? '_claim' : '_uploaded';
  let rel = relativePathFor(`${base}${suffix}.pdf`);
  const clash = db
    .prepare(
      `SELECT id FROM claims
       WHERE (local_pdf_path = @p OR generated_pdf_path = @p) AND id <> @id`
    )
    .get({ p: rel, id: claim.id });
  if (clash) rel = relativePathFor(`${base}${suffix}_${claim.id}.pdf`);
  return rel;
}

/** Load everything the PDF generator needs for one claim. */
function claimPdfContext(claim) {
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(claim.client_id);
  const agreement = claim.agreement_id
    ? db
        .prepare(
          `SELECT a.*, p.name AS payer_name
           FROM agreements a LEFT JOIN payers p ON p.id = a.payer_id
           WHERE a.id = ?`
        )
        .get(claim.agreement_id)
    : null;
  const entries = db
    .prepare(
      `SELECT d.*, t.first_name AS caretaker_first_name, t.last_name AS caretaker_last_name,
              t.npi_number AS caretaker_npi
       FROM day_entries d
       LEFT JOIN caretakers t ON t.id = d.caretaker_id
       WHERE d.claim_id = ?
       ORDER BY d.work_date`
    )
    .all(claim.id);
  const caseManager =
    client?.case_manager_id
      ? db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(client.case_manager_id)
      : null;
  return { client, agreement, caseManager, entries };
}

/* ------------------------------------------------------------------ routes */

/**
 * A day entry is available for a new claim when it has no claim, or when the
 * claim it points at has been archived — archiving retires a claim without
 * destroying the link, so its days become claimable again.
 */
export const AVAILABLE_ENTRY_SQL =
  `(claim_id IS NULL OR claim_id IN (SELECT id FROM claims WHERE COALESCE(archived, 0) = 1))`;

/** GET /api/claims?client_id=&status=&overdue=1 */
router.get('/', (req, res) => {
  const where = [];
  const params = {};

  if (req.query.client_id) {
    where.push('cl.client_id = @client_id');
    params.client_id = Number(req.query.client_id);
  }
  if (req.query.status) {
    where.push('cl.status = @status');
    params.status = req.query.status;
  }
  // Archived claims are hidden unless explicitly asked for.
  if (req.query.archived !== '1') where.push('COALESCE(cl.archived, 0) = 0');

  if (req.query.overdue === '1') {
    where.push(`cl.paid_date IS NULL AND cl.expected_pay_date IS NOT NULL
                AND cl.expected_pay_date < @today
                AND cl.status NOT IN ('Draft','Denied')`);
    params.today = todayISO();
  }

  const rows = db
    .prepare(
      `SELECT cl.*, c.first_name, c.last_name, c.ma_number, p.name AS payer_name,
              p.typical_days_to_pay
       FROM claims cl
       JOIN clients c ON c.id = cl.client_id
       LEFT JOIN agreements a ON a.id = cl.agreement_id
       LEFT JOIN payers p ON p.id = a.payer_id
       WHERE cl.agency_id = @agency
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(cl.period_start, cl.created_at) DESC, cl.id DESC`
    )
    .all({ ...params, agency: req.agencyId });

  // The dashboard counter needs the total regardless of the filter.
  const archivedTotal = db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims
        WHERE COALESCE(archived, 0) = 1 AND agency_id = @agency`
    )
    .get({ agency: req.agencyId }).n;

  res.json({ claims: rows.map((r) => decorate(r, req.agencyId)), archived_count: archivedTotal });
});

/**
 * GET /api/claims/preview?client_id=&period_start=&period_end=
 * Live claim-name preview plus what would be swept into the claim.
 * Must stay above /:id.
 */
router.get('/preview', (req, res) => {
  const clientId = Number(req.query.client_id);
  if (!clientId) return res.status(400).json({ error: 'client_id is required' });

  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Every unclaimed day this client has, regardless of any chosen window. This
  // is what the profile summary counts, so the dialog can prove it has not
  // quietly left one out.
  const allUnclaimed = db
    .prepare(
      `SELECT work_date, units, dollars FROM day_entries
       WHERE client_id = ? AND ${AVAILABLE_ENTRY_SQL}
       ORDER BY work_date`
    )
    .all(clientId);

  const overall = {
    day_count: allUnclaimed.length,
    total_units: allUnclaimed.reduce((s, e) => s + (e.units || 0), 0),
    total_dollars: round2(allUnclaimed.reduce((s, e) => s + (e.dollars || 0), 0)),
    first_date: allUnclaimed[0]?.work_date ?? null,
    last_date: allUnclaimed[allUnclaimed.length - 1]?.work_date ?? null,
  };

  // With no explicit window, span the whole unclaimed range rather than
  // guessing at a calendar week. A fixed week boundary silently drops the days
  // either side of it.
  let start = req.query.period_start;
  let end = req.query.period_end;
  const usedSuggestion = !isISODate(start) || !isISODate(end);

  if (usedSuggestion) {
    if (!overall.first_date) {
      return res.json({
        claim_name: null,
        seq: 1,
        period_start: null,
        period_end: null,
        client: { id: client.id, first_name: client.first_name, last_name: client.last_name },
        day_count: 0,
        already_claimed_count: 0,
        total_units: 0,
        total_dollars: 0,
        days: [],
        overall_unclaimed: overall,
        suggested_period_start: null,
        suggested_period_end: null,
        excluded_unclaimed_count: 0,
        covers_all_unclaimed: true,
      });
    }
    start = overall.first_date;
    end = overall.last_date;
  }

  if (end < start) return res.status(400).json({ error: 'period_end cannot be before period_start' });

  const entries = db
    .prepare(
      `SELECT * FROM day_entries
       WHERE client_id = ? AND work_date >= ? AND work_date <= ?
       ORDER BY work_date`
    )
    .all(clientId, start, end);

  const unclaimed = entries.filter((e) => !e.claim_id);
  const alreadyClaimed = entries.length - unclaimed.length;
  const excluded = overall.day_count - unclaimed.length;

  const { claim_name, seq } = buildClaimName(client, start, end);

  res.json({
    claim_name,
    seq,
    period_start: start,
    period_end: end,
    client: { id: client.id, first_name: client.first_name, last_name: client.last_name },
    day_count: unclaimed.length,
    already_claimed_count: alreadyClaimed,
    total_units: unclaimed.reduce((s, e) => s + (e.units || 0), 0),
    total_dollars: round2(unclaimed.reduce((s, e) => s + (e.dollars || 0), 0)),
    days: unclaimed.map((e) => ({
      work_date: e.work_date,
      minutes_worked: e.minutes_worked,
      units: e.units,
      dollars: e.dollars,
    })),
    // Lets the UI say "6 of 7" instead of quietly showing a short total.
    overall_unclaimed: overall,
    suggested_period_start: overall.first_date,
    suggested_period_end: overall.last_date,
    excluded_unclaimed_count: excluded,
    covers_all_unclaimed: excluded === 0,
  });
});

/**
 * GET /api/claims/payer-stats
 * Observed payer behaviour: how long they really take vs the configured terms.
 * Must stay above /:id.
 */
router.get('/payer-stats', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id AS payer_id, p.name AS payer_name, p.typical_days_to_pay,
              COUNT(cl.id) AS paid_claims,
              ROUND(AVG(julianday(cl.paid_date) - julianday(cl.submitted_date)), 1) AS avg_lag_days,
              ROUND(AVG(cl.variance_days), 1) AS avg_variance_days,
              COALESCE(SUM(cl.paid_amount), 0) AS total_paid
       FROM payers p
       LEFT JOIN agreements a ON a.payer_id = p.id
       LEFT JOIN claims cl ON cl.agreement_id = a.id AND cl.paid_date IS NOT NULL
       GROUP BY p.id
       ORDER BY p.name COLLATE NOCASE`
    )
    .all();

  res.json({ payers: rows.map((r) => ({ ...r, total_paid: round2(r.total_paid) })) });
});

/**
 * POST /api/claims  { client_id, period_start, period_end }
 * Sweeps every unclaimed day entry in the period into a new Draft claim.
 */
router.post('/', (req, res) => {
  const b = req.body ?? {};
  const clientId = Number(b.client_id);
  const start = b.period_start;
  const end = b.period_end;

  if (!clientId) return res.status(400).json({ error: 'client_id is required' });
  if (!isISODate(start) || !isISODate(end)) {
    return res.status(400).json({ error: 'period_start and period_end must be YYYY-MM-DD' });
  }
  if (end < start) return res.status(400).json({ error: 'period_end cannot be before period_start' });

  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const run = db.transaction(() => {
    const entries = db
      .prepare(
        `SELECT * FROM day_entries
         WHERE client_id = ? AND work_date >= ? AND work_date <= ? AND ${AVAILABLE_ENTRY_SQL}
         ORDER BY work_date`
      )
      .all(clientId, start, end);

    if (!entries.length) {
      const err = new Error('No unclaimed day entries in that period.');
      err.status = 400;
      throw err;
    }

    const totalUnits = entries.reduce((s, e) => s + (e.units || 0), 0);
    const totalDollars = round2(entries.reduce((s, e) => s + (e.dollars || 0), 0));
    const agreementId = entries.find((e) => e.agreement_id)?.agreement_id ?? null;
    const { claim_name } = buildClaimName(client, start, end);

    const info = db
      .prepare(
        `INSERT INTO claims
           (claim_name, client_id, agreement_id, period_start, period_end,
            total_units, total_dollars, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft')`
      )
      .run(claim_name, clientId, agreementId, start, end, totalUnits, totalDollars);

    const claimId = info.lastInsertRowid;
    const link = db.prepare(`UPDATE day_entries SET claim_id = ? WHERE id = ?`);
    for (const e of entries) link.run(claimId, e.id);

    return claimId;
  });

  try {
    const claimId = run();
    const row = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId);
    res.status(201).json({ claim: decorate(row, req.agencyId) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * PUT / PATCH /api/claims/:id
 * Drives the Draft -> Submitted -> Paid lifecycle.
 */
function updateClaim(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Claim not found' });

  const b = req.body ?? {};
  const updates = {};

  if ('status' in b) {
    const allowed = ['Draft', 'Submitted', 'Paid', 'Denied'];
    if (!allowed.includes(b.status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    updates.status = b.status;
  }
  // Archive/unarchive. The link to its day entries is deliberately kept: the
  // claim keeps its billing history, and everything that matters (validation,
  // exports, reports, the calendar) treats an archived claim as "not claiming
  // these days".
  if ('archived' in b) {
    updates.archived = b.archived === true || b.archived === 1 || b.archived === '1' ? 1 : 0;
  }

  for (const f of ['submitted_date', 'expected_pay_date', 'paid_date']) {
    if (f in b) updates[f] = b[f] === '' ? null : b[f];
  }
  if ('paid_amount' in b) {
    updates.paid_amount = b.paid_amount === '' || b.paid_amount === null ? null : Number(b.paid_amount);
    if (updates.paid_amount !== null && !Number.isFinite(updates.paid_amount)) {
      return res.status(400).json({ error: 'paid_amount must be a number' });
    }
  }
  for (const f of ['submitted_date', 'expected_pay_date', 'paid_date']) {
    if (updates[f] && !isISODate(updates[f])) {
      return res.status(400).json({ error: `${f} must be YYYY-MM-DD` });
    }
  }

  // Moving into Submitted stamps the dates if the caller did not supply them.
  const nextStatus = updates.status ?? existing.status;
  if (nextStatus === 'Submitted' && existing.status !== 'Submitted') {
    const submitted = updates.submitted_date ?? existing.submitted_date ?? todayISO();
    updates.submitted_date = submitted;
    if (!('expected_pay_date' in updates) && !existing.expected_pay_date) {
      updates.expected_pay_date = expectedFromPayer(existing, submitted);
    }
  }
  // A submitted claim with no expected date yet still gets one on any edit.
  if (nextStatus === 'Submitted' && !updates.expected_pay_date && !existing.expected_pay_date) {
    updates.expected_pay_date = expectedFromPayer(existing, updates.submitted_date ?? existing.submitted_date);
  }

  // Recording a payment settles the claim and stores the slippage.
  let paidDate = 'paid_date' in updates ? updates.paid_date : existing.paid_date;

  // Marking a claim Paid without a date left it unmeasurable: the payer-lag
  // stats and the variance both key off paid_date. Stamp today, exactly as
  // moving to Submitted stamps submitted_date.
  if (nextStatus === 'Paid' && !paidDate) {
    paidDate = todayISO();
    updates.paid_date = paidDate;
  }

  if (paidDate) {
    const expected = updates.expected_pay_date ?? existing.expected_pay_date;
    updates.variance_days = expected ? daysBetween(expected, paidDate) : null;
    // A recorded payment settles the claim. This is forced rather than inferred
    // from the request, because the UI sends the status it was showing and that
    // would otherwise leave a paid claim sitting in "Submitted".
    updates.status = 'Paid';
    if (!('paid_amount' in updates) && existing.paid_amount == null) {
      updates.paid_amount = existing.total_dollars;
    }
  } else if ('paid_date' in updates && !paidDate) {
    // Payment un-recorded: clear the derived slippage too.
    updates.variance_days = null;
  }

  if (!Object.keys(updates).length) return res.json({ claim: decorate(existing, req.agencyId) });

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE claims SET ${setSql} WHERE id = @id`).run({ ...updates, id });

  res.json({ claim: decorate(db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id), req.agencyId) });
}

router.patch('/:id', updateClaim);
router.put('/:id', updateClaim);

/**
 * DELETE /api/claims/:id — releases its day entries back to unclaimed and
 * removes any attached PDF, so deleting a claim never orphans a file on disk.
 */
/** How many day entries still point at a claim. */
function linkedEntryCount(id) {
  return db.prepare(`SELECT COUNT(*) AS n FROM day_entries WHERE claim_id = ?`).get(id).n;
}

/**
 * How a claim's linked entries break down by where they came from.
 *
 * `day_entries.source` is the source of truth: entries the RA import created
 * are import artefact and go with the claim, while anything a human typed is
 * never deleted.
 */
function linkedEntryBreakdown(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return { ra_import_entries: 0, manual_entries: 0, linked_entries: 0 };
  const placeholders = list.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT CASE WHEN source = 'ra_import' THEN 'ra_import' ELSE 'manual' END AS kind,
              COUNT(*) AS n
       FROM day_entries WHERE claim_id IN (${placeholders})
       GROUP BY kind`
    )
    .all(...list);
  const ra = rows.find((r) => r.kind === 'ra_import')?.n ?? 0;
  const manual = rows.find((r) => r.kind === 'manual')?.n ?? 0;
  return { ra_import_entries: ra, manual_entries: manual, linked_entries: ra + manual };
}

/**
 * Keep the RA import log honest after RA-created claims are deleted.
 *
 * A log row whose every claim is gone is removed outright, so a deleted import
 * stops showing on the Home Dashboard. One that still has claims keeps its
 * place, but its client count drops to the survivors.
 */
function reconcileRaImports(importIds) {
  const ids = [...new Set(importIds.filter((n) => Number.isInteger(n) && n > 0))];
  let removed = 0;
  let updated = 0;
  for (const id of ids) {
    const survivors = db
      .prepare(
        `SELECT COUNT(*) AS claims, COUNT(DISTINCT client_id) AS clients
         FROM claims WHERE ra_import_id = ?`
      )
      .get(id);
    if (!survivors.claims) {
      db.prepare(`DELETE FROM ra_imports WHERE id = ?`).run(id);
      removed += 1;
    } else {
      db.prepare(`UPDATE ra_imports SET num_clients = ? WHERE id = ?`).run(survivors.clients, id);
      updated += 1;
    }
  }
  return { removed, updated };
}

/**
 * Release a claim's linked entries just before the claim row is removed.
 *
 * RA-imported entries are DELETED — they are the import's own schedule, hours
 * and caretaker assignment, and deleting the claim should clear them from the
 * calendar and the caretaker totals. Manually-entered entries are PRESERVED and
 * merely unlinked, so no hand-typed work is ever lost.
 */
function releaseLinkedEntries(claimIds) {
  const list = Array.isArray(claimIds) ? claimIds : [claimIds];
  if (!list.length) return { removed: 0, unlinked: 0 };
  const placeholders = list.map(() => '?').join(',');
  const removed = db
    .prepare(`DELETE FROM day_entries WHERE claim_id IN (${placeholders}) AND source = 'ra_import'`)
    .run(...list).changes;
  const unlinked = db
    .prepare(
      `UPDATE day_entries SET claim_id = NULL
       WHERE claim_id IN (${placeholders}) AND COALESCE(source, 'manual') <> 'ra_import'`
    )
    .run(...list).changes;
  return { removed, unlinked };
}

/**
 * POST /api/claims/bulk-archive  { ids: [] }
 *
 * Only archives the non-archived ones — this is not a toggle — and reports how
 * many were already archived so the UI can say so.
 */
router.post('/bulk-archive', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, archived FROM claims WHERE id IN (${placeholders})`)
    .all(...ids);

  const toArchive = rows.filter((r) => !r.archived).map((r) => r.id);
  const alreadyArchived = rows.length - toArchive.length;

  if (toArchive.length) {
    const set = toArchive.map(() => '?').join(',');
    db.prepare(`UPDATE claims SET archived = 1 WHERE id IN (${set})`).run(...toArchive);
  }

  res.json({
    archived: toArchive.length,
    already_archived: alreadyArchived,
    not_found: ids.length - rows.length,
  });
});

/** POST /api/claims/bulk-delete-check  { ids: [] } — pre-flight for the modal. */
router.post('/bulk-delete-check', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.id, COALESCE(c.archived, 0) AS archived,
              (SELECT COUNT(*) FROM day_entries d WHERE d.claim_id = c.id) AS linked
       FROM claims c WHERE c.id IN (${placeholders})`
    )
    .all(...ids);

  // Only a LIVE claim with days attached is undeletable; archived claims are
  // always removable.
  const blocked = rows.filter((r) => !r.archived && r.linked > 0).map((r) => r.id);
  const deletableIds = rows.filter((r) => !blocked.includes(r.id)).map((r) => r.id);

  res.json({
    deletable: deletableIds.length > 0,
    deletable_count: deletableIds.length,
    deletable_ids: deletableIds,
    blocked_count: blocked.length,
    blocked_ids: blocked,
    total: ids.length,
    // What the delete will actually do to the entries it frees.
    ...linkedEntryBreakdown(deletableIds),
  });
});

/**
 * Day entries inside a claim's period that now belong to a DIFFERENT, live
 * claim. That is what makes unarchiving risky: the days were unlocked when the
 * claim was archived, and a new claim may have been generated over them.
 */
function unarchiveConflicts(claimIds) {
  if (!claimIds.length) return new Map();
  const placeholders = claimIds.map(() => '?').join(',');
  const claims = db
    .prepare(
      `SELECT id, claim_name, client_id, period_start, period_end
       FROM claims WHERE id IN (${placeholders})`
    )
    .all(...claimIds);

  const count = db.prepare(
    `SELECT COUNT(*) AS n
     FROM day_entries d
     JOIN claims other ON other.id = d.claim_id
     WHERE other.client_id = @client
       AND d.claim_id <> @self
       AND COALESCE(other.archived, 0) = 0
       AND d.work_date >= @start AND d.work_date <= @end`
  );

  const out = new Map();
  for (const c of claims) {
    if (!c.period_start || !c.period_end) {
      out.set(c.id, 0);
      continue;
    }
    out.set(
      c.id,
      count.get({ self: c.id, client: c.client_id, start: c.period_start, end: c.period_end }).n
    );
  }
  return out;
}

/** POST /api/claims/bulk-unarchive-check  { ids: [] } — pre-flight for the modal. */
router.post('/bulk-unarchive-check', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, claim_name, archived FROM claims WHERE id IN (${placeholders})`)
    .all(...ids);

  const archived = rows.filter((r) => r.archived);
  const conflicts = unarchiveConflicts(archived.map((r) => r.id));
  const conflicting = archived
    .map((r) => ({ id: r.id, claim_name: r.claim_name, entries: conflicts.get(r.id) ?? 0 }))
    .filter((r) => r.entries > 0);

  res.json({
    archived_count: archived.length,
    not_archived_count: rows.length - archived.length,
    not_found: ids.length - rows.length,
    conflict_count: conflicting.reduce((s, r) => s + r.entries, 0),
    conflicting_claims: conflicting,
    total: ids.length,
  });
});

/**
 * POST /api/claims/bulk-unarchive  { ids: [] }
 *
 * Restores the archived ones — not a toggle — and reports how many were
 * skipped because they were already live.
 */
router.post('/bulk-unarchive', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, archived FROM claims WHERE id IN (${placeholders})`)
    .all(...ids);

  const toRestore = rows.filter((r) => r.archived).map((r) => r.id);

  if (toRestore.length) {
    const set = toRestore.map(() => '?').join(',');
    db.prepare(`UPDATE claims SET archived = 0 WHERE id IN (${set})`).run(...toRestore);
  }

  res.json({
    unarchived: toRestore.length,
    skipped: rows.length - toRestore.length,
    not_found: ids.length - rows.length,
  });
});

/**
 * POST /api/claims/bulk-delete  { ids: [] }
 *
 * All-or-nothing: if ANY selected claim still has day entries linked, nothing
 * is deleted and the offending claims are reported so the UI can offer
 * "Archive Instead" instead.
 */
router.post('/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.id, c.claim_name, COALESCE(c.archived, 0) AS archived,
              c.source, c.ra_import_id,
              c.local_pdf_path, c.generated_pdf_path,
              (SELECT COUNT(*) FROM day_entries d WHERE d.claim_id = c.id) AS linked
       FROM claims c WHERE c.id IN (${placeholders})`
    )
    .all(...ids);

  const blocked = rows.filter((r) => !r.archived && r.linked > 0);
  const deletable = rows.filter((r) => !blocked.includes(r));

  // Nothing at all can go: report the block so the UI can offer Archive Instead.
  if (!deletable.length) {
    return res.status(409).json({
      error:
        `${blocked.length} of the selected claims have linked day entries and cannot be deleted. ` +
        'Archive them instead?',
      blocked: true,
      blocked_count: blocked.length,
      blocked_ids: blocked.map((r) => r.id),
      total: rows.length,
    });
  }

  // Live claims being removed outright take their PDFs with them; archived ones
  // keep their paperwork on disk.
  const files = [];
  for (const r of deletable) {
    if (r.archived) continue;
    for (const stored of [r.local_pdf_path, r.generated_pdf_path]) if (stored) files.push(stored);
  }

  const deleteIds = deletable.map((r) => r.id);
  const delPlaceholders = deleteIds.map(() => '?').join(',');
  let removed = 0;
  let unlinked = 0;
  const importIds = deletable
    .filter((r) => r.source === 'ra_import' && r.ra_import_id)
    .map((r) => r.ra_import_id);
  let logRowsRemoved = 0;
  db.transaction(() => {
    // Same rule as the single-claim path: imported entries go, manual ones stay.
    const r = releaseLinkedEntries(deleteIds);
    removed = r.removed;
    unlinked = r.unlinked;
    db.prepare(`DELETE FROM claims WHERE id IN (${delPlaceholders})`).run(...deleteIds);
    markOrphanedImports(req.agencyId);
    logRowsRemoved = reconcileRaImports(importIds).removed;
  })();

  for (const rel of files) {
    try {
      fs.unlinkSync(resolveStored(rel));
    } catch {
      /* already gone */
    }
  }

  res.json({
    deleted: deletable.length,
    deleted_archived: deletable.filter((r) => r.archived).length,
    deleted_entries: removed,
    unlinked_entries: unlinked,
    ra_imports_removed: logRowsRemoved,
    skipped: blocked.length,
    skipped_ids: blocked.map((r) => r.id),
    not_found: ids.length - rows.length,
  });
});

/** GET /api/claims/:id/delete-check — may this claim be deleted, or archived? */
router.get('/:id/delete-check', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  const breakdown = linkedEntryBreakdown(id);
  const archived = Boolean(claim.archived);
  res.json({
    // An archived claim may always be removed. A live claim still refuses while
    // day entries are attached.
    deletable: archived || breakdown.linked_entries === 0,
    claim_id: id,
    claim_name: claim.claim_name ?? `#${id}`,
    ...breakdown,
    archived,
    keep_pdfs: archived,
  });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Claim not found' });

  // A LIVE claim with days on it must be archived first. (The RA import's
  // overwrite releases its own entries explicitly, so it is unaffected.)
  const linked = linkedEntryCount(id);
  const archived = Boolean(existing.archived);
  if (!archived && linked > 0) {
    return res.status(409).json({
      error:
        `Cannot delete this claim. It has ${linked} linked day entr${linked === 1 ? 'y' : 'ies'}. ` +
        'Archive it instead to preserve billing history.',
      blocked: true,
      claim_id: id,
      claim_name: existing.claim_name ?? `#${id}`,
      linked_entries: linked,
    });
  }

  // An archived claim keeps its PDFs on disk: the paperwork is the only record
  // left of what it covered once the row is gone.
  const removedFiles = [];
  if (!archived) {
    for (const stored of [existing.local_pdf_path, existing.generated_pdf_path]) {
      if (!stored) continue;
      try {
        const absolute = resolveStored(stored);
        if (fs.existsSync(absolute)) {
          fs.unlinkSync(absolute);
          removedFiles.push(stored);
        }
      } catch {
        /* bad or already-missing path: the row still goes away */
      }
    }
  }

  const released = { removed: 0, unlinked: 0 };
  const reconcile = { removed: 0, updated: 0 };
  db.transaction(() => {
    // RA-imported entries go with the claim; manual ones are only unlinked.
    const r = releaseLinkedEntries(id);
    released.removed = r.removed;
    released.unlinked = r.unlinked;
    db.prepare(`DELETE FROM claims WHERE id = ?`).run(id);
    markOrphanedImports(req.agencyId);
    if (existing.source === 'ra_import' && existing.ra_import_id) {
      Object.assign(reconcile, reconcileRaImports([existing.ra_import_id]));
    }
  })();

  res.json({
    deleted: true,
    id,
    ra_imports_removed: reconcile.removed,
    deleted_entries: released.removed,
    unlinked_entries: released.unlinked,
    removed_files: removedFiles,
    kept_pdfs: archived,
  });
});

/**
 * POST /api/claims/:id/pdf/generate
 * Builds the claim summary PDF from the claim's own data, saves it under
 * data/claims/, and records the path. Regenerating simply overwrites it, so
 * this is always safe to run again.
 */
/**
 * Render the claim PDF and store it, recording the path on the claim.
 * Shared by the explicit "generate" route and by regeneration.
 */
async function writeClaimPdf(claim) {
  const { client, agreement, caseManager, entries } = claimPdfContext(claim);
  if (!entries.length) throw new Error('This claim has no day entries, so there is nothing to summarise.');

  const buffer = await buildClaimPdf({ claim, client, agreement, caseManager, entries });
  if (!isPdfBuffer(buffer)) throw new Error('the generator produced something that is not a PDF');

  const rel = storedPdfPath(claim, 'generated');
  const absolute = resolveStored(rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);

  // The filename can change if the claim was renamed; drop the stale file.
  const previous = claim.generated_pdf_path;
  if (previous && previous !== rel) {
    try {
      fs.unlinkSync(resolveStored(previous));
    } catch {
      /* already gone */
    }
  }

  db.prepare(`UPDATE claims SET generated_pdf_path = ? WHERE id = ?`).run(rel, claim.id);
  return { path: rel, name: path.basename(rel), bytes: buffer.length, day_count: entries.length };
}

router.post('/:id/pdf/generate', async (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  try {
    const file = await writeClaimPdf(claim);
    const updated = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
    res.status(201).json({ claim: decorate(updated, req.agencyId), file });
  } catch (e) {
    res.status(500).json({ error: `Could not build the claim PDF: ${e.message}` });
  }
});

/**
 * POST /api/claims/:id/regenerate
 *
 * Re-derives the claim's totals from the day entries in its period. Only a
 * Draft claim may be regenerated: a submitted or paid claim is a record that
 * was sent to a payer, so changing its numbers behind the scenes would be
 * wrong. The caller is told to revert to Draft first.
 *
 * Entries in the period that belong to a DIFFERENT claim are reported and left
 * alone rather than being silently absorbed.
 */
router.post('/:id/regenerate', async (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  if (claim.status !== 'Draft') {
    return res.status(409).json({
      error: `This claim is locked (${claim.status}). Revert to Draft first to edit.`,
      locked: true,
      status: claim.status,
    });
  }
  if (!claim.period_start || !claim.period_end) {
    return res.status(400).json({ error: 'This claim has no period, so there is nothing to re-aggregate.' });
  }

  const inPeriod = db
    .prepare(
      `SELECT * FROM day_entries
       WHERE client_id = ? AND work_date >= ? AND work_date <= ?
       ORDER BY work_date`
    )
    .all(claim.client_id, claim.period_start, claim.period_end);

  const mine = inPeriod.filter((e) => e.claim_id == null || e.claim_id === id);
  const others = inPeriod.filter((e) => e.claim_id != null && e.claim_id !== id);

  const totalUnits = mine.reduce((sum, e) => sum + (e.units || 0), 0);
  const totalDollars = round2(mine.reduce((sum, e) => sum + (e.dollars || 0), 0));
  const agreementId = mine.find((e) => e.agreement_id)?.agreement_id ?? claim.agreement_id ?? null;

  db.transaction(() => {
    // 1. clear the old aggregate, 2. re-link the period's entries, 3. write the new one.
    db.prepare(`UPDATE claims SET total_units = NULL, total_dollars = NULL WHERE id = ?`).run(id);
    const link = db.prepare(`UPDATE day_entries SET claim_id = ? WHERE id = ?`);
    for (const e of mine) if (e.claim_id !== id) link.run(id, e.id);
    db.prepare(
      `UPDATE claims
       SET total_units = ?, total_dollars = ?, agreement_id = ?, last_regenerated_at = datetime('now')
       WHERE id = ?`
    ).run(totalUnits, totalDollars, agreementId, id);
  })();

  // 4. refresh the stored PDF, if one exists. A claim without one is left alone.
  let pdf = { regenerated: false, reason: null };
  const afterAggregate = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (afterAggregate.generated_pdf_path) {
    try {
      const file = await writeClaimPdf(afterAggregate);
      pdf = { regenerated: true, ...file };
    } catch (e) {
      pdf.reason = e.message;
    }
  } else {
    pdf.reason = 'no generated PDF on this claim yet';
  }

  res.json({
    claim: decorate(db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id), req.agencyId),
    aggregation: {
      day_count: mine.length,
      total_units: totalUnits,
      total_dollars: totalDollars,
      skipped_other_claims: others.length,
    },
    pdf,
  });
});

/**
 * POST /api/claims/:id/revert
 * Unlocks a Submitted/Paid claim by returning it to Draft.
 *
 * The submission timeline (submitted_date / expected_pay_date / variance_days)
 * is cleared because the claim is no longer submitted. Recorded payment facts
 * (paid_date / paid_amount) are deliberately KEPT — deleting a payment record
 * automatically would be destructive; the caller can clear them explicitly.
 */
router.post('/:id/revert', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (claim.status === 'Draft') {
    return res.json({ claim: decorate(claim, req.agencyId), changed: false });
  }

  db.prepare(
    `UPDATE claims
     SET status = 'Draft', submitted_date = NULL, expected_pay_date = NULL, variance_days = NULL
     WHERE id = ?`
  ).run(id);

  res.json({
    claim: decorate(db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id), req.agencyId),
    changed: true,
    kept_payment_record: claim.paid_date != null || claim.paid_amount != null,
  });
});

/**
 * GET /api/claims/:id/pdf/generated[?download=1]
 * Streams the generated PDF. Inline by default so it opens in a tab;
 * ?download=1 sends it as an attachment using the clean claim name.
 */
router.get('/:id/pdf/generated', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (!claim.generated_pdf_path) {
    return res.status(404).json({
      error: 'No generated PDF yet — use "Download Claim PDF" to create one.',
    });
  }

  let absolute;
  try {
    absolute = resolveStored(claim.generated_pdf_path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(absolute)) {
    return res.status(410).json({
      error: `The PDF is recorded as ${claim.generated_pdf_path} but is missing from disk. Regenerate it.`,
    });
  }

  const download = req.query.download === '1';
  const niceName = `${safeFileName(claim.claim_name, `claim-${claim.id}`)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${niceName}"`
  );
  fs.createReadStream(absolute).pipe(res);
});

/** DELETE /api/claims/:id/pdf/generated — removes just the generated file. */
router.delete('/:id/pdf/generated', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (!claim.generated_pdf_path) return res.json({ removed: false, claim: decorate(claim, req.agencyId) });

  try {
    fs.unlinkSync(resolveStored(claim.generated_pdf_path));
  } catch {
    /* already gone */
  }
  db.prepare(`UPDATE claims SET generated_pdf_path = NULL WHERE id = ?`).run(id);
  res.json({ removed: true, claim: decorate(db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id), req.agencyId) });
});

/**
 * POST /api/claims/:id/pdf   (multipart field name: "file")
 * Stores the PDF under data/claims/ and records its path on the claim.
 * Uploading again simply replaces whatever was there.
 */
router.post('/:id/pdf', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  upload.single('file')(req, res, (err) => {
    if (err) {
      const status = err.status ?? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That PDF is larger than the ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB limit.`
          : err.message ?? 'Upload failed.';
      return res.status(status).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    if (!isPdfBuffer(req.file.buffer)) {
      return res.status(400).json({
        error: 'That file is not a PDF (it does not start with %PDF-).',
      });
    }

    const previous = claim.local_pdf_path;
    // Replace in place if an upload already exists, otherwise pick a fresh name.
    const rel = previous ?? storedPdfPath(claim, 'uploaded');
    const absolute = resolveStored(rel);

    try {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, req.file.buffer);
    } catch (e) {
      return res.status(500).json({ error: `Could not write the file: ${e.message}` });
    }

    // Replacing can land on a different name (e.g. the claim was renamed), so
    // clean up the old file rather than orphaning it.
    if (previous && previous !== rel) {
      try {
        fs.unlinkSync(resolveStored(previous));
      } catch {
        /* already gone — nothing to do */
      }
    }

    db.prepare(`UPDATE claims SET local_pdf_path = ? WHERE id = ?`).run(rel, id);
    const updated = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
    res.status(201).json({
      claim: decorate(updated, req.agencyId),
      file: { path: rel, name: path.basename(rel), bytes: req.file.size, replaced: Boolean(previous) },
    });
  });
});

/** GET /api/claims/:id/pdf — streams the stored PDF (used by "View PDF"). */
router.get('/:id/pdf', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (!claim.local_pdf_path) {
    return res.status(404).json({ error: 'No PDF is attached to this claim.' });
  }

  let absolute;
  try {
    absolute = resolveStored(claim.local_pdf_path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(absolute)) {
    return res.status(410).json({
      error: `The PDF is recorded as ${claim.local_pdf_path} but is missing from disk.`,
    });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(absolute)}"`);
  fs.createReadStream(absolute).pipe(res);
});

/** GET /api/claims/:id/pdf/info — metadata only, for the UI. */
router.get('/:id/pdf/info', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });

  const uploaded = fileInfo(claim.local_pdf_path);
  const generated = fileInfo(claim.generated_pdf_path);
  res.json({
    uploaded,
    generated,
    // Kept for the earlier single-file shape.
    attached: uploaded.attached,
    exists: uploaded.exists,
    path: uploaded.path,
    name: uploaded.name,
    bytes: uploaded.bytes,
  });
});

/** Shared shape for describing one stored file. */
function fileInfo(relativePath) {
  if (!relativePath) return { attached: false, exists: false, path: null, name: null, bytes: null };
  try {
    const absolute = resolveStored(relativePath);
    const exists = fs.existsSync(absolute);
    return {
      attached: true,
      exists,
      path: relativePath,
      name: path.basename(relativePath),
      bytes: exists ? fs.statSync(absolute).size : null,
    };
  } catch {
    return { attached: true, exists: false, path: relativePath, name: path.basename(relativePath), bytes: null };
  }
}

/** DELETE /api/claims/:id/pdf — detach, and delete the file from disk. */
router.delete('/:id/pdf', (req, res) => {
  const id = Number(req.params.id);
  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!claim) return res.status(404).json({ error: 'Claim not found' });
  if (!claim.local_pdf_path) return res.json({ detached: false, claim: decorate(claim, req.agencyId) });

  try {
    fs.unlinkSync(resolveStored(claim.local_pdf_path));
  } catch {
    /* file already gone; still clear the reference */
  }
  db.prepare(`UPDATE claims SET local_pdf_path = NULL WHERE id = ?`).run(id);
  res.json({ detached: true, claim: decorate(db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id), req.agencyId) });
});

/**
 * GET /api/claims/export.csv[?status=&client_id=&overdue=1]
 * Downloads every matching claim as a spreadsheet-ready CSV. Honours the same
 * filters as the dashboard, so the file matches what is on screen.
 */
router.get('/export.csv', (req, res) => {
  const where = [];
  const params = {};

  if (req.query.client_id) {
    where.push('cl.client_id = @client_id');
    params.client_id = Number(req.query.client_id);
  }
  if (req.query.status) {
    where.push('cl.status = @status');
    params.status = req.query.status;
  }
  if (req.query.overdue === '1') {
    where.push(`cl.paid_date IS NULL AND cl.expected_pay_date IS NOT NULL
                AND cl.expected_pay_date < @today AND cl.status NOT IN ('Draft','Denied')`);
    params.today = todayISO();
  }

  const rows = db
    .prepare(
      `SELECT cl.*, c.first_name, c.last_name, c.ma_number
       FROM claims cl JOIN clients c ON c.id = cl.client_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(cl.period_start, cl.created_at) DESC, cl.id DESC`
    )
    .all(params);

  const header = [
    'Claim Name',
    'Client Name',
    'MA Number',
    'Date Range',
    'Total Units',
    'Total Dollars',
    'Status',
    'Submitted Date',
    'Expected Pay Date',
    'Actual Paid Date',
    'Paid Amount',
  ];

  const body = rows.map((r) => [
    r.claim_name ?? '',
    `${r.last_name ?? ''}, ${r.first_name ?? ''}`.trim(),
    r.ma_number ?? '',
    r.period_start && r.period_end ? `${r.period_start} to ${r.period_end}` : '',
    r.total_units ?? '',
    // Plain number, no currency symbol, so spreadsheets treat it as numeric.
    r.total_dollars == null ? '' : Number(r.total_dollars).toFixed(2),
    r.status ?? '',
    r.submitted_date ?? '',
    r.expected_pay_date ?? '',
    r.paid_date ?? '',
    r.paid_amount == null ? '' : Number(r.paid_amount).toFixed(2),
  ]);

  const csv = [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const filename = `claims_export_${todayISO()}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The BOM makes Excel open UTF-8 correctly instead of mangling accents.
  res.send('\uFEFF' + csv + '\r\n');
});

/** Quote a CSV field only when it needs it, doubling any embedded quotes. */
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/claims/:id — the claim plus the day entries rolled into it. */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid claim id' });
  const row = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Claim not found' });
  const entries = db
    .prepare(`SELECT * FROM day_entries WHERE claim_id = ? ORDER BY work_date`)
    .all(row.id);
  res.json({ claim: decorate(row, req.agencyId), entries });
});

/* ----------------------------------------------------------------- helpers */

function isISODate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** submitted_date + the payer's typical terms, or null if we don't know them. */
function expectedFromPayer(claim, submittedDate) {
  if (!submittedDate) return null;
  const payer = db
    .prepare(
      `SELECT p.typical_days_to_pay
       FROM agreements a JOIN payers p ON p.id = a.payer_id
       WHERE a.id = ?`
    )
    .get(claim.agreement_id);
  const days = payer?.typical_days_to_pay;
  if (days == null) return null;
  return addDays(submittedDate, Number(days));
}

export default router;
