/**
 * End-to-end proof:
 *   277 fixture -> pending claim -> actual RA verification -> paid.
 * Runs against a disposable copy so no real data changes.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const SOURCE_DB = '/tmp/hha24/vision-test.db';
const TEST_DB = '/tmp/hha24/reconciliation-test.db';
const FIXTURE = '/Users/james/.dsh/attachments/v1/files/13/131e33b965d92c0a5785a17bb94f35dd58a41a6f455d9461c7abbbac4bdd8662/sarah end of sept.pdf';

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(`${TEST_DB}${suffix}`, { force: true }); } catch {}
}
fs.copyFileSync(SOURCE_DB, TEST_DB);
process.env.BILLING_DB = TEST_DB;

const { extractClaimSubmission } = await import('./server/claimSubmissionParser.js');
const { groupRecordsByClaim } = await import('./server/routes/ai.js');
const db = new Database(TEST_DB);

const claim277 = await extractClaimSubmission(fs.readFileSync(FIXTURE));
if (claim277.claim_status_code !== '46') throw new Error('Fixture did not extract status 46.');
if (!claim277.expected_payment) throw new Error('Fixture did not extract expected payment.');

const first = 'SARAH';
const last = 'SIMS';
let client = db.prepare(
  `SELECT id FROM clients WHERE agency_id = 1 AND upper(first_name)=? AND upper(last_name)=?`
).get(first, last);
if (!client) {
  const info = db.prepare(
    `INSERT INTO clients (first_name,last_name,ma_number,active,agency_id) VALUES (?,?,?,?,1)`
  ).run(first, last, String(claim277.subscriber_id ?? '').replace(/\D/g, ''), 1);
  client = { id: Number(info.lastInsertRowid) };
}
// Isolate this client's claims so the pending row is the only candidate.
db.prepare('DELETE FROM claims WHERE client_id = ? AND agency_id = 1').run(client.id);
const pending = db.prepare(
  `INSERT INTO claims
     (claim_name, client_id, period_start, period_end, total_units, total_dollars,
      status, charge_amount, expected_payment, patient_control_number, claim_status_code,
      client_name_raw, agency_id)
   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)`
).run(
  `TEST_277_${claim277.patient_control_number ?? 'pending'}`,
  client.id,
  claim277.period_start,
  claim277.period_end,
  claim277.service_lines.length,
  claim277.total_charge,
  claim277.total_charge,
  claim277.expected_payment,
  claim277.patient_control_number,
  claim277.claim_status_code,
  claim277.subscriber_name
);

const records = [{
  client_name: 'SIMS SARAH E',
  member_id: claim277.subscriber_id,
  claim_status: 'PAID',
  claim_period_start: claim277.period_start,
  claim_period_end: claim277.period_end,
  date_of_service: claim277.period_start,
  amount_paid: claim277.expected_payment,
  charge_amount: claim277.total_charge,
  claim_total_paid: claim277.expected_payment,
  claim_total_charge: claim277.total_charge,
}];
const grouped = groupRecordsByClaim(records, 1);
const row = db.prepare('SELECT id,status,paid_amount FROM claims WHERE id = ?').get(Number(pending.lastInsertRowid));
db.close();

if (!['paid', 'mismatch'].includes(row?.status)) {
  throw new Error(`Pending claim was not reconciled (got ${row?.status ?? 'missing'}).`);
}
if (row.status !== 'paid') {
  throw new Error(`Expected paid, got ${row.status}.`);
}
console.log(`[TEST-RECONCILIATION] Pending claim successfully moved to ${row.status}.`);
console.log(JSON.stringify({ claim_id: row.id, status: row.status, paid_amount: row.paid_amount, grouped: grouped.map((g) => g.status) }, null, 2));
