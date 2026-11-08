import express from 'express';
import db from '../db.js';

const router = express.Router();

/**
 * A day entry is "orphaned" when it can no longer be reached through a valid,
 * active client:
 *
 *  - its `client_id` has no matching client row (the CASCADE on that foreign
 *    key should prevent this, so a hit here means the database was edited
 *    outside the app);
 *  - its client is archived, which hides it from every client-facing view;
 *  - its `claim_id` points at a claim that no longer exists.
 *
 * Foreign keys are ON, so the last two are rarely reachable — but this is the
 * report you reach for when the dashboard and the client list disagree.
 */
const ORPHAN_QUERY = `
  SELECT d.id, d.work_date, d.client_id, d.claim_id, d.caretaker_id, d.agreement_id,
         d.minutes_worked, d.dollars, d.source,
         cu.id IS NOT NULL AS client_exists,
         COALESCE(cu.archived, 0) AS client_archived,
         cu.first_name, cu.last_name,
         cl.id IS NOT NULL AS claim_exists,
         cl.claim_name, cl.source AS claim_source,
         a.id IS NOT NULL AS agreement_exists
  FROM day_entries d
  LEFT JOIN clients cu ON cu.id = d.client_id
  LEFT JOIN claims cl ON cl.id = d.claim_id
  LEFT JOIN agreements a ON a.id = d.agreement_id
  WHERE cu.id IS NULL
     OR COALESCE(cu.archived, 0) = 1
     OR (d.claim_id IS NOT NULL AND cl.id IS NULL)
      AND d.agency_id = @agency
  ORDER BY d.work_date, d.id
`;

/** Human-readable reasons, so the table can say what is wrong with each row. */
function problemsFor(row) {
  const out = [];
  if (!row.client_exists) out.push('Client no longer exists');
  else if (row.client_archived) out.push('Client is archived');
  if (row.claim_id != null && !row.claim_exists) out.push('Claim no longer exists');
  if (row.agreement_id != null && !row.agreement_exists) out.push('Agreement no longer exists');
  if (row.claim_id == null) out.push('Not on any claim');
  if (row.caretaker_id == null) out.push('No caretaker');
  return out;
}

const decorate = (row) => ({ ...row, problems: problemsFor(row) });

/** GET /api/admin/orphaned-entries — the full report. */
/**
 * GET /api/admin/claims-dump
 *
 * Every claim, grouped for reconciliation. READ-ONLY: this endpoint never
 * writes, so it is safe to run against live data while diagnosing.
 */
router.get('/claims-dump', (req, res) => {
  const rows = db
    .prepare(
      `SELECT cl.id, cl.ra_claim_number, cl.claim_name, cl.status, cl.source,
              cl.total_dollars, cl.paid_amount, cl.paid_date, cl.ra_import_id,
              cl.created_at, cl.period_start, cl.period_end, COALESCE(cl.archived,0) AS archived,
              cl.reversal_flag, cl.denial_status,
              c.first_name, c.last_name, c.ma_number,
              i.file_name, i.status AS import_status, i.total_payment AS import_payment
       FROM claims cl
       LEFT JOIN clients c ON c.id = cl.client_id
       LEFT JOIN ra_imports i ON i.id = cl.ra_import_id
           WHERE cl.agency_id = @agency
       ORDER BY cl.ra_import_id, cl.period_start, cl.id`
    )
    .all({ agency: req.agencyId });

  const claims = rows.map((r) => ({
    id: r.id,
    ra_claim_number: r.ra_claim_number,
    claim_name: r.claim_name,
    client_name: `${r.last_name ?? ''}, ${r.first_name ?? ''}`.replace(/^, |, $/g, ''),
    ma_number: r.ma_number,
    dos_start: r.period_start,
    dos_end: r.period_end,
    total_charge: r.total_dollars,
    paid_amount: r.paid_amount,
    status: r.status,
    source: r.source,
    ra_import_id: r.ra_import_id,
    created_at: r.created_at,
    archived: r.archived,
    file_name: r.file_name,
  }));

  // Group by import so a bad file shows up as a bad subtotal.
  const groups = [];
  const byImport = new Map();
  for (const c of claims) {
    const key = c.ra_import_id ?? 'none';
    if (!byImport.has(key)) {
      const g = {
        ra_import_id: c.ra_import_id,
        file_name: rows.find((r) => r.ra_import_id === c.ra_import_id)?.file_name ?? null,
        import_status: rows.find((r) => r.ra_import_id === c.ra_import_id)?.import_status ?? null,
        import_payment: rows.find((r) => r.ra_import_id === c.ra_import_id)?.import_payment ?? null,
        claims: [],
        subtotal_charge: 0,
        subtotal_paid: 0,
      };
      byImport.set(key, g);
      groups.push(g);
    }
    const g = byImport.get(key);
    g.claims.push(c);
    g.subtotal_charge += Number(c.total_charge) || 0;
    g.subtotal_paid += Number(c.paid_amount) || 0;
  }
  for (const g of groups) {
    g.subtotal_charge = Math.round(g.subtotal_charge * 100) / 100;
    g.subtotal_paid = Math.round(g.subtotal_paid * 100) / 100;
    g.count = g.claims.length;
    // The audit trail matters more than the number when they disagree.
    g.diff_vs_recorded =
      g.import_payment == null ? null : Math.round((g.subtotal_paid - g.import_payment) * 100) / 100;
  }

  const positive = claims.filter((c) => (Number(c.paid_amount) || 0) > 0);
  const negative = claims.filter((c) => (Number(c.paid_amount) || 0) < 0);

  res.json({
    generated_at: new Date().toISOString(),
    claims,
    groups,
    totals: {
      count: claims.length,
      archived: claims.filter((c) => c.archived).length,
      charge: Math.round(claims.reduce((s, c) => s + (Number(c.total_charge) || 0), 0) * 100) / 100,
      // every paid_amount, exactly as the Reports card computes it
      paid_all: Math.round(claims.reduce((s, c) => s + (Number(c.paid_amount) || 0), 0) * 100) / 100,
      paid_positive: Math.round(positive.reduce((s, c) => s + Number(c.paid_amount), 0) * 100) / 100,
      paid_negative: Math.round(negative.reduce((s, c) => s + Number(c.paid_amount), 0) * 100) / 100,
      paid_status_paid: Math.round(
        claims
          .filter((c) => c.status === 'Paid')
          .reduce((s, c) => s + (Number(c.paid_amount) || 0), 0) * 100
      ) / 100,
      positive_count: positive.length,
      negative_count: negative.length,
      // what the import records say the checks were worth
      import_recorded: Math.round(
        db.prepare(`SELECT COALESCE(SUM(total_payment), 0) AS s FROM ra_imports WHERE agency_id = ?`).get(req.agencyId).s * 100
      ) / 100,
    },
  });
});

router.get('/orphaned-entries', (req, res) => {
  const rows = db.prepare(ORPHAN_QUERY).all({ agency: req.agencyId }).map(decorate);
  res.json({
    entries: rows,
    count: rows.length,
    totals: {
      hours: Math.round((rows.reduce((s, r) => s + (r.minutes_worked || 0), 0) / 60) * 100) / 100,
      dollars: Math.round(rows.reduce((s, r) => s + (r.dollars || 0), 0) * 100) / 100,
    },
  });
});

/** GET /api/admin/orphaned-entries/count — a cheap badge count. */
router.get('/orphaned-entries/count', (req, res) => {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM day_entries d
       LEFT JOIN clients cu ON cu.id = d.client_id
       LEFT JOIN claims cl ON cl.id = d.claim_id
       WHERE cu.id IS NULL
          OR COALESCE(cu.archived, 0) = 1
          OR (d.claim_id IS NOT NULL AND cl.id IS NULL)
              AND d.agency_id = @agency`
    )
    .get({ agency: req.agencyId }).n;
  res.json({ count: n });
});

/**
 * POST /api/admin/orphaned-entries/cleanup
 *
 * Removes exactly the entries the report lists, and nothing else. Any entry
 * whose client exists and is not archived is preserved, including entries with
 * no claim and no caretaker — those are perfectly valid unclaimed days.
 */
router.post('/orphaned-entries/cleanup', (req, res) => {
  // Typed confirmation, matching the claim-delete flow.
  if ((req.body?.confirm ?? '') !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm this cleanup.' });
  }

  const before = db.prepare(`SELECT COUNT(*) AS n FROM day_entries WHERE agency_id = ?`).get(req.agencyId).n;
  const doomed = db.prepare(ORPHAN_QUERY).all({ agency: req.agencyId }).map((r) => r.id);

  let deleted = 0;
  db.transaction(() => {
    const remove = db.prepare(`DELETE FROM day_entries WHERE id = ? AND agency_id = ?`);
    for (const id of doomed) deleted += remove.run(id, req.agencyId).changes;
  })();

  res.json({ deleted, preserved: before - deleted });
});

export default router;
