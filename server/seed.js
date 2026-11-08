/**
 * Seed script. Creates realistic test data so the Week 1 slice is testable
 * immediately. Safe to re-run: `node server/seed.js --reset` wipes first.
 */
import db from './db.js';
import { computeEntry, todayISO, weekStart, addDays } from './calc.js';

const reset = process.argv.includes('--reset');

if (reset) {
  db.exec(`
    DELETE FROM day_entries;
    DELETE FROM claims;
    DELETE FROM agreements;
    DELETE FROM payers;
    DELETE FROM clients;
    DELETE FROM sqlite_sequence;
  `);
  console.log('Cleared existing data.');
}

const already = db.prepare(`SELECT COUNT(*) AS n FROM clients`).get().n;
if (already > 0) {
  console.log(`Database already has ${already} client(s) — nothing to seed.`);
  console.log('Use `npm run db:reset` to wipe and reseed.');
  db.close();
  process.exit(0);
}

const seed = db.transaction(() => {
  const insertPayer = db.prepare(
    `INSERT INTO payers (name, typical_days_to_pay, notes) VALUES (?, ?, ?)`
  );
  const payers = {
    ma: insertPayer.run('State Medicaid', 30, 'Title XIX; pays on a 30-day cycle.').lastInsertRowid,
    bcbs: insertPayer.run('Blue Cross Blue Shield', 21, 'Commercial; usually 2-3 weeks.').lastInsertRowid,
    uhc: insertPayer.run('UnitedHealthcare', 45, 'Slower on the authorizations desk.').lastInsertRowid,
    private: insertPayer.run('Private Pay / Self', 7, 'Family pays directly.').lastInsertRowid,
  };

  const insertClient = db.prepare(
    `INSERT INTO clients (first_name, last_name, dob, ma_number, notes, active)
     VALUES (@first_name, @last_name, @dob, @ma_number, @notes, @active)`
  );
  const insertAgreement = db.prepare(
    `INSERT INTO agreements (
       client_id, agreement_number, start_date, end_date, authorized_units_per_week,
       minutes_per_unit, rate_per_unit, max_units_per_day, service_code, payer_id
     ) VALUES (
       @client_id, @agreement_number, @start_date, @end_date, @authorized_units_per_week,
       @minutes_per_unit, @rate_per_unit, @max_units_per_day, @service_code, @payer_id
     )`
  );

  const clients = [
    {
      first_name: 'Alice', last_name: 'Smith', dob: '1985-03-14', ma_number: '123456789',
      notes: 'Prefers morning visits. Spanish-speaking household.',
      active: 1,
      agreements: [
        {
          agreement_number: 'AGR-2026-001', start_date: '2026-01-01', end_date: '2026-12-31',
          authorized_units_per_week: 60, minutes_per_unit: 15, rate_per_unit: 18.5,
          max_units_per_day: 16, service_code: 'T1019', payer_id: payers.ma,
        },
      ],
    },
    {
      first_name: 'Marcus', last_name: 'Johnson', dob: '1979-11-02', ma_number: '987654321',
      notes: 'Wheelchair access required at the side entrance.',
      active: 1,
      agreements: [
        {
          agreement_number: 'AGR-2026-014', start_date: '2026-01-01', end_date: '2026-06-30',
          authorized_units_per_week: 40, minutes_per_unit: 15, rate_per_unit: 21.0,
          max_units_per_day: 12, service_code: 'T1019', payer_id: payers.bcbs,
        },
        {
          agreement_number: 'AGR-2025-088', start_date: '2025-07-01', end_date: '2025-12-31',
          authorized_units_per_week: 30, minutes_per_unit: 15, rate_per_unit: 19.0,
          max_units_per_day: 8, service_code: 'T1019', payer_id: payers.bcbs,
        },
      ],
    },
    {
      first_name: 'Priya', last_name: 'Raman', dob: '1992-06-25', ma_number: '456789123',
      notes: 'Authorization renewal due each March.',
      active: 1,
      agreements: [
        {
          agreement_number: 'AGR-2026-022', start_date: '2026-02-01', end_date: null,
          authorized_units_per_week: 80, minutes_per_unit: 30, rate_per_unit: 32.0,
          max_units_per_day: 8, service_code: 'T1021', payer_id: payers.uhc,
        },
      ],
    },
    {
      first_name: 'Darnell', last_name: 'Williams', dob: '1968-09-08', ma_number: '321654987',
      notes: 'Private pay. Invoice on the 1st.',
      active: 1,
      agreements: [
        {
          agreement_number: 'PP-2026-003', start_date: '2026-01-01', end_date: null,
          authorized_units_per_week: null, minutes_per_unit: 15, rate_per_unit: 25.0,
          max_units_per_day: 12, service_code: 'S5125', payer_id: payers.private,
        },
      ],
    },
    {
      first_name: 'Elena', last_name: 'Petrova', dob: '1955-01-30', ma_number: '741852963',
      notes: 'Discharged 2025-12-15.',
      active: 0,
      agreements: [
        {
          agreement_number: 'AGR-2025-061', start_date: '2025-03-01', end_date: '2025-12-15',
          authorized_units_per_week: 45, minutes_per_unit: 15, rate_per_unit: 17.25,
          max_units_per_day: 12, service_code: 'T1019', payer_id: payers.ma,
        },
      ],
    },
  ];

  const insertEntry = db.prepare(
    `INSERT INTO day_entries
       (client_id, agreement_id, work_date, minutes_worked, units, rate_per_unit, dollars, notes)
     VALUES
       (@client_id, @agreement_id, @work_date, @minutes_worked, @units, @rate_per_unit, @dollars, @notes)`
  );

  const thisWeek = weekStart(todayISO());
  const lastWeek = addDays(thisWeek, -7);

  for (const c of clients) {
    const { agreements, ...clientFields } = c;
    const clientId = insertClient.run(clientFields).lastInsertRowid;

    let primaryAgreementId = null;
    for (const a of agreements) {
      const id = insertAgreement.run({ ...a, client_id: clientId }).lastInsertRowid;
      if (a.end_date === null) primaryAgreementId = id;
    }
    if (!primaryAgreementId) primaryAgreementId = db
      .prepare(`SELECT id FROM agreements WHERE client_id = ? ORDER BY start_date DESC LIMIT 1`)
      .get(clientId).id;

    // Only give the active clients some worked days in the current + last week.
    if (!clientFields.active) continue;
    const agreement = db.prepare(`SELECT * FROM agreements WHERE id = ?`).get(primaryAgreementId);

    for (const weekStartISO of [lastWeek, thisWeek]) {
      const pattern = [60, 90, 75, 120, 45, 0, 0]; // Mon–Sun minutes
      pattern.forEach((minutes, idx) => {
        if (!minutes) return;
        const workDate = addDays(weekStartISO, idx);
        if (workDate > todayISO()) return; // don't log the future
        const calc = computeEntry({
          minutes_worked: minutes,
          minutes_per_unit: agreement.minutes_per_unit,
          rate_per_unit: agreement.rate_per_unit,
          max_units_per_day: agreement.max_units_per_day,
        });
        insertEntry.run({
          client_id: clientId,
          agreement_id: agreement.id,
          work_date: workDate,
          minutes_worked: calc.minutes_worked,
          units: calc.units,
          rate_per_unit: calc.rate_per_unit,
          dollars: calc.dollars,
          notes: null,
        });
      });
    }
  }
});

seed();

const counts = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM clients)    AS clients,
       (SELECT COUNT(*) FROM payers)     AS payers,
       (SELECT COUNT(*) FROM agreements) AS agreements,
       (SELECT COUNT(*) FROM day_entries) AS day_entries,
       (SELECT COUNT(*) FROM claims)     AS claims`
  )
  .get();

console.log('Seed complete:', counts);
console.log(`Current week starts ${weekStart(todayISO())} (Mon–Sun).`);

// Close explicitly: leaked Statement handles would otherwise be finalized by a
// GC weak callback after the Node environment has been torn down, which aborts
// the process inside the native addon.
db.close();
