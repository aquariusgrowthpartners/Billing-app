#!/usr/bin/env node
/**
 * Seed a synthetic demo database.
 *
 * Writes to a SEPARATE file (data/demo.db by default) and refuses to run against
 * the live database. Demo mode then points the server at that file, so a public
 * demo can never read real client PHI.
 *
 *   node server/scripts/seed-demo.js
 *   DEMO_MODE=true node server/index.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const LIVE = path.join(ROOT, 'data', 'billing.db');
const TARGET = path.resolve(process.env.DEMO_DB ?? path.join(ROOT, 'data', 'demo.db'));

if (TARGET === LIVE) {
  console.error('  REFUSING: DEMO_DB points at the live database. Choose another path.');
  process.exit(1);
}

if (fs.existsSync(TARGET)) {
  fs.rmSync(TARGET);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(TARGET + suffix, { force: true });
  console.log(`  removed previous demo database`);
}
fs.mkdirSync(path.dirname(TARGET), { recursive: true });

const db = new Database(TARGET);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ------------------------------------------------------------------ schema */
/*
 * The schema is COPIED from the live database rather than hand-written.
 * A hand-maintained copy drifts the moment a migration lands, and the server
 * then crashes on a column the demo DB is missing. Copying guarantees the demo
 * is structurally identical to production.
 */
let schemaSql = [];
if (fs.existsSync(LIVE)) {
  const live = new Database(LIVE, { readonly: true });
  schemaSql = live
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE sql IS NOT NULL
          AND type IN ('table','index')
          AND name NOT LIKE 'sqlite_%'`
    )
    .all()
    .map((r) => r.sql);
  live.close();
  console.log(`  copied ${schemaSql.length} schema objects from the live database`);
} else {
  console.error('  REFUSING: no live database to copy the schema from.');
  process.exit(1);
}

db.pragma('foreign_keys = OFF');
for (const sql of schemaSql) {
  try {
    db.exec(sql);
  } catch (err) {
    console.warn(`  skipped schema object: ${err.message}`);
  }
}
db.pragma('foreign_keys = ON');

/* --------------------------------------------------------------- synthetic */

/**
 * Insert a row using only the columns the real table actually has.
 * Keeps the seed working when a migration adds or renames a column.
 */
const COLUMN_CACHE = new Map();
function columnsOf(table) {
  if (!COLUMN_CACHE.has(table)) {
    COLUMN_CACHE.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
  }
  return COLUMN_CACHE.get(table);
}
function insertRow(table, obj) {
  const cols = columnsOf(table);
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  if (!keys.length) throw new Error(`no matching columns for ${table}`);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`;
  return Number(db.prepare(sql).run(Object.fromEntries(keys.map((k) => [k, obj[k]]))).lastInsertRowid);
}

/* deterministic pseudo-random so a reseed looks the same */
let seed = 20260101;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const CLIENTS = [
  ['John', 'Doe', '1980-03-14', '10000001', 'R69'],
  ['Jane', 'Smith', '1975-07-22', '10000002', 'M62.81'],
  ['Robert', 'Johnson', '1952-11-02', '10000003', 'I10'],
  ['Maria', 'Garcia', '1988-01-30', '10000004', 'E11.9'],
  ['David', 'Chen', '1969-09-18', '10000005', 'J44.9'],
  ['Sarah', 'Williams', '1991-05-07', '10000006', 'F32.9'],
  ['Michael', 'Brown', '1948-12-25', '10000007', 'G20'],
  ['Linda', 'Davis', '1983-04-11', '10000008', 'M17.11'],
  ['James', 'Wilson', '1977-08-03', '10000009', 'N18.3'],
  ['Patricia', 'Moore', '1960-02-19', '10000010', 'R26.2'],
];

const CARETAKERS = [
  ['Alice', 'Nguyen', '1111111111', 'Active', '2001-06-10'],
  ['Brian', 'Okafor', '2222222222', 'Active', '1998-02-27'],
  ['Carla', 'Mendez', '3333333333', 'Pending', '2000-10-05'],
  ['Derek', 'Olsen', '4444444444', 'Active', '1995-11-30'],
  ['Elena', 'Petrova', '5555555555', 'Pending', '1992-07-14'],
];

const clientIds = CLIENTS.map(([first, last, dob, ma, dx]) =>
  insertRow('clients', {
    first_name: first,
    last_name: last,
    dob,
    ma_number: ma,
    diagnosis_code: dx,
    notes: 'Synthetic demo record',
    active: 1,
    archived: 0,
  })
);

const careIds = CARETAKERS.map(([first, last, npi, status, dob], i) =>
  insertRow('caretakers', {
    first_name: first,
    last_name: last,
    npi_number: npi,
    status,
    active: status === 'Active' ? 1 : 0,
    ssn: `000-00-000${i}`,
    dob,
    phone: `555-010${i}`,
    hire_date: status === 'Active' ? '2024-01-15' : null,
    city: 'Minneapolis',
    state: 'MN',
    hourly_wage_rate: 22 + i,
  })
);

const cmId = insertRow('case_managers', {
  first_name: 'Dana',
  last_name: 'Whitfield',
  organization: 'Northstar Care Coordination',
  email: 'dana@example.com',
  phone: '555-0142',
  active: 1,
});

const payerId = insertRow('payers', { name: 'Demo Health Plan', typical_days_to_pay: 21 });

for (const [k, v] of Object.entries({
  theme_mode: 'light',
  theme_color: 'blue',
  agency_name: 'Dundas Home Care LLC (DEMO)',
  agency_tax_id: '00-0000000',
  office_npi: '0000000000',
})) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(k, v);
}

/* ------------------------------------------------- service agreements ---
   A parent (service_agreements) plus a child (agreements) per client, so the
   Service Agreements tab has something realistic to render. */
const SERVICE_CODES = ['T1019', 'S5116'];
const TODAY = new Date();
const YEAR_START = `${TODAY.getFullYear() - 1}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-01`;

for (let i = 0; i < clientIds.length; i++) {
  const code = SERVICE_CODES[i % SERVICE_CODES.length];
  const saId = insertRow('service_agreements', {
    client_id: clientIds[i],
    dhs_service_agreement_num: `DHS-${100000 + i}`,
    hhaexchange_auth_number: `AUTH-${200000 + i}`,
    effective_date: YEAR_START,
    through_date: `${TODAY.getFullYear() + 1}-12-31`,
    icd10_code: CLIENTS[i][4],
  });
  insertRow('agreements', {
    client_id: clientIds[i],
    agreement_number: `AGR-${TODAY.getFullYear()}-${String(i + 1).padStart(3, '0')}`,
    start_date: YEAR_START,
    end_date: `${TODAY.getFullYear() + 1}-12-31`,
    authorized_units_per_week: 60,
    minutes_per_unit: 15,
    rate_per_unit: code === 'T1019' ? 6.45 : 9.25,
    max_units_per_day: 16,
    service_code: code,
    payer_id: payerId,
    hhaexchange_auth_number: `AUTH-${200000 + i}`,
    dhs_service_agreement_num: `DHS-${100000 + i}`,
    service_agreement_id: saId,
  });
}

/* ------------------------------------------------------ day entries ----
   12 months of visits, weekdays mostly, a mix of codes and unit counts. */
const insEntry = db.prepare(
  `INSERT INTO day_entries
     (client_id, work_date, minutes_worked, units, rate_per_unit, dollars,
      caretaker_id, start_time, source, service_code, modifier)
   VALUES (@client_id, @work_date, @minutes, @units, @rate, @dollars,
           @caretaker_id, @start, 'demo', @code, @modifier)`
);

const dayRows = [];
for (let monthsBack = 11; monthsBack >= 0; monthsBack--) {
  const ref = new Date(TODAY.getFullYear(), TODAY.getMonth() - monthsBack, 1);
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m, d).getDay();
    if (dow === 0 || dow === 6) continue; // weekdays only

    for (let ci = 0; ci < clientIds.length; ci++) {
      // not every client every day — keeps the dataset from looking synthetic
      if (rnd() < 0.35) continue;
      const code = SERVICE_CODES[ci % SERVICE_CODES.length];
      const units = between(15, 40);
      const rate = code === 'T1019' ? 6.45 : 9.25;
      const date = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      dayRows.push({
        client_id: clientIds[ci],
        work_date: date,
        minutes: units * 15,
        units,
        rate,
        dollars: Math.round(units * rate * 100) / 100,
        caretaker_id: careIds[ci % careIds.length],
        start: `${String(7 + (ci % 4)).padStart(2, '0')}:00`,
        code,
        modifier: code === 'S5116' ? 'U1' : 'U9',
      });
    }
  }
}

const insertEntries = db.transaction((rows) => rows.forEach((r) => insEntry.run(r)));
insertEntries(dayRows);

/* ---------------------------------------------------------- claims ----
   Group the entries into bi-weekly periods per client and mark most paid. */
const claimsByPeriod = new Map();
for (const row of dayRows) {
  const d = new Date(row.work_date + 'T00:00:00');
  const half = d.getDate() <= 15 ? 1 : 2;
  const key = `${row.client_id}|${d.getFullYear()}-${d.getMonth() + 1}|${half}`;
  if (!claimsByPeriod.has(key)) claimsByPeriod.set(key, []);
  claimsByPeriod.get(key).push(row);
}

let claimCount = 0;
for (const [key, rows] of claimsByPeriod) {
  const [clientId] = key.split('|');
  const dates = rows.map((r) => r.work_date).sort();
  const units = rows.reduce((a, r) => a + r.units, 0);
  const dollars = Math.round(rows.reduce((a, r) => a + r.dollars, 0) * 100) / 100;
  const paid = Math.round(dollars * (0.82 + rnd() * 0.18) * 100) / 100;
  const start = dates[0];
  const end = dates[dates.length - 1];
  insertRow('claims', {
    claim_name: `DEMO_${clientId}_${start}_${end}`,
    client_id: Number(clientId),
    period_start: start,
    period_end: end,
    total_units: units,
    total_dollars: dollars,
    // capitalised to match the app's status vocabulary (Draft/Submitted/Paid/Denied)
    status: 'Paid',
    submitted_date: end,
    expected_pay_date: end,
    paid_date: end,
    paid_amount: paid,
  });
  claimCount += 1;
}

/* a few unpaid claims so Submitted / Draft pills render too */
db.prepare("UPDATE claims SET status = 'Submitted', paid_amount = NULL, paid_date = NULL WHERE id IN (SELECT id FROM claims ORDER BY id DESC LIMIT 12)").run();
db.prepare("UPDATE claims SET status = 'Draft', paid_amount = NULL, paid_date = NULL WHERE id IN (SELECT id FROM claims ORDER BY id ASC LIMIT 8)").run();

/* --------------------------------------------------------- denials ----
   Three denials with real adjustment codes so the explainer has material. */
const DENIAL_SPECS = [
  { ci: 0, code: 'CO 144', proc: 'T1019', units: 16, billed: 103.2, dos: '2026-01-05' },
  { ci: 3, code: 'CO 45', proc: 'S5116', units: 24, billed: 222.0, dos: '2026-02-11' },
  { ci: 6, code: 'CO 16', proc: 'T1019', units: 20, billed: 129.0, dos: '2026-03-18' },
];

for (const spec of DENIAL_SPECS) {
  const dcId = insertRow('denied_claims', {
    client_id: clientIds[spec.ci],
    client_name_raw: `${CLIENTS[spec.ci][0]} ${CLIENTS[spec.ci][1]}`,
    claim_status: 'denied',
    dos_start: spec.dos,
    dos_end: spec.dos,
    total_charge: spec.billed,
    total_payment: 0,
    source_filename: 'DEMO_RA01.pdf',
    recovery_status: 'unrecovered',
    adjustment_code: spec.code,
  });
  insertRow('denied_line_items', {
    denied_claim_id: dcId,
    client_id: clientIds[spec.ci],
    dos: spec.dos,
    procedure_code: spec.proc,
    units: spec.units,
    minutes_worked: spec.units * 15,
    billed: spec.billed,
    recovered: 0,
    recovery_status: 'unrecovered',
    adjustment_code: spec.code,
  });
}

/* ----------------------------------------------------------- tasks ---- */
const hireTask = insertRow('tasks', {
  title: 'New hire — Carla Mendez',
  type: 'new_hire',
  status: 'pending',
  due_date: '2026-03-01',
  caretaker_id: careIds[2],
});
['Background Check Clearance', 'Fingerprinting Completion', 'PCA/CFSS Worker Certificate', 'NPI Letter'].forEach(
  (label, i) =>
    insertRow('task_checklist_items', {
      task_id: hireTask,
      label,
      is_completed: i === 0 ? 1 : 0,
      sort_order: i,
    })
);

insertRow('tasks', {
  title: 'Review demo contract renewal',
  type: 'general',
  status: 'pending',
  due_date: '2026-04-15',
  ai_summary:
    'Demo Health Plan proposes a rate increase to $6.45 per unit effective January. All existing authorizations carry over automatically.',
});
insertRow('tasks', {
  title: 'Quarterly audit of demo denials',
  type: 'general',
  status: 'pending',
  due_date: '2026-05-30',
});

const counts = {
  clients: db.prepare('SELECT COUNT(*) n FROM clients').get().n,
  caretakers: db.prepare('SELECT COUNT(*) n FROM caretakers').get().n,
  day_entries: db.prepare('SELECT COUNT(*) n FROM day_entries').get().n,
  claims: db.prepare('SELECT COUNT(*) n FROM claims').get().n,
  tasks: db.prepare('SELECT COUNT(*) n FROM tasks').get().n,
  denied_claims: db.prepare('SELECT COUNT(*) n FROM denied_claims').get().n,
};
db.close();

console.log(`  demo database: ${TARGET}`);
console.log('  seeded:', JSON.stringify(counts));
console.log('  run with:  DEMO_MODE=true BILLING_DB=' + TARGET + ' node server/index.js');
