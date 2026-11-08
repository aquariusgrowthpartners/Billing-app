import express from 'express';
import db from '../db.js';
import { computeEntry, round2 } from '../calc.js';
import { clockTime } from '../hhaFields.js';

const router = express.Router();

/**
 * Total minutes for a request body.
 *
 * The calendar sends separate `hours` and `minutes` fields; the total is always
 * computed here so the client can never disagree with what is stored. A plain
 * `minutes_worked` is still accepted for direct API callers.
 */
export function resolveMinutes(body = {}) {
  const hasSplit = body.hours !== undefined || body.minutes !== undefined;
  if (hasSplit) {
    const h = Math.max(0, Math.trunc(Number(body.hours) || 0));
    const m = Math.max(0, Math.trunc(Number(body.minutes) || 0));
    return h * 60 + m;
  }
  return Math.max(0, Math.trunc(Number(body.minutes_worked) || 0));
}

/**
 * Caretaker ids are validated here as well as by the foreign key, so the API
 * returns a readable error rather than a constraint failure.
 * Empty / null / undefined clears the caretaker.
 */
export function resolveCaretaker(value) {
  if (value === '' || value === null || value === undefined) return { id: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: 'caretaker_id must be a positive integer' };
  if (!db.prepare(`SELECT 1 FROM caretakers WHERE id = ? AND agency_id = ?`).get(id, req.agencyId)) {
    return { error: 'caretaker_id does not exist' };
  }
  return { id };
}

/** Read-side shape: every returned entry carries its caretaker for display. */
const ENTRY_SELECT = `
  SELECT d.*, t.first_name AS caretaker_first_name, t.last_name AS caretaker_last_name,
         t.npi_number AS caretaker_npi,
         cl.status AS claim_status, cl.claim_name AS claim_name,
              cl.archived AS claim_archived
  FROM day_entries d
  LEFT JOIN caretakers t ON t.id = d.caretaker_id
  LEFT JOIN claims cl ON cl.id = d.claim_id
  WHERE d.agency_id = @agency
`;

/** One entry, joined to its caretaker. */
function readEntry(id) {
  return db.prepare(`${ENTRY_SELECT} AND d.id = ?`).get(id, req.agencyId);
}

/**
 * GET /api/day-entries?client_id=&start=&end=
 * Range is inclusive of start, exclusive of end (so [start, start+7) is one week).
 */
router.get('/', (req, res) => {
  const where = [];
  const params = {};

  if (req.query.client_id) {
    where.push('client_id = @client_id');
    params.client_id = Number(req.query.client_id);
  }
  if (req.query.start) {
    where.push('work_date >= @start');
    params.start = req.query.start;
  }
  if (req.query.end) {
    where.push('work_date < @end');
    params.end = req.query.end;
  }
  if (req.query.claim_id) {
    where.push('claim_id = @claim_id');
    params.claim_id = Number(req.query.claim_id);
  }
  if (req.query.unclaimed === '1') {
    where.push('claim_id IS NULL');
  }

  const rows = db
    .prepare(
      `${ENTRY_SELECT}
       ${where.length ? `WHERE ${where.map((w) => `d.${w}`).join(' AND ')}` : ''}
       ORDER BY d.work_date, d.client_id`
    )
    .all({ ...params, agency: req.agencyId });

  res.json({ entries: rows, totals: sumEntries(rows) });
});

/**
 * POST /api/day-entries
 * Upserts on (client_id, work_date). units/rate/dollars are always recomputed
 * server-side from the agreement — the client never gets to dictate money.
 */
router.post('/', (req, res) => {
  const b = req.body ?? {};
  const clientId = Number(b.client_id);
  const workDate = (b.work_date ?? '').toString();
  if (!clientId) return res.status(400).json({ error: 'client_id is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
  }
  if (!db.prepare(`SELECT 1 FROM clients WHERE id = ? AND agency_id = ?`).get(clientId, req.agencyId)) {
    return res.status(400).json({ error: 'client_id does not exist' });
  }

  const agreementId = b.agreement_id ? Number(b.agreement_id) : null;
  const agreement = agreementId
    ? db.prepare(`SELECT * FROM agreements WHERE id = ? AND agency_id = ?`).get(agreementId, req.agencyId)
    : null;

  if (agreementId && !agreement) return res.status(400).json({ error: 'agreement_id does not exist' });
  if (agreement && agreement.client_id !== clientId) {
    return res.status(400).json({ error: 'agreement does not belong to this client' });
  }

  const caretaker = resolveCaretaker(b.caretaker_id);
  if (caretaker.error) return res.status(400).json({ error: caretaker.error });

  const startTime = clockTime(b.start_time);
  if (startTime.error) return res.status(400).json({ error: startTime.error });

  const minutes = resolveMinutes(b);

  const computed = computeEntry({
    minutes_worked: minutes,
    minutes_per_unit: agreement?.minutes_per_unit,
    rate_per_unit: agreement?.rate_per_unit,
    max_units_per_day: agreement?.max_units_per_day,
  });

  const existing = db
    .prepare(`SELECT * FROM day_entries WHERE client_id = ? AND work_date = ? AND agency_id = ?`)
    .get(clientId, workDate, req.agencyId);

  // Zero minutes = the day was cleared.
  if (minutes === 0 && !b.notes) {
    if (existing) db.prepare(`DELETE FROM day_entries WHERE id = ? AND agency_id = ?`).run(existing.id, req.agencyId);
    return res.json({ entry: null, deleted: Boolean(existing), calc: computed });
  }

  const payload = {
    client_id: clientId,
    agreement_id: agreementId,
    caretaker_id: caretaker.id,
    start_time: startTime.ok,
    work_date: workDate,
    minutes_worked: computed.minutes_worked,
    units: computed.units,
    rate_per_unit: computed.rate_per_unit,
    dollars: computed.dollars,
    notes: b.notes ?? null,
  };

  let entry;
  if (existing) {
    db.prepare(
      `UPDATE day_entries
       SET agreement_id = @agreement_id,
           caretaker_id = @caretaker_id,
           start_time = @start_time,
           minutes_worked = @minutes_worked,
           units = @units,
           rate_per_unit = @rate_per_unit,
           dollars = @dollars,
           notes = @notes
       WHERE id = @id`
    ).run({ ...payload, id: existing.id });
    entry = readEntry(existing.id);
  } else {
    const info = db
      .prepare(
        `INSERT INTO day_entries
           (client_id, agreement_id, caretaker_id, start_time, work_date, minutes_worked, units, rate_per_unit, dollars, notes, agency_id)
         VALUES
           (@client_id, @agreement_id, @caretaker_id, @start_time, @work_date, @minutes_worked, @units, @rate_per_unit, @dollars, @notes, @agency)`
      )
      .run(payload);
    entry = readEntry(info.lastInsertRowid);
  }

  res.status(existing ? 200 : 201).json({
    entry,
    calc: computed,
    updated: Boolean(existing),
    // The claim that owns this day (if any) now has stale totals.
    claim_id: entry?.claim_id ?? null,
    needs_regeneration: Boolean(entry?.claim_id),
  });
});

/** POST /api/day-entries/bulk — save a whole week in one transaction. */
router.post('/bulk', (req, res) => {
  const days = Array.isArray(req.body?.days) ? req.body.days : null;
  if (!days) return res.status(400).json({ error: 'days[] is required' });

  const results = [];
  const run = db.transaction((rows) => {
    for (const row of rows) {
      const clientId = Number(row.client_id);
      const workDate = (row.work_date ?? '').toString();
      if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        results.push({ work_date: workDate, error: 'client_id and work_date are required' });
        continue;
      }

      if (!db.prepare(`SELECT 1 FROM clients WHERE id = ? AND agency_id = ?`).get(clientId, req.agencyId)) {
        results.push({ work_date: workDate, error: 'client_id does not exist' });
        continue;
      }

      const agreementId = row.agreement_id ? Number(row.agreement_id) : null;
      const agreement = agreementId
        ? db.prepare(`SELECT * FROM agreements WHERE id = ? AND agency_id = ?`).get(agreementId, req.agencyId)
        : null;

      // Same ownership rule as the single-day endpoint — never bill one
      // client's day against another client's agreement.
      if (agreementId && !agreement) {
        results.push({ work_date: workDate, error: 'agreement_id does not exist' });
        continue;
      }
      if (agreement && agreement.client_id !== clientId) {
        results.push({ work_date: workDate, error: 'agreement does not belong to this client' });
        continue;
      }

      const caretaker = resolveCaretaker(row.caretaker_id);
      if (caretaker.error) {
        results.push({ work_date: workDate, error: caretaker.error });
        continue;
      }

      const startTime = clockTime(row.start_time);
      if (startTime.error) {
        results.push({ work_date: workDate, error: startTime.error });
        continue;
      }

      const computed = computeEntry({
        minutes_worked: resolveMinutes(row),
        minutes_per_unit: agreement?.minutes_per_unit,
        rate_per_unit: agreement?.rate_per_unit,
        max_units_per_day: agreement?.max_units_per_day,
      });

      const existing = db
        .prepare(`SELECT * FROM day_entries WHERE client_id = ? AND work_date = ? AND agency_id = ?`)
        .get(clientId, workDate, req.agencyId);

      if (computed.minutes_worked === 0 && !row.notes) {
        if (existing) db.prepare(`DELETE FROM day_entries WHERE id = ? AND agency_id = ?`).run(existing.id, req.agencyId);
        results.push({ work_date: workDate, entry: null, deleted: Boolean(existing) });
        continue;
      }

      const payload = {
        client_id: clientId,
        agreement_id: agreementId,
        caretaker_id: caretaker.id,
        start_time: startTime.ok,
        work_date: workDate,
        minutes_worked: computed.minutes_worked,
        units: computed.units,
        rate_per_unit: computed.rate_per_unit,
        dollars: computed.dollars,
        notes: row.notes ?? null,
      };

      if (existing) {
        db.prepare(
          `UPDATE day_entries SET agreement_id=@agreement_id, caretaker_id=@caretaker_id,
             start_time=@start_time, minutes_worked=@minutes_worked, units=@units,
             rate_per_unit=@rate_per_unit, dollars=@dollars, notes=@notes
           WHERE id=@id`
        ).run({ ...payload, id: existing.id });
      } else {
        db.prepare(
          `INSERT INTO day_entries
             (client_id, agreement_id, caretaker_id, start_time, work_date, minutes_worked, units, rate_per_unit, dollars, notes, agency_id)
           VALUES
             (@client_id, @agreement_id, @caretaker_id, @start_time, @work_date, @minutes_worked, @units, @rate_per_unit, @dollars, @notes, @agency)`
        ).run(payload);
      }

      const saved = db
        .prepare(`${ENTRY_SELECT} WHERE d.client_id = ? AND d.work_date = ?`)
        .get(clientId, workDate, req.agencyId);
      results.push({ work_date: workDate, entry: saved });
    }
  });

  run(days);
  res.json({ results });
});

/**
 * POST /api/day-entries/bulk-delete  { client_id, dates: [] }
 * Deletes the day entries for several dates at once. Days attached to a claim
 * are deletable: the claim's totals simply go stale until it is regenerated.
 */
router.post('/bulk-delete', (req, res) => {
  const clientId = Number(req.body?.client_id);
  const dates = Array.isArray(req.body?.dates)
    ? req.body.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
    : [];

  if (!clientId) return res.status(400).json({ error: 'client_id is required' });
  if (!dates.length) return res.status(400).json({ error: 'dates[] is required' });
  if (!db.prepare(`SELECT 1 FROM clients WHERE id = ? AND agency_id = ?`).get(clientId, req.agencyId)) {
    return res.status(400).json({ error: 'client_id does not exist' });
  }

  const placeholders = dates.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, work_date, claim_id FROM day_entries
       WHERE client_id = ? AND work_date IN (${placeholders})`
    )
    .all(clientId, ...dates);

  if (!rows.length) return res.json({ deleted: 0, dates: [], on_claims: 0 });

  const del = db.prepare(`DELETE FROM day_entries WHERE id = ?`);
  db.transaction(() => {
    for (const row of rows) del.run(row.id);
  })();

  res.json({
    deleted: rows.length,
    dates: rows.map((r) => r.work_date),
    on_claims: rows.filter((r) => r.claim_id != null).length,
  });
});

/** DELETE /api/day-entries/:id */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM day_entries WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  db.prepare(`DELETE FROM day_entries WHERE id = ? AND agency_id = ?`).run(id, req.agencyId);
  res.json({ deleted: true, id });
});

/**
 * GET /api/day-entries/summary?client_id=&start=
 * Week totals for one client. (The authorized-units-per-week metric was
 * retired; the column stays in the schema but nothing calculates against it.)
 */
router.get('/summary', (req, res) => {
  const clientId = Number(req.query.client_id);
  const start = req.query.start;
  if (!clientId || !start) {
    return res.status(400).json({ error: 'client_id and start are required' });
  }

  const rows = db
    .prepare(
      `${ENTRY_SELECT}
       WHERE d.client_id = ? AND d.work_date >= ? AND d.work_date < date(?, '+7 days')`
    )
    .all(clientId, start, start);

  res.json({ start, totals: sumEntries(rows) });
});

function sumEntries(rows) {
  return {
    entry_count: rows.length,
    total_minutes: rows.reduce((s, r) => s + (r.minutes_worked || 0), 0),
    total_units: rows.reduce((s, r) => s + (r.units || 0), 0),
    total_dollars: round2(rows.reduce((s, r) => s + (r.dollars || 0), 0)),
  };
}

export default router;
