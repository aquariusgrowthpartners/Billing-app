import express from 'express';
import db from '../db.js';
import { computeEntry, todayISO, round2 } from '../calc.js';
import { diagnosisCodes } from '../hhaFields.js';

const router = express.Router();

/** GET /api/clients?q=smith&active=1&limit=25 — search by name or MA number. */
router.get('/', (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
  const activeOnly = req.query.active !== '0';
  // Archived clients are hidden by default: `?archived=1` opts back in.
  const includeArchived = req.query.archived === '1';

  const where = [];
  const params = {};

  if (activeOnly) where.push('c.active = 1');
  if (!includeArchived) where.push('c.archived = 0');

  if (q) {
    where.push(`(
      c.first_name LIKE @like OR
      c.last_name  LIKE @like OR
      (c.first_name || ' ' || c.last_name) LIKE @like OR
      (c.last_name  || ' ' || c.first_name) LIKE @like OR
      c.ma_number  LIKE @like
    )`);
    params.like = `%${q}%`;
  }

  const sql = `
    SELECT c.id, c.first_name, c.last_name, c.dob, c.ma_number, c.notes, c.active, c.archived,
           (SELECT COUNT(*) FROM agreements a WHERE a.client_id = c.id) AS agreement_count,
           (SELECT COUNT(*) FROM claims cl WHERE cl.client_id = c.id)    AS claim_count
    FROM clients c
    WHERE c.agency_id = @agency
    ${where.length ? `AND ${where.join(' AND ')}` : ''}
    ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE
    LIMIT @limit
  `;

  res.json({ clients: db.prepare(sql).all({ ...params, limit, agency: req.agencyId }) });
});

/** GET /api/clients/:id — profile payload: client + agreements + recent claims. */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const agreements = db
    .prepare(
      `SELECT a.*, p.name AS payer_name, p.typical_days_to_pay
       FROM agreements a
       LEFT JOIN payers p ON p.id = a.payer_id
       WHERE a.client_id = ?
       ORDER BY (a.start_date IS NULL), a.start_date DESC, a.id DESC`
    )
    .all(id);

  // Archived claims are hidden unless explicitly asked for, matching the
  // dashboard's Show Archived toggle.
  const includeArchived = req.query.archived === '1';
  const claims = db
    .prepare(
      `SELECT * FROM claims
       WHERE client_id = ? ${includeArchived ? '' : 'AND COALESCE(archived, 0) = 0'}
       ORDER BY COALESCE(period_start, created_at) DESC, id DESC
       LIMIT 25`
    )
    .all(id);

  const case_manager = client.case_manager_id
    ? db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(client.case_manager_id)
    : null;

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(units), 0)   AS total_units,
         COALESCE(SUM(dollars), 0) AS total_dollars,
         COUNT(*)                  AS entry_count,
         MIN(work_date)            AS first_date,
         MAX(work_date)            AS last_date
       FROM day_entries WHERE client_id = ?`
    )
    .get(id);

  totals.total_dollars = round2(totals.total_dollars);

  /*
   * Parent/child groupings for the Service Agreements card.
   *
   * One entry per service_agreements row, with its lines nested. Legacy rows
   * that predate the parent table (service_agreement_id IS NULL) are returned
   * as their own single-line entries with a null DHS number, so nothing that
   * still feeds visits is hidden from the user.
   */
  const parents = db
    .prepare('SELECT * FROM service_agreements WHERE client_id = ? ORDER BY (effective_date IS NULL), effective_date DESC, id DESC')
    .all(id);
  const children = db
    .prepare(
      `SELECT * FROM agreements
        WHERE client_id = ? AND service_agreement_id IS NOT NULL
        ORDER BY (superseded_at IS NOT NULL), (start_date IS NULL), start_date, id`
    )
    .all(id);
  const grouped = parents.map((sa) => ({
    ...sa,
    legacy: false,
    lines: children.filter((c) => c.service_agreement_id === sa.id),
  }));
  const legacy = agreements
    .filter((a) => a.service_agreement_id == null)
    .map((a) => ({
      id: null,
      dhs_service_agreement_num: null,
      hhaexchange_auth_number: null,
      effective_date: a.start_date,
      through_date: a.end_date,
      icd10_code: null,
      pdf_path: a.service_agreement_pdf_path,
      uploaded_at: null,
      legacy: true,
      lines: [a],
    }));

  res.json({
    client,
    case_manager,
    agreements,
    service_agreements: [...grouped, ...legacy],
    claims,
    active_agreement: agreements.find((a) => isActiveOn(a, todayISO())) ?? agreements[0] ?? null,
    totals,
  });

  // Remember this as a recently viewed client (the Home Dashboard's list).
  // Kept to the 8 newest rows.
  try {
    db.prepare(
      `INSERT INTO recent_clients (client_id, viewed_at, agency_id) VALUES (@id, @at, @agency)
       ON CONFLICT(client_id) DO UPDATE SET viewed_at = excluded.viewed_at`
    ).run({ id, at: new Date().toISOString(), agency: req.agencyId });
    db.prepare(
      `DELETE FROM recent_clients WHERE agency_id = @agency AND id NOT IN (
         SELECT id FROM recent_clients WHERE agency_id = @agency
         ORDER BY viewed_at DESC, id DESC LIMIT 8
       )`
    ).run({ agency: req.agencyId });
  } catch {
    /* tracking is best-effort; never fail a profile load over it */
  }
});

/** POST /api/clients */
router.post('/', (req, res) => {
  const b = req.body ?? {};
  const first = (b.first_name ?? '').toString().trim();
  const last = (b.last_name ?? '').toString().trim();
  if (!first || !last) return res.status(400).json({ error: 'first_name and last_name are required' });

  const assigned = resolveCaseManager(b.case_manager_id);
  if (assigned.error) return res.status(400).json({ error: assigned.error });

  const dx = diagnosisCodes(b.diagnosis_code);
  if (dx.error) return res.status(400).json({ error: dx.error });

  const mi = normaliseMiddleInitial(b.middle_initial);
  if (mi.error) return res.status(400).json({ error: mi.error });

  const info = db
    .prepare(
      `INSERT INTO clients
         (first_name, last_name, middle_initial, dob, ma_number, notes, active,
          case_manager_id, diagnosis_code, agency_id)
       VALUES
         (@first_name, @last_name, @middle_initial, @dob, @ma_number, @notes, @active,
          @case_manager_id, @diagnosis_code, @agency)`
    )
    .run({
      first_name: first,
      last_name: last,
      middle_initial: mi.ok,
      dob: b.dob ?? null,
      ma_number: b.ma_number ?? null,
      notes: b.notes ?? null,
      active: b.active === false || b.active === 0 ? 0 : 1,
      case_manager_id: assigned.id,
      diagnosis_code: dx.ok,
      agency: req.agencyId,
    });

  res.status(201).json(db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(info.lastInsertRowid, req.agencyId));
});

/**
 * PUT and PATCH /api/clients/:id — both verbs are accepted and both perform a
 * partial update, so callers can use whichever they prefer.
 */
function updateClient(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const fields = ['first_name', 'last_name', 'dob', 'ma_number', 'notes', 'active', 'archived'];
  const DX_FIELD = 'diagnosis_code';
  const updates = {};
  for (const f of fields) {
    if (f in (req.body ?? {})) updates[f] = req.body[f];
  }

  if ('archived' in updates) {
    updates.archived = updates.archived === true || updates.archived === 1 ? 1 : 0;
  }

  if ('middle_initial' in (req.body ?? {})) {
    const mi = normaliseMiddleInitial(req.body.middle_initial);
    if (mi.error) return res.status(400).json({ error: mi.error });
    updates.middle_initial = mi.ok;
  }

  // HHAeXchange diagnosis codes (pipe-separated).
  if (DX_FIELD in (req.body ?? {})) {
    const check = diagnosisCodes(req.body[DX_FIELD]);
    if (check.error) return res.status(400).json({ error: check.error });
    updates[DX_FIELD] = check.ok;
  }

  // Assigning (or clearing) the case manager.
  if ('case_manager_id' in (req.body ?? {})) {
    const assigned = resolveCaseManager(req.body.case_manager_id);
    if (assigned.error) return res.status(400).json({ error: assigned.error });
    updates.case_manager_id = assigned.id;
  }

  // A client must always keep a first and last name.
  for (const f of ['first_name', 'last_name']) {
    if (f in updates && !String(updates[f] ?? '').trim()) {
      return res
        .status(400)
        .json({ error: `${f.replace('_', ' ')} cannot be empty` });
    }
    if (f in updates) updates[f] = String(updates[f]).trim();
  }

  // Cleared optional fields are stored as NULL, not empty strings.
  for (const f of ['dob', 'ma_number', 'notes']) {
    if (f in updates && (updates[f] === '' || updates[f] === undefined)) updates[f] = null;
  }

  if (typeof updates.active === 'boolean') updates.active = updates.active ? 1 : 0;
  if (!Object.keys(updates).length) return res.json(existing);

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE clients SET ${setSql} WHERE id = @id AND agency_id = @agency`).run({ ...updates, id, agency: req.agencyId });

  res.json(db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(id, req.agencyId));
}

router.patch('/:id', updateClient);
router.put('/:id', updateClient);

/**
 * DELETE /api/clients/:id
 * Refuses if the client has any logged time or claims — those are billing
 * records and should be deactivated, not silently cascaded away.
 */
/**
 * Billing records that stand in the way of a hard delete. Shared by the
 * pre-flight check and the delete itself so they can never disagree.
 */
function deletionBlockers(id) {
  const days = db.prepare(`SELECT COUNT(*) AS n FROM day_entries WHERE client_id = ?`).get(id).n;
  const claims = db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE client_id = ?`).get(id).n;
  return { days, claims, blocked: days > 0 || claims > 0 };
}

/** GET /api/clients/:id/delete-check — may this client be hard deleted? */
router.get('/:id/delete-check', (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { days, claims, blocked } = deletionBlockers(id);
  const name = `${client.first_name} ${client.last_name}`.trim();
  res.json({
    deletable: !blocked,
    client_name: name,
    days,
    claims,
    archived: Boolean(client.archived),
    blockers: {
      days,
      claims,
      // Agreements are not billing history, but they do go with the client.
      agreements: db.prepare(`SELECT COUNT(*) AS n FROM agreements WHERE client_id = ?`).get(id).n,
    },
  });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const client = db.prepare(`SELECT * FROM clients WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { days, claims, blocked } = deletionBlockers(id);
  if (blocked) {
    const name = `${client.first_name} ${client.last_name}`.trim();
    return res.status(409).json({
      error:
        `Cannot delete ${name}. They have ${claims} claim${claims === 1 ? '' : 's'} and ` +
        `${days} logged day${days === 1 ? '' : 's'}. Please archive them instead to ` +
        'preserve billing history.',
      blocked: true,
      client_name: name,
      claims,
      days,
    });
  }

  // No day entries and no claims: nothing is cascaded away except the client's
  // own agreements, which belong to them.
  db.prepare(`DELETE FROM clients WHERE id = ? AND agency_id = ?`).run(id, req.agencyId);
  res.json({ deleted: true, id, client_name: `${client.first_name} ${client.last_name}`.trim() });
});

/** GET /api/clients/:id/agreements */
router.get('/:id/agreements', (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, p.name AS payer_name, p.typical_days_to_pay
       FROM agreements a LEFT JOIN payers p ON p.id = a.payer_id
       WHERE a.client_id = ? ORDER BY a.start_date DESC, a.id DESC`
    )
    .all(Number(req.params.id));
  res.json({ agreements: rows });
});

/** GET /api/clients/:id/weeks?start=YYYY-MM-DD — one Mon–Sun week of day entries. */
router.get('/:id/weeks', (req, res) => {
  const id = Number(req.params.id);
  const start = req.query.start;
  if (!start) return res.status(400).json({ error: 'start query param (YYYY-MM-DD) is required' });

  const rows = db
    .prepare(
      `SELECT d.*, t.first_name AS caretaker_first_name, t.last_name AS caretaker_last_name,
              t.npi_number AS caretaker_npi,
              cl.status AS claim_status, cl.claim_name AS claim_name,
              cl.archived AS claim_archived
       FROM day_entries d
       LEFT JOIN caretakers t ON t.id = d.caretaker_id
       LEFT JOIN claims cl ON cl.id = d.claim_id
       WHERE d.client_id = ? AND d.work_date >= ? AND d.work_date < date(?, '+7 days')
       ORDER BY d.work_date`
    )
    .all(id, start, start);

  // Claims overlapping this week that are already with the payer. The calendar
  // warns about edits inside them, but does not block them.
  const lockedClaims = db
    .prepare(
      `SELECT id, claim_name, status, period_start, period_end, total_units, total_dollars
       FROM claims
       WHERE client_id = ?
         AND COALESCE(archived, 0) = 0
         AND status IN ('Submitted', 'Paid')
         AND period_start IS NOT NULL AND period_end IS NOT NULL
         AND period_start <= date(?, '+6 days')
         AND period_end >= ?
       ORDER BY period_start`
    )
    .all(id, start, start);

  res.json({ entries: rows, locked_claims: lockedClaims });
});

/**
 * Optional middle initial. Trimmed, at most two characters, empty means none.
 * A trailing period is kept out of storage so the display format is consistent.
 */
function normaliseMiddleInitial(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return { ok: null };
  const bare = raw.endsWith('.') ? raw.slice(0, -1).trim() : raw;
  if (!bare) return { ok: null };
  if (bare.length > 2) return { error: 'Middle initial must be at most 2 characters' };
  if (!/^[A-Za-z]+$/.test(bare)) return { error: 'Middle initial must be letters only' };
  return { ok: bare.toUpperCase() };
}

/**
 * case_manager_id may be a number or null/empty to unassign.
 * Validated here so the API returns a readable error rather than an FK failure.
 */
function resolveCaseManager(value) {
  if (value === '' || value === null || value === undefined) return { id: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: 'case_manager_id must be a positive integer' };
  if (!db.prepare(`SELECT 1 FROM case_managers WHERE id = ?`).get(id)) {
    return { error: 'case_manager_id does not exist' };
  }
  return { id };
}

function isActiveOn(agreement, iso) {
  if (!agreement) return false;
  if (agreement.start_date && iso < agreement.start_date) return false;
  if (agreement.end_date && iso > agreement.end_date) return false;
  return true;
}


/* ------------------------------------------------ service agreement scanner */

import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseServiceAgreement } from '../serviceAgreementParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGREEMENT_DIR = path.join(__dirname, '..', '..', 'data', 'agreement_uploads');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const safeName = (v) => String(v ?? 'agreement.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);

/**
 * POST /api/clients/:clientId/service-agreement
 *
 * Turns a DHS Service Agreement PDF into agreements rows.
 *
 * ONE ROW PER APPROVED LINE. The lines are deliberately NOT merged: different
 * lines cover different date windows with different codes (plain T1019 for one
 * period, T1019:U9 for the next), and collapsing them would leave visits with
 * no agreement covering their date.
 */
router.post('/:clientId/service-agreement', upload.single('file'), async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'A valid client id is required' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const client = db.prepare('SELECT id, first_name, last_name, ma_number, diagnosis_code FROM clients WHERE id = ? AND agency_id = ?').get(clientId, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const buf = req.file.buffer;
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ error: 'That file is not a PDF' });
  }

  let parsed;
  try {
    parsed = await parseServiceAgreement(buf);
  } catch (err) {
    return res.status(400).json({ error: `Could not read that PDF: ${err.message}` });
  }

  // The recipient id in the advice must be this client's Medicaid number. The
  // name is NOT used for matching — it is shown for the user to eyeball.
  const want = digits(client.ma_number);
  const got = digits(parsed.recipient_id);
  if (!want || !got || want !== got) {
    return res.status(400).json({
      error:
        `This agreement is for recipient ${parsed.recipient_id ?? '(none)'} (${parsed.recipient_name ?? 'unknown name'}), ` +
        `but ${client.first_name} ${client.last_name} has Medicaid number ${client.ma_number ?? '(none)'}. ` +
        'Upload it from the correct client profile.',
      parsed_recipient_id: parsed.recipient_id ?? null,
      client_ma_number: client.ma_number ?? null,
    });
  }

  /*
   * Dry run: parse and return what WOULD happen, writing nothing — not even the
   * PDF. The UI shows this before the user commits, so a wrong document never
   * lands on disk or in the agreements table.
   */
  if (req.query.dryRun === '1' || req.query.dryRun === 'true') {
    return res.json({
      preview: true,
      extracted: parsed,
      agreements_created: 0,
      agreements_updated: 0,
      diagnosis_code_set: null,
      pdf_path: null,
      warnings: parsed.lines.length ? [] : ['No APPROVED lines were found in that PDF.'],
    });
  }

  fs.mkdirSync(AGREEMENT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `${clientId}_${stamp}_${safeName(req.file.originalname)}`;
  fs.writeFileSync(path.join(AGREEMENT_DIR, filename), buf);
  const storedPath = path.posix.join('data', 'agreement_uploads', filename);

  /*
   * Match on the DATE WINDOW **and the code**.
   *
   * Two lines can share a window and differ only by modifier — SIMS's advice
   * has plain T1019 and T1019:UA both running 12/01/24-12/31/24. Keying on the
   * window alone collapsed them into one row and silently dropped a code, so
   * a visit could resolve to the wrong procedure. Each line must survive.
   */
  const findExisting = db.prepare(
    `SELECT id FROM agreements
      WHERE client_id = @client_id
        AND COALESCE(dhs_service_agreement_num, '') = COALESCE(@dhs, '')
        AND COALESCE(start_date, '') = COALESCE(@start, '')
        AND COALESCE(end_date, '')   = COALESCE(@end, '')
        AND COALESCE(service_code_with_modifier, '') = COALESCE(@code_with_mod, '')`
  );
  const insert = db.prepare(
    `INSERT INTO agreements
       (client_id, agreement_number, start_date, end_date, authorized_units_per_week,
        minutes_per_unit, rate_per_unit, max_units_per_day, service_code, payer_id,
        dhs_service_agreement_num, service_code_with_modifier, service_agreement_pdf_path,
        authorized_total_amount, service_agreement_id, superseded_at)
     VALUES
       (@client_id, @agreement_number, @start, @end, @units_per_week,
        15, @rate, NULL, @code, @payer_id,
        @dhs, @code_with_mod, @pdf,
        @total, @parentId, NULL)`
  );
  const update = db.prepare(
    `UPDATE agreements
        SET rate_per_unit = @rate,
            authorized_units_per_week = @units_per_week,
            service_code = @code,
            service_code_with_modifier = @code_with_mod,
            service_agreement_pdf_path = @pdf,
            authorized_total_amount = @total,
            service_agreement_id = @parentId,
            superseded_at = NULL
      WHERE id = @id`
  );

  // Fall back to the client's current payer when the PDF does not name one.
  const defaultPayer = db
    .prepare('SELECT payer_id FROM agreements WHERE client_id = ? AND payer_id IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(clientId)?.payer_id ?? null;

  const warnings = [];
  let created = 0;
  let updated = 0;
  let firstId = null;

  /* ------------------------------------------------ parent (Part 2a) */
  const findParent = db.prepare(
    'SELECT id FROM service_agreements WHERE client_id = ? AND dhs_service_agreement_num = ?'
  );
  const updateParent = db.prepare(
    `UPDATE service_agreements
        SET effective_date = @effective, through_date = @through, icd10_code = @icd,
            pdf_path = @pdf, uploaded_at = @now
      WHERE id = @id`
  );
  const insertParent = db.prepare(
    `INSERT INTO service_agreements
       (client_id, dhs_service_agreement_num, hhaexchange_auth_number,
        effective_date, through_date, icd10_code, pdf_path, uploaded_at)
     VALUES (@client_id, @dhs, NULL, @effective, @through, @icd, @pdf, @now)`
  );
  /* ------------------------------------------ lines removed by a revision */
  const liveChildren = db.prepare(
    `SELECT id, COALESCE(service_code_with_modifier, '') AS sc, COALESCE(start_date, '') AS sd,
            COALESCE(end_date, '') AS ed
       FROM agreements WHERE service_agreement_id = ? AND superseded_at IS NULL`
  );
  const supersede = db.prepare("UPDATE agreements SET superseded_at = datetime('now') WHERE id = ?");

  let parentId = null;
  let superseded = 0;

  const run = db.transaction(() => {
    /* 2a — one parent per (client_id, DHS #). The auth number is entered once
       here, not per line, and is never overwritten by an upload. */
    const parentParams = {
      client_id: clientId,
      dhs: parsed.dhs_service_agreement_num,
      effective: parsed.effective_date ?? null,
      through: parsed.through_date ?? null,
      icd: parsed.icd10_code ?? null,
      pdf: storedPath,
      now: new Date().toISOString(),
    };
    const foundParent = findParent.get(clientId, parsed.dhs_service_agreement_num ?? null);
    if (foundParent) {
      parentId = foundParent.id;
      updateParent.run({ ...parentParams, id: parentId });
    } else {
      parentId = Number(insertParent.run(parentParams).lastInsertRowid);
    }

    const keep = new Set();
    for (const line of parsed.lines) {
      if (line.status !== 'APPROVED') continue;
      const codeWithMod = line.modifier ? `${line.procedure_code}:${line.modifier}` : line.procedure_code;
      const start = line.start_date ?? parsed.effective_date ?? null;
      const end = line.end_date ?? parsed.through_date ?? null;
      if (!start) warnings.push(`Line ${line.line_number} has no start date — skipped.`);

      const match = findExisting.get({
        client_id: clientId,
        dhs: parsed.dhs_service_agreement_num ?? null,
        start,
        end,
        code_with_mod: codeWithMod,
      });
      /*
       * A budget line (S5116:U9) has no rate and no quantity — its money is a
       * period total, not a per-visit rate. rate_per_unit is NOT NULL, so a
       * bare NULL tripped the constraint and killed the whole upload; the row
       * is stored at 0 and its budget goes in authorized_total_amount.
       */
      if (line.rate_per_unit == null) {
        warnings.push(
          `Line ${line.line_number} (${codeWithMod}): stored as budget line, rate 0, not exported to HHAeXchange.`
        );
      }
      const params = {
        client_id: clientId,
        agreement_number: parsed.dhs_service_agreement_num ?? null,
        start,
        end,
        units_per_week: line.quantity ?? null,
        rate: line.rate_per_unit ?? 0,
        total: line.total_amount ?? null,
        code: line.procedure_code,
        code_with_mod: codeWithMod,
        payer_id: defaultPayer,
        dhs: parsed.dhs_service_agreement_num ?? null,
        pdf: storedPath,
      };
      if (match) {
        update.run({ ...params, id: match.id, parentId });
        updated += 1;
        if (firstId == null) firstId = match.id;
      } else {
        const info = insert.run({ ...params, parentId });
        created += 1;
        if (firstId == null) firstId = Number(info.lastInsertRowid);
      }
      // remembered so a line the revised PDF dropped can be retired
      keep.add(`${codeWithMod}|${start ?? ''}|${end ?? ''}`);
    }

    /* 2c — a line the PDF no longer carries is RETIRED, never deleted: old
       billing history may still reference it. Rows with no parent (legacy
       hand-created agreements) are deliberately out of scope. */
    for (const child of liveChildren.all(parentId)) {
      if (!keep.has(`${child.sc}|${child.sd}|${child.ed}`)) {
        supersede.run(child.id);
        superseded += 1;
      }
    }
  });
  try {
    run();
  } catch (err) {
    // Never let a constraint escape as an uncaught throw — that killed the
    // process and the browser saw only "Request failed".
    console.error(`[service-agreement] upload failed: ${err.message}`);
    return res.status(500).json({ error: 'Upload failed', detail: err.message });
  }

  // The DHS ICD-10 carries a decimal; billing wants it without.
  let diagnosisSet = null;
  if (!client.diagnosis_code && parsed.icd10_code) {
    diagnosisSet = parsed.icd10_code.replace(/\./g, '');
    db.prepare('UPDATE clients SET diagnosis_code = ? WHERE id = ? AND agency_id = ?').run(diagnosisSet, clientId, req.agencyId);
  }

  if (created === 0 && updated === 0) {
    warnings.push('No APPROVED lines were found in that PDF.');
  }

  res.json({
    extracted: parsed,
    service_agreement_id: parentId,
    agreements_created: created,
    agreements_updated: updated,
    agreements_superseded: superseded,
    diagnosis_code_set: diagnosisSet,
    pdf_path: storedPath,
    first_agreement_id: firstId,
    warnings,
  });
});

/* ---------------------------------------------------------------- agreement */

export default router;
