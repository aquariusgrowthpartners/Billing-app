import { extractRaWithAzureDocIntel } from './aiService.js';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const money = (v) => {
  const m = String(v ?? '').match(/\$?\s*([\d,]+\.\d{2})/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
const number = (v) => {
  const m = String(v ?? '').match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
const iso = (v) => {
  const m = clean(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};
const MODS = new Set(['UA','U1','U2','U3','U4','U5','U6','U7','U8','U9','HQ','GT','GO','GP','GW','KX','25','26','59','95','76','77','TC']);

function tableRows(tables) {
  return (tables ?? []).flatMap((table) =>
    (table.cells ?? []).reduce((rows, cell) => {
      const r = Number(cell.rowIndex) || 0;
      rows[r] ??= [];
      rows[r][Number(cell.columnIndex) || 0] = clean(cell.content);
      return rows;
    }, []).map((cells) => cells ?? [])
  );
}

export function mapServiceAgreement(text, tables) {
  const rows = tableRows(tables);
  const headerRow = rows.find(
    (r) => /^\d{8,}$/.test(r[0] ?? '') && r.some((v) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v))
  );
  const header = headerRow
    ? {
        dhs_service_agreement_num: headerRow[0],
        recipient_id: headerRow[1],
        recipient_name: headerRow[2],
        effective_date: iso(headerRow[3]),
        through_date: iso(headerRow[4]),
      }
    : {};
  const cm = text.match(/Case\s*Manager\s*Name\s*(?:and\s*Number)?\s*:?\s*([A-Za-z][A-Za-z.'\- ]*?)\s*(?:\n|\r|\s{2,})(\d{3}[-.\s]\d{3}[-.\s]\d{4})/i);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = cm?.[2] ?? (text.match(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/)?.[0] ?? null);
  const lines = [];
  const rowRe = /^\s*(\d{1,2})\s+(APPROVED|DENIED|PENDING|VOID)\s+([A-Z]\d{4})(?:\s+([A-Z0-9]{2}))?\s+([\s\S]*?)(?=^\s*\d{1,2}\s+(?:APPROVED|DENIED|PENDING|VOID)\s+|\z)/gm;
  for (const m of text.matchAll(rowRe)) {
    if (m[2].toUpperCase() !== 'APPROVED') continue;
    const block = m[5];
    const amount = money(block.match(/Total Amount:[\s\S]*?(\$?\s*[\d,]+\.\d{2})/i)?.[1]);
    const rate = money(block.match(/Rate\/Unit:[\s\S]*?(\$?\s*[\d,]+\.\d{2})/i)?.[1]);
    const quantity = number(block.match(/Quantity:\s*(?:\$?\s*[\d,]+\.\d{2}\s*)?(\d[\d,]*)/i)?.[1]);
    const start = iso(block.match(/Start Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]);
    const end = iso(block.match(/End Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]);
    const mod = m[4] && MODS.has(m[4].toUpperCase()) ? m[4].toUpperCase() : null;
    lines.push({
      line_number: m[1],
      procedure_code: m[3],
      procedure_description: clean(block.split(/Total Amount:|Quantity:|Rate\/Unit:|Start Date:|End Date:/i)[0]),
      modifier_1: mod,
      modifier_2: null,
      modifier_3: null,
      modifier_4: null,
      rate_per_unit: rate,
      total_units: quantity,
      total_amount: amount,
      start_date: start,
      end_date: end,
    });
  }
  return {
    ...header,
    case_manager_name: cm ? clean(cm[1]) : null,
    case_manager_phone: phone,
    case_manager_email: email ? email[0] : null,
    lines,
  };
}

export async function extractServiceAgreement(buffer) {
  const extracted = await extractRaWithAzureDocIntel(buffer, 'application/pdf');
  return mapServiceAgreement(extracted.text, extracted.tables);
}
