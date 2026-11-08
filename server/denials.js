/**
 * Denial and reversal tracking.
 *
 * A denied or reversed advice is stored here INSTEAD of becoming a claim: it
 * creates no claim and no day entries, and therefore can never reach Reports,
 * the Home Dashboard, MPSMISC or the HHAeXchange exports.
 *
 * The recovery engine is the interesting half. When a denial is later worked
 * and rebilled successfully, a PAID advice arrives covering the same client,
 * date and procedure code. Matching the two is what turns "money lost" into
 * "money recovered".
 */
import db from './db.js';
import { round2, toISODate } from './calc.js';
import { classifyStatus } from './raImport.js';

/** "08-21-26" -> "2026-08-21" (the RA prints MM-DD-YY). */
const prodDate = (raw) => (raw ? toISODate(raw) : null);

/**
 * Store one denied/reversed advice block.
 *
 * Returns the new denied_claims id, or null when there is nothing to store.
 */
export function saveDeniedBlock({
  block,
  sourceFilename = null,
  clientId = null,
  caretakerId = null,
  originalClaimId = null,
  raImportId = null,
  agencyId = null,
}) {
  const status = classifyStatus(block.claim_status);
  const items = Array.isArray(block.line_items) ? block.line_items : [];
  const dates = items.map((i) => i.date).filter(Boolean).sort();
  // The claim-level code is the first line that carries one. Lines are already
  // ordered by date, so this is stable across re-imports.
  const claimAdjustment =
    items.find((i) => i.adjustment_code)?.adjustment_code ?? null;

  const info = db
    .prepare(
      `INSERT INTO denied_claims
         (ra_claim_number, client_id, client_name_raw, caretaker_id, caretaker_npi_raw,
          claim_status, dos_start, dos_end, total_charge, total_payment, ra_prod_date,
          source_filename, original_claim_id, recovery_status, ra_import_id,
          adjustment_code, agency_id)
       VALUES
         (@claim_number, @client_id, @client_name_raw, @caretaker_id, @npi,
          @status, @dos_start, @dos_end, @charge, @payment, @prod,
          @file, @original, 'unrecovered', @ra_import_id,
          @adjustment, @agency)`
    )
    .run({
      claim_number: block.claim_number ?? null,
      client_id: clientId,
      client_name_raw: block.client_name ?? null,
      caretaker_id: caretakerId,
      npi: block.rendered_provider_id ?? null,
      status,
      dos_start: block.dos_start ?? dates[0] ?? null,
      dos_end: block.dos_end ?? dates[dates.length - 1] ?? null,
      charge: block.total_charge ?? null,
      payment: block.total_payment ?? null,
      prod: prodDate(block.ra_prod_date),
      file: sourceFilename,
      original: originalClaimId,
      ra_import_id: raImportId,
      adjustment: claimAdjustment,
      agency: agencyId ?? 1,
    });

  const deniedId = Number(info.lastInsertRowid);
  const insertItem = db.prepare(
    `INSERT INTO denied_line_items
       (denied_claim_id, client_id, dos, procedure_code, units, minutes_worked, billed,
        adjustment_code, agency_id)
     VALUES (@denied, @client, @dos, @code, @units, @minutes, @billed, @adjustment, @agency)`
  );
  for (const li of items) {
    insertItem.run({
      denied: deniedId,
      client: clientId,
      dos: li.date ?? null,
      code: li.procedure_code ?? null,
      units: li.units ?? null,
      minutes: li.minutes_worked ?? null,
      billed: li.billed ?? null,
      adjustment: li.adjustment_code ?? null,
      agency: agencyId ?? 1,
    });
  }

  ensureRebillTasks(agencyId);
  updateRecoveryStatuses(agencyId);
  return deniedId;
}

/**
 * A rebill task exists for every unrecovered line item, so the work is visible
 * as a to-do rather than only as an archive row.
 */
export function ensureRebillTasks(agencyId) {
  const scoped = Number.isInteger(agencyId);
  const missing = db
    .prepare(
      `SELECT i.id, i.client_id, i.dos, i.procedure_code, i.units, i.minutes_worked, i.billed,
              c.caretaker_id
       FROM denied_line_items i
       JOIN denied_claims c ON c.id = i.denied_claim_id
       WHERE i.recovered = 0
         AND COALESCE(i.recovery_status, '') <> 'written_off'
         ${scoped ? 'AND c.agency_id = ?' : ''}
         AND NOT EXISTS (SELECT 1 FROM rebill_tasks t WHERE t.denied_line_item_id = i.id)`
    )
    .all(...(scoped ? [agencyId] : []));

  const insert = db.prepare(
    `INSERT INTO rebill_tasks
       (denied_line_item_id, client_id, caretaker_id, dos, procedure_code, units,
        minutes_worked, billed, status, agency_id)
     VALUES (@item, @client, @caretaker, @dos, @code, @units, @minutes, @billed, 'open', @agency)`
  );
  const run = db.transaction(() => {
    for (const m of missing) {
      insert.run({
        item: m.id,
        client: m.client_id,
        caretaker: m.caretaker_id ?? null,
        dos: m.dos,
        code: m.procedure_code,
        units: m.units,
        minutes: m.minutes_worked,
        billed: m.billed,
        agency: agencyId ?? 1,
      });
    }
  });
  run();
  return missing.length;
}

/**
 * Match unrecovered denials against day entries that belong to a PAID claim.
 *
 * The claim check matters: an entry on a still-unpaid claim has not been
 * rebilled successfully, so it must not count as a recovery.
 */
export function runRecovery(agencyId) {
  const scoped = Number.isInteger(agencyId);
  const open = db
    .prepare(
      `SELECT i.id, i.denied_claim_id, i.client_id, i.dos, i.procedure_code
       FROM denied_line_items i
       WHERE i.recovered = 0
         AND i.client_id IS NOT NULL
         AND i.dos IS NOT NULL
         AND i.procedure_code IS NOT NULL
         ${scoped ? 'AND i.agency_id = ?' : ''}`
    )
    .all(...(scoped ? [agencyId] : []));

  const find = db.prepare(
    `SELECT d.id, d.work_date
     FROM day_entries d
     JOIN claims c ON c.id = d.claim_id
     WHERE d.client_id = @client
       AND d.work_date = @dos
       AND COALESCE(c.archived, 0) = 0
       AND c.status = 'Paid'
       AND NOT EXISTS (
         SELECT 1 FROM denied_line_items x WHERE x.recovered_by_day_entry_id = d.id
       )
     ORDER BY d.id
     LIMIT 1`
  );

  const mark = db.prepare(
    `UPDATE denied_line_items
     SET recovered = 1, recovered_by_day_entry_id = @entry, recovered_dos = @dos
     WHERE id = @id`
  );
  const closeTask = db.prepare(
    `UPDATE rebill_tasks
     SET status = 'paid', resolved_at = datetime('now'), updated_at = datetime('now')
     WHERE denied_line_item_id = ? AND status <> 'written_off'`
  );

  let recovered = 0;
  db.transaction(() => {
    for (const item of open) {
      const hit = find.get(scoped
          ? { client: item.client_id, dos: item.dos, agency: agencyId }
          : { client: item.client_id, dos: item.dos });
      if (!hit) continue;
      mark.run({ id: item.id, entry: hit.id, dos: hit.work_date });
      closeTask.run(item.id);
      recovered += 1;
    }
  })();
  if (recovered) updateRecoveryStatuses(agencyId);
  return recovered;
}

/** Roll each denied claim's status up from its line items. */
export function updateRecoveryStatuses(agencyId) {
  const scoped = Number.isInteger(agencyId);
  const rows = db
    .prepare(
      `SELECT c.id,
              COUNT(i.id) AS total,
              SUM(CASE WHEN i.recovered = 1 THEN 1 ELSE 0 END) AS done
       FROM denied_claims c
       LEFT JOIN denied_line_items i ON i.denied_claim_id = c.id
       WHERE 1 = 1 ${scoped ? 'AND c.agency_id = ?' : ''}
       GROUP BY c.id`
    )
    .all(...(scoped ? [agencyId] : []));
  const set = db.prepare(`UPDATE denied_claims SET recovery_status = ? WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      const status = r.total === 0 ? 'pending' : r.done === 0 ? 'unrecovered' : r.done === r.total ? 'recovered' : 'partial';
      set.run(status, r.id);
    }
  })();
}

/** Open rebill tasks — the badge count and the Home alert both use this. */
/** Everything a denial delete removes, counted before it goes. */
export function denialDeleteCounts(ids, agencyId) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) return { denials: 0, line_items: 0, rebill_tasks: 0, found_ids: [] };
  const ph = list.map(() => '?').join(',');
  const scoped = Number.isInteger(agencyId);
  const denials = (scoped
    ? db.prepare(`SELECT id FROM denied_claims WHERE id IN (${ph}) AND agency_id = ?`).all(...list, agencyId)
    : db.prepare(`SELECT id FROM denied_claims WHERE id IN (${ph})`).all(...list)
  ).map((r) => r.id);
  if (!denials.length) return { denials: 0, line_items: 0, rebill_tasks: 0, found_ids: [] };
  const dph = denials.map(() => '?').join(',');
  const items = db
    .prepare(`SELECT id FROM denied_line_items WHERE denied_claim_id IN (${dph})`)
    .all(...denials)
    .map((r) => r.id);
  let tasks = 0;
  if (items.length) {
    const iph = items.map(() => '?').join(',');
    tasks = db
      .prepare(`SELECT COUNT(*) AS n FROM rebill_tasks WHERE denied_line_item_id IN (${iph})`)
      .get(...items).n;
  }
  return { denials: denials.length, line_items: items.length, rebill_tasks: tasks, found_ids: denials };
}

/**
 * Remove denial tracking records.
 *
 * Nothing here can reach a claim, a day entry or any revenue figure — it only
 * clears the archive. A line item that was recovered stays recovered on its day
 * entry; the link simply goes away with the record.
 */
export function deleteDenials(ids, agencyId) {
  const counts = denialDeleteCounts(ids, agencyId);
  if (!counts.found_ids.length) return { ...counts, deleted: 0 };
  const ph = counts.found_ids.map(() => '?').join(',');
  const scoped = Number.isInteger(agencyId);
  db.prepare(
    scoped
      ? `DELETE FROM denied_claims WHERE id IN (${ph}) AND agency_id = ?`
      : `DELETE FROM denied_claims WHERE id IN (${ph})`
  ).run(...(scoped ? [...counts.found_ids, agencyId] : counts.found_ids));
  // denied_line_items and rebill_tasks cascade from the parent row
  return {
    deleted_denial: counts.denials,
    deleted_line_items: counts.line_items,
    deleted_rebill_tasks: counts.rebill_tasks,
    found_ids: counts.found_ids,
  };
}

/** Clear one rebill task, marking its line item written off first. */
export function deleteRebillTask(id, agencyId) {
  const scoped = Number.isInteger(agencyId);
  const task = (scoped
    ? db.prepare(`SELECT * FROM rebill_tasks WHERE id = ? AND agency_id = ?`).get(Number(id), agencyId)
    : db.prepare(`SELECT * FROM rebill_tasks WHERE id = ?`).get(Number(id)));
  if (!task) return null;
  db.transaction(() => {
    db.prepare(
      `UPDATE denied_line_items SET recovery_status = 'written_off' WHERE id = ?`
    ).run(task.denied_line_item_id);
    db.prepare(
      scoped ? `DELETE FROM rebill_tasks WHERE id = ? AND agency_id = ?`
             : `DELETE FROM rebill_tasks WHERE id = ?`
    ).run(...(scoped ? [task.id, agencyId] : [task.id]));
  })();
  return { deleted_rebill_task: 1, denied_line_item_id: task.denied_line_item_id };
}

/**
 * An import whose claims and denials have all been deleted is not wrong, just
 * empty. Marking it lets the audit screen say "No claims on file" rather than
 * quoting totals for data that no longer exists.
 *
 * Only ACTIVE rows are touched: an import already marked overwritten keeps
 * that status, which carries more meaning.
 */
export function markOrphanedImports(agencyId) {
  const scoped = Number.isInteger(agencyId);
  const rows = db
    .prepare(
      `SELECT i.id,
              (SELECT COUNT(*) FROM claims c WHERE c.ra_import_id = i.id) AS claims,
              (SELECT COUNT(*) FROM denied_claims d WHERE d.ra_import_id = i.id) AS denials
       FROM ra_imports i
       WHERE i.status = 'active'${scoped ? ' AND i.agency_id = ?' : ''}`
    )
    .all(...(scoped ? [agencyId] : []));
  const orphan = rows.filter((r) => r.claims === 0 && r.denials === 0);
  if (!orphan.length) return [];
  const mark = db.prepare(`UPDATE ra_imports SET status = 'orphaned' WHERE id = ?`);
  db.transaction(() => {
    for (const r of orphan) mark.run(r.id);
  })();
  console.log(`[denials] marked ${orphan.length} import(s) orphaned: ${orphan.map((r) => r.id).join(', ')}`);
  return orphan.map((r) => r.id);
}

export function openTaskCount(agencyId) {
  if (Number.isInteger(agencyId)) {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM rebill_tasks WHERE status = 'open' AND agency_id = ?`)
      .get(agencyId).n;
  }
  return db.prepare(`SELECT COUNT(*) AS n FROM rebill_tasks WHERE status = 'open'`).get().n;
}

/**
 * Startup reconciliation: retry every historical denial once, so an import that
 * happened before the rebill landed still gets credited.
 */
export function reconcileOnStartup() {
  ensureRebillTasks();
  const recovered = runRecovery();
  updateRecoveryStatuses();
  return { recovered, open_tasks: openTaskCount() };
}

export default {
  saveDeniedBlock,
  ensureRebillTasks,
  runRecovery,
  updateRecoveryStatuses,
  openTaskCount,
  denialDeleteCounts,
  deleteDenials,
  deleteRebillTask,
  reconcileOnStartup,
};
