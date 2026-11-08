import express from 'express';
import db from '../db.js';
import { computeEntry, round2 } from '../calc.js';

const router = express.Router();

/** GET /api/agreements?client_id=1 */
router.get('/', (req, res) => {
  const clientId = req.query.client_id ? Number(req.query.client_id) : null;
  const rows = db
    .prepare(
      `SELECT a.*, p.name AS payer_name, p.typical_days_to_pay,
              c.first_name, c.last_name
       FROM agreements a
       LEFT JOIN payers p ON p.id = a.payer_id
       LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.agency_id = @agency
         ${clientId ? 'AND a.client_id = @clientId' : ''}
       ORDER BY a.client_id, a.start_date DESC, a.id DESC`
    )
    .all(clientId ? { clientId, agency: req.agencyId } : { agency: req.agencyId });
  res.json({ agreements: rows });
});

/** GET /api/agreements/:id */
router.get('/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT a.*, p.name AS payer_name, p.typical_days_to_pay
       FROM agreements a LEFT JOIN payers p ON p.id = a.payer_id
       WHERE a.id = ? AND a.agency_id = ?`
      )
      .get(Number(req.params.id), req.agencyId);
  if (!row) return res.status(404).json({ error: 'Agreement not found' });
  res.json(row);
});

/** POST /api/agreements */
router.post('/', (req, res) => {
  const b = req.body ?? {};
  const clientId = Number(b.client_id);
  if (!clientId) return res.status(400).json({ error: 'client_id is required' });
  if (!db.prepare(`SELECT 1 FROM clients WHERE id = ? AND agency_id = ?`).get(clientId, req.agencyId)) {
    return res.status(400).json({ error: 'client_id does not exist' });
  }

  const info = db
    .prepare(
      `INSERT INTO agreements (
         client_id, agreement_number, start_date, end_date,
         authorized_units_per_week, minutes_per_unit, rate_per_unit,
         max_units_per_day, service_code, payer_id, agency_id
       ) VALUES (
         @client_id, @agreement_number, @start_date, @end_date,
         @authorized_units_per_week, @minutes_per_unit, @rate_per_unit,
         @max_units_per_day, @service_code, @payer_id, @agency
       )`
    )
    .run({
      client_id: clientId,
      agreement_number: b.agreement_number ?? null,
      start_date: b.start_date ?? null,
      end_date: b.end_date ?? null,
      authorized_units_per_week: num(b.authorized_units_per_week),
      minutes_per_unit: num(b.minutes_per_unit) ?? 15,
      rate_per_unit: num(b.rate_per_unit) ?? 0,
      max_units_per_day: num(b.max_units_per_day),
      service_code: b.service_code ?? null,
      payer_id: b.payer_id ? Number(b.payer_id) : null,
        agency: req.agencyId,
    });

  res.status(201).json(db.prepare(`SELECT * FROM agreements WHERE id = ? AND agency_id = ?`).get(info.lastInsertRowid, req.agencyId));
});

/**
 * PUT and PATCH /api/agreements/:id — both verbs accepted, both partial.
 *
 * Changes apply going forward only: existing day_entries keep their snapshot of
 * units/rate_per_unit/dollars, so editing a rate never rewrites history.
 */
function updateAgreement(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM agreements WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Agreement not found' });

  const fields = [
    'agreement_number', 'start_date', 'end_date', 'authorized_units_per_week',
    'minutes_per_unit', 'rate_per_unit', 'max_units_per_day', 'service_code', 'payer_id',
    // filled in by hand from the HHAeXchange patient profile
    'hhaexchange_auth_number',
  ];
  const updates = {};
  for (const f of fields) {
    if (f in (req.body ?? {})) updates[f] = req.body[f];
  }

  if ('minutes_per_unit' in updates) {
    const n = Number(updates.minutes_per_unit);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'minutes_per_unit must be greater than 0' });
    }
    updates.minutes_per_unit = Math.trunc(n);
  }
  if ('rate_per_unit' in updates) {
    const n = Number(updates.rate_per_unit);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'rate_per_unit must be 0 or more' });
    }
    updates.rate_per_unit = n;
  }
  for (const f of ['agreement_number', 'start_date', 'end_date', 'service_code']) {
    if (f in updates && updates[f] === '') updates[f] = null;
  }
  if ('payer_id' in updates) {
    if (updates.payer_id === '' || updates.payer_id === null) {
      updates.payer_id = null;
    } else {
      updates.payer_id = Number(updates.payer_id);
      if (!db.prepare(`SELECT 1 FROM payers WHERE id = ? AND agency_id = ?`).get(updates.payer_id, req.agencyId)) {
        return res.status(400).json({ error: 'payer_id does not exist' });
      }
    }
  }
  if (!Object.keys(updates).length) return res.json(existing);

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE agreements SET ${setSql} WHERE id = @id AND agency_id = @agency`).run({ ...updates, id, agency: req.agencyId });
  res.json(db.prepare(`SELECT * FROM agreements WHERE id = ?`).get(id));
}

router.patch('/:id', updateAgreement);
router.put('/:id', updateAgreement);

/**
 * GET /api/agreements/:id/calc?minutes=85
 * Live preview used by the calendar UI. Does not touch the database.
 */
router.get('/:id/calc', (req, res) => {
  const agreement = db.prepare(`SELECT * FROM agreements WHERE id = ? AND agency_id = ?`).get(Number(req.params.id), req.agencyId);
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  res.json(
    computeEntry({
      minutes_worked: req.query.minutes,
      minutes_per_unit: agreement.minutes_per_unit,
      rate_per_unit: agreement.rate_per_unit,
      max_units_per_day: agreement.max_units_per_day,
    })
  );
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export { num as toNullableNumber, round2 };
export default router;
