import { extractRaWithAzureDocIntel } from './aiService.js';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const money = (v) => {
  const m = String(v ?? '').match(/\$?\s*([\d,]+\.\d{2})/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
const iso = (v) => {
  const m = clean(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

export function map277(text, tables = []) {
  const subscriber = text.match(/Subscriber\s*ID\s*Number\s*(\d+)\s*Name:\s*([^\n]+?)\s*Patient\s*Control\s*Number:\s*([^\n]+)/i);
  const pcn = text.match(/Patient\s*Control\s*Number:\s*([^\n]+)/i)?.[1];
  const name = subscriber?.[2] ? clean(subscriber[2]) : (text.match(/Name:\s*([A-Z][A-Z ,.'-]+)/)?.[1] ?? null);
  const subscriberId = subscriber?.[1] ?? text.match(/Subscriber\s*ID\s*Number\s*(\d+)/i)?.[1] ?? null;
  const totalCharge = money(text.match(/Total\s*Claim\s*Charge\s*Amount:?\s*([\s\S]*?)(?=Claim\s*Payment|Adjudication|$)/i)?.[1]);
  const payment = money(text.match(/Claim\s*Payment\s*Amount:?[\s\S]{0,160}?(\$?\s*[\d,]+\.\d{2})/i)?.[1]);
  const periodText = text.match(/Service\s*Period:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  let statusCode = null;
  for (const table of tables) {
    const cells = (table.cells ?? []).map((c) => clean(c.content));
    const idx = cells.findIndex((v) => /^Claim Status$/i.test(v));
    if (idx >= 0) {
      const next = cells.slice(idx + 1).find((v) => /^\d{2}$/.test(v));
      if (next) { statusCode = next; break; }
    }
  }
  if (!statusCode) statusCode = text.match(/Claim\s*Status[\s\S]{0,40}\b(\d{2})\b/i)?.[1] ?? null;
  const lineDates = [...text.matchAll(/Service\s*Dates:\s*(\d{1,2}\/\d{1,2}\/\d{4})/gi)].map((m) => iso(m[1])).filter(Boolean);
  const lines = lineDates.map((date) => ({ date_of_service: date }));
  return {
    subscriber_id: subscriberId,
    subscriber_name: name,
    patient_control_number: pcn ? clean(pcn) : null,
    period_start: periodText ? iso(periodText[1]) : (lines[0]?.date_of_service ?? null),
    period_end: periodText ? iso(periodText[2]) : (lines[lines.length - 1]?.date_of_service ?? null),
    total_charge: totalCharge,
    expected_payment: payment,
    claim_status_code: statusCode,
    service_lines: lines,
    status: statusCode === '46' ? 'pending' : 'submitted',
  };
}

export async function extractClaimSubmission(buffer) {
  const extracted = await extractRaWithAzureDocIntel(buffer, 'application/pdf');
  return map277(extracted.text, extracted.tables);
}
