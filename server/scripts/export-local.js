#!/usr/bin/env node
/**
 * Export the local Dundas workspace to a portable JSON file.
 *
 * The export is intentionally agency-agnostic: `agency_id` is stripped so the
 * import endpoint can attach every row to the authenticated admin's agency.
 * Internal row ids are kept so the importer can remap every foreign key.
 *
 *   node server/scripts/export-local.js
 *   LOCAL_DB=data/billing.db OUT=local-export.json node server/scripts/export-local.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const LOCAL_DB = path.resolve(process.env.LOCAL_DB ?? path.join(ROOT, 'data', 'billing.db'));
const OUT = path.resolve(process.env.OUT ?? path.join(ROOT, 'local-export.json'));

if (!fs.existsSync(LOCAL_DB)) {
  console.error(`  REFUSING: local database not found at ${LOCAL_DB}`);
  process.exit(1);
}

const db = new Database(LOCAL_DB, { readonly: true });

/**
 * Tables that make up a usable workspace, in dependency order. `settings` is
 * deliberately excluded: the cloud admin already has its own agency identity,
 * and an API key must never travel in a data export.
 */
const TABLES = [
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
];

// Local filesystem paths are meaningless on Railway. Null them so a restored
// row cannot point at a PDF that does not exist in the cloud volume.
const PATH_COLUMNS = new Set([
  'pdf_path',
  'stored_path',
  'local_pdf_path',
  'generated_pdf_path',
  'document_path',
  'service_agreement_pdf_path',
]);

const columnsOf = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const data = {};
const counts = {};

for (const table of TABLES) {
  const cols = columnsOf(table);
  if (!cols.length) {
    counts[table] = 0;
    continue;
  }
  const hasAgency = cols.includes('agency_id');
  const sql = hasAgency
    ? `SELECT * FROM ${table} WHERE agency_id = 1 ORDER BY id`
    : `SELECT * FROM ${table} ORDER BY id`;
  const rows = db.prepare(sql).all().map((row) => {
    const out = { ...row };
    delete out.agency_id;
    for (const col of PATH_COLUMNS) {
      if (col in out) out[col] = null;
    }
    return out;
  });
  data[table] = rows;
  counts[table] = rows.length;
}

db.close();

const payload = {
  format: 'billing-local-export-v1',
  exported_at: new Date().toISOString(),
  source_db: path.basename(LOCAL_DB),
  source_agency_id: 1,
  tables: TABLES,
  counts,
  data,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
const bytes = fs.statSync(OUT).size;
console.log(`  exported ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`);
console.log(`  counts: ${JSON.stringify(counts)}`);
console.log(`  file:   ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);
