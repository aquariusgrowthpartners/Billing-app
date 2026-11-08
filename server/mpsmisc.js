/**
 * Minnesota DHS "MPSMISC" reporting spreadsheet.
 *
 * The layout is not guessed: the workbook is the agency's own last-submitted
 * file, kept at server/templates/MPSMISC_template.xlsx, with its header block,
 * merged instructions, column widths and per-row PTO formula copied verbatim.
 * Only the agency header values and the worker rows are replaced.
 *
 * Ground truth for hours is OUR day_entries, never the RA. Hours are only ever
 * read.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import db from './db.js';
import { round2 } from './calc.js';
import { VALID_ENTRY_FROM, VALID_ENTRY_SQL } from './payPeriod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, 'templates', 'MPSMISC_template.xlsx');

/** Rows in the template's fixed header block. */
export const HEADER_ROW = 17; // column titles
export const FIRST_DATA_ROW = 18;
const LABEL_ROWS = { umpi: 5, name: 7, street: 9, cityStateZip: 11, period: 13 };

const mmddyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
};
const yyyymmdd = (iso) => String(iso ?? '').replace(/-/g, '');
/** The template names its sheet MMDDYYYY-MMDDYYYY. */
const sheetNameFor = (start, end) =>
  `${mmddyyyy(start).replace(/\//g, '')}-${mmddyyyy(end).replace(/\//g, '')}`;

/** Keep a value as text in Excel, so 55433 never becomes 55433.0. */
const asText = (v) => (v == null || v === '' ? null : String(v));

const setText = (ws, coord, value) => {
  const cell = ws.getCell(coord);
  cell.value = value;
  cell.numFmt = '@';
};

/**
 * Every caretaker with recorded hours in the work window, alphabetically.
 *
 * Archived caretakers are skipped, and the shared validity rule applies (the
 * client must exist and not be archived) so the spreadsheet agrees with every
 * other total in the app.
 */
export function buildRows(workStart, workEnd) {
  const rows = db
    .prepare(
      `SELECT t.id, t.first_name, t.last_name, t.npi_number,
              t.street_address, t.city, t.state, t.zip, t.phone,
              t.hire_date, t.termination_date, t.hourly_wage_rate,
              t.union_member, t.dues_deducted, t.seiu_voluntary_dues,
              SUM(d.minutes_worked) AS minutes
       ${VALID_ENTRY_FROM}
       JOIN caretakers t ON t.id = d.caretaker_id
       WHERE d.work_date >= @start AND d.work_date <= @end
         AND COALESCE(t.active, 1) = 1
         AND ${VALID_ENTRY_SQL}
       GROUP BY t.id
       HAVING SUM(d.minutes_worked) > 0
       ORDER BY t.last_name COLLATE NOCASE, t.first_name COLLATE NOCASE`
    )
    .all({ start: workStart, end: workEnd });

  return rows.map((r) => {
    const hours = round2((r.minutes || 0) / 60);
    const wage = r.hourly_wage_rate == null ? null : round2(r.hourly_wage_rate);
    return {
      caretaker_id: r.id,
      umpi: r.npi_number ?? null,
      last_name: r.last_name,
      first_name: r.first_name,
      // the template's "Middle name" column, filled from the caretaker's notes
      middle_name: null,
      street: r.street_address ?? null,
      city: r.city ?? null,
      state: r.state ?? null,
      zip: r.zip ?? null,
      phone: r.phone ?? null,
      hire_date: r.hire_date ?? null,
      termination_date: r.termination_date ?? null,
      hours,
      wage,
      gross_pay: wage == null ? null : round2(hours * wage),
      union_member: r.union_member ? 'Y' : 'N',
      dues_deducted: round2(r.dues_deducted ?? 0),
      seiu_voluntary_dues: round2(r.seiu_voluntary_dues ?? 0),
      hours_minutes: r.minutes,
    };
  });
}

/** Which required fields a row is missing — DHS rejects an incomplete row. */
export function missingFields(row) {
  const missing = [];
  if (!row.umpi) missing.push('UMPI / NPI');
  if (!row.street) missing.push('street address');
  if (!row.city) missing.push('city');
  if (!row.state) missing.push('state');
  if (!row.zip) missing.push('ZIP');
  if (!row.phone) missing.push('phone');
  if (!row.hire_date) missing.push('hire date');
  if (row.wage == null) missing.push('hourly wage rate');
  return missing;
}

export function previewRows(workStart, workEnd) {
  return buildRows(workStart, workEnd).map((r) => ({ ...r, missing: missingFields(r) }));
}

/** The agency block, read straight from settings. */
export function agencyBlock() {
  const get = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value ?? '';
  return {
    umpi: get('office_npi').trim(),
    name: get('agency_name').trim(),
    street: get('agency_street_address').trim(),
    city: get('agency_city').trim(),
    state: get('agency_state').trim(),
    zip: get('agency_zip').trim(),
  };
}

export const cityStateZip = (a) =>
  [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

export const fileNameFor = (agencyUmpi, labelStart, labelEnd, today = new Date()) => {
  const d = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
    today.getDate()
  ).padStart(2, '0')}`;
  return `${agencyUmpi}_MPSMISC_${d}_Reporting_Spreadsheet_${yyyymmdd(labelStart)}_${yyyymmdd(
    labelEnd
  )}.xlsx`;
};

/**
 * Build the workbook. Read-only: nothing here writes to the database.
 * Resolves to a Buffer ready to stream.
 */
export async function buildWorkbook({ labelStart, labelEnd, workStart, workEnd }) {
  const agency = agencyBlock();
  const rows = buildRows(workStart, workEnd);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.worksheets[0];

  // The template's own name is a previous period's; never reuse it.
  ws.name = sheetNameFor(labelStart, labelEnd);

  // Agency block.
  setText(ws, `A${LABEL_ROWS.umpi}`, agency.umpi);
  setText(ws, `A${LABEL_ROWS.name}`, agency.name);
  setText(ws, `A${LABEL_ROWS.street}`, agency.street);
  setText(ws, `A${LABEL_ROWS.cityStateZip}`, cityStateZip(agency));
  setText(ws, `A${LABEL_ROWS.period}`, `${mmddyyyy(labelStart)} \u2013 ${mmddyyyy(labelEnd)}`);

  // Wipe the previous submission's workers, but leave the template's blank
  // rows (the =L/30 formula and the "End of row" marker) exactly as they are.
  const lastTemplateRow = ws.rowCount;
  for (let r = FIRST_DATA_ROW; r <= lastTemplateRow; r++) {
    for (let c = 1; c <= 20; c++) {
      if (c === 15) continue; // column O keeps its formula
      const cell = ws.getCell(r, c);
      if (cell.value !== null && cell.value !== undefined) cell.value = null;
    }
  }

  rows.forEach((row, i) => {
    const r = FIRST_DATA_ROW + i;
    const put = (col, value, { text = false } = {}) => {
      const cell = ws.getCell(`${col}${r}`);
      cell.value = value;
      if (text) cell.numFmt = '@';
    };

    // A: the UMPI must stay text so a leading letter or zero survives
    put('A', asText(row.umpi), { text: true });
    put('B', asText(row.last_name), { text: true });
    put('C', asText(row.first_name), { text: true });
    put('D', asText(row.middle_name), { text: true });
    put('E', asText(row.street), { text: true });
    put('F', asText(row.city), { text: true });
    put('G', asText(row.state), { text: true });
    // H: 5-digit ZIP as text, never 55433.0
    put('H', asText(row.zip), { text: true });
    // I: exactly 10 digits
    put('I', asText(row.phone), { text: true });
    // J/K: dates as MM/DD/YYYY strings, not Excel datetimes
    put('J', row.hire_date ? mmddyyyy(row.hire_date) : null, { text: true });
    put('K', row.termination_date ? mmddyyyy(row.termination_date) : null, { text: true });
    put('L', row.hours);
    put('M', row.wage);
    put('N', row.gross_pay);
    // O: the required live formula, not a value
    ws.getCell(`O${r}`).value = { formula: `L${r}/30` };
    // P, Q blank
    put('R', asText(row.union_member), { text: true });
    put('S', row.dues_deducted);
    put('T', row.seiu_voluntary_dues);
  });

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows, agency };
}
