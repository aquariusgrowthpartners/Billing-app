/**
 * Local fuzzy-match verification.
 *
 * Copies the local test DB, seeds a Sarah Sims client and claim, clears any
 * stale alternative name from Samantha Mattson, then proves:
 *   - SIMS SARAH E matches Sarah Sims
 *   - SIMS SARAH E does not match Samantha Mattson
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const source = process.env.BILLING_DB || '/tmp/hha24/vision-test.db';
const testDbPath = '/tmp/hha24/fuzzy-test.db';
fs.copyFileSync(source, testDbPath);
process.env.BILLING_DB = testDbPath;

const sqlite = new Database(testDbPath);
const mattson = sqlite
  .prepare(`SELECT id FROM clients WHERE agency_id = 1 AND upper(last_name) LIKE 'MATTSON%' LIMIT 1`)
  .get();
const existingSarah = sqlite
  .prepare(`SELECT id FROM clients WHERE agency_id = 1 AND upper(first_name) = 'SARAH' AND upper(last_name) = 'SIMS' LIMIT 1`)
  .get();
let sarah = existingSarah;
if (!sarah) {
  const info = sqlite
    .prepare(
      `INSERT INTO clients
         (first_name, last_name, ma_number, active, agency_id)
       VALUES ('SARAH', 'SIMS', '99999999', 1, 1)`
    )
    .run();
  sarah = { id: Number(info.lastInsertRowid) };
}
if (mattson) {
  sqlite
    .prepare(`UPDATE clients SET alternative_names = NULL WHERE id = ?`)
    .run(mattson.id);
}
const claimName = 'TEST_SIMS_MATCH';
sqlite.prepare(`DELETE FROM claims WHERE claim_name = ? AND agency_id = 1`).run(claimName);
sqlite
  .prepare(
    `INSERT INTO claims
       (claim_name, client_id, period_start, period_end, status, paid_date, paid_amount, charge_amount, source, agency_id)
     VALUES (?, ?, '2026-01-01', '2026-01-02', 'Paid', '2026-01-03', 173.88, 167.88, 'manual', 1)`
  )
  .run(claimName, sarah.id);

const { groupRecordsByClaim } = await import('./server/routes/ai.js');
const { matchClient } = await import('./server/routes/importRa.js');
const records = [
  {
    client_name: 'SIMS SARAH E',
    member_id: '99999999',
    date_of_service: '2026-01-01',
    amount_paid: 86.94,
    charge_amount: 83.94,
  },
  {
    client_name: 'SIMS SARAH E',
    member_id: '99999999',
    date_of_service: '2026-01-02',
    amount_paid: 86.94,
    charge_amount: 83.94,
  },
];
const grouped = groupRecordsByClaim(records, 1);
const result = grouped.find((row) => row.status === 'match');
const importMatch = matchClient('SIMS SARAH E', null, 1);
console.log(
  JSON.stringify(
    {
      grouped: grouped.map((row) => ({
        status: row.status,
        client_id: row.db_data?.client_id ?? null,
        claim: row.db_data?.claim_name ?? null,
        amount: row.ra_data?.amount_paid,
      })),
      importMatch: importMatch
        ? { client_id: importMatch.id, name: `${importMatch.first_name} ${importMatch.last_name}` }
        : null,
      expected_client_id: sarah.id,
      mattson_client_id: mattson?.id ?? null,
    },
    null,
    2
  )
);

const passed =
  result &&
  result.db_data?.client_id === sarah.id &&
  result.db_data?.client_id !== mattson?.id &&
  importMatch?.id === sarah.id;

sqlite.close();
if (!passed) {
  console.error('FAIL: Sarah Sims did not match exclusively.');
  process.exit(1);
}
console.log('Match');
