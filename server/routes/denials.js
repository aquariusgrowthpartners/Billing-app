/**
 * Denial and reversal tracking API.
 *
 * Read-only apart from the rebill-task status updates: nothing here can touch
 * claims or day entries.
 */
import express from 'express';
import PDFDocument from 'pdfkit';
import db from '../db.js';
import { complete } from '../aiService.js';
import { round2 } from '../calc.js';
import { openTaskCount, denialDeleteCounts, deleteDenials, deleteRebillTask } from '../denials.js';

const router = express.Router();

const clientName = (r) =>
  [r.last_name, r.first_name].filter(Boolean).join(', ') || r.client_name_raw || '—';

/** GET /api/denials/summary — the header metrics and the per-client breakdown. */
/**
 * GET /api/denials/markers?client_id=&from=&to=
 *
 * Per-day denial state for the calendar. One row per service date, and an
 * UNRECOVERED day always wins over a recovered one on the same date — it is the
 * one that still needs action.
 */
router.get('/markers', (req, res) => {
  const clientId = Number(req.query.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'client_id is required', expects: 'client_id' });
  }
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');

  const rows = db
    .prepare(
      `SELECT i.dos,
              i.recovered,
              i.recovered_dos,
              i.recovered_by_day_entry_id,
              i.denied_claim_id,
              i.procedure_code,
              i.units,
              i.billed,
              i.minutes_worked,
              d.created_at AS denial_created_at,
              d.claim_status AS denial_status,
              c.last_name, c.first_name
       FROM denied_line_items i
       JOIN denied_claims d ON d.id = i.denied_claim_id
       LEFT JOIN clients c ON c.id = i.client_id AND c.agency_id = i.agency_id
       WHERE i.client_id = ? AND i.agency_id = ? AND i.dos >= ? AND i.dos <= ?`

    )
    .all(clientId, req.agencyId, from, to);

  const today = new Date();
  const byDay = new Map();
  for (const r of rows) {
    if (!r.dos) continue;
    const recovered = Boolean(r.recovered_by_day_entry_id) || r.recovered === 1;
    const openDays = r.denial_created_at
      ? Math.max(0, Math.round((today - new Date(String(r.denial_created_at).replace(' ', 'T') + 'Z')) / 86400000))
      : 0;
    const entry = {
      dos: r.dos,
      state: recovered ? 'recovered' : 'unrecovered',
      recovered_dos: r.recovered_dos ?? r.dos,
      days_open: openDays,
      // everything the Rebill List needs, from the SAME call — no second endpoint
      denied_claim_id: r.denied_claim_id,
      procedure_code: r.procedure_code ?? null,
      units: r.units ?? null,
      billed: r.billed ?? null,
      minutes_worked: r.minutes_worked ?? null,
      denial_status: r.denial_status ?? null,
      client_name: `${r.last_name ?? ''}, ${r.first_name ?? ''}`.replace(/^, |, $/g, '') || null,
    };
    const prev = byDay.get(r.dos);
    // unrecovered takes priority: it still needs a rebill
    if (!prev || (prev.state === 'recovered' && entry.state === 'unrecovered')) byDay.set(r.dos, entry);
  }
  res.json({ markers: [...byDay.values()] });
});

router.get('/summary', (req, res) => {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS claims,
              COALESCE(SUM(total_charge), 0) AS charge
       FROM denied_claims WHERE agency_id = ?`
    )
    .get(req.agencyId);

  const unrecovered = db
    .prepare(
      `SELECT COUNT(*) AS days, COALESCE(SUM(billed), 0) AS dollars
       FROM denied_line_items WHERE recovered = 0 AND agency_id = ?`
    )
    .get(req.agencyId);

  const byClient = db
    .prepare(
      `SELECT i.client_id,
              COALESCE(cu.last_name || ', ' || cu.first_name, c.client_name_raw) AS client_name,
              COUNT(*) AS days,
              ROUND(COALESCE(SUM(i.billed), 0), 2) AS dollars
       FROM denied_line_items i
       JOIN denied_claims c ON c.id = i.denied_claim_id
       LEFT JOIN clients cu ON cu.id = i.client_id AND cu.agency_id = i.agency_id
       WHERE i.recovered = 0 AND i.agency_id = ?
       GROUP BY i.client_id
       ORDER BY dollars DESC`
    )
    .all(req.agencyId)
    .map((r) => ({ ...r, client_name: r.client_name || '—' }));

  const byMonth = db
    .prepare(
      `SELECT substr(i.dos, 1, 7) AS month,
              COUNT(*) AS days,
              ROUND(COALESCE(SUM(i.billed), 0), 2) AS dollars
       FROM denied_line_items i
       WHERE i.recovered = 0 AND i.dos IS NOT NULL AND i.agency_id = ?
       GROUP BY month
       ORDER BY month DESC`
    )
    .all(req.agencyId);

  res.json({
    open_tasks: openTaskCount(req.agencyId),
    unrecovered_days: unrecovered.days,
    unrecovered_dollars: round2(unrecovered.dollars),
    total_denied_claims: totals.claims,
    total_denied_dollars: round2(totals.charge),
    by_client: byClient,
    by_month: byMonth,
  });
});

/** GET /api/denials — the searchable archive. */
router.get('/', (req, res) => {
  const where = [];
  const params = {};
  if (req.query.client_id) {
    where.push('c.client_id = @client');
    params.client = Number(req.query.client_id);
  }
  if (req.query.recovery_status) {
    where.push('c.recovery_status = @status');
    params.status = String(req.query.recovery_status);
  }
  if (req.query.date_from) {
    where.push('c.dos_start >= @from');
    params.from = String(req.query.date_from);
  }
  if (req.query.date_to) {
    where.push('c.dos_end <= @to');
    params.to = String(req.query.date_to);
  }
  if (req.query.search) {
    where.push('(c.client_name_raw LIKE @q OR c.ra_claim_number LIKE @q)');
    params.q = `%${String(req.query.search).trim()}%`;
  }

  const rows = db
    .prepare(
      `SELECT c.*,
              cu.first_name, cu.last_name,
              t.first_name AS caretaker_first, t.last_name AS caretaker_last,
              (SELECT COUNT(*) FROM denied_line_items i
                WHERE i.denied_claim_id = c.id AND i.agency_id = c.agency_id) AS items,
              (SELECT COUNT(*) FROM denied_line_items i
                WHERE i.denied_claim_id = c.id AND i.recovered = 1
                  AND i.agency_id = c.agency_id) AS recovered
       FROM denied_claims c
       LEFT JOIN clients cu ON cu.id = c.client_id AND cu.agency_id = c.agency_id
       LEFT JOIN caretakers t ON t.id = c.caretaker_id AND t.agency_id = c.agency_id
       WHERE c.agency_id = @agency
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
       ORDER BY c.dos_start DESC, c.id DESC
       LIMIT 500`
    )
    .all({ ...params, agency: req.agencyId });

  res.json({
    denials: rows.map((r) => ({
      ...r,
      client_label: clientName(r),
      caretaker_label: [r.caretaker_last, r.caretaker_first].filter(Boolean).join(', ') || null,
    })),
  });
});

/**
 * GET /api/denials/delete-preview?ids=1,2 — what a delete would remove.
 * Read-only, so the confirmation modal can state exact numbers.
 */
router.get('/delete-preview', (req, res) => {
  const ids = String(req.query.ids ?? '')
    .split(',')
    .map(Number)
    .filter(Number.isInteger);
  res.json(denialDeleteCounts(ids, req.agencyId));
});

const mmddyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '—';
};
const yyyymmdd = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const recoveryLabel = (status) =>
  status === 'recovered' ? 'Fully Recovered' : status === 'partial' ? 'Partial' : 'Unrecovered';

/** Everything one denial needs for a PDF or a CSV row. */
function denialDetail(id, agencyId) {
  const denial = db
    .prepare(
      `SELECT c.*, cu.first_name, cu.last_name, cu.ma_number,
              t.first_name AS caretaker_first, t.last_name AS caretaker_last
       FROM denied_claims c
       LEFT JOIN clients cu ON cu.id = c.client_id AND cu.agency_id = c.agency_id
       LEFT JOIN caretakers t ON t.id = c.caretaker_id AND t.agency_id = c.agency_id
       WHERE c.id = ? AND c.agency_id = ?`
    )
    .get(Number(id), agencyId);
  if (!denial) return null;
  const line_items = db
    .prepare(
      `SELECT i.*, d.work_date AS entry_dos
       FROM denied_line_items i
       LEFT JOIN day_entries d ON d.id = i.recovered_by_day_entry_id
                             AND d.agency_id = i.agency_id
       WHERE i.denied_claim_id = ? AND i.agency_id = ?
       ORDER BY i.dos, i.id`
    )
    .all(denial.id, agencyId);
  return { denial, line_items };
}

/** GET /api/denials/:id/pdf — one denial as a PDF record. */
router.get('/:id/pdf', async (req, res) => {
  const detail = denialDetail(req.params.id, req.agencyId);
  if (!detail) return res.status(404).json({ error: 'Denied claim not found' });
  const { denial, line_items } = detail;

  try {
    const doc = new PDFDocument({ margin: 44, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', resolve));

    const agency =
      db
        .prepare(`SELECT value FROM settings WHERE agency_id = ? AND key = 'agency_name'`)
        .get(req.agencyId)?.value ?? '';

    doc.font('Helvetica-Bold').fontSize(17).text('Denied Claim Record');
    if (agency) doc.font('Helvetica').fontSize(10).fillColor('#555').text(agency);
    doc.fontSize(9).fillColor('#777').text(`Generated ${new Date().toLocaleString()}`);
    doc.moveDown(1).fillColor('#000');

    const row = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(String(value ?? '—'));
    };

    row('RA Claim Number', denial.ra_claim_number);
    row('Client', denial.last_name ? `${denial.last_name}, ${denial.first_name}` : denial.client_name_raw);
    if (denial.ma_number) row('MA Number', denial.ma_number);
    row(
      'Caretaker',
      denial.caretaker_last ? `${denial.caretaker_last}, ${denial.caretaker_first}` : denial.caretaker_npi_raw
    );
    if (denial.caretaker_npi_raw) row('Caretaker NPI', denial.caretaker_npi_raw);
    row('Claim Status', String(denial.claim_status ?? '').toUpperCase());
    row('DOS Range', `${mmddyyyy(denial.dos_start)} – ${mmddyyyy(denial.dos_end)}`);
    row('Total Charge', `$${(Number(denial.total_charge) || 0).toFixed(2)}`);
    row('Recovery Status', recoveryLabel(denial.recovery_status));
    row('Source File', denial.source_filename);

    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(11).text('Line items');
    doc.moveDown(0.4);

    const cols = [70, 70, 50, 50, 70, 80, 90];
    const heads = ['DOS', 'Procedure', 'Units', 'Hours', 'Billed', 'Recovered?', 'Recovered via'];
    let x = doc.page.margins.left;
    const startY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5);
    heads.forEach((h, i) => {
      doc.text(h, x, startY, { width: cols[i] });
      x += cols[i];
    });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8.5);

    if (!line_items.length) {
      doc.fillColor('#777').text('No line items were recorded for this claim.').fillColor('#000');
    }
    for (const li of line_items) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
      x = doc.page.margins.left;
      const y = doc.y;
      const cells = [
        mmddyyyy(li.dos),
        li.procedure_code ?? '—',
        li.units ?? '—',
        ((Number(li.minutes_worked) || 0) / 60).toFixed(2),
        `$${(Number(li.billed) || 0).toFixed(2)}`,
        li.recovered ? 'Yes' : 'No',
        li.recovered ? mmddyyyy(li.entry_dos ?? li.recovered_dos) : 'Rebill needed',
      ];
      cells.forEach((c, i) => {
        doc.text(String(c), x, y, { width: cols[i] });
        x += cols[i];
      });
      doc.y = y + 13;
    }

    doc.end();
    await done;
    const buffer = Buffer.concat(chunks);
    const name = `Denial_${denial.ra_claim_number ?? denial.id}_${yyyymmdd()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-File-Name', name);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: `Could not build the denial PDF: ${e.message}` });
  }
});

/**
 * GET /api/denials/export.csv?ids=1,2  or  ?search=&recovery_status=...
 *
 * One row per line item, so a denial with eight items produces eight rows.
 */
router.get('/export.csv', (req, res) => {
  const params = { agency: req.agencyId };
  const where = ['c.agency_id = @agency'];
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({ error: 'ids must be a list of numbers' });
    where.push(`c.id IN (${ids.map((_, i) => `@id${i}`).join(',')})`);
    ids.forEach((id, i) => { params[`id${i}`] = id; });
  } else {
    if (req.query.client_id) {
      where.push('c.client_id = @client');
      params.client = Number(req.query.client_id);
    }
    if (req.query.recovery_status) {
      where.push('c.recovery_status = @status');
      params.status = String(req.query.recovery_status);
    }
    if (req.query.date_from) {
      where.push('c.dos_start >= @from');
      params.from = String(req.query.date_from);
    }
    if (req.query.date_to) {
      where.push('c.dos_end <= @to');
      params.to = String(req.query.date_to);
    }
    if (req.query.search) {
      where.push('(c.client_name_raw LIKE @q OR c.ra_claim_number LIKE @q)');
      params.q = `%${String(req.query.search).trim()}%`;
    }
    if (req.query.status) {
      where.push('c.claim_status = @claimStatus');
      params.claimStatus = String(req.query.status);
    }
  }

  const sql = `SELECT c.*, cu.first_name, cu.last_name,
                      i.dos AS item_dos, i.procedure_code, i.units, i.minutes_worked,
                      i.billed, i.recovered, i.recovery_status AS item_status
               FROM denied_claims c
               LEFT JOIN clients cu ON cu.id = c.client_id AND cu.agency_id = c.agency_id
               LEFT JOIN denied_line_items i ON i.denied_claim_id = c.id
                                            AND i.agency_id = c.agency_id
               WHERE ${where.join(' AND ')}
               ORDER BY c.dos_start DESC, c.id, i.dos, i.id`;
  const rows = db.prepare(sql).all(params);

  const header = [
    'RA Claim #', 'Client', 'Caretaker', 'Status', 'DOS Start', 'DOS End', 'Total Charge',
    'Recovery Status', 'Source File', 'Line Item DOS', 'Line Item Procedure',
    'Line Item Units', 'Line Item Hours', 'Line Item Billed', 'Line Item Recovered',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.ra_claim_number,
        r.last_name ? `${r.last_name}, ${r.first_name}` : r.client_name_raw,
        r.caretaker_npi_raw,
        String(r.claim_status ?? '').toUpperCase(),
        r.dos_start,
        r.dos_end,
        (Number(r.total_charge) || 0).toFixed(2),
        recoveryLabel(r.recovery_status),
        r.source_filename,
        r.item_dos,
        r.procedure_code,
        r.units,
        ((Number(r.minutes_worked) || 0) / 60).toFixed(2),
        (Number(r.billed) || 0).toFixed(2),
        r.recovered ? 'Yes' : 'No',
      ]
        .map(csvCell)
        .join(',')
    );
  }

  const d = new Date();
  const stamp = `${yyyymmdd(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const name = `Denials_Export_${stamp}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('X-File-Name', name);
  res.send(lines.join('\r\n'));
});

/** GET /api/denials/:id — one denial with every line item. */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const claim = db
    .prepare(
      `SELECT c.*, cu.first_name, cu.last_name
       FROM denied_claims c
       LEFT JOIN clients cu ON cu.id = c.client_id AND cu.agency_id = c.agency_id
       WHERE c.id = ? AND c.agency_id = ?`
    )
    .get(id, req.agencyId);
  if (!claim) return res.status(404).json({ error: 'Denied claim not found' });

  const items = db
    .prepare(
      `SELECT i.*, t.status AS task_status, t.id AS task_id,
              d.work_date AS entry_dos, d.minutes_worked AS entry_minutes
       FROM denied_line_items i
       LEFT JOIN rebill_tasks t ON t.denied_line_item_id = i.id
                              AND t.agency_id = i.agency_id
       LEFT JOIN day_entries d ON d.id = i.recovered_by_day_entry_id
                             AND d.agency_id = i.agency_id
       WHERE i.denied_claim_id = ? AND i.agency_id = ?
       ORDER BY i.dos, i.id`
    )
    .all(id, req.agencyId);

  res.json({ denial: { ...claim, client_label: clientName(claim) }, line_items: items });
});

/** GET /api/rebill-tasks — the working list. */
router.get('/rebill/tasks', (req, res) => {
  const where = ['t.agency_id = @agency'];
  const params = { agency: req.agencyId };
  if (req.query.client_id) {
    where.push('t.client_id = @client');
    params.client = Number(req.query.client_id);
  }
  if (req.query.caretaker_id) {
    where.push('t.caretaker_id = @caretaker');
    params.caretaker = Number(req.query.caretaker_id);
  }
  if (req.query.status) {
    where.push('t.status = @status');
    params.status = String(req.query.status);
  }
  if (req.query.date_from) {
    where.push('t.dos >= @from');
    params.from = String(req.query.date_from);
  }
  if (req.query.date_to) {
    where.push('t.dos <= @to');
    params.to = String(req.query.date_to);
  }

  const rows = db
    .prepare(
      `SELECT t.*,
              cu.first_name, cu.last_name, cu.id AS client_id,
              k.first_name AS caretaker_first, k.last_name AS caretaker_last,
              CAST(julianday('now') - julianday(t.created_at) AS INTEGER) AS days_open
       FROM rebill_tasks t
       LEFT JOIN clients cu ON cu.id = t.client_id AND cu.agency_id = t.agency_id
       LEFT JOIN caretakers k ON k.id = t.caretaker_id AND k.agency_id = t.agency_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.dos DESC, t.id DESC
       LIMIT 1000`
    )
    .all(params);

  res.json({
    tasks: rows.map((r) => ({
      ...r,
      client_label: clientName(r),
      caretaker_label: [r.caretaker_last, r.caretaker_first].filter(Boolean).join(', ') || '—',
      hours: round2((r.minutes_worked || 0) / 60),
    })),
  });
});

/** POST /api/denials/bulk-delete { ids } — all or nothing. */
router.post('/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });

  const preview = denialDeleteCounts(ids, req.agencyId);
  if (!preview.found_ids.length) return res.status(404).json({ error: 'No matching denials' });

  // One transaction: a partial archive delete would be worse than none.
  db.transaction(() => {
    const ph = preview.found_ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM denied_claims WHERE id IN (${ph}) AND agency_id = ?`).run(
      ...preview.found_ids,
      req.agencyId
    );
  })();

  res.json({
    deleted_denial: preview.denials,
    deleted_line_items: preview.line_items,
    deleted_rebill_tasks: preview.rebill_tasks,
  });
});

/** DELETE /api/denials/:id */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const result = deleteDenials([id], req.agencyId);
  if (!result.found_ids.length) return res.status(404).json({ error: 'Denied claim not found' });
  res.json({
    deleted_denial: result.deleted_denial,
    deleted_line_items: result.deleted_line_items,
    deleted_rebill_tasks: result.deleted_rebill_tasks,
  });
});

/** PATCH /api/rebill-tasks/:id — status, notes, resolved_at. */
router.patch('/rebill/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare(`SELECT * FROM rebill_tasks WHERE id = ? AND agency_id = ?`)
    .get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Rebill task not found' });

  const STATUSES = ['open', 'submitted', 'paid', 'written_off'];
  const updates = {};
  if ('status' in req.body) {
    if (!STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    updates.status = req.body.status;
  }
  if ('notes' in req.body) {
    const n = req.body.notes == null ? null : String(req.body.notes).trim() || null;
    updates.notes = n;
  }
  updates.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const terminal = ['paid', 'written_off'];
  const nextStatus = updates.status ?? existing.status;
  updates.resolved_at = terminal.includes(nextStatus)
    ? existing.resolved_at ?? updates.updated_at
    : null;

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE rebill_tasks SET ${setSql} WHERE id = @id AND agency_id = @agency`).run({
    ...updates,
    id,
    agency: req.agencyId,
  });

  const open = openTaskCount(req.agencyId);
  res.json({
    task: db
      .prepare(`SELECT * FROM rebill_tasks WHERE id = ? AND agency_id = ?`)
      .get(id, req.agencyId),
    open_tasks: open,
  });
});


/**
 * POST /api/denials/:id/explain
 *
 * Turns the stored denial into a prompt for the configured AI provider.
 *
 * Note what is NOT available: neither `denied_claims` nor `denied_line_items`
 * stores an adjustment reason code, so the prompt carries the claim status and
 * the procedure lines instead of a code like "CO-45". The model is told this
 * explicitly so it does not invent a code.
 */
router.post('/:id/explain', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'A valid denial id is required' });
  }

  const denial = db
    .prepare('SELECT * FROM denied_claims WHERE id = ? AND agency_id = ?')
    .get(id, req.agencyId);
  if (!denial) return res.status(404).json({ error: 'Denial not found' });

  const client = denial.client_id
    ? db
        .prepare('SELECT first_name, last_name, ma_number FROM clients WHERE id = ? AND agency_id = ?')
        .get(denial.client_id, req.agencyId)
    : null;
  const items = db
    .prepare(
      `SELECT procedure_code, units, billed, dos, recovery_status, adjustment_code
         FROM denied_line_items WHERE denied_claim_id = ? AND agency_id = ?
         ORDER BY dos, id`
    )
    .all(id, req.agencyId);
  const claim = denial.original_claim_id
    ? db
        .prepare(
          `SELECT claim_name, period_start, period_end, status, total_dollars, submitted_date
             FROM claims WHERE id = ? AND agency_id = ?`
        )
        .get(denial.original_claim_id, req.agencyId)
    : null;

  const money = (n) => (n == null ? 'unknown' : `$${Number(n).toFixed(2)}`);
  const clientName = client
    ? `${client.first_name} ${client.last_name}`
    : denial.client_name_raw ?? 'unknown client';

  const denialBlock = [
    `Claim status: ${denial.claim_status}`,
    `Amount: ${money(denial.total_payment)}`,
    `Client: ${clientName}${client?.ma_number ? ` (MA ${client.ma_number})` : ''}`,
    `Date of service: ${denial.dos_start ?? 'not recorded'} to ${denial.dos_end ?? 'not recorded'}`,
    `Recovery status: ${denial.recovery_status ?? 'unknown'}`,
    `Original claim #: ${denial.original_claim_number ?? denial.ra_claim_number ?? 'not on file'}`,
    `Source advice: ${denial.source_filename ?? 'unknown'}`,
    denial.adjustment_code
      ? `Adjustment Code: ${denial.adjustment_code}`
      : 'Adjustment Code: Not recorded (this claim predates code capture) — do not invent one.',
  ].join('\n');

  const claimBlock = claim
    ? [
        `Claim: ${claim.claim_name}`,
        `Period: ${claim.period_start ?? '?'} to ${claim.period_end ?? '?'}`,
        `Status: ${claim.status}`,
        `Billed: ${money(claim.total_dollars)}`,
        `Submitted: ${claim.submitted_date ?? 'not submitted'}`,
      ].join('\n')
    : 'No original claim is linked to this denial.';

  const lineBlock = items.length
    ? items
        .map(
          (i) =>
            `- ${i.dos ?? '?'}: ${i.procedure_code ?? 'no code'}, ${i.units ?? '?'} units, billed ${money(i.billed)}${i.adjustment_code ? `, adj ${i.adjustment_code}` : ''}`
        )
        .join('\n')
    : 'No service lines recorded.';

  const prompt = [
    'You are a home-care billing expert for the state of Minnesota.',
    'Explain this claim denial to the biller in plain English.',
    'Provide the meaning of the denial code and the exact next steps to fix it.',
    'Keep it to two short paragraphs.',
    '',
    'Denial Details:',
    denialBlock,
    '',
    'Claim Details:',
    claimBlock,
    '',
    'Service lines:',
    lineBlock,
  ].join('\n');

  const { text, source } = await complete(prompt, { agencyId: req.agencyId });

  res.json({
    explanation: text,
    source,
    denial_id: id,
    // surface what was actually sent so the UI can say "no code on file"
    has_reason_code: Boolean(denial.adjustment_code),
    line_count: items.length,
  });
});

export default router;
