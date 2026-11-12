/**
 * Generate completely synthetic demo PDFs for tutorial mode.
 * No production PHI is ever read or copied.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'client/public/samples');

function escapePdf(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf(lines) {
  const content = ['BT', '/F1 11 Tf', '40 760 Td', '15 TL',
    ...lines.map((line) => `(${escapePdf(line)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const DEMO = {
  name: 'Jane Doe',
  member: '12345678',
  dob: '1990-01-01',
};

const samples = {
  'sample-sa.pdf': [
    'MINNESOTA DEPARTMENT OF HUMAN SERVICES',
    'SERVICE AGREEMENT / AUTHORIZATION',
    'SERVICE AGREEMENT NUMBER: DEMO-SA-0001',
    `Client Name: ${DEMO.name}`,
    `Member ID: ${DEMO.member}`,
    `Date of Birth: ${DEMO.dob}`,
    'Effective Date: 01/01/2026',
    'Through Date: 12/31/2026',
    'Case Manager: Demo Case Manager',
    'Case Manager Phone: 555-0100',
    'Case Manager Email: demo@example.org',
    '',
    'APPROVED SERVICE LINES',
    'Procedure Code: T1019',
    'Modifier 1: U1',
    'Rate per Unit: 20.00',
    'Units: 100',
    'Start Date: 01/01/2026',
    'End Date: 12/31/2026',
    'Total Amount: 2000.00',
    'Procedure Description: Personal Care Assistance',
  ],
  'sample-claim.pdf': [
    '277 Claim Response Print',
    'Minnesota Department of Human Services',
    'Submission Response: This claim has been submitted for processing',
    'Subscriber ID Number 12345678 Name: JANE DOE Patient Control Number: DEMO-0001',
    'Claim Information',
    'Status Info Effective Date: 01/01/2026',
    'Total Claim Charge Amount: $ 100.00',
    'Claim Payment Amount: $ 100.00',
    'Service Line Information',
    'Service Dates: 01/01/2026-01/01/2026',
    'Charge $ 100.00',
    'Payment: $ 100.00',
    'Service Period: 01/01/2026-01/01/2026',
    'Payer Claim Control Number: DEMO-PCN-0001',
    'Claim Status Category Claim Status',
    'P2 46',
  ],
  'sample-ra.pdf': [
    'REMITTANCE ADVICE',
    'Minnesota Department of Human Services',
    'Provider: Dundas Home Care LLC',
    `Client Name: ${DEMO.name}`,
    `Member ID: ${DEMO.member}`,
    `Date of Birth: ${DEMO.dob}`,
    'Claim Number: DEMO-RA-0001',
    'Service Period: 01/01/2026-01/01/2026',
    'Procedure Code: T1019',
    'Units: 5',
    'Billed Amount: 100.00',
    'Paid Amount: 100.00',
    'Claim Status: PAID',
  ],
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, lines] of Object.entries(samples)) {
  fs.writeFileSync(path.join(OUT, name), makePdf(lines));
  console.log(`wrote ${name}`);
}
