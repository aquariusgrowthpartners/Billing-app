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
  LEFT JOIN clients cu ON cu.id = d.client_id AND cu.agency_id = d.agency_id
  LEFT JOIN claims cl ON cl.id = d.claim_id AND cl.agency_id = d.agency_id
  LEFT JOIN agreements a ON a.id = d.agreement_id AND a.agency_id = d.agency_id
  WHERE d.agency_id = @agency
    AND (cu.id IS NULL
      OR COALESCE(cu.archived, 0) = 1
      OR (d.claim_id IS NOT NULL AND cl.id IS NULL))
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

/** GET /api/admin/audit-data — platform data-integrity summary (Agency 1 only). */
router.get('/audit-data', (req, res) => {
  const user = req.user;
  const isSuperAdmin =
    user && ['admin', 'superadmin'].includes(user.role) &&
    (user.agency_id === 1 || user.role === 'superadmin');
  if (!isSuperAdmin) return res.status(403).json({ error: 'Super admin access is required.' });

  const count = (sql) => Number(db.prepare(sql).get()?.n ?? 0);
  const totalClients = count('SELECT COUNT(*) AS n FROM clients');
  const totalClaims = count('SELECT COUNT(*) AS n FROM claims');
  const totalRas = count('SELECT COUNT(*) AS n FROM ra_imports');
  const orphanedClaims = count(
    `SELECT COUNT(*) AS n
       FROM claims cl
       LEFT JOIN clients c ON c.id = cl.client_id AND c.agency_id = cl.agency_id
      WHERE c.id IS NULL`
  );

  res.json({
    total_clients: totalClients,
    total_claims: totalClaims,
    total_ras_processed: totalRas,
    orphaned_claims: orphanedClaims,
    generated_at: new Date().toISOString(),
  });
});

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
       LEFT JOIN clients c ON c.id = cl.client_id AND c.agency_id = cl.agency_id
       LEFT JOIN ra_imports i ON i.id = cl.ra_import_id AND i.agency_id = cl.agency_id
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
       LEFT JOIN clients cu ON cu.id = d.client_id AND cu.agency_id = d.agency_id
       LEFT JOIN claims cl ON cl.id = d.claim_id AND cl.agency_id = d.agency_id
       WHERE d.agency_id = @agency
         AND (cu.id IS NULL
           OR COALESCE(cu.archived, 0) = 1
           OR (d.claim_id IS NOT NULL AND cl.id IS NULL))`
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

/* ------------------------------------------------- import local workspace */

const IMPORT_PATH_COLUMNS = new Set([
  'pdf_path',
  'stored_path',
  'local_pdf_path',
  'generated_pdf_path',
  'document_path',
  'service_agreement_pdf_path',
]);

const IMPORT_DELETE_ORDER = [
  'rebill_tasks',
  'denied_line_items',
  'denied_claims',
  'day_entries',
  'claims',
  'task_checklist_items',
  'tasks',
  'agreements',
  'service_agreements',
  'ra_import_files',
  'ra_import_history',
  'ra_imports',
  'case_managers',
  'payers',
  'caretakers',
  'clients',
  'recent_clients',
];

/**
 * POST /api/admin/import-local
 *
 * One-time migration of a local JSON export into the authenticated admin's
 * agency. Every inserted row gets req.agencyId, and every internal id is
 * remapped so local ids can never collide with another tenant's rows.
 *
 * Refuses the Demo Agency outright. Existing data requires `mode: "replace"`
 * plus `confirm: "REPLACE"` so a second run cannot silently duplicate a
 * workspace.
 */
router.post('/import-local', (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'An administrator login is required.' });
  }
  const agency = db.prepare(`SELECT id, name FROM agencies WHERE id = ?`).get(req.agencyId);
  if (!agency) return res.status(404).json({ error: 'Agency not found.' });
  if (agency.name === 'Demo Agency') {
    return res.status(403).json({ error: 'Refusing to import real data into the Demo Agency.' });
  }

  const body = req.body ?? {};
  const data = body.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data object is required.' });
  }
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const dryRun = body.dryRun === true;

  if (mode === 'replace' && body.confirm !== 'REPLACE') {
    return res.status(400).json({ error: 'Replace mode requires confirm: "REPLACE".' });
  }

  const existing = db
    .prepare(`SELECT COUNT(*) AS n FROM clients WHERE agency_id = ?`)
    .get(req.agencyId).n;
  if (existing > 0 && mode !== 'replace') {
    return res.status(409).json({
      error:
        'This agency already has data. Re-run with --replace to wipe it first, or import into an empty agency.',
      existing_clients: existing,
    });
  }

  const colsOf = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const columnCache = new Map();
  const columns = (table) => {
    if (!columnCache.has(table)) columnCache.set(table, colsOf(table));
    return columnCache.get(table);
  };

  const insert = (table, row, overrides = {}) => {
    const targetCols = columns(table);
    const values = { ...row, ...overrides, agency_id: req.agencyId };
    delete values.id;
    for (const col of IMPORT_PATH_COLUMNS) {
      if (col in values) values[col] = null;
    }
    const keys = Object.keys(values).filter((k) => k !== 'id' && targetCols.has(k));
    if (!keys.length) throw new Error(`No importable columns for ${table}`);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys
      .map((k) => '@' + k)
      .join(',')})`;
    return Number(
      db.prepare(sql).run(Object.fromEntries(keys.map((k) => [k, values[k]]))).lastInsertRowid
    );
  };

  const rows = (table) => (Array.isArray(data[table]) ? data[table] : []);
  const maps = {};
  for (const t of [
    'case_managers',
    'payers',
    'caretakers',
    'clients',
    'service_agreements',
    'agreements',
    'ra_imports',
    'ra_import_files',
    'claims',
    'day_entries',
    'denied_claims',
    'denied_line_items',
    'rebill_tasks',
    'tasks',
    'task_checklist_items',
  ]) {
    maps[t] = new Map();
  }
  const map = (table, localId) => {
    if (localId == null) return null;
    return maps[table].get(Number(localId)) ?? null;
  };
  const mapRequired = (table, localId, label) => {
    const mapped = map(table, localId);
    if (mapped == null) throw new Error(`${label}: missing ${table} reference ${localId}`);
    return mapped;
  };

  const counts = {};
  const work = () => {
    if (mode === 'replace') {
      for (const table of IMPORT_DELETE_ORDER) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE agency_id = ?`).run(req.agencyId);
        } catch {
          /* table absent in this build */
        }
      }
    }

    for (const r of rows('case_managers')) {
      const id = insert('case_managers', r);
      maps.case_managers.set(Number(r.id), id);
      counts.case_managers = (counts.case_managers ?? 0) + 1;
    }
    for (const r of rows('payers')) {
      const id = insert('payers', r);
      maps.payers.set(Number(r.id), id);
      counts.payers = (counts.payers ?? 0) + 1;
    }
    for (const r of rows('caretakers')) {
      const id = insert('caretakers', r);
      maps.caretakers.set(Number(r.id), id);
      counts.caretakers = (counts.caretakers ?? 0) + 1;
    }
    for (const r of rows('clients')) {
      const id = insert('clients', r, { case_manager_id: map('case_managers', r.case_manager_id) });
      maps.clients.set(Number(r.id), id);
      counts.clients = (counts.clients ?? 0) + 1;
    }
    for (const r of rows('service_agreements')) {
      const id = insert('service_agreements', r, {
        client_id: mapRequired('clients', r.client_id, 'service_agreements'),
      });
      maps.service_agreements.set(Number(r.id), id);
      counts.service_agreements = (counts.service_agreements ?? 0) + 1;
    }
    for (const r of rows('agreements')) {
      const id = insert('agreements', r, {
        client_id: mapRequired('clients', r.client_id, 'agreements'),
        payer_id: map('payers', r.payer_id),
        service_agreement_id: map('service_agreements', r.service_agreement_id),
      });
      maps.agreements.set(Number(r.id), id);
      counts.agreements = (counts.agreements ?? 0) + 1;
    }
    for (const r of rows('ra_imports')) {
      const id = insert('ra_imports', r);
      maps.ra_imports.set(Number(r.id), id);
      counts.ra_imports = (counts.ra_imports ?? 0) + 1;
    }
    for (const r of rows('ra_import_files')) {
      const id = insert('ra_import_files', r, {
        ra_import_id: map('ra_imports', r.ra_import_id),
      });
      maps.ra_import_files.set(Number(r.id), id);
      counts.ra_import_files = (counts.ra_import_files ?? 0) + 1;
    }
    for (const r of rows('claims')) {
      const id = insert('claims', r, {
        client_id: mapRequired('clients', r.client_id, 'claims'),
        agreement_id: map('agreements', r.agreement_id),
        ra_import_id: map('ra_imports', r.ra_import_id),
      });
      maps.claims.set(Number(r.id), id);
      counts.claims = (counts.claims ?? 0) + 1;
    }
    for (const r of rows('day_entries')) {
      const id = insert('day_entries', r, {
        client_id: mapRequired('clients', r.client_id, 'day_entries'),
        agreement_id: map('agreements', r.agreement_id),
        caretaker_id: map('caretakers', r.caretaker_id),
        claim_id: map('claims', r.claim_id),
        ra_import_id: map('ra_imports', r.ra_import_id),
      });
      maps.day_entries.set(Number(r.id), id);
      counts.day_entries = (counts.day_entries ?? 0) + 1;
    }
    for (const r of rows('denied_claims')) {
      const id = insert('denied_claims', r, {
        client_id: map('clients', r.client_id),
        caretaker_id: map('caretakers', r.caretaker_id),
        original_claim_id: map('claims', r.original_claim_id),
        ra_import_id: map('ra_imports', r.ra_import_id),
      });
      maps.denied_claims.set(Number(r.id), id);
      counts.denied_claims = (counts.denied_claims ?? 0) + 1;
    }
    for (const r of rows('denied_line_items')) {
      const id = insert('denied_line_items', r, {
        denied_claim_id: mapRequired('denied_claims', r.denied_claim_id, 'denied_line_items'),
        client_id: map('clients', r.client_id),
        recovered_by_day_entry_id: map('day_entries', r.recovered_by_day_entry_id),
      });
      maps.denied_line_items.set(Number(r.id), id);
      counts.denied_line_items = (counts.denied_line_items ?? 0) + 1;
    }
    for (const r of rows('rebill_tasks')) {
      const id = insert('rebill_tasks', r, {
        denied_line_item_id: mapRequired(
          'denied_line_items',
          r.denied_line_item_id,
          'rebill_tasks'
        ),
        client_id: map('clients', r.client_id),
        caretaker_id: map('caretakers', r.caretaker_id),
      });
      maps.rebill_tasks.set(Number(r.id), id);
      counts.rebill_tasks = (counts.rebill_tasks ?? 0) + 1;
    }
    for (const r of rows('tasks')) {
      const id = insert('tasks', r, { caretaker_id: map('caretakers', r.caretaker_id) });
      maps.tasks.set(Number(r.id), id);
      counts.tasks = (counts.tasks ?? 0) + 1;
    }
    for (const r of rows('task_checklist_items')) {
      const id = insert('task_checklist_items', r, {
        task_id: mapRequired('tasks', r.task_id, 'task_checklist_items'),
      });
      maps.task_checklist_items.set(Number(r.id), id);
      counts.task_checklist_items = (counts.task_checklist_items ?? 0) + 1;
    }

    // Settings are identity/preferences, not table rows with ids. Upsert them
    // on top of the admin agency's existing config, never replacing the AI key.
    for (const r of rows('settings')) {
      const key = String(r.key ?? '').trim();
      if (!key || key === 'ai_api_key' || key.startsWith('ra_')) continue;
      db.prepare(
        `INSERT INTO settings (agency_id, key, value, updated_at)
         VALUES (?, ?, ?, COALESCE(?, datetime('now')))
         ON CONFLICT(agency_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      ).run(req.agencyId, key, r.value ?? null, r.updated_at ?? null);
      counts.settings = (counts.settings ?? 0) + 1;
    }
  };

  if (dryRun) {
    const preview = {};
    for (const table of Object.keys(maps)) preview[table] = rows(table).length;
    preview.settings = rows('settings').filter(
      (r) => r.key && r.key !== 'ai_api_key' && !String(r.key).startsWith('ra_')
    ).length;
    return res.json({ dry_run: true, target_agency: agency, mode, counts: preview });
  }

  try {
    db.transaction(work)();
    res.json({
      imported: true,
      target_agency: agency,
      mode,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    });
  } catch (err) {
    console.error(`[admin] local import failed: ${err.message}`);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

export default router;
