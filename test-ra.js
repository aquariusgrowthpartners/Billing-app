/**
 * Local Vision fixture test.
 *
 * Run with:
 *   BILLING_DB=/tmp/hha24/vision-test.db node test-ra.js
 *
 * The fixture is rotated with pdf-lib, Page 3 is extracted as a standalone
 * PDF, and the result is sent through the same extractRaWithAzureVision()
 * function used by /api/ai/verify-ra.
 */
import fs from 'node:fs';
import { normalizePdfRotation, extractPdfPage } from './server/pdfImage.js';
import { extractRaWithAzureVision } from './server/aiService.js';

const fixture =
  process.env.TEST_RA_PDF ||
  '/Users/james/.dsh/attachments/v1/files/81/81633025aef2f9bdcdb8a9b0572f27c44e7e97c929206c953a1440d41a0dcb1d/M417128800_M417128800_2026-05-05_RA01.pdf';

const buffer = fs.readFileSync(fixture);
const upright = await normalizePdfRotation(buffer);
const pagePdf = await extractPdfPage(upright, 3);
const result = await extractRaWithAzureVision(
  pagePdf.toString('base64'),
  1,
  'application/pdf'
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const records = result.records ?? [];
console.log(JSON.stringify(records, null, 2));
fs.writeFileSync('test-ra-output.json', JSON.stringify(records, null, 2));

const hasDate = records.some((record) => /\d{2}-\d{2}-\d{2}/.test(String(record.date_of_service ?? '')));
const hasAmount = records.some((record) => /\d+\.\d{2}/.test(String(record.amount_paid ?? '')));
if (!records.length || !hasDate || !hasAmount) {
  console.error('Vision output did not contain usable dates and decimal amounts.');
  process.exit(1);
}
console.log(`PASS: ${records.length} records with dates and decimal amounts.`);
