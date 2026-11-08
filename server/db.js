import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
 * Which database this process opens.
 *
 * DEMO_MODE is a hard guard: when it is on, the live database is never opened,
 * whatever BILLING_DB says. A public demo must not be able to read real client
 * PHI even if the deployment sets the wrong env var.
 */
const LIVE_DB = path.join(__dirname, '..', 'data', 'billing.db');
const DEMO_DB = path.join(__dirname, '..', 'data', 'demo.db');
const IS_DEMO = String(process.env.DEMO_MODE ?? '').toLowerCase() === 'true';

export const DEMO_MODE = IS_DEMO;

export const DB_PATH = IS_DEMO
  ? LIVE_DB === path.resolve(process.env.BILLING_DB ?? '')
    ? DEMO_DB // ignore a BILLING_DB that points at the live file
    : path.resolve(process.env.BILLING_DB ?? DEMO_DB)
  : process.env.BILLING_DB
    ? path.resolve(process.env.BILLING_DB)
    : LIVE_DB;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/*
 * Demo mode auto-seed.
 *
 * A fresh deployment with DEMO_MODE=true has no database, and every screen
 * would 500 on a missing table. Seeding here means the app boots correctly on
 * the first try with no manual step. The seeder runs as a child process: it is
 * a complete script that copies the live schema and fills synthetic rows, and
 * running it out-of-process keeps this module free of its imports.
 */
if (IS_DEMO && !fs.existsSync(DB_PATH)) {
  /*
   * Seeding happens at IMAGE BUILD time (see Dockerfile), which writes a
   * ready-made demo database to SEED_TEMPLATE. At runtime we only copy it into
   * the mounted volume.
   *
   * Running the seeder as a child process here was fragile: the volume can be
   * empty or awkwardly mounted, and a failure took the whole server down with a
   * bare "Command failed". Copying a file has none of those failure modes. The
   * child-process path stays only as a fallback for local runs without an image.
   */
  const template = path.join(__dirname, '..', 'seed', 'demo.db');
  console.log(`  demo mode   no database at ${DB_PATH}`);

  if (fs.existsSync(template)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.copyFileSync(template, DB_PATH);
    console.log(`  demo mode   copied prebuilt demo database from ${template}`);
  } else {
    console.log('  demo mode   no prebuilt database in the image — running the seeder');
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'seed-demo.js')], {
        env: { ...process.env, DEMO_DB: DB_PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      if (out) process.stdout.write(out);
    } catch (err) {
      if (err.stdout) process.stdout.write(String(err.stdout));
      if (err.stderr) process.stderr.write(String(err.stderr));
      console.error(`  demo mode   auto-seed FAILED: ${err.message}`);
      console.error('  demo mode   cannot continue without a database');
      process.exit(1);
    }
  }
}

export const db = new Database(DB_PATH);

// Local-first: durability + concurrency flags that suit a single-user desktop app.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Schema. Column names/order match the agreed spec exactly.
 *
 * day_entries.units / rate_per_unit / dollars are DENORMALIZED on purpose:
 * they snapshot the agreement terms at the moment the day was worked, so a
 * later rate change can never rewrite historical claims.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT    NOT NULL,
    last_name     TEXT    NOT NULL,
    dob           TEXT,
    ma_number     TEXT,
    notes         TEXT,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS payers (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    typical_days_to_pay  INTEGER,
    notes                TEXT
  );

  CREATE TABLE IF NOT EXISTS agreements (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id                 INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    agreement_number          TEXT,
    start_date                TEXT,
    end_date                  TEXT,
    authorized_units_per_week INTEGER,
    minutes_per_unit          INTEGER NOT NULL DEFAULT 15,
    rate_per_unit             REAL    NOT NULL DEFAULT 0,
    max_units_per_day         INTEGER,
    service_code              TEXT,
    payer_id                  INTEGER REFERENCES payers(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS day_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    agreement_id   INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
    work_date      TEXT    NOT NULL,
    minutes_worked INTEGER NOT NULL DEFAULT 0,
    units          INTEGER NOT NULL DEFAULT 0,
    rate_per_unit  REAL    NOT NULL DEFAULT 0,
    dollars        REAL    NOT NULL DEFAULT 0,
    notes          TEXT,
    claim_id       INTEGER REFERENCES claims(id) ON DELETE SET NULL,
    UNIQUE (client_id, work_date)
  );

  CREATE TABLE IF NOT EXISTS claims (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_name        TEXT,
    client_id         INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    agreement_id      INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
    period_start      TEXT,
    period_end        TEXT,
    total_units       INTEGER,
    total_dollars     REAL,
    status            TEXT NOT NULL DEFAULT 'Draft',
    submitted_date    TEXT,
    expected_pay_date TEXT,
    paid_date         TEXT,
    paid_amount       REAL,
    drive_file_id     TEXT,
    drive_link        TEXT,
    -- Realised payment slippage: paid_date minus expected_pay_date, in days.
    -- Negative means the payer paid early. Written when a paid_date is recorded
    -- so real payer lag can be averaged later.
    variance_days     INTEGER,
    -- Project-relative path to the claim's locally stored PDF, e.g.
    -- 'data/claims/Smith_123456789_20261005_20261011_01.pdf'.
    local_pdf_path    TEXT,
    -- Project-relative path to the PDF we generate from the claim's own data.
    -- Kept separate from local_pdf_path so a manual upload and a generated
    -- document can coexist instead of overwriting one another.
    generated_pdf_path TEXT,
    -- When the claim's totals were last re-aggregated from its day entries.
    last_regenerated_at TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Simple key/value store for app preferences (claim naming template, etc.).
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- People who coordinate a client's care. Assigned per client.
  CREATE TABLE IF NOT EXISTS case_managers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name   TEXT    NOT NULL,
    last_name    TEXT    NOT NULL,
    email        TEXT,
    phone        TEXT,
    organization TEXT,
    notes        TEXT,
    active       INTEGER NOT NULL DEFAULT 1
  );

  -- People who actually deliver the care. Recorded per day worked.
  CREATE TABLE IF NOT EXISTS caretakers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT    NOT NULL,
    last_name  TEXT    NOT NULL,
    npi_number TEXT,
    notes      TEXT,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_clients_name        ON clients (last_name, first_name);
  CREATE INDEX IF NOT EXISTS idx_clients_ma          ON clients (ma_number);
  CREATE INDEX IF NOT EXISTS idx_agreements_client   ON agreements (client_id);
  CREATE INDEX IF NOT EXISTS idx_day_entries_client  ON day_entries (client_id, work_date);
  CREATE INDEX IF NOT EXISTS idx_day_entries_date    ON day_entries (work_date);
  CREATE INDEX IF NOT EXISTS idx_day_entries_claim   ON day_entries (claim_id);
  CREATE INDEX IF NOT EXISTS idx_claims_client       ON claims (client_id, period_start);
  CREATE INDEX IF NOT EXISTS idx_claims_status       ON claims (status);
`);

/**
 * Additive migrations. These only ever ADD columns, so an existing database
 * keeps every row and no existing column changes shape. The original spec's
 * columns are untouched. Nothing here drops or recreates a table.
 *
 * `reference` is attempted as a real FOREIGN KEY first. SQLite does support
 * ADD COLUMN ... REFERENCES (verified), but an older build would reject it, so
 * it falls back to a plain INTEGER column — the relationship is then enforced
 * in application code instead.
 */
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

/**
 * Same, but with a foreign key where the SQLite build allows one.
 * Reports which form was used so the caller can log it.
 */
function addReferenceColumn(table, column, target, onDelete = 'SET NULL') {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (existing.includes(column)) return 'present';
  try {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER REFERENCES ${target}(id) ON DELETE ${onDelete}`
    );
    return 'foreign-key';
  } catch {
    // Older SQLite: fall back to a plain column, enforced in app code.
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
    return 'plain-integer';
  }
}

addColumnIfMissing('claims', 'variance_days', 'INTEGER');
addColumnIfMissing('claims', 'local_pdf_path', 'TEXT');
addColumnIfMissing('claims', 'generated_pdf_path', 'TEXT');
addColumnIfMissing('claims', 'last_regenerated_at', 'TEXT');

// Case managers are assigned to a client; caretakers are recorded per day.
const caseManagerColumn = addReferenceColumn('clients', 'case_manager_id', 'case_managers');
const caretakerColumn = addReferenceColumn('day_entries', 'caretaker_id', 'caretakers');

// HHAeXchange flat-file import fields.
addColumnIfMissing('payers', 'hhaechange_payer_id', 'TEXT');
addColumnIfMissing('clients', 'diagnosis_code', 'TEXT');
addColumnIfMissing('caretakers', 'ssn', 'TEXT');
addColumnIfMissing('caretakers', 'gender', 'TEXT');
// Date of birth is required by BOTH HHAeXchange exports and had no home before.
addColumnIfMissing('caretakers', 'dob', 'TEXT');
addColumnIfMissing('day_entries', 'start_time', 'TEXT');

// Soft delete. Archived clients keep every row; they just leave the default
// list. Separate from `active`, which means "not currently receiving services".
addColumnIfMissing('clients', 'archived', 'INTEGER NOT NULL DEFAULT 0');

/*
 * RA import identity, for duplicate detection.
 *
 * `file_hash` catches a byte-identical re-upload instantly. The three header
 * identifiers catch a REGENERATED copy of the same advice, where the bytes
 * differ but the batch is plainly the same.
 */
addColumnIfMissing('ra_imports', 'file_hash', 'TEXT');
addColumnIfMissing('ra_imports', 'check_eft_number', 'TEXT');
addColumnIfMissing('ra_imports', 'prod_date', 'TEXT');
addColumnIfMissing('ra_imports', 'vendor_number', 'TEXT');
addColumnIfMissing('ra_imports', 'claim_count', 'INTEGER DEFAULT 0');
addColumnIfMissing('ra_imports', 'denial_count', 'INTEGER DEFAULT 0');
addColumnIfMissing('ra_imports', 'status', "TEXT NOT NULL DEFAULT 'active'");

/*
 * One row per RA FILE (an import batch may carry several). The audit screen and
 * re-parse both work at this grain: a batch-level row hides which file failed.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS ra_import_files (
    id                INTEGER PRIMARY KEY,
    ra_import_id      INTEGER REFERENCES ra_imports(id) ON DELETE SET NULL,
    file_name         TEXT NOT NULL,
    stored_path       TEXT,
    file_hash         TEXT,
    check_date        TEXT,
    prod_date         TEXT,
    vendor_number     TEXT,
    check_eft_number  TEXT,
    payment_amount    REAL,
    forwarding_balance REAL,
    claim_count       INTEGER NOT NULL DEFAULT 0,
    denial_count      INTEGER NOT NULL DEFAULT 0,
    client_count      INTEGER NOT NULL DEFAULT 0,
    raw_char_count    INTEGER,
    status            TEXT NOT NULL DEFAULT 'active',
    note              TEXT,
    imported_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ra_import_files_hash ON ra_import_files (file_hash);
  CREATE INDEX IF NOT EXISTS idx_ra_import_files_import ON ra_import_files (ra_import_id);
`);

/*
 * One-off backfill: give every import at least one audit row.
 *
 * Imports made through the Import RA screen before this fix wrote no
 * ra_import_files rows at all, so the audit table showed nothing while the
 * claims were present. The original filenames survive in ra_imports.file_name
 * (comma-joined), so they are split back out into one row each.
 *
 * Per-file claim counts, check dates and the PDF badge are NOT recoverable for
 * these rows — the numbers were never recorded and the uploads predate storage.
 * They are marked with a note so the UI can say "unknown" rather than "0".
 */
if (db.prepare(`SELECT value FROM settings WHERE key = 'ra_files_backfill'`).get()?.value !== 'done') {
  const imports = db
    .prepare(
      `SELECT i.id, i.file_name, i.claim_count, i.imported_at
       FROM ra_imports i
       WHERE NOT EXISTS (SELECT 1 FROM ra_import_files f WHERE f.ra_import_id = i.id)`
    )
    .all();
  const insert = db.prepare(
    `INSERT INTO ra_import_files
       (ra_import_id, file_name, claim_count, denial_count, status, imported_at, note)
     VALUES (?, ?, 0, 0, 'active', ?, ?)`
  );
  let made = 0;
  for (const imp of imports) {
    const names = String(imp.file_name ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const list = names.length ? names : [`import #${imp.id}`];
    for (const name of list) {
      insert.run(
        imp.id,
        name,
        imp.imported_at ?? null,
        'backfilled from the legacy batch record; per-file counts, check date and PDF are not recoverable'
      );
      made += 1;
    }
  }
  if (made) console.log(`  migrations   backfilled ${made} RA file row(s)`);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ra_files_backfill', 'done')
     ON CONFLICT(key) DO UPDATE SET value = 'done'`
  ).run();
}

/*
 * One-off: older imports recorded every file of a batch in a single
 * comma-joined name, which hides which file failed. Split them into per-file
 * rows so the audit screen has one row per RA from the start.
 */
if (
  db.prepare(`SELECT value FROM settings WHERE key = 'ra_file_split'`).get()?.value !== 'done'
) {
  const legacy = db
    .prepare(`SELECT * FROM ra_imports WHERE file_name LIKE '%,%' OR file_name IS NOT NULL`)
    .all();
  const insert = db.prepare(
    `INSERT INTO ra_import_files
       (ra_import_id, file_name, file_hash, claim_count, denial_count, status, imported_at, note)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?)`
  );
  let made = 0;
  for (const row of legacy) {
    const already = db
      .prepare(`SELECT COUNT(*) AS n FROM ra_import_files WHERE ra_import_id = ?`)
      .get(row.id).n;
    if (already) continue;
    const names = String(row.file_name ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    for (const name of names) {
      insert.run(
        row.id,
        name,
        null,
        row.status ?? 'active',
        row.imported_at ?? null,
        'created from the legacy batch record; per-file counts are not known'
      );
      made += 1;
    }
  }
  if (made) console.log(`  migrations   split ${made} legacy RA file row(s)`);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ra_file_split', 'done')
     ON CONFLICT(key) DO UPDATE SET value = 'done'`
  ).run();
}

// The stored PDF for an import, so a re-parse never needs a re-upload.
// Relative on purpose: "ra_uploads/<hash>.pdf", never an absolute path.
addColumnIfMissing('ra_imports', 'pdf_path', 'TEXT');
addColumnIfMissing('ra_imports', 'updated_at', 'TEXT');

// A log of every re-parse, so a changed import is never silently different.
db.exec(`
  CREATE TABLE IF NOT EXISTS ra_import_history (
    id              INTEGER PRIMARY KEY,
    ra_import_id    INTEGER REFERENCES ra_imports(id) ON DELETE CASCADE,
    reparsed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    old_claim_count INTEGER,
    new_claim_count INTEGER,
    notes           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ra_import_history_import ON ra_import_history (ra_import_id);
`);

/*
 * Deletion log columns.
 *
 * ra_import_history.ra_import_id cascades on delete, so a row describing a
 * DELETED import must not point at it. The structured counts live here instead,
 * with ra_import_id left NULL for deletion records.
 */
addColumnIfMissing('ra_import_history', 'deleted_at', 'TEXT');
addColumnIfMissing('ra_import_history', 'import_ids', 'TEXT');
addColumnIfMissing('ra_import_history', 'claim_count_purged', 'INTEGER DEFAULT 0');
addColumnIfMissing('ra_import_history', 'day_entry_count_purged', 'INTEGER DEFAULT 0');
addColumnIfMissing('ra_import_history', 'denial_count_purged', 'INTEGER DEFAULT 0');

// The link that makes a clean overwrite possible: only rows carrying the id of
// the import being replaced are ever deleted.
addColumnIfMissing('denied_claims', 'ra_import_id', 'INTEGER');
addColumnIfMissing('day_entries', 'ra_import_id', 'INTEGER');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ra_imports_hash ON ra_imports (file_hash);
  CREATE INDEX IF NOT EXISTS idx_ra_imports_header
    ON ra_imports (check_eft_number, prod_date, vendor_number);
  CREATE INDEX IF NOT EXISTS idx_claims_ra_import ON claims (ra_import_id);
  CREATE INDEX IF NOT EXISTS idx_denied_claims_ra_import ON denied_claims (ra_import_id);
  CREATE INDEX IF NOT EXISTS idx_day_entries_ra_import ON day_entries (ra_import_id);
`);

/*
 * The raw ORIG REF NBR from a reversal, kept as text alongside the resolved
 * integer FK. The number is what the advice printed; the id only exists when we
 * happen to still hold the original claim.
 */
addColumnIfMissing('denied_claims', 'original_claim_number', 'TEXT');

/*
 * Whether a claim was fully understood at import time.
 *
 * 'layout_incomplete' means the advice's text layer was columnar, so the header
 * (and therefore the money) parsed but the service lines did not — the claim is
 * real and must be kept, but its DOS and line items are missing.
 */
addColumnIfMissing('claims', 'parse_status', "TEXT NOT NULL DEFAULT 'complete'");

// Denial / reversal tracking. These live ALONGSIDE a claim, never instead of
// one: a denied or reversed advice creates no claim and no day entries.
addColumnIfMissing('denied_line_items', 'recovery_status', 'TEXT');
addColumnIfMissing('claims', 'ra_claim_number', 'TEXT');
addColumnIfMissing('claims', 'denial_status', 'TEXT');
addColumnIfMissing('claims', 'reversal_flag', 'INTEGER DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS denied_claims (
    id                 INTEGER PRIMARY KEY,
    ra_claim_number    TEXT,
    client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name_raw    TEXT,
    caretaker_id       INTEGER REFERENCES caretakers(id) ON DELETE SET NULL,
    caretaker_npi_raw  TEXT,
    claim_status       TEXT,
    dos_start          TEXT,
    dos_end            TEXT,
    total_charge       REAL,
    total_payment      REAL,
    ra_prod_date       TEXT,
    source_filename    TEXT,
    original_claim_id  INTEGER REFERENCES claims(id) ON DELETE SET NULL,
    recovery_status    TEXT NOT NULL DEFAULT 'unrecovered',
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS denied_line_items (
    id                        INTEGER PRIMARY KEY,
    denied_claim_id           INTEGER NOT NULL REFERENCES denied_claims(id) ON DELETE CASCADE,
    -- denormalised from the parent so the recovery query can index on it
    client_id                 INTEGER,
    dos                       TEXT,
    procedure_code            TEXT,
    units                     REAL,
    minutes_worked            INTEGER,
    billed                    REAL,
    recovered                 INTEGER NOT NULL DEFAULT 0,
    -- 'written_off' when its rebill task was cleared outside the app
    recovery_status           TEXT,
    recovered_by_day_entry_id INTEGER REFERENCES day_entries(id) ON DELETE SET NULL,
    recovered_dos             TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rebill_tasks (
    id                   INTEGER PRIMARY KEY,
    denied_line_item_id  INTEGER NOT NULL REFERENCES denied_line_items(id) ON DELETE CASCADE,
    client_id            INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    caretaker_id         INTEGER REFERENCES caretakers(id) ON DELETE SET NULL,
    dos                  TEXT,
    procedure_code        TEXT,
    units                REAL,
    minutes_worked       INTEGER,
    billed               REAL,
    status               TEXT NOT NULL DEFAULT 'open',
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_denied_line_items_dos_client
    ON denied_line_items (dos, client_id);
  CREATE INDEX IF NOT EXISTS idx_rebill_tasks_status_client
    ON rebill_tasks (status, client_id);
  CREATE INDEX IF NOT EXISTS idx_claims_ra_claim_number
    ON claims (ra_claim_number);
  CREATE INDEX IF NOT EXISTS idx_denied_claims_claim_number
    ON denied_claims (ra_claim_number);
`);

// MPSMISC reporting fields. All nullable: a caretaker can be recorded before
// their payroll details are known, and the export flags what is missing.
addColumnIfMissing('caretakers', 'street_address', 'TEXT');
addColumnIfMissing('caretakers', 'city', 'TEXT');
addColumnIfMissing('caretakers', 'state', 'TEXT');
addColumnIfMissing('caretakers', 'zip', 'TEXT');
addColumnIfMissing('caretakers', 'phone', 'TEXT');
addColumnIfMissing('caretakers', 'hire_date', 'TEXT');
addColumnIfMissing('caretakers', 'termination_date', 'TEXT');
addColumnIfMissing('caretakers', 'hourly_wage_rate', 'REAL');
addColumnIfMissing('caretakers', 'union_member', 'INTEGER DEFAULT 0');
addColumnIfMissing('caretakers', 'dues_deducted', 'REAL DEFAULT 0');
addColumnIfMissing('caretakers', 'seiu_voluntary_dues', 'REAL DEFAULT 0');

// Which RA import created a claim, so the Home Dashboard can link to them.
addColumnIfMissing('claims', 'ra_import_id', 'INTEGER');

// Clients the user actually opened, newest first. Capped at 8 rows when read.
db.exec(`
  CREATE TABLE IF NOT EXISTS recent_clients (
    id        INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    viewed_at TEXT    NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recent_clients_client ON recent_clients(client_id);
`);

// One row per saved RA PDF, for the Home Dashboard's recent-submissions list.
db.exec(`
  CREATE TABLE IF NOT EXISTS ra_imports (
    id            INTEGER PRIMARY KEY,
    imported_at   TEXT    NOT NULL,
    num_clients   INTEGER NOT NULL DEFAULT 0,
    total_payment REAL,
    file_name     TEXT
  );
`);

// Optional middle initial, e.g. "Sarah E. N". Nullable: never required.
addColumnIfMissing('clients', 'middle_initial', 'TEXT');

// Where a record came from, so an RA re-import can safely replace only what it
// created and never touch anything the user entered by hand.
addColumnIfMissing('claims', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumnIfMissing('claims', 'archived', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('day_entries', 'source', "TEXT NOT NULL DEFAULT 'manual'");

/**
 * One-off backfill for data that the RA import created BEFORE the `source`
 * column existed. Without this, a re-import would treat the user's earlier
 * imports as hand-entered and refuse to replace them.
 *
 * day_entries is exact: `notes = 'Imported from RA'` is the marker this app
 * writes. Claims are inferred conservatively — only claims whose linked day
 * entries are ALL RA imports, so a claim built from manual calendar days can
 * never be mislabelled. Runs once, when the column is first created.
 */
if (addColumnIfMissing('day_entries', '_source_backfilled', 'INTEGER')) {
  const entries = db
    .prepare(
      `UPDATE day_entries SET source = 'ra_import'
       WHERE notes = 'Imported from RA' AND source <> 'ra_import'`
    )
    .run().changes;

  const claims = db
    .prepare(
      `UPDATE claims SET source = 'ra_import'
       WHERE source <> 'ra_import'
         AND id IN (SELECT claim_id FROM day_entries WHERE claim_id IS NOT NULL GROUP BY claim_id)
         AND id NOT IN (
           SELECT claim_id FROM day_entries
           WHERE claim_id IS NOT NULL AND source <> 'ra_import'
         )`
    )
    .run().changes;

  if (entries || claims) {
    console.log(`  backfilled   ${entries} RA day entries, ${claims} RA claims as source='ra_import'`);
  }
  db.exec('ALTER TABLE day_entries DROP COLUMN _source_backfilled');
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_clients_case_manager ON clients (case_manager_id);
  CREATE INDEX IF NOT EXISTS idx_day_entries_caretaker ON day_entries (caretaker_id);
  CREATE INDEX IF NOT EXISTS idx_caretakers_name ON caretakers (last_name, first_name);
  CREATE INDEX IF NOT EXISTS idx_case_managers_name ON case_managers (last_name, first_name);
`);

if (process.env.BILLING_MIGRATION_LOG !== '0') {
  console.log(
    `  migrations   clients.case_manager_id (${caseManagerColumn}), ` +
      `day_entries.caretaker_id (${caretakerColumn})`
  );
}

/** Seed defaults. INSERT OR IGNORE, so an existing value is never overwritten. */
function seedSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`
  ).run(key, value);
}

seedSetting('claim_name_template', '{last}_{ma}_{dos_start}_{dos_end}_{seq}');

/*
 * One-off backfill: any day entry sitting on an RA-imported claim is itself
 * RA-imported data, whatever its `source` says.
 *
 * Deleting such a claim removes its entries only when they are tagged
 * `ra_import`, so entries left untagged would survive a delete and linger as
 * orphans. Guarded so it runs exactly once.
 */
if (
  db.prepare(`SELECT value FROM settings WHERE key = 'ra_source_backfill'`).get()?.value !== 'done'
) {
  const tagged = db
    .prepare(
      `UPDATE day_entries
       SET source = 'ra_import'
       WHERE claim_id IS NOT NULL
         AND COALESCE(source, 'manual') <> 'ra_import'
         AND claim_id IN (SELECT id FROM claims WHERE source = 'ra_import')`
    )
    .run().changes;
  if (tagged) console.log(`  migrations   tagged ${tagged} day entr(y/ies) as ra_import`);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ra_source_backfill', 'done')
     ON CONFLICT(key) DO UPDATE SET value = 'done'`
  ).run();
}

/*
 * One-off backfill: drop RA import log rows whose claims have all been deleted.
 *
 * Deleting the last claim of an import removes its log row from now on, but
 * rows left behind by deletes made before that rule existed would keep showing
 * on the Home Dashboard. Guarded by a settings flag so it runs exactly once —
 * an import saved in future that happens to create no claims is left alone.
 */
if (
  db.prepare(`SELECT value FROM settings WHERE key = 'ra_import_orphan_sweep'`).get()?.value !== 'done'
) {
  const swept = db
    .prepare(
      `DELETE FROM ra_imports
       WHERE id NOT IN (SELECT DISTINCT ra_import_id FROM claims WHERE ra_import_id IS NOT NULL)`
    )
    .run().changes;
  if (swept) console.log(`  migrations   removed ${swept} orphaned RA import log row(s)`);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ra_import_orphan_sweep', 'done')
     ON CONFLICT(key) DO UPDATE SET value = 'done'`
  ).run();
}

// Agency identity used by the HHAeXchange exports. Seeded empty on purpose:
// a wrong Tax ID would be worse than a blank one, and the export validates it.
// Agency identity for the MPSMISC reporting spreadsheet.
seedSetting('agency_name', '');
seedSetting('agency_street_address', '');
seedSetting('agency_city', '');
seedSetting('agency_state', '');
seedSetting('agency_zip', '');
seedSetting('agency_tax_id', '');
seedSetting('office_npi', '');

/*
 * Demo AI key.
 *
 * A demo deployment should have working AI without anyone typing a key into the
 * UI. DEMO_AI_KEY in the environment is written into the demo database's
 * settings on every boot (it wins over whatever is stored), so rotating the key
 * is just a redeploy.
 *
 * Only ever runs in demo mode: this must never overwrite a real key.
 */
if (IS_DEMO) {
  const demoKey = String(process.env.DEMO_AI_KEY ?? '').trim();
  if (demoKey) {
    const provider = String(process.env.DEMO_AI_PROVIDER ?? 'deepseek').trim().toLowerCase();
    const set = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    set.run('ai_api_key', demoKey);
    set.run('ai_provider', ['deepseek', 'openai'].includes(provider) ? provider : 'deepseek');
    console.log(`  demo mode   AI key injected from DEMO_AI_KEY (${provider})`);
  }
}

export default db;
