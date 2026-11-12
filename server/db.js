import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hashPassword } from './auth.js';
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
function seedDemoDatabase() {
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

/**
 * A demo volume can outlive the image that created it. When the migration that
 * added `agency_id` landed, an older `/app/data/demo.db` kept booting and every
 * tenant query then failed with "no such column". Detect that stale schema
 * before opening the database and rebuild it from the current image seed.
 */
function demoSchemaIsStale(dbPath) {
  // Every table that must carry the tenant key. A volume can predate a later
  // migration (the original bug was rebill_tasks; settings was the second one),
  // so check each table rather than trusting the file's age.
  const REQUIRED = [
    ['rebill_tasks', 'agency_id'],
    ['settings', 'agency_id'],
  ];
  let probe = null;
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    for (const [table, column] of REQUIRED) {
      const cols = probe.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(column)) return true;
    }
    return false;
  } catch {
    // Unreadable, empty, or missing table: all mean "rebuild it".
    return true;
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

if (IS_DEMO) {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  demo mode   no database at ${DB_PATH}`);
    seedDemoDatabase();
  } else if (demoSchemaIsStale(DB_PATH)) {
    console.warn(
      `  demo mode   stale demo schema at ${DB_PATH} (missing tenant columns) — reseeding`
    );
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
    seedDemoDatabase();
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
  CREATE TABLE IF NOT EXISTS agencies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    logo_url   TEXT,
    ai_quick_prompts TEXT,
    is_demo    INTEGER NOT NULL DEFAULT 0,
    baa_signed_at TEXT,
    baa_signed_name TEXT,
    baa_signed_ip TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_id     INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','member')),
    onboarding_checklist TEXT,
    tutorial_completed INTEGER NOT NULL DEFAULT 0,
    totp_secret   TEXT,
    totp_enabled  INTEGER NOT NULL DEFAULT 0,
    totp_recovery_codes TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT    NOT NULL,
    last_name     TEXT    NOT NULL,
    dob           TEXT,
    ma_number     TEXT,
    notes         TEXT,
    alternative_names TEXT,
    case_manager_name TEXT,
    case_manager_phone TEXT,
    case_manager_email TEXT,
    is_stub       INTEGER NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1,
    agency_id     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS payers (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    typical_days_to_pay  INTEGER,
    notes                TEXT,
    agency_id            INTEGER NOT NULL DEFAULT 1
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
    payer_id                  INTEGER REFERENCES payers(id) ON DELETE SET NULL,
    dhs_service_agreement_num TEXT,
    service_code_with_modifier TEXT,
    service_agreement_pdf_path TEXT,
    authorized_total_amount   REAL,
    service_agreement_id      INTEGER REFERENCES service_agreements(id) ON DELETE SET NULL,
    superseded_at             TEXT,
    procedure_description     TEXT,
    modifier_1                TEXT,
    modifier_2                TEXT,
    modifier_3                TEXT,
    modifier_4                TEXT,
    total_units               REAL,
    agency_id                 INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS service_agreements (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id                 INTEGER NOT NULL REFERENCES clients(id),
    dhs_service_agreement_num TEXT    NOT NULL,
    hhaexchange_auth_number   TEXT,
    effective_date            TEXT,
    through_date              TEXT,
    icd10_code                TEXT,
    pdf_path                  TEXT,
    uploaded_at               TEXT,
    case_manager_name         TEXT,
    case_manager_phone        TEXT,
    case_manager_email        TEXT,
    agency_id                 INTEGER NOT NULL DEFAULT 1,
    UNIQUE(client_id, dhs_service_agreement_num)
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
    agency_id      INTEGER NOT NULL DEFAULT 1,
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
    -- Structured RA values for audit and Pre-Check. client_id remains canonical.
    client_name_raw   TEXT,
    member_id         TEXT,
    date_of_service   TEXT,
    charge_amount     REAL,
    procedure_code    TEXT,
    patient_control_number TEXT,
    expected_payment  REAL,
    claim_status_code TEXT,
    ra_import_id      INTEGER,
    agency_id         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ra_imports (
    id             INTEGER PRIMARY KEY,
    imported_at    TEXT    NOT NULL,
    num_clients    INTEGER NOT NULL DEFAULT 0,
    total_payment  REAL,
    file_name      TEXT,
    file_hash      TEXT,
    check_eft_number TEXT,
    prod_date      TEXT,
    vendor_number  TEXT,
    claim_count    INTEGER DEFAULT 0,
    denial_count   INTEGER DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'active',
    pdf_path       TEXT,
    updated_at     TEXT,
    agency_id      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ra_import_files (
    id                 INTEGER PRIMARY KEY,
    ra_import_id       INTEGER REFERENCES ra_imports(id) ON DELETE SET NULL,
    file_name          TEXT NOT NULL,
    stored_path        TEXT,
    file_hash          TEXT,
    check_date         TEXT,
    prod_date          TEXT,
    vendor_number      TEXT,
    check_eft_number   TEXT,
    payment_amount     REAL,
    forwarding_balance REAL,
    claim_count        INTEGER NOT NULL DEFAULT 0,
    denial_count       INTEGER NOT NULL DEFAULT 0,
    client_count       INTEGER NOT NULL DEFAULT 0,
    raw_char_count     INTEGER,
    status             TEXT NOT NULL DEFAULT 'active',
    note               TEXT,
    imported_at        TEXT NOT NULL DEFAULT (datetime('now')),
    agency_id          INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ra_import_history (
    id                       INTEGER PRIMARY KEY,
    ra_import_id             INTEGER REFERENCES ra_imports(id) ON DELETE CASCADE,
    reparsed_at              TEXT NOT NULL DEFAULT (datetime('now')),
    old_claim_count          INTEGER,
    new_claim_count          INTEGER,
    notes                    TEXT,
    deleted_at               TEXT,
    import_ids               TEXT,
    claim_count_purged       INTEGER DEFAULT 0,
    day_entry_count_purged   INTEGER DEFAULT 0,
    denial_count_purged      INTEGER DEFAULT 0,
    agency_id                INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS denied_claims (
    id                  INTEGER PRIMARY KEY,
    ra_claim_number     TEXT,
    client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name_raw     TEXT,
    caretaker_id        INTEGER REFERENCES caretakers(id) ON DELETE SET NULL,
    caretaker_npi_raw   TEXT,
    claim_status        TEXT,
    dos_start           TEXT,
    dos_end             TEXT,
    total_charge        REAL,
    total_payment       REAL,
    ra_prod_date        TEXT,
    source_filename     TEXT,
    original_claim_id   INTEGER REFERENCES claims(id) ON DELETE SET NULL,
    recovery_status     TEXT NOT NULL DEFAULT 'unrecovered',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    ra_import_id        INTEGER,
    original_claim_number TEXT,
    adjustment_code     TEXT,
    agency_id           INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS denied_line_items (
    id                        INTEGER PRIMARY KEY,
    denied_claim_id           INTEGER NOT NULL REFERENCES denied_claims(id) ON DELETE CASCADE,
    client_id                 INTEGER,
    dos                       TEXT,
    procedure_code            TEXT,
    units                     REAL,
    minutes_worked            INTEGER,
    billed                    REAL,
    recovered                 INTEGER NOT NULL DEFAULT 0,
    recovered_by_day_entry_id INTEGER REFERENCES day_entries(id) ON DELETE SET NULL,
    recovered_dos             TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    recovery_status           TEXT,
    adjustment_code           TEXT,
    agency_id                 INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS rebill_tasks (
    id                   INTEGER PRIMARY KEY,
    denied_line_item_id  INTEGER NOT NULL REFERENCES denied_line_items(id) ON DELETE CASCADE,
    client_id            INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    caretaker_id         INTEGER REFERENCES caretakers(id) ON DELETE SET NULL,
    dos                  TEXT,
    procedure_code       TEXT,
    units                REAL,
    minutes_worked       INTEGER,
    billed               REAL,
    status               TEXT NOT NULL DEFAULT 'open',
    notes                TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at          TEXT,
    agency_id            INTEGER NOT NULL DEFAULT 1
  );

  -- Simple key/value store for app preferences (claim naming template, etc.).
  CREATE TABLE IF NOT EXISTS settings (
    agency_id  INTEGER NOT NULL DEFAULT 1 REFERENCES agencies(id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,
    value      TEXT,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agency_id, key)
  );

  -- People who coordinate a client's care. Assigned per client.
  CREATE TABLE IF NOT EXISTS ra_verification_jobs (
    id               TEXT PRIMARY KEY,
    agency_id        INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    total_files      INTEGER NOT NULL DEFAULT 0,
    processed_files  INTEGER NOT NULL DEFAULT 0,
    results_json     TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ra_verification_jobs_agency_created
    ON ra_verification_jobs (agency_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS case_managers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name   TEXT    NOT NULL,
    last_name    TEXT    NOT NULL,
    email        TEXT,
    phone        TEXT,
    organization TEXT,
    notes        TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    agency_id    INTEGER NOT NULL DEFAULT 1
  );

  -- People who actually deliver the care. Recorded per day worked.
  CREATE TABLE IF NOT EXISTS caretakers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT    NOT NULL,
    last_name  TEXT    NOT NULL,
    npi_number TEXT,
    notes      TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    status     TEXT    NOT NULL DEFAULT 'Active',
    dl_number  TEXT,
    agency_id  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'general' CHECK (type IN ('new_hire','general')),
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
    due_date     TEXT,
    caretaker_id INTEGER REFERENCES caretakers(id),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    ai_summary   TEXT,
    agency_id    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS task_checklist_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label         TEXT    NOT NULL,
    is_completed  INTEGER NOT NULL DEFAULT 0,
    document_path TEXT,
    completed_at  TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    agency_id     INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_clients_name        ON clients (last_name, first_name);
  CREATE INDEX IF NOT EXISTS idx_clients_ma          ON clients (ma_number);
  CREATE INDEX IF NOT EXISTS idx_agreements_client   ON agreements (client_id);
  CREATE INDEX IF NOT EXISTS idx_day_entries_client  ON day_entries (client_id, work_date);
  CREATE INDEX IF NOT EXISTS idx_day_entries_date    ON day_entries (work_date);
  CREATE INDEX IF NOT EXISTS idx_day_entries_claim   ON day_entries (claim_id);
  CREATE INDEX IF NOT EXISTS idx_claims_client       ON claims (client_id, period_start);
  CREATE INDEX IF NOT EXISTS idx_claims_status       ON claims (status);
  CREATE INDEX IF NOT EXISTS idx_claims_pending_reconciliation ON claims (agency_id, status, client_id, period_start, period_end);
`);

/*
 * Tenant zero. Settings and migration flags use agency_id = 1, so a brand-new
 * database needs that row before any settings write. On an existing database
 * this is a no-op; the real Dundas agency keeps its existing id/name.
 */
if (!db.prepare(`SELECT 1 FROM agencies WHERE id = 1`).get()) {
  db.prepare(`INSERT INTO agencies (id, name) VALUES (1, 'Dundas Home Care LLC')`).run();
  console.log('  tenants      default agency created (id 1)');
}

/**
 * Settings became per-agency. SQLite cannot change a primary key in place, so
 * an existing single-column-key table is rebuilt once, preserving every row as
 * Agency 1. New databases already have the composite key from CREATE TABLE.
 */
function migrateSettingsToAgency() {
  const cols = db.prepare(`PRAGMA table_info(settings)`).all().map((c) => c.name);
  if (cols.includes('agency_id')) return false;

  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS settings_new;
      CREATE TABLE settings_new (
        agency_id  INTEGER NOT NULL DEFAULT 1,
        key        TEXT    NOT NULL,
        value      TEXT,
        updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agency_id, key),
        FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE
      );
      INSERT INTO settings_new (agency_id, key, value, updated_at)
      SELECT 1, key, value, updated_at FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  })();
  console.log('  migrations   settings are now per-agency');
  return true;
}

migrateSettingsToAgency();

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
  // A fresh database creates tables in stages; a migration aimed at a table
  // that has not been created yet is simply a no-op.
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table)) {
    return false;
  }
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
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table)) {
    return 'missing-table';
  }
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

/*
 * Bring an older single-tenant database up to the tenant schema. Every table
 * that carries tenant rows gets agency_id (default 1, which is the original
 * Dundas workspace). Existing rows are therefore preserved and owned by the
 * real tenant, never by the public demo.
 */
for (const table of [
  'clients',
  'payers',
  'agreements',
  'day_entries',
  'claims',
  'case_managers',
  'caretakers',
  'service_agreements',
  'tasks',
  'task_checklist_items',
  'ra_imports',
  'ra_import_files',
  'ra_import_history',
  'denied_claims',
  'denied_line_items',
  'rebill_tasks',
  'recent_clients',
]) {
  addColumnIfMissing(table, 'agency_id', 'INTEGER NOT NULL DEFAULT 1');
}

// Service-coding columns the RA importer and UI have always expected.
addColumnIfMissing('day_entries', 'service_code', 'TEXT');
addColumnIfMissing('day_entries', 'modifier', 'TEXT');

/*
 * Forced password change for the bootstrap admin. The column is added once;
 * when that happens on an existing deployment, mark the real admin so the
 * temporary password cannot be used indefinitely. After the user changes it the
 * flag is cleared and this migration never sets it again.
 */
const mustChangeColumn = addColumnIfMissing(
  'users',
  'must_change_password',
  'INTEGER NOT NULL DEFAULT 0'
);
if (mustChangeColumn) {
  const adminEmail = String(process.env.REAL_ADMIN_EMAIL ?? 'james@aquariusgp.com')
    .trim()
    .toLowerCase();
  const marked = db
    .prepare(`UPDATE users SET must_change_password = 1 WHERE lower(email) = ?`)
    .run(adminEmail);
  if (marked.changes) {
    console.log(`  migrations   must-change-password set for ${adminEmail}`);
  }
}

addColumnIfMissing('claims', 'variance_days', 'INTEGER');
addColumnIfMissing('claims', 'local_pdf_path', 'TEXT');
addColumnIfMissing('claims', 'generated_pdf_path', 'TEXT');
addColumnIfMissing('claims', 'last_regenerated_at', 'TEXT');
// Structured RA fields: additive only; client_id remains the canonical link.
addColumnIfMissing('claims', 'client_name_raw', 'TEXT');
addColumnIfMissing('claims', 'member_id', 'TEXT');
addColumnIfMissing('claims', 'date_of_service', 'TEXT');
addColumnIfMissing('claims', 'charge_amount', 'REAL');
addColumnIfMissing('claims', 'procedure_code', 'TEXT');
addColumnIfMissing('claims', 'patient_control_number', 'TEXT');
addColumnIfMissing('claims', 'expected_payment', 'REAL');
addColumnIfMissing('claims', 'claim_status_code', 'TEXT');

// Alternative client names used by Import/Verify fuzzy matching.
addColumnIfMissing('clients', 'alternative_names', 'TEXT');
addColumnIfMissing('clients', 'case_manager_name', 'TEXT');
addColumnIfMissing('clients', 'case_manager_phone', 'TEXT');
addColumnIfMissing('clients', 'case_manager_email', 'TEXT');
addColumnIfMissing('clients', 'is_stub', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('agencies', 'logo_url', 'TEXT');
addColumnIfMissing('agencies', 'ai_quick_prompts', 'TEXT');
addColumnIfMissing('agencies', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('alerts', 'metadata', 'TEXT');
addColumnIfMissing('users', 'totp_secret', 'TEXT');
addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'totp_recovery_codes', 'TEXT');
addColumnIfMissing('agencies', 'baa_signed_at', 'TEXT');
addColumnIfMissing('agencies', 'baa_signed_name', 'TEXT');
addColumnIfMissing('agencies', 'baa_signed_ip', 'TEXT');
addColumnIfMissing('users', 'onboarding_checklist', 'TEXT');
addColumnIfMissing('users', 'tutorial_completed', 'INTEGER NOT NULL DEFAULT 0');

// Service-agreement parent/link fields used by the Client Profile.
addColumnIfMissing('agreements', 'dhs_service_agreement_num', 'TEXT');
addColumnIfMissing('agreements', 'service_code_with_modifier', 'TEXT');
addColumnIfMissing('agreements', 'service_agreement_pdf_path', 'TEXT');
addColumnIfMissing('agreements', 'authorized_total_amount', 'REAL');
addColumnIfMissing('agreements', 'superseded_at', 'TEXT');
addColumnIfMissing('agreements', 'procedure_description', 'TEXT');
addColumnIfMissing('agreements', 'modifier_1', 'TEXT');
addColumnIfMissing('agreements', 'modifier_2', 'TEXT');
addColumnIfMissing('agreements', 'modifier_3', 'TEXT');
addColumnIfMissing('agreements', 'modifier_4', 'TEXT');
addColumnIfMissing('agreements', 'total_units', 'REAL');
addColumnIfMissing('service_agreements', 'case_manager_name', 'TEXT');
addColumnIfMissing('service_agreements', 'case_manager_phone', 'TEXT');
addColumnIfMissing('service_agreements', 'case_manager_email', 'TEXT');
addReferenceColumn('agreements', 'service_agreement_id', 'service_agreements', 'SET NULL');

// Case managers are assigned to a client; caretakers are recorded per day.
const caseManagerColumn = addReferenceColumn('clients', 'case_manager_id', 'case_managers');
const caretakerColumn = addReferenceColumn('day_entries', 'caretaker_id', 'caretakers');

// HHAeXchange flat-file import fields.
addColumnIfMissing('payers', 'hhaechange_payer_id', 'TEXT');
addColumnIfMissing('clients', 'diagnosis_code', 'TEXT');
addColumnIfMissing('caretakers', 'ssn', 'TEXT');
addColumnIfMissing('caretakers', 'gender', 'TEXT');
addColumnIfMissing('caretakers', 'status', "TEXT NOT NULL DEFAULT 'Active'");
addColumnIfMissing('caretakers', 'dl_number', 'TEXT');
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
if (db.prepare(`SELECT value FROM settings WHERE agency_id = 1 AND key = 'ra_files_backfill'`).get()?.value !== 'done') {
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
    `INSERT INTO settings (agency_id, key, value) VALUES (1, 'ra_files_backfill', 'done')
     ON CONFLICT(agency_id, key) DO UPDATE SET value = 'done'`
  ).run();
}

/*
 * One-off: older imports recorded every file of a batch in a single
 * comma-joined name, which hides which file failed. Split them into per-file
 * rows so the audit screen has one row per RA from the start.
 */
if (
  db.prepare(`SELECT value FROM settings WHERE agency_id = 1 AND key = 'ra_file_split'`).get()?.value !== 'done'
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
    `INSERT INTO settings (agency_id, key, value) VALUES (1, 'ra_file_split', 'done')
     ON CONFLICT(agency_id, key) DO UPDATE SET value = 'done'`
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
// Dashboard notifications for stub clients and incomplete profiles.
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_id  INTEGER NOT NULL DEFAULT 1,
    client_id  INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'client_profile',
    title      TEXT NOT NULL,
    message    TEXT,
    metadata   TEXT,
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_agency_created ON alerts (agency_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_client ON alerts (client_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_id     INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT,
    ip_address    TEXT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_agency_time
    ON audit_logs (agency_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time
    ON audit_logs (user_id, timestamp DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recent_clients (
    id        INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    viewed_at TEXT    NOT NULL,
    agency_id INTEGER NOT NULL DEFAULT 1,
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

db.prepare(
  `UPDATE agencies SET is_demo = 1
    WHERE id IN (SELECT agency_id FROM users WHERE lower(email) = 'demo@dundas.com')`
).run();

/** Seed defaults. INSERT OR IGNORE, so an existing value is never overwritten. */
function seedSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (agency_id, key, value) VALUES (1, ?, ?)
     ON CONFLICT(agency_id, key) DO NOTHING`
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
  db.prepare(`SELECT value FROM settings WHERE agency_id = 1 AND key = 'ra_source_backfill'`).get()?.value !== 'done'
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
    `INSERT INTO settings (agency_id, key, value) VALUES (1, 'ra_source_backfill', 'done')
     ON CONFLICT(agency_id, key) DO UPDATE SET value = 'done'`
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
  db.prepare(`SELECT value FROM settings WHERE agency_id = 1 AND key = 'ra_import_orphan_sweep'`).get()?.value !== 'done'
) {
  const swept = db
    .prepare(
      `DELETE FROM ra_imports
       WHERE id NOT IN (SELECT DISTINCT ra_import_id FROM claims WHERE ra_import_id IS NOT NULL)`
    )
    .run().changes;
  if (swept) console.log(`  migrations   removed ${swept} orphaned RA import log row(s)`);
  db.prepare(
    `INSERT INTO settings (agency_id, key, value) VALUES (1, 'ra_import_orphan_sweep', 'done')
     ON CONFLICT(agency_id, key) DO UPDATE SET value = 'done'`
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
      `INSERT INTO settings (agency_id, key, value, updated_at) VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT(agency_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    set.run('ai_api_key', demoKey);
    set.run('ai_provider', ['deepseek', 'openai'].includes(provider) ? provider : 'deepseek');
    console.log(`  demo mode   AI key injected from DEMO_AI_KEY (${provider})`);
  }
}

/**
 * Demo tenant provisioning.
 *
 * DEMO_MODE used to mean one global shared workspace pointed at demo.db. Now
 * the demo is a normal tenant: a real agency row, a real demo user, and the
 * same synthetic rows every other tenant query is scoped to. Runs once (or
 * resumes if seeding was interrupted) and only when explicitly enabled on a
 * non-demo deployment.
 */
/** Remove every row owned by the demo agency before a retry. */
function resetDemoAgencyData(agencyId) {
  const tables = [
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
    'settings',
  ];
  db.transaction(() => {
    for (const table of tables) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE agency_id = ?`).run(agencyId);
      } catch {
        /* table not present in this build; nothing to clear */
      }
    }
  })();
  console.log(`  demo agency  cleared partial seed (agency ${agencyId})`);
}

function ensureDemoAgency() {
  if (IS_DEMO) return;
  if (process.env.ENSURE_DEMO_AGENCY !== 'true' && process.env.NODE_ENV !== 'production') {
    return;
  }

  let agency = db.prepare(`SELECT id FROM agencies WHERE name = 'Demo Agency'`).get();
  if (!agency) {
    const id = Number(db.prepare(`INSERT INTO agencies (name) VALUES ('Demo Agency')`).run().lastInsertRowid);
    agency = { id };
    console.log(`  demo agency  created (agency ${id})`);
  }
  const agencyId = agency.id;

  const demoUser = db
    .prepare(`SELECT id FROM users WHERE lower(email) = 'demo@dundas.com'`)
    .get();
  if (!demoUser) {
    // The demo login bypasses the password. This deliberately invalid hash
    // means the normal password path can never authenticate this account.
    db.prepare(
      `INSERT INTO users (agency_id, email, password_hash, role)
       VALUES (?, 'demo@dundas.com', '!', 'admin')`
    ).run(agencyId);
    console.log('  demo agency  demo@dundas.com created');
  }

  const seeded = db
    .prepare(
      `SELECT value FROM settings WHERE agency_id = ? AND key = 'demo_seed_complete'`
    )
    .get(agencyId)?.value;

  if (seeded !== '1') {
    // A prior boot may have died halfway through (the original day_entries
    // schema bug). Clear its partial rows, then seed cleanly from zero.
    resetDemoAgencyData(agencyId);
    console.log(`  demo agency  seeding synthetic data as agency ${agencyId}`);
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(__dirname, 'scripts', 'seed-demo.js')],
        {
          env: {
            ...process.env,
            DEMO_DB: DB_PATH,
            DEMO_SEED_EXISTING: '1',
            DEMO_AGENCY_ID: String(agencyId),
            DEMO_AGENCY_NAME: 'Demo Agency',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        }
      );
      if (out) process.stdout.write(out);
    } catch (err) {
      if (err.stdout) process.stdout.write(String(err.stdout));
      if (err.stderr) process.stderr.write(String(err.stderr));
      console.error(`  demo agency  seeding FAILED: ${err.message}`);
    }
  }

  // A per-tenant AI key so the Demo account has working AI without borrowing
  // the real tenant's settings. DEMO_AI_KEY is a deployment secret.
  const demoKey = String(process.env.DEMO_AI_KEY ?? '').trim();
  if (demoKey) {
    const provider = String(process.env.DEMO_AI_PROVIDER ?? 'deepseek').trim().toLowerCase();
    const set = db.prepare(
      `INSERT INTO settings (agency_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(agency_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    set.run(agencyId, 'ai_api_key', demoKey);
    set.run(agencyId, 'ai_provider', ['deepseek', 'openai'].includes(provider) ? provider : 'deepseek');
    console.log(`  demo agency  AI key installed (${provider})`);
  }
}

/**
 * Optional real-tenant bootstrap. Set REAL_ADMIN_EMAIL and REAL_ADMIN_PASSWORD
 * on a deployment to create the Dundas Home Care LLC admin once. The password
 * is hashed before storage and is never logged.
 */
function ensureRealAdmin() {
  if (IS_DEMO) return;
  const email = String(process.env.REAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = String(process.env.REAL_ADMIN_PASSWORD ?? '');
  if (!email || !password) return;

  let agency = db.prepare(`SELECT id FROM agencies WHERE name = 'Dundas Home Care LLC'`).get();
  if (!agency) {
    const id = Number(
      db.prepare(`INSERT INTO agencies (name) VALUES ('Dundas Home Care LLC')`).run().lastInsertRowid
    );
    agency = { id };
    console.log(`  real agency  created (agency ${id})`);
  }

  const existing = db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email);
  if (existing) return;

  db.prepare(
    `INSERT INTO users (agency_id, email, password_hash, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 1)`
  ).run(agency.id, email, hashPassword(password));
  console.log(`  real agency  admin created for ${email}`);
}

ensureDemoAgency();
ensureRealAdmin();

/**
 * Every agency gets an explicit AI feature switch. This is a default only:
 * an existing '0' is never overwritten.
 */
function ensureAgencyAiDefaults() {
  const agencies = db.prepare(`SELECT id FROM agencies`).all();
  const insert = db.prepare(
    `INSERT INTO settings (agency_id, key, value, updated_at)
     VALUES (?, 'ai_enabled', '1', datetime('now'))
     ON CONFLICT(agency_id, key) DO NOTHING`
  );
  db.transaction(() => {
    for (const agency of agencies) insert.run(agency.id);
  })();
}

ensureAgencyAiDefaults();

export default db;
