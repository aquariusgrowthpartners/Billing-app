/**
 * Minnesota DHS Service Agreement parser.
 *
 * Regexes are anchored on LABELS, never on character position: the PDF's text
 * layer varies in whitespace and column widths between printings, so anything
 * positional breaks on the next version of the form.
 *
 * No writes here. Pure text in, plain object out.
 */

/**
 * Recognised procedure modifiers.
 *
 * A whitelist, not `[A-Z0-9]{2}`, because the description that follows the code
 * also starts with capitals — "T1019 PERSONAL CARE" would otherwise parse "PE"
 * as a modifier. MHCP uses this set on T1019/T1021 personal-care lines.
 */
const MODIFIERS = new Set([
  'UA','U1','U2','U3','U4','U5','U6','U7','U8','U9',
  'HQ','GT','GO','GP','GW','KX','25','26','59','95','76','77','TC',
]);

/** A procedure code: letter + 4 digits (T1019, S5125, T1021). */
const CODE_RE = /^[A-Z]\d{4}$/;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "12/01/24" -> "2024-12-01". Already-ISO values pass through. */
export function toISODate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!us) return null;
  const [, m, d, y] = us;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the key/value pairs out of the label-anchored header region.
 */
function parseHeader(text) {
  const grab = (re) => {
    const m = text.match(re);
    return m ? clean(m[1]) : null;
  };

  const header = {
    provider_id: grab(/Provider\s*I\.?\s*D\.?\s*:?\s*([A-Z0-9-]+)/i),
    icd10_code: grab(/ICD-?10\s*(?:DIAGNOSIS\s*)?CODE\s*:?\s*([A-Z]\d{2}(?:\.\d{1,4})?)/i),
    /*
     * The name is followed by a phone number and a case-manager number, on the
     * same line in the real PDF's text layer and on the next line in a copy.
     * Capture the name only — letters, spaces, periods and hyphens — stopping
     * at the first digit, so the contact details never leak into the name.
     */
    case_manager_name: grab(
      /Case\s*Manager\s*Name\s*(?:and\s*Number)?\s*:?\s*([A-Za-z][A-Za-z.'\- ]*?)\s*(?=\d|\n|$)/i
    ),
  };

  // The key row carries four values in one line. Match the whole row, then take
  // each field by its own shape rather than by column offset.
  const keyRow = text.match(
    /SERVICE\s*AGREEMENT\s*#?\s*RECIPIENT\s*I\.?\s*D\.?\s*RECIPIENT\s*NAME\s*EFFECTIVE\s*DATE\s*THROUGH\s*DATE[^\n]*\n([^\n]+)/i
  );
  const row = keyRow
    ? keyRow[1]
    : (text.match(/^\s*(\d{8,}\s+\d{6,}\s+[A-Z][^\n]*\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}\/\d{1,2}\/\d{2,4})/m) || [])[1];

  if (row) {
    const flat = clean(row);
    const nums = flat.match(/^(\d{8,})\s+(\d{6,})\s+(.*)$/);
    if (nums) {
      header.dhs_service_agreement_num = nums[1];
      header.recipient_id = nums[2];
      const rest = nums[3];
      const dates = rest.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/);
      if (dates) {
        header.recipient_name = clean(rest.slice(0, rest.indexOf(dates[1])));
        header.effective_date = toISODate(dates[1]);
        header.through_date = toISODate(dates[2]);
      } else {
        header.recipient_name = clean(rest);
      }
    }
  }
  return header;
}

/**
 * The line-item table.
 *
 * Each row is `<line#> <STATUS> <CODE> [MOD] <description>` followed, on later
 * lines, by its own totals block. Both rows and totals are matched by label or
 * shape, so a missing totals block skips the row rather than shifting the rest.
 */
function parseLines(text) {
  const lines = [];
  const rowRe = /^[ \t]*(\d{1,2})[ \t]+(APPROVED|DENIED|PENDING|VOID)[ \t]+([A-Z]\d{4})(?:[ \t]+([A-Z0-9]{2}))?(?![A-Z0-9])[ \t]*(.*)$/gm;

  const rows = [];
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const [, lineNo, status, code, maybeMod, desc] = m;
    if (!CODE_RE.test(code)) continue;
    // the optional group may have swallowed the first word of the description
    const mod = maybeMod && MODIFIERS.has(maybeMod) ? maybeMod : null;
    const description = clean(mod ? desc : [maybeMod, desc].filter(Boolean).join(' '));
    rows.push({
      index: m.index,
      end: m.index + m[0].length,
      line_number: lineNo,
      status: status.toUpperCase(),
      procedure_code: code,
      modifier: mod,
      description,
    });
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.status !== 'APPROVED') continue;
    // totals belong to the row that precedes them
    const slice = text.slice(r.end, rows[i + 1] ? rows[i + 1].index : r.end + 400);
    const amount = slice.match(/Total\s*Amount\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);
    const rate = slice.match(/Rate\s*\/?\s*Unit\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);
    const qty = slice.match(/Quantity\s*:?\s*([\d,]+)/i);
    const start = slice.match(/Start\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    const end = slice.match(/End\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    lines.push({
      line_number: r.line_number,
      status: r.status,
      procedure_code: r.procedure_code,
      modifier: r.modifier,
      description: r.description,
      total_amount: amount ? money(amount[1]) : null,
      rate_per_unit: rate ? money(rate[1]) : null,
      quantity: qty ? Number(qty[1].replace(/,/g, '')) : null,
      start_date: start ? toISODate(start[1]) : null,
      end_date: end ? toISODate(end[1]) : null,
    });
  }
  return lines;
}

/** Parse an already-extracted text layer. */
export function parseServiceAgreementText(text) {
  const src = String(text ?? '');
  const header = parseHeader(src);
  return { ...header, lines: parseLines(src) };
}

/** Parse a PDF buffer. pdf-parse is already a dependency of this app. */
export async function parseServiceAgreement(pdfBuffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const { text } = await parser.getText();
    return parseServiceAgreementText(text);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export default parseServiceAgreement;
