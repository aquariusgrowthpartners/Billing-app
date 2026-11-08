-- Schema snapshot for the demo seeder.
-- Generated from the live database. DDL only, no patient data.
-- Regenerate with: node scripts/dump-schema.mjs

CREATE TABLE agreements (
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
  , hhaexchange_auth_number TEXT, dhs_service_agreement_num TEXT, service_code_with_modifier TEXT, service_agreement_pdf_path TEXT, authorized_total_amount NUMERIC, service_agreement_id INTEGER REFERENCES service_agreements(id), superseded_at TEXT);

CREATE TABLE caretakers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT    NOT NULL,
    last_name  TEXT    NOT NULL,
    npi_number TEXT,
    notes      TEXT,
    active     INTEGER NOT NULL DEFAULT 1
  , ssn TEXT, gender TEXT, dob TEXT, street_address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, hire_date TEXT, termination_date TEXT, hourly_wage_rate REAL, union_member INTEGER DEFAULT 0, dues_deducted REAL DEFAULT 0, seiu_voluntary_dues REAL DEFAULT 0, dl_number TEXT, status TEXT NOT NULL DEFAULT 'Active');

CREATE TABLE case_managers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name   TEXT    NOT NULL,
    last_name    TEXT    NOT NULL,
    email        TEXT,
    phone        TEXT,
    organization TEXT,
    notes        TEXT,
    active       INTEGER NOT NULL DEFAULT 1
  );

CREATE TABLE claims (
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
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  , variance_days INTEGER, local_pdf_path TEXT, generated_pdf_path TEXT, last_regenerated_at TEXT, source TEXT NOT NULL DEFAULT 'manual', archived INTEGER NOT NULL DEFAULT 0, ra_import_id INTEGER, ra_claim_number TEXT, denial_status TEXT, reversal_flag INTEGER DEFAULT 0, parse_status TEXT NOT NULL DEFAULT 'complete');

CREATE TABLE clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT    NOT NULL,
    last_name     TEXT    NOT NULL,
    dob           TEXT,
    ma_number     TEXT,
    notes         TEXT,
    active        INTEGER NOT NULL DEFAULT 1
  , case_manager_id INTEGER REFERENCES case_managers(id) ON DELETE SET NULL, diagnosis_code TEXT, archived INTEGER NOT NULL DEFAULT 0, middle_initial TEXT);

CREATE TABLE day_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    agreement_id   INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
    work_date      TEXT    NOT NULL,
    minutes_worked INTEGER NOT NULL DEFAULT 0,
    units          INTEGER NOT NULL DEFAULT 0,
    rate_per_unit  REAL    NOT NULL DEFAULT 0,
    dollars        REAL    NOT NULL DEFAULT 0,
    notes          TEXT,
    claim_id       INTEGER REFERENCES claims(id) ON DELETE SET NULL, caretaker_id INTEGER REFERENCES caretakers(id) ON DELETE SET NULL, start_time TEXT, source TEXT NOT NULL DEFAULT 'manual', ra_import_id INTEGER, service_code TEXT, modifier TEXT,
    UNIQUE (client_id, work_date)
  );

CREATE TABLE denied_claims (
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
  , ra_import_id INTEGER, original_claim_number TEXT, adjustment_code TEXT);

CREATE TABLE denied_line_items (
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
    recovered_by_day_entry_id INTEGER REFERENCES day_entries(id) ON DELETE SET NULL,
    recovered_dos             TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now'))
  , recovery_status TEXT, adjustment_code TEXT);

CREATE TABLE payers (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    typical_days_to_pay  INTEGER,
    notes                TEXT
  , hhaechange_payer_id TEXT);

CREATE TABLE ra_import_files (
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

CREATE TABLE ra_import_history (
    id              INTEGER PRIMARY KEY,
    ra_import_id    INTEGER REFERENCES ra_imports(id) ON DELETE CASCADE,
    reparsed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    old_claim_count INTEGER,
    new_claim_count INTEGER,
    notes           TEXT
  , deleted_at TEXT, import_ids TEXT, claim_count_purged INTEGER DEFAULT 0, day_entry_count_purged INTEGER DEFAULT 0, denial_count_purged INTEGER DEFAULT 0);

CREATE TABLE ra_imports (
    id            INTEGER PRIMARY KEY,
    imported_at   TEXT    NOT NULL,
    num_clients   INTEGER NOT NULL DEFAULT 0,
    total_payment REAL,
    file_name     TEXT
  , file_hash TEXT, check_eft_number TEXT, prod_date TEXT, vendor_number TEXT, claim_count INTEGER DEFAULT 0, denial_count INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', pdf_path TEXT, updated_at TEXT);

CREATE TABLE rebill_tasks (
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

CREATE TABLE recent_clients (
    id        INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    viewed_at TEXT    NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

CREATE TABLE service_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  dhs_service_agreement_num TEXT NOT NULL,
  hhaexchange_auth_number TEXT,
  effective_date DATE, through_date DATE, icd10_code TEXT,
  pdf_path TEXT, uploaded_at TEXT,
  UNIQUE(client_id, dhs_service_agreement_num));

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE task_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  document_path TEXT,
  completed_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('new_hire','general')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  due_date TEXT,
  caretaker_id INTEGER REFERENCES caretakers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_summary TEXT);

CREATE INDEX idx_agreements_client   ON agreements (client_id);

CREATE INDEX idx_agreements_dhs_num ON agreements(dhs_service_agreement_num);

CREATE INDEX idx_agreements_service_agreement ON agreements(service_agreement_id);

CREATE INDEX idx_caretakers_name ON caretakers (last_name, first_name);

CREATE INDEX idx_case_managers_name ON case_managers (last_name, first_name);

CREATE INDEX idx_claims_client       ON claims (client_id, period_start);

CREATE INDEX idx_claims_ra_claim_number
    ON claims (ra_claim_number);

CREATE INDEX idx_claims_ra_import ON claims (ra_import_id);

CREATE INDEX idx_claims_status       ON claims (status);

CREATE INDEX idx_clients_case_manager ON clients (case_manager_id);

CREATE INDEX idx_clients_ma          ON clients (ma_number);

CREATE INDEX idx_clients_name        ON clients (last_name, first_name);

CREATE INDEX idx_day_entries_caretaker ON day_entries (caretaker_id);

CREATE INDEX idx_day_entries_claim   ON day_entries (claim_id);

CREATE INDEX idx_day_entries_client  ON day_entries (client_id, work_date);

CREATE INDEX idx_day_entries_date    ON day_entries (work_date);

CREATE INDEX idx_day_entries_ra_import ON day_entries (ra_import_id);

CREATE INDEX idx_day_entries_service_code ON day_entries(service_code);

CREATE INDEX idx_denied_claims_claim_number
    ON denied_claims (ra_claim_number);

CREATE INDEX idx_denied_claims_ra_import ON denied_claims (ra_import_id);

CREATE INDEX idx_denied_line_items_dos_client
    ON denied_line_items (dos, client_id);

CREATE INDEX idx_ra_import_files_hash ON ra_import_files (file_hash);

CREATE INDEX idx_ra_import_files_import ON ra_import_files (ra_import_id);

CREATE INDEX idx_ra_import_history_import ON ra_import_history (ra_import_id);

CREATE INDEX idx_ra_imports_hash ON ra_imports (file_hash);

CREATE INDEX idx_ra_imports_header
    ON ra_imports (check_eft_number, prod_date, vendor_number);

CREATE INDEX idx_rebill_tasks_status_client
    ON rebill_tasks (status, client_id);

CREATE UNIQUE INDEX idx_recent_clients_client ON recent_clients(client_id);

CREATE INDEX idx_tasks_caretaker ON tasks(caretaker_id);

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_tci_task ON task_checklist_items(task_id);
