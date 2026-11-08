/**
 * Caretakers — the people who deliver care. Recorded per day worked.
 *
 * Deactivating is the normal way to retire someone: it hides them from
 * pickers while every historical day entry keeps pointing at them.
 */
import express from 'express';
import db from '../db.js';
import { ssn, gender as genderField, isoDate } from '../hhaFields.js';
import { round2, todayISO, addDays } from '../calc.js';
import {
  payPeriodFor,
  shiftPayPeriod,
  VALID_ENTRY_SQL,
  VALID_ENTRY_FROM,
  entryFrom,
  monthBounds,
  yearBounds,
} from '../payPeriod.js';

const router = express.Router();

const FIELDS = [
  'first_name', 'last_name', 'npi_number', 'notes', 'active', 'ssn', 'gender', 'dob',
  // MPSMISC reporting spreadsheet fields
  'street_address', 'city', 'state', 'zip', 'phone', 'hire_date', 'termination_date',
  'hourly_wage_rate', 'union_member', 'dues_deducted', 'seiu_voluntary_dues',
];

/** Trimmed string, or null when empty. */
const trimmed = (v) => {
  const t = v == null ? '' : String(v).trim();
  return t === '' ? null : t;
};

/** Digits only — used for the ZIP and the 10-digit phone. */
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');

const decimal = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

function normalise(body) {
  const updates = {};
  for (const f of FIELDS) if (f in body) updates[f] = body[f];

  for (const f of ['first_name', 'last_name']) {
    if (f in updates && !String(updates[f] ?? '').trim()) {
      return { error: `${f.replace('_', ' ')} is required` };
    }
    if (f in updates) updates[f] = String(updates[f]).trim();
  }
  for (const f of ['npi_number', 'notes']) {
    if (f in updates) {
      const v = String(updates[f] ?? '').trim();
      updates[f] = v || null;
    }
  }

  // HHAeXchange caregiver fields.
  if ('ssn' in updates) {
    const check = ssn(updates.ssn);
    if (check.error) return { error: check.error };
    updates.ssn = check.ok;
  }
  if ('gender' in updates) {
    const check = genderField(updates.gender);
    if (check.error) return { error: check.error };
    updates.gender = check.ok;
  }
  if ('dob' in updates) {
    const check = isoDate(updates.dob, { label: 'Date of birth' });
    if (check.error) return { error: check.error };
    updates.dob = check.ok;
  }
  if ('active' in updates) {
    updates.active = updates.active === false || updates.active === 0 ? 0 : 1;
  }

  // MPSMISC reporting fields.
  for (const f of ['street_address', 'city']) {
    if (f in updates) updates[f] = trimmed(updates[f]);
  }
  if ('state' in updates) {
    const st = trimmed(updates.state);
    if (st && !/^[A-Za-z]{2}$/.test(st)) return { error: 'State must be a 2-letter code' };
    updates.state = st ? st.toUpperCase() : null;
  }
  if ('zip' in updates) {
    const z = digitsOnly(updates.zip);
    if (z && z.length !== 5) return { error: 'ZIP must be 5 digits' };
    updates.zip = z || null;
  }
  if ('phone' in updates) {
    const ph = digitsOnly(updates.phone);
    if (ph && ph.length !== 10) return { error: 'Phone number must be 10 digits' };
    updates.phone = ph || null;
  }
  for (const f of ['hire_date', 'termination_date']) {
    if (f in updates) {
      const check = isoDate(updates[f], { label: f.replace('_', ' ') });
      if (check.error) return { error: check.error };
      updates[f] = check.ok;
    }
  }
  if ('hourly_wage_rate' in updates) {
    const w = decimal(updates.hourly_wage_rate);
    if (updates.hourly_wage_rate !== null && updates.hourly_wage_rate !== '' && w === null) {
      return { error: 'Hourly wage rate must be a number' };
    }
    updates.hourly_wage_rate = w;
  }
  for (const f of ['dues_deducted', 'seiu_voluntary_dues']) {
    if (f in updates) updates[f] = decimal(updates[f]) ?? 0;
  }
  if ('union_member' in updates) {
    updates.union_member =
      updates.union_member === true || updates.union_member === 1 || updates.union_member === '1'
        ? 1
        : 0;
  }
  return { updates };
}

/** Name for display, tolerating either column being absent. */
const fullName = (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();

/** GET /api/caretakers?active=0  (active=0 returns everyone) */
router.get('/', (req, res) => {
  const activeOnly = req.query.active !== '0';
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM day_entries d WHERE d.caretaker_id = c.id AND d.agency_id = c.agency_id) AS day_count
       FROM caretakers c
      WHERE c.agency_id = @agency
       ${activeOnly ? 'AND c.active = 1' : ''}
       ORDER BY c.active DESC, c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`
    )
    .all({ agency: req.agencyId });
  res.json({ caretakers: rows });
});

/** GET /api/caretakers/:id */
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(Number(req.params.id), req.agencyId);
  if (!row) return res.status(404).json({ error: 'Caretaker not found' });
  res.json(row);
});

/** POST /api/caretakers */
router.post('/', (req, res) => {
  const { updates, error } = normalise(req.body ?? {});
  if (error) return res.status(400).json({ error });
  if (!updates.first_name || !updates.last_name) {
    return res.status(400).json({ error: 'first_name and last_name are required' });
  }

  const info = db
    .prepare(
      `INSERT INTO caretakers
         (first_name, last_name, npi_number, notes, active, ssn, gender, dob,
          street_address, city, state, zip, phone, hire_date, termination_date,
          hourly_wage_rate, union_member, dues_deducted, seiu_voluntary_dues, agency_id)
       VALUES
         (@first_name, @last_name, @npi_number, @notes, @active, @ssn, @gender, @dob,
          @street_address, @city, @state, @zip, @phone, @hire_date, @termination_date,
          @hourly_wage_rate, @union_member, @dues_deducted, @seiu_voluntary_dues, @agency)`
    )
    .run({
      first_name: updates.first_name,
      last_name: updates.last_name,
      npi_number: updates.npi_number ?? null,
      notes: updates.notes ?? null,
      active: updates.active ?? 1,
      ssn: updates.ssn ?? null,
      gender: updates.gender ?? null,
      dob: updates.dob ?? null,
      street_address: updates.street_address ?? null,
      city: updates.city ?? null,
      state: updates.state ?? null,
      zip: updates.zip ?? null,
      phone: updates.phone ?? null,
      hire_date: updates.hire_date ?? null,
      termination_date: updates.termination_date ?? null,
      hourly_wage_rate: updates.hourly_wage_rate ?? null,
      union_member: updates.union_member ?? 0,
      dues_deducted: updates.dues_deducted ?? 0,
      seiu_voluntary_dues: updates.seiu_voluntary_dues ?? 0,
      agency: req.agencyId,
    });

  res.status(201).json(db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(info.lastInsertRowid, req.agencyId));
});

/** PUT and PATCH /api/caretakers/:id — both partial. */
function updateCaretaker(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Caretaker not found' });

  const { updates, error } = normalise(req.body ?? {});
  if (error) return res.status(400).json({ error });
  if (!Object.keys(updates).length) return res.json(existing);

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE caretakers SET ${setSql} WHERE id = @id AND agency_id = @agency`).run({ ...updates, id, agency: req.agencyId });
  res.json(db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(id, req.agencyId));
}

router.patch('/:id', updateCaretaker);
router.put('/:id', updateCaretaker);

/* ------------------------------------------------------------------ stats */

/** Confirm the caretaker exists, or answer 404. */
function requireCaretaker(req, res) {
  const id = Number(req.params.id);
  const caretaker = db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!caretaker) {
    res.status(404).json({ error: 'Caretaker not found' });
    return null;
  }
  return caretaker;
}

/** "08:30" + 90 minutes -> "10:00". */
function clockFrom(startTime, minutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTime));
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + Number(minutes || 0);
  const h = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Totals for one caretaker over a date window (inclusive), using the same
 * validity rule as the Home Dashboard. `null` bounds mean "no limit".
 */
function totalsFor(caretakerId, start, end) {
  const where = ['d.caretaker_id = @id', VALID_ENTRY_SQL];
  const params = { id: caretakerId };
  if (start && end) {
    where.push('d.work_date >= @start AND d.work_date <= @end');
    params.start = start;
    params.end = end;
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(d.minutes_worked), 0) AS minutes,
              COALESCE(SUM(d.dollars), 0)       AS dollars,
              COUNT(DISTINCT d.client_id)       AS clients,
              COUNT(*)                          AS entries
       ${VALID_ENTRY_FROM}
       AND ${where.join(' AND ')}`
    )
    .get(params);
  return {
    minutes: row.minutes,
    hours: round2(row.minutes / 60),
    dollars: round2(row.dollars),
    clients: row.clients,
    entries: row.entries,
  };
}

/** Every active caretaker's hours for a period, ranked — the dashboard's ranking. */
function rankingFor(start, end) {
  return db
    .prepare(
      `SELECT d.caretaker_id AS id, SUM(d.minutes_worked) AS minutes
       ${entryFrom({ caretaker: true })}
       AND d.work_date >= @start AND d.work_date <= @end
         AND COALESCE(t.active, 1) = 1
         AND ${VALID_ENTRY_SQL}
       GROUP BY d.caretaker_id
       HAVING SUM(d.minutes_worked) > 0
       ORDER BY minutes DESC, id ASC`
    )
    .all({ start, end });
}

/**
 * Claim money attached to this caretaker, by claim status.
 *
 * A claim counts once however many of its days this caretaker worked, and
 * archived claims are left out to match Reports.
 */
function claimMoney(caretakerId, status) {
  return round2(
    db
      .prepare(
        `SELECT COALESCE(SUM(c.total_dollars), 0) AS dollars
         FROM claims c
         WHERE c.status = @status
           AND COALESCE(c.archived, 0) = 0
           AND EXISTS (
             SELECT 1 FROM day_entries d
             WHERE d.claim_id = c.id AND d.caretaker_id = @id
           )`
      )
      .get({ id: caretakerId, status }).dollars
  );
}

/** Resolve ?start= into a concrete pay period, with prev/next for navigation. */
function periodFrom(req) {
  const current = payPeriodFor(todayISO());
  const start = req.query.start || current.start;
  const period = { start, end: addDays(start, 13) };
  return {
    ...period,
    is_current: period.start === current.start,
    prev_start: shiftPayPeriod(period, -1).start,
    next_start: shiftPayPeriod(period, 1).start,
  };
}

/** GET /api/caretakers/:id/summary?start= — period snapshot plus earnings. */
router.get('/:id/summary', (req, res) => {
  const caretaker = requireCaretaker(req, res);
  if (!caretaker) return;

  const period = periodFrom(req);
  const today = todayISO();
  const month = monthBounds(today);
  const year = yearBounds(today);

  const inPeriod = totalsFor(caretaker.id, period.start, period.end);
  const ranking = rankingFor(period.start, period.end);
  const index = ranking.findIndex((r) => r.id === caretaker.id);

  res.json({
    caretaker: {
      id: caretaker.id,
      first_name: caretaker.first_name,
      last_name: caretaker.last_name,
      active: caretaker.active,
    },
    period,
    in_period: {
      ...inPeriod,
      // null when they have no hours this period, so the UI can say so plainly
      rank: index === -1 ? null : index + 1,
      of: ranking.length,
    },
    earnings: {
      period: inPeriod.dollars,
      mtd: totalsFor(caretaker.id, month.start, month.end).dollars,
      ytd: totalsFor(caretaker.id, year.start, year.end).dollars,
      anticipated: claimMoney(caretaker.id, 'Submitted'),
      confirmed: claimMoney(caretaker.id, 'Paid'),
    },
  });
});

/** GET /api/caretakers/:id/client-splits?range=period|month|ytd|all&start= */
router.get('/:id/client-splits', (req, res) => {
  const caretaker = requireCaretaker(req, res);
  if (!caretaker) return;

  const today = todayISO();
  const range = ['period', 'month', 'ytd', 'all'].includes(req.query.range)
    ? req.query.range
    : 'period';

  let start = null;
  let end = null;
  if (range === 'period') {
    const p = periodFrom(req);
    start = p.start;
    end = p.end;
  } else if (range === 'month') {
    ({ start, end } = monthBounds(today));
  } else if (range === 'ytd') {
    ({ start, end } = yearBounds(today));
  }

  const where = ['d.caretaker_id = @id', VALID_ENTRY_SQL];
  const params = { id: caretaker.id };
  if (start && end) {
    where.push('d.work_date >= @start AND d.work_date <= @end');
    params.start = start;
    params.end = end;
  }

  const rows = db
    .prepare(
      `SELECT d.client_id,
              cu.first_name, cu.last_name, cu.middle_initial,
              SUM(d.minutes_worked)    AS minutes,
              ROUND(SUM(d.dollars), 2) AS dollars
       ${VALID_ENTRY_FROM}
       AND ${where.join(' AND ')}
       GROUP BY d.client_id
       ORDER BY dollars DESC, cu.last_name COLLATE NOCASE`
    )
    .all(params);

  const total = rows.reduce((s, r) => s + (r.dollars || 0), 0);
  res.json({
    range,
    start,
    end,
    total_dollars: round2(total),
    splits: rows.map((r) => ({
      client_id: r.client_id,
      client_name: [r.last_name, r.first_name].filter(Boolean).join(', '),
      first_name: r.first_name,
      last_name: r.last_name,
      minutes: r.minutes,
      hours: round2(r.minutes / 60),
      dollars: round2(r.dollars),
      percentage: total > 0 ? Math.round((r.dollars / total) * 1000) / 10 : 0,
    })),
  });
});

/** GET /api/caretakers/:id/work-history?from=&to=&client_id=&page=&per_page=&sort= */
router.get('/:id/work-history', (req, res) => {
  const caretaker = requireCaretaker(req, res);
  if (!caretaker) return;

  const where = ['d.caretaker_id = @id', VALID_ENTRY_SQL];
  const params = { id: caretaker.id };
  if (req.query.from) {
    where.push('d.work_date >= @from');
    params.from = req.query.from;
  }
  if (req.query.to) {
    where.push('d.work_date <= @to');
    params.to = req.query.to;
  }
  if (req.query.client_id) {
    where.push('d.client_id = @client');
    params.client = Number(req.query.client_id);
  }

  const perPage = Math.min(Math.max(Number(req.query.per_page) || 20, 1), 200);
  const total = db
    .prepare(`SELECT COUNT(*) AS n ${VALID_ENTRY_FROM} AND ${where.join(' AND ')}`)
    .get({ ...params, agency: req.agencyId }).n;
  const pages = Math.max(Math.ceil(total / perPage), 1);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  const direction = req.query.sort === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `SELECT d.id, d.work_date, d.minutes_worked, d.units, d.dollars, d.start_time,
              d.client_id, d.claim_id, d.source,
              cu.first_name, cu.last_name,
              cl.status AS claim_status, cl.claim_name,
              COALESCE(cl.archived, 0) AS claim_archived
       ${entryFrom({ claim: true })}
       AND ${where.join(' AND ')}
       ORDER BY d.work_date ${direction}, d.id ${direction}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: perPage, offset: (page - 1) * perPage, agency: req.agencyId });

  res.json({
    page,
    per_page: perPage,
    total,
    pages,
    sort: direction === 'ASC' ? 'asc' : 'desc',
    entries: rows.map((r) => ({
      id: r.id,
      work_date: r.work_date,
      client_id: r.client_id,
      client_name: [r.last_name, r.first_name].filter(Boolean).join(', '),
      first_name: r.first_name,
      hours: round2((r.minutes_worked || 0) / 60),
      minutes: r.minutes_worked,
      units: r.units,
      dollars: round2(r.dollars ?? 0),
      start_time: r.start_time,
      end_time:
        r.start_time && r.minutes_worked ? clockFrom(r.start_time, r.minutes_worked) : null,
      claim_id: r.claim_id,
      // an archived claim is not worth showing as a status
      claim_status: r.claim_id && !r.claim_archived ? r.claim_status : null,
      claim_name: r.claim_name,
      source: r.source,
    })),
  });
});

/** GET /api/caretakers/:id/calendar?month=YYYY-MM */
router.get('/:id/calendar', (req, res) => {
  const caretaker = requireCaretaker(req, res);
  if (!caretaker) return;

  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month
    : todayISO().slice(0, 7);

  const rows = db
    .prepare(
      `SELECT d.id, d.work_date, d.minutes_worked, d.units, d.dollars, d.start_time,
              d.client_id, d.claim_id,
              cu.first_name, cu.last_name,
              cl.status AS claim_status,
              COALESCE(cl.archived, 0) AS claim_archived
       ${entryFrom({ claim: true })}
       AND d.caretaker_id = @id
         AND ${VALID_ENTRY_SQL}
         AND d.work_date >= @first AND d.work_date <= @last
       ORDER BY d.work_date, d.id`
    )
    .all({ id: caretaker.id, first: `${month}-01`, last: `${month}-31`, agency: req.agencyId });

  // one bucket per day worked, in date order
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.work_date)) {
      byDate.set(r.work_date, {
        work_date: r.work_date,
        clients: [],
        total_hours: 0,
        total_dollars: 0,
        entries: [],
      });
    }
    const day = byDate.get(r.work_date);
    const name = [r.last_name, r.first_name].filter(Boolean).join(', ');
    if (!day.clients.includes(name)) day.clients.push(name);
    day.total_hours = round2(day.total_hours + (r.minutes_worked || 0) / 60);
    day.total_dollars = round2(day.total_dollars + (r.dollars || 0));
    day.entries.push({
      id: r.id,
      client_id: r.client_id,
      client_name: name,
      first_name: r.first_name,
      minutes: r.minutes_worked,
      hours: round2((r.minutes_worked || 0) / 60),
      units: r.units,
      dollars: round2(r.dollars ?? 0),
      start_time: r.start_time,
      end_time:
        r.start_time && r.minutes_worked ? clockFrom(r.start_time, r.minutes_worked) : null,
      claim_id: r.claim_id,
      claim_status: r.claim_id && !r.claim_archived ? r.claim_status : null,
    });
  }

  res.json({
    month,
    days: [...byDate.values()],
    total_hours: round2([...byDate.values()].reduce((s, d) => s + d.total_hours, 0)),
    total_dollars: round2([...byDate.values()].reduce((s, d) => s + d.total_dollars, 0)),
  });
});

/**
 * DELETE /api/caretakers/:id
 * Refuses while any day entry references them, so recorded history is never
 * silently un-attributed. Deactivate instead, or force and null the links.
 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM caretakers WHERE id = ? AND agency_id = ?`).get(id, req.agencyId);
  if (!existing) return res.status(404).json({ error: 'Caretaker not found' });

  const used = db.prepare(`SELECT COUNT(*) n FROM day_entries WHERE caretaker_id = ? AND agency_id = ?`).get(id, req.agencyId).n;
  if (used > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `${fullName(existing)} is recorded on ${used} day entr${used === 1 ? 'y' : 'ies'}.`,
      in_use: used,
      hint: 'Deactivate them instead, or re-send with ?force=1 to delete and clear those links.',
    });
  }

  if (used > 0) db.prepare(`UPDATE day_entries SET caretaker_id = NULL WHERE caretaker_id = ? AND agency_id = ?`).run(id, req.agencyId);
  db.prepare(`DELETE FROM caretakers WHERE id = ? AND agency_id = ?`).run(id, req.agencyId);
  res.json({ deleted: true, id, cleared_day_entries: used });
});

export default router;
