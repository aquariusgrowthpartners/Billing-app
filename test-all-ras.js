/**
 * Regression suite for the 22 production RA PDFs.
 *
 * For each PDF:
 *   1. Doc Intel layout extraction + structured table mapping.
 *   2. Persist daily claims into a disposable DB copy.
 *   3. Run the real verification grouper against those claims.
 *   4. Assert totals, daily row counts, and a successful status.
 *
 * Run:
 *   AZURE_DOC_INTEL_ENDPOINT=... AZURE_DOC_INTEL_KEY=... node test-all-ras.js
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = '/Users/james/.dsh/attachments/v1/files';
const TEST_DB = '/tmp/hha24/all-ras-test.db';
const SOURCE_DB = '/tmp/hha24/vision-test.db';

function findPdfs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPdfs(full));
    else if (/\.pdf$/i.test(entry.name) && /RA01/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function splitName(raw) {
  const value = String(raw ?? '').trim();
  if (value.includes(',')) {
    const [last, ...rest] = value.split(',');
    return { first: rest.join(' ').trim().split(/\s+/)[0] || 'UNKNOWN', last: last.trim() };
  }
  const parts = value.split(/\s+/).filter(Boolean);
  return { first: parts[1] ?? 'UNKNOWN', last: parts[0] ?? 'UNKNOWN' };
}

for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
  } catch {
    /* none */
  }
}
fs.copyFileSync(SOURCE_DB, TEST_DB);
process.env.BILLING_DB = TEST_DB;

const sqlite = new Database(TEST_DB);
sqlite.prepare('DELETE FROM claims').run();
sqlite.prepare('DELETE FROM day_entries').run();

const { extractRaWithAzureDocIntel } = await import('./server/aiService.js');
const { buildDocIntelRecords } = await import('./server/routes/ai.js');
const { groupRecordsByClaim } = await import('./server/routes/ai.js');

const allFiles = findPdfs(ROOT);
const requestedLimit = Number(process.env.CANARY_LIMIT || 0);
if (!requestedLimit && allFiles.length !== 22) {
  throw new Error(`Expected 22 RA PDFs, found ${allFiles.length}`);
}
let files = allFiles;
if (requestedLimit > 0) {
  if (requestedLimit > allFiles.length) {
    throw new Error(`Canary limit ${requestedLimit} exceeds ${allFiles.length} PDFs`);
  }
  const shuffled = [...allFiles].sort(() => Math.random() - 0.5);
  files = shuffled.slice(0, requestedLimit);
}

const ensureClient = (rawName) => {
  const { first, last } = splitName(rawName);
  let found = sqlite
    .prepare(
      `SELECT id FROM clients WHERE agency_id = 1 AND upper(first_name) = upper(?) AND upper(last_name) = upper(?) LIMIT 1`
    )
    .get(first, last);
  if (!found && first === 'UNKNOWN') {
    found = sqlite
      .prepare(
        `SELECT id FROM clients WHERE agency_id = 1 AND upper(last_name) = upper(?) LIMIT 1`
      )
      .get(last);
  }
  if (found) return found.id;
  const info = sqlite
    .prepare(
      `INSERT INTO clients (first_name, last_name, active, agency_id)
       VALUES (?, ?, 1, 1)`
    )
    .run(first, last);
  return Number(info.lastInsertRowid);
};

const results = [];
for (const file of files) {
  const buffer = fs.readFileSync(file);
  const extracted = await extractRaWithAzureDocIntel(buffer, 'application/pdf');
  const { records } = buildDocIntelRecords(extracted);
  if (!records.length) throw new Error(`${path.basename(file)}: no structured records`);

  const byClient = new Map();
  for (const record of records) {
    const key = `${record.client_name}|${record.claim_period_start}|${record.claim_period_end}`;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(record);
  }

  let inserted = 0;
  for (const [clientKey, clientRecords] of byClient.entries()) {
    const clientName = clientRecords[0].client_name;
    const clientId = ensureClient(clientName);
    const storedClient = sqlite
      .prepare(`SELECT first_name, last_name FROM clients WHERE id = ?`)
      .get(clientId);
    const displayName = storedClient
      ? `${storedClient.first_name} ${storedClient.last_name}`.trim()
      : clientName;
    for (const record of clientRecords) {
      record.client_name = displayName;
      const amount = Number(record.amount_paid);
      if (!Number.isFinite(amount)) {
        throw new Error(`${path.basename(file)}: non-numeric payment for ${record.date_of_service}`);
      }
      sqlite
        .prepare(
          `INSERT INTO claims
             (claim_name, client_id, period_start, period_end, status, paid_date,
              paid_amount, date_of_service, charge_amount, source, agency_id)
           VALUES (?, ?, ?, ?, 'Paid', date('now'), ?, ?, ?, 'ra_import', 1)`
        )
        .run(
          `TEST_${path.basename(file, '.pdf')}_${record.date_of_service}`,
          clientId,
          record.date_of_service,
          record.date_of_service,
          amount,
          record.date_of_service,
          record.charge_amount ?? null
        );
      inserted += 1;
    }
  }

  const grouped = groupRecordsByClaim(
    records.map((record) => ({
      ...record,
      claim_status: record.claim_status,
      amount_paid: record.amount_paid,
      charge_amount: record.charge_amount,
      claim_total_paid: null,
      claim_total_charge: null,
      claim_period_start: record.date_of_service,
      claim_period_end: record.date_of_service,
    })),
    1
  );

  const successStatuses = new Set([
    'paid',
    'match',
    'rebilled',
    'matched_reversal',
    'matched_denied',
    'denied_success',
  ]);
  const bad = grouped.filter((row) => !successStatuses.has(row.status));
  if (!grouped.length || bad.length) {
    throw new Error(
      `${path.basename(file)}: verification failed: ${JSON.stringify(
        bad.map((row) => ({ status: row.status, discrepancy: row.discrepancy }))
      )}`
    );
  }

  for (const [clientKey, clientRecords] of byClient.entries()) {
    const clientName = clientRecords[0].client_name;
    const paid = Number(clientRecords[0]?.claim_total_paid);
    const charge = Number(clientRecords[0]?.claim_total_charge);
    const dailyPaid = clientRecords.reduce((sum, record) => sum + Number(record.amount_paid || 0), 0);
    if (!Number.isFinite(paid) || paid < 0) {
      throw new Error(`${path.basename(file)} / ${clientName}: missing printed TOTAL PAYMENT`);
    }
    results.push({
      file: path.basename(file),
      client: clientName,
      period: clientKey.split('|').slice(1).join(' → '),
      charge: Number.isFinite(charge) ? charge.toFixed(2) : '—',
      paid: paid.toFixed(2),
      daily: dailyPaid.toFixed(2),
      rows: clientRecords.length,
      status: grouped[0]?.status ?? 'none',
      inserted,
    });
  }
}

sqlite.close();

console.log('\nFile Name | Client | Period | Charge Extracted | Payment Extracted | Daily Rows | Verify Status');
console.log('--- | --- | --- | ---: | ---: | ---: | ---');
for (const row of results) {
  console.log(
    `${row.file} | ${row.client} | ${row.period} | ${row.charge} | ${row.paid} | ${row.rows} | ${row.status}`
  );
}
console.log(`\nPASS: ${files.length} files, ${results.length} client claims.`);
