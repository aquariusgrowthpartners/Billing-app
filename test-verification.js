/**
 * Local DB comparison test for the Vision output produced by test-ra.js.
 *
 *   BILLING_DB=/tmp/hha24/vision-test.db node test-verification.js
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const dbPath = process.env.BILLING_DB || '/tmp/hha24/vision-test.db';
const records = JSON.parse(fs.readFileSync('test-ra-output.json', 'utf8'));
const sqlite = new Database(dbPath);
const client = sqlite
  .prepare(`SELECT id FROM clients WHERE agency_id = 1 AND upper(last_name) LIKE 'MATTSON%' LIMIT 1`)
  .get();

if (!client) {
  console.error('No MATTSON client in test database.');
  process.exit(1);
}

const claimName = 'TEST_VISION_MATCH';
sqlite.prepare(`DELETE FROM claims WHERE claim_name = ? AND agency_id = 1`).run(claimName);
const amount = records.reduce((sum, record) => sum + Number(record.amount_paid || 0), 0);
sqlite
  .prepare(
    `INSERT INTO claims
       (claim_name, client_id, period_start, period_end, status, paid_date, paid_amount, source, agency_id)
     VALUES (?, ?, '2026-01-01', '2026-01-02', 'Paid', '2026-01-03', ?, 'manual', 1)`
  )
  .run(claimName, client.id, Math.round(amount * 100) / 100);
console.log('seeded claim for client', client.id, 'amount', amount);
console.log(
  sqlite
    .prepare(
      `SELECT cl.id, cl.claim_name, cl.client_id, cl.period_start, cl.period_end, cl.agency_id,
              cu.first_name, cu.last_name
         FROM claims cl JOIN clients cu ON cu.id = cl.client_id AND cu.agency_id = cl.agency_id
        WHERE cl.claim_name = ?`
    )
    .get(claimName)
);

const { groupRecordsByClaim } = await import('./server/routes/ai.js');
const grouped = groupRecordsByClaim(records, 1);
console.log(JSON.stringify(grouped, null, 2));

const matched = grouped.some((record) => record.status === 'match');
sqlite.prepare(`DELETE FROM claims WHERE claim_name = ? AND agency_id = 1`).run(claimName);
sqlite.close();

if (!matched) {
  console.error('FAIL: no Match result.');
  process.exit(1);
}
console.log('Match');
