import express from 'express';
import db from '../db.js';
import { round2, todayISO, addDays } from '../calc.js';
import { payPeriodFor, shiftPayPeriod } from '../payPeriod.js';

const router = express.Router();

/** Shared WHERE for a period, with the archive rules applied. */
// Only entries reachable through a valid, ACTIVE client count. An entry whose
// client is gone or archived is not something the ranking should report, and a
// dangling agreement reference means the row is no longer trustworthy.
//
// Dates compare as plain ISO strings, which `work_date` always is, so no time
// component can shift a period boundary.
const PERIOD_WHERE = `
  d.work_date >= @start AND d.work_date <= @end
  AND cu.id IS NOT NULL
  AND COALESCE(cu.archived, 0) = 0
  AND (d.agreement_id IS NULL OR a.id IS NOT NULL)
`;

const BASE_FROM = `
  FROM day_entries d
  JOIN clients cu ON cu.id = d.client_id
  LEFT JOIN claims cl ON cl.id = d.claim_id
  LEFT JOIN agreements a ON a.id = d.agreement_id
`;

/**
 * GET /api/dashboard/pay-period?start=&end=
 *
 * Defaults to the current bi-weekly Sunday→Saturday period. Only caretakers
 * with more than zero hours are returned (the ranking), and only when they are
 * still active.
 */
router.get('/pay-period', (req, res) => {
  const current = payPeriodFor(todayISO());

  let start = req.query.start || null;
  let end = req.query.end || null;
  if (start && !end) end = addDays(start, 13);
  if (end && !start) start = addDays(end, -13);
  if (!start) {
    start = current.start;
    end = current.end;
  }

  const params = { start, end };

  const caretakers = db
    .prepare(
      `SELECT t.id, t.first_name, t.last_name,
              SUM(d.minutes_worked)        AS minutes,
              ROUND(SUM(d.dollars), 2)     AS dollars,
              COUNT(DISTINCT d.client_id)  AS clients
       ${BASE_FROM}
       JOIN caretakers t ON t.id = d.caretaker_id
       WHERE ${PERIOD_WHERE}
         AND COALESCE(t.active, 1) = 1
       GROUP BY t.id
       HAVING SUM(d.minutes_worked) > 0
       ORDER BY minutes DESC, t.last_name COLLATE NOCASE, t.first_name COLLATE NOCASE`
    )
    .all(params);

  // Hours recorded with no caretaker attached. Surfaced rather than hidden, so
  // the grand total always reconciles with the rows on screen.
  const unassigned = db
    .prepare(
      `SELECT SUM(d.minutes_worked) AS minutes, ROUND(SUM(d.dollars), 2) AS dollars,
              COUNT(DISTINCT d.client_id) AS clients, COUNT(*) AS entries
       ${BASE_FROM}
       WHERE ${PERIOD_WHERE} AND d.caretaker_id IS NULL`
    )
    .get(params);

  // Entries in the period the validity rule keeps out, so the numbers are
  // auditable rather than mysteriously low.
  const excluded = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM day_entries d
       LEFT JOIN clients cu ON cu.id = d.client_id
       LEFT JOIN agreements a ON a.id = d.agreement_id
       WHERE d.work_date >= @start AND d.work_date <= @end
         AND (cu.id IS NULL OR COALESCE(cu.archived, 0) = 1
              OR (d.agreement_id IS NOT NULL AND a.id IS NULL))`
    )
    .get(params).n;

  // Entries in the period that carry no caretaker at all — they are counted in
  // the totals but cannot appear in a per-caretaker ranking.
  const unassignedEntries = db
    .prepare(
      `SELECT COUNT(*) AS n ${BASE_FROM}
       WHERE ${PERIOD_WHERE} AND d.caretaker_id IS NULL`
    )
    .get(params).n;

  const withRank = caretakers.map((c, i) => ({
    ...c,
    rank: i + 1,
    hours: round2(c.minutes / 60),
    dollars: round2(c.dollars ?? 0),
  }));

  const unassignedHours = round2((unassigned?.minutes ?? 0) / 60);
  const unassignedDollars = round2(unassigned?.dollars ?? 0);

  const countedEntries = db
    .prepare(`SELECT COUNT(*) AS n ${BASE_FROM} WHERE ${PERIOD_WHERE}`)
    .get(params).n;

  const totalHours = round2(withRank.reduce((s, c) => s + c.hours, 0) + (unassignedHours || 0));
  const totalDollars = round2(withRank.reduce((s, c) => s + c.dollars, 0) + (unassignedDollars || 0));

  console.log('[dashboard] --------------------------------------------------');
  console.log(`[dashboard] pay period   ${start} → ${end}${start === current.start ? '  (current)' : ''}`);
  console.log(
    `[dashboard] entries      ${countedEntries} counted ` +
      `(${unassignedEntries} with no caretaker, ${countedEntries - unassignedEntries} assigned)`
  );
  console.log(
    `[dashboard] caretakers   ${withRank.length} with hours` +
      (excluded ? `  (${excluded} excluded: client missing/archived or agreement gone)` : '')
  );
  console.log(`[dashboard] total        ${totalHours} hrs | $${totalDollars.toFixed(2)}`);
  for (const c of withRank) {
    console.log(
      `[dashboard]   #${c.rank} ${c.last_name}, ${c.first_name} — ${c.hours} hrs | ` +
        `$${c.dollars.toFixed(2)} | ${c.clients} client(s) | ${c.minutes} min`
    );
  }
  if (unassignedHours) {
    console.log(`[dashboard]   (unassigned) ${unassignedHours} hrs | $${unassignedDollars.toFixed(2)}`);
  }
  console.log('[dashboard] --------------------------------------------------');

  res.json({
    period: {
      start,
      end,
      is_current: start === current.start,
      prev_start: shiftPayPeriod({ start, end }, -1).start,
      next_start: shiftPayPeriod({ start, end }, 1).start,
    },
    caretakers: withRank,
    unassigned: {
      hours: unassignedHours,
      dollars: unassignedDollars,
      clients: unassigned?.clients ?? 0,
      entries: unassigned?.entries ?? 0,
    },
    totals: {
      hours: round2(withRank.reduce((s, c) => s + c.hours, 0) + (unassignedHours || 0)),
      dollars: round2(withRank.reduce((s, c) => s + c.dollars, 0) + (unassignedDollars || 0)),
      active_caretakers: withRank.length,
    },
    unassigned_entries: unassignedEntries,
    excluded_entries: excluded,
  });
});

/** GET /api/dashboard/recent-ra — the last 5 saved RA imports. */
router.get('/recent-ra', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM ra_imports ORDER BY id DESC LIMIT 5`)
    .all();

  const claimsFor = db.prepare(
    `SELECT id, claim_name, status, total_dollars
     FROM claims
     WHERE ra_import_id = ?
     ORDER BY id
     LIMIT 5`
  );

  res.json({
    imports: rows.map((r) => ({
      id: r.id,
      imported_at: r.imported_at,
      num_clients: r.num_clients,
      total_payment: round2(r.total_payment ?? 0),
      file_name: r.file_name,
      claims: claimsFor.all(r.id),
    })),
  });
});

/** GET /api/dashboard/recent-clients — the last 8 profiles opened. */
router.get('/recent-clients', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT rc.client_id, rc.viewed_at,
              c.first_name, c.last_name, c.middle_initial, c.archived
       FROM recent_clients rc
       JOIN clients c ON c.id = rc.client_id
       ORDER BY rc.viewed_at DESC, rc.id DESC
       LIMIT 8`
    )
    .all();
  res.json({ clients: rows });
});

export default router;
