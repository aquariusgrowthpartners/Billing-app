/**
 * Minnesota Health Care Programs (MHCP) Remittance Advice parsing.
 *
 * Pure functions: this module reads text and returns plain objects. Nothing
 * here touches the database, so parsing can never write anything — the import
 * is read-only until the user confirms.
 *
 * A single RA PDF can cover many clients, and one client's line items can spill
 * across a page break. Blocks are split on "PATIENT:" and then merged back
 * together by client name, so a page break never produces a duplicate client.
 */

/** Field labels that can appear in a block, longest first for the regex. */
export const FIELD_LABELS = [
  'ORIGINAL CLM #',
  'ORIGINAL CLM#',
  'ORIGINAL CLAIM #',
  'ORIG CLM #',
  'ORIG CLM#',
  'REVERSED CLM #',
  'CLAIM STATUS',
  'PROD DATE',
  'REND PROV ID',
  'TOTAL CHARGE',
  'TOTAL ADJUST',
  'TOTAL PAYMENT',
  'CLAIM TYPE',
  'REND PROV',
  'CLM #',
  'PATIENT',
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Stop-lookahead: any known label followed by a colon. */
const STOP = FIELD_LABELS.map((l) => `${escapeRegex(l)}\\s*:`).join('|');

/**
 * Value of `label:` in a block, up to the next known label.
 * Returns null when the label is absent or the value is empty.
 */
export function extractField(block, label) {
  const re = new RegExp(`${escapeRegex(label)}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${STOP})|$)`, 'i');
  const m = block.match(re);
  if (!m) return null;
  const value = m[1].replace(/\s+/g, ' ').trim();
  return value || null;
}

/** "$1,234.56" -> 1234.56. Returns null when there is no number. */
export function parseMoney(value) {
  if (value == null) return null;
  const m = String(value).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "09-04-26" -> "2026-09-04". */
export function toISODate(mmddyy) {
  const m = String(mmddyy ?? '').match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yy = Number(m[3]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${m[1]}-${m[2]}`;
}

/** 1 unit = 15 minutes, per the import spec. */
export const MINUTES_PER_UNIT = 15;

/**
 * Drop the Minnesota cover/year pages and the repeating scan-artifact lines.
 * Page markers are emitted by the PDF text extractor as "===== Page N =====".
 */
export function cleanMinnesotaText(rawText) {
  let text = String(rawText ?? '');
  const pages = text.split('===== Page ');
  if (pages.length > 1) {
    const tablePages = pages.filter((page) => {
      const dates = (page.match(/\d{2}-\d{2}-\d{2}/g) || []).length;
      const amounts = (page.match(/\d+\.\d{2}/g) || []).length;
      return dates >= 3 && amounts >= 3;
    });
    text = tablePages.join('===== Page ');
  }
  return text.replace(/^(?:\d+\s+)+\d+$/gm, '');
}

/**
 * Last-resort table parser for Minnesota's sideways-column extraction.
 * It zips the date column to the amount column by index.
 */
export function parseMinnesotaTable(cleanText) {
  const dates = String(cleanText ?? '').match(/\d{2}-\d{2}-\d{2}/g) ?? [];
  const amounts = String(cleanText ?? '').match(/\d+\.\d{2}/g) ?? [];
  if (!dates.length || !amounts.length) return [];
  if (Math.abs(dates.length - amounts.length) > 1) return [];

  const count = Math.min(dates.length, amounts.length);
  return dates
    .slice(0, count)
    .map((date, index) => ({
      date_of_service: toISODate(date),
      amount_paid: Number(amounts[index]),
    }))
    .filter(
      (record) =>
        record.date_of_service &&
        Number.isFinite(record.amount_paid)
    );
}

/**
 * Line-item row:
 *   01 09-04-26 09-04-26 T1019 UP 99.52 16 CO 144 -6.24 0 16 105.76
 *   01 09-04-26 09-04-26 T1019 124.40 5 CO 45 93.30 0 5 32.35
 * The middle varies by payer, so the billed amount is the first number, the
 * units are the integer right after it, and the paid amount is the last number.
 */
export const LINE_ITEM_RE =
  /^\s*(\d{2})\s+(\d{2}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+([A-Z]\d{4}|\d{5})\b(.*)$/;

/**
 * A full service line, tolerant of line breaks.
 *
 * MHCP advices extract two ways depending on the PDF: genuinely one line per
 * service, or — for the ordinary ones — one FIELD per line, so a single service
 * spans seven lines. `\s` spans the newlines, which reads both. The modifier
 * column is optional and blank on most rows.
 *
 *   seq  from-dos    to-dos    code  [mod] charge units [grp] [reason] adj qty pd qty payment
 */
/**
 * Page furniture that can bisect a service row.
 *
 * On 2026-10-06_RA01, SIMS row 08 (09-11-26) has its SECOND adjustment group and
 * its payment on page 2 — an entire page header sits between them — so the
 * single-row regex could never reach the trailing payment and the row vanished.
 *
 * Stripped for LINE-ITEM matching only. Status and header parsing keep reading
 * the original text, because this block contains "CLAIM STATUS: PAID-PRIMARY",
 * which statusAt depends on.
 */
export const PAGE_FURNITURE_RE = /\n\s*-- \d+ of \d+ --[\s\S]*?-{10,}\n/g;

export const SERVICE_LINE_RE =
  /^\s*(\d{2})\s+(\d{2}-\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{2})\s+([A-Z]\d{4}|\d{5})\s+(?:([A-Z]{2}|[A-Z]\d)\s+)?(\d+\.\d{2})\s+(\d+)\s+(?:(?:([A-Z]{2})\s+(\d+)\s+-?\d+\.\d{2}\s+\d+\s+))*(\d+)\s+(-?\d+\.\d{2})/gm;

/** Parse every service line in a block, whichever way it was extracted. */
export function parseServiceLines(block) {
  const out = [];
  const cleaned = String(block ?? '').replace(PAGE_FURNITURE_RE, '\n');
  for (const m of cleaned.matchAll(SERVICE_LINE_RE)) {
    // group 5 is the modifier; it was captured but never bound, so every line
    // lost its modifier. The repeated adjustment group now allows MHCP rows
    // carrying two CO adjustments (SIMS) as well as one (MATTSON).
    /*
     * Groups 8/9 are the LAST adjustment group on the line ("CO", "144").
     * A quantified capture keeps only its final iteration, which is deliberate:
     * the last adjustment is the one that decided the payment. Multiple groups
     * are NOT concatenated — that would confuse the denial explainer.
     */
    const [, , fromDate, , procedureCode, modifier, charge, units, adjGroup, adjReason, , payment] = m;
    const u = Number(units);
    const minutes = Number.isFinite(u) ? u * MINUTES_PER_UNIT : null;
    const date = toISODate(fromDate);
    out.push({
      date,
      procedure_code: procedureCode,
      // blank column stays an empty string, not null — it is present and empty
      modifier: modifier ? modifier.trim() : '',
      units: Number.isFinite(u) ? u : null,
      minutes_worked: minutes,
      hours_worked: minutes == null ? null : Math.round((minutes / 60) * 100) / 100,
      billed: Number.isFinite(Number(charge)) ? Number(charge) : null,
      paid: Number.isFinite(Number(payment)) ? Number(payment) : null,
      adjustment_code: adjGroup && adjReason ? `${adjGroup} ${adjReason}` : null,
    });
  }
  return out;
}

export function parseLineItem(line) {
  const m = line.match(LINE_ITEM_RE);
  if (!m) return null;
  const [, , fromDate, , procedureCode, tail] = m;

  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  const numeric = [];
  tokens.forEach((t, i) => {
    // A row is only useful when it carries a real decimal amount. This keeps
    // the repeating "1 1 1 1" scan artifact from becoming a service row.
    if (/^-?\d+\.\d{2}$/.test(t)) numeric.push(i);
  });
  if (!numeric.length) return null;

  const billed = Number(tokens[numeric[0]]);
  // The units are the plain integer immediately after the billed amount.
  const nextToken = tokens[numeric[0] + 1];
  const units = nextToken && /^\d+$/.test(nextToken) ? Number(nextToken) : null;
  const paid = Number(tokens[numeric[numeric.length - 1]]);

  const date = toISODate(fromDate);
  const minutes = units == null ? null : units * MINUTES_PER_UNIT;

  return {
    date,
    procedure_code: procedureCode,
    units,
    minutes_worked: minutes,
    hours_worked: minutes == null ? null : Math.round((minutes / 60) * 100) / 100,
    billed: Number.isFinite(billed) ? billed : null,
    paid: Number.isFinite(paid) ? paid : null,
  };
}

/**
 * "REND PROV ID:" — a single token (the caregiver's NPI).
 *
 * Bounded to one word on purpose: the block that follows often contains labels
 * the stop-list does not know about ("PROV CTRL NBR:", the DOS/ADJ column
 * headers, …), and a lazy match that only stops at known labels runs to the end
 * of the block. Stopping at the first whitespace is always correct here.
 */
export const REND_PROV_ID_RE = /REND\s+PROV\s+ID\s*:\s*([A-Za-z0-9-]+)/i;

/**
 * "REND PROV:" — the provider name, up to "REND PROV ID:" or the end of the
 * line, whichever comes first. The line bound means a block with no
 * "REND PROV ID:" still cannot leak the rest of the page into the name.
 */
export const REND_PROV_NAME_RE = /REND\s+PROV\s*:\s*([^\n]*?)(?=\s*REND\s+PROV\s+ID\s*:|\n|$)/i;

/**
 * Both rendering-provider values for one block, trimmed.
 * Logged so a stray capture is visible immediately in the server console.
 */
export function extractRenderingProvider(block) {
  const nameMatch = block.match(REND_PROV_NAME_RE);
  const idMatch = block.match(REND_PROV_ID_RE);
  const name = nameMatch ? nameMatch[1].replace(/\s+/g, ' ').trim() || null : null;
  const id = idMatch ? idMatch[1].trim() || null : null;
  console.log(
    `[import-ra] REND PROV -> name=${JSON.stringify(name)} id=${JSON.stringify(id)}`
  );
  return { name, id };
}

/**
 * Claim statuses that represent real money.
 *
 * Everything else — DENIED, REVERSED, SUSPENDED, VOID, anything the payer
 * invents later — is treated as "not paid": it produces no day entries and can
 * never reach a revenue total. Matching on an allow-list rather than a
 * deny-list means an unknown status fails safe.
 */
export const PAID_STATUSES = new Set(['PAID-PRIMARY', 'PAID-SECONDARY', 'PAID']);

/** Nothing else pays. */
export const isPaidStatus = (status) => PAID_STATUSES.has(String(status ?? '').trim().toUpperCase());

/** Normalised status for storage: 'paid' | 'denied' | 'reversed' | the raw value. */
export function classifyStatus(status) {
  const raw = String(status ?? '').trim().toUpperCase();
  if (isPaidStatus(raw)) return 'paid';
  if (raw === 'DENIED') return 'denied';
  /*
   * MHCP prints "REVERSAL" on a reversal advice, not "REVERSED". Missing that
   * spelling let it fall through to the raw lowercase value, which the save
   * path then stored as 'denied' — so real reversals wore a red DENIED badge.
   */
  if (raw === 'REVERSED' || raw === 'REVERSAL' || raw === 'REVERSALS') return 'reversed';
  return raw ? raw.toLowerCase() : 'unknown';
}

/**
 * "PATIENT:" up to the end of its line, or up to "PATIENT ID" when the advice
 * prints the whole claim header on one line.
 *
 * The generic label scan ran on to the next label with a colon, so a real MHCP
 * advice produced "MATTSON SAMANTHA A PATIENT ID #:00292069 CONTRACT: MA ..."
 * as the client name. It still matched, but every display of it was wrong.
 */
export const PATIENT_NAME_RE = /PATIENT\s*:\s*([^\n]*?)(?=\s*PATIENT\s+ID|\n|$)/i;

export function extractPatientName(block) {
  const m = block.match(PATIENT_NAME_RE);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  return name || null;
}

/**
 * The recipient's MA / patient id, e.g. "PATIENT ID #:03276736".
 *
 * This is the ONE identifier that survives a legal name change, so it is
 * matched before the name. "SIMS SARAH E" and "NNADIKWE SARAH E" are the same
 * person; her MA number 03276736 is what proves it.
 */
/*
 * Tolerant of the layouts MHCP (and other payers) actually print:
 *
 *   PATIENT ID #:00292069      PATIENT ID: 00292069
 *   PATIENT ID#:00292069       PATIENT  ID # : 00292069
 *   PATIENT ID                  PATIENT I.D. 00292069
 *   00292069
 *
 * Anchored on PATIENT/RECIPIENT so it can never pick up "PAYER ID # 1411674742",
 * which sits in the same header and would otherwise be captured as the client.
 * The value is digits and hyphens only; whitespace between the label and the
 * value is allowed so a wrapping advice still matches.
 */
export const PATIENT_ID_RE =
  /(?:PATIENT|RECIPIENT)\s*I\.?\s*D\.?\s*(?:#|NO\.?|NUMBER)?\s*:?\s*([0-9][0-9-]{4,})/i;

export function extractPatientId(block) {
  const m = block.match(PATIENT_ID_RE);
  if (!m) return null;
  // keep digits only, so "03276736" and " 03276736 " compare equal
  const digits = m[1].replace(/\D/g, '');
  return digits || null;
}

/** Name key used to merge a client split across a page break. */
function nameKey(name) {
  return String(name ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Split one block into its header, its line items and the client name.
 * Exported so it can be tested directly.
 */
export function parseBlock(block) {
  // The multi-line scanner first; the one-line reader is the fallback for
  // advices whose fields genuinely sit on one line.
  let lineItems = parseServiceLines(block);
  if (!lineItems.length) {
    for (const line of block.split('\n')) {
      const item = parseLineItem(line);
      if (item) lineItems.push(item);
    }
  }

  const dates = lineItems.map((i) => i.date).filter(Boolean).sort();

  const { name: providerName, id: providerId } = extractRenderingProvider(block);

  const claimStatus = extractField(block, 'CLAIM STATUS');
  // A reversal may name the claim it reverses explicitly; if it does not, the
  // advice's own CLM # is the reference.
  const originalNumber =
    extractField(block, 'ORIGINAL CLM #') ??
    extractField(block, 'ORIGINAL CLM#') ??
    extractField(block, 'ORIGINAL CLAIM #') ??
    extractField(block, 'ORIG CLM #') ??
    extractField(block, 'ORIG CLM#') ??
    extractField(block, 'REVERSED CLM #') ??
    null;

  return {
    client_name: extractPatientName(block),
    patient_id: extractPatientId(block),
    claim_number: extractField(block, 'CLM #'),
    claim_status: claimStatus,
    paid: isPaidStatus(claimStatus),
    // set by parseRemittance once the page header is attributed
    ra_prod_date: null,
    original_claim_number: originalNumber,
    // "REND PROV:" — the rendering provider's name.
    rendered_provider_name: providerName,
    // "REND PROV ID:" — this is the caregiver's NPI, the key we match on.
    rendered_provider_id: providerId,
    // Kept for anything still reading the original name.
    rendered_provider: providerName,
    total_charge: parseMoney(extractField(block, 'TOTAL CHARGE')),
    total_adjust: parseMoney(extractField(block, 'TOTAL ADJUST')),
    total_payment: parseMoney(extractField(block, 'TOTAL PAYMENT')),
    dos_start: dates[0] ?? null,
    dos_end: dates[dates.length - 1] ?? null,
    line_items: lineItems,
  };
}

/**
 * Parse a whole remittance advice.
 *
 * @returns {{ clients: object[], block_count: number }}
 *   `clients` holds one entry per distinct client, with `merged_pages` recording
 *   how many PATIENT: blocks were folded together.
 */
export function parseRemittance(rawText) {
  const text = cleanMinnesotaText(
    String(rawText ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  );
  const minnesotaRecords = parseMinnesotaTable(text);

  // CLAIM STATUS and PROD DATE sit in the page header ABOVE the claims they
  // describe, and repeat on every page, so a block's status is the last one
  // seen before it — not the one inside its own text.
  const headerRe =
    /(CLAIM STATUS|PROD DATE|CHECK\/EFT NBR|CHK\/EFT NBR|CHK\/EFT DT|CHECK\/EFT DT|VENDOR NBR)\s*:\s*\n?\s*([A-Za-z0-9\/-]+)/gi;
  const headers = [...text.matchAll(headerRe)].map((m) => ({
    index: m.index,
    kind: m[1].toUpperCase(),
    value: m[2].trim(),
  }));
  const statusAt = (offset) => {
    let status = null;
    let prod = null;
    let check = null;
    let vendor = null;
    let checkDate = null;
    for (const h of headers) {
      if (h.index >= offset) break;
      if (h.kind === 'CLAIM STATUS') status = h.value;
      else if (h.kind === 'PROD DATE') prod = h.value;
      else if (h.kind === 'VENDOR NBR') vendor = h.value;
      else if (h.kind.endsWith('DT')) checkDate = h.value; // CHK/EFT DT
      else check = h.value; // CHECK/EFT NBR or CHK/EFT NBR
    }
    return { status, prod, check, vendor, checkDate };
  };

  // Everything before the first PATIENT: is letterhead — ignore it.
  const blocks = [];
  const patientRe = /PATIENT\s*:/gi;
  const starts = [...text.matchAll(patientRe)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : text.length;
    blocks.push({ body: `PATIENT: ${text.slice(from + 8, to)}`, start: from });
  }

  const byKey = new Map();
  const order = [];
  const unnamed = [];

  const parsedBlocks = blocks.map((b) => {
    const parsed = parseBlock(b.body);
    const { status, prod, check, vendor, checkDate } = statusAt(b.start);
    parsed.claim_status = status;
    parsed.paid = isPaidStatus(status);
    parsed.ra_prod_date = prod;
    parsed.check_eft_number = check;
    parsed.vendor_number = vendor;
    parsed.check_date = checkDate;
    if (!parsed.original_claim_number) parsed.original_claim_number = parsed.claim_number;
    return parsed;
  });

  for (const parsed of parsedBlocks) {
    /*
     * Merge key: client name + paid flag + CLAIM NUMBER.
     *
     * The claim number is what makes a continuation a continuation. Merging on
     * the name alone collapsed every separate claim for the same client in a
     * multi-claim advice into one, keeping only the first CLM #'s payment and
     * silently dropping the rest — which is why a $9,048 advice could import as
     * a fraction of that.
     *
     * A block without a claim number falls back to name + paid, which is the
     * old behaviour for advices that do not print one.
     */
    const name = nameKey(parsed.client_name);
    const key = name
      ? `${name}|${parsed.paid}|${parsed.claim_number ?? ''}`
      : '';

    // A block without a usable name can never be merged, so it stands alone.
    if (!key) {
      unnamed.push({ ...parsed, merged_pages: 1 });
      continue;
    }

    if (byKey.has(key)) {
      // Continuation of a client whose items ran onto the next page.
      const existing = byKey.get(key);
      existing.line_items.push(...parsed.line_items);
      for (const f of [
        'claim_number',
        'rendered_provider_name',
        'rendered_provider_id',
        'rendered_provider',
        'total_charge',
        'total_adjust',
        'total_payment',
        'claim_status',
        'ra_prod_date',
        'patient_id',
        'check_eft_number',
        'vendor_number',
        'check_date',
      ]) {
        if (existing[f] == null && parsed[f] != null) existing[f] = parsed[f];
      }
      existing.merged_pages += 1;
    } else {
      const entry = { ...parsed, merged_pages: 1 };
      byKey.set(key, entry);
      order.push(entry);
    }
  }

  const clients = [...order, ...unnamed].map((c) => {
    // Last line of defence: every persisted/extracted row must have a real
    // MM-DD-YY date and a decimal paid amount.
    const lineItems = c.line_items.filter(
      (item) => item?.date && Number.isFinite(Number(item.paid))
    );
    const dates = lineItems.map((i) => i.date).filter(Boolean).sort();
    return {
      ...c,
      line_items: lineItems,
      dos_start: dates[0] ?? null,
      dos_end: dates[dates.length - 1] ?? null,
    };
  });

  // The file-level header: the first one seen, used for duplicate identity.
  // The check total, printed once at the end of the advice. This is the figure
  // an operator reconciles against, and it is not the sum of the per-claim
  // payments when a forwarding balance is carried.
  const payMatch = /PAYMENT\s+AMOUNT\s*:\s*\n?\s*([\d,]+\.\d{2})/i.exec(text);
  const paymentAmount = payMatch ? Number(payMatch[1].replace(/,/g, '')) : null;
  const fwdMatches = [...text.matchAll(/FORWARDING\s+BALANCE\s*\n?\s*\$?(-?[\d,]+\.\d{2})/gi)];
  const forwardingBalance = fwdMatches.reduce(
    (sum, m) => sum + Number(m[1].replace(/,/g, '')),
    0
  );

  const header = {
    payment_amount: Number.isFinite(paymentAmount) ? paymentAmount : null,
    forwarding_balance: fwdMatches.length ? Math.round(forwardingBalance * 100) / 100 : null,
    check_eft_number:
      headers.find((h) => h.kind.includes('NBR') && h.kind.startsWith('CH'))?.value ?? null,
    check_date:
      headers.find((h) => h.kind.includes('DT') && h.kind.startsWith('CH'))?.value ?? null,
    prod_date: headers.find((h) => h.kind === 'PROD DATE')?.value ?? null,
    vendor_number: headers.find((h) => h.kind === 'VENDOR NBR')?.value ?? null,
  };

  const layout = detectUnrecognisedLayout(text, clients);
  return { clients, block_count: blocks.length, header, minnesota_records: minnesotaRecords, ...layout };
}

/**
 * Times for one imported visit: 08:00 plus the minutes worked.
 * `end_time` is derived rather than stored — the day_entries table is
 * unchanged, and start + minutes already describes the window everywhere else
 * in the app (including the HHAeXchange export).
 */
export function visitTimes(minutesWorked) {
  const total = Math.max(0, Number(minutesWorked) || 0);
  const startMin = 8 * 60;
  const end = startMin + total;
  const at = (min) => {
    const wrapped = min % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  return { start_time: '08:00', end_time: at(end) };
}

/**
 * Is this advice's text layer columnar rather than row-wise?
 *
 * Some MHCP PDFs extract one table CELL per line, with blank lines between, so
 * a single service row ("01 05-01-26 05-01-26 T1019 -99.52 ...") never appears
 * on one line. The service-line scanner then finds nothing, and the claim is
 * stored with no DOS and no line items — a phantom denial.
 *
 * The signature is a standalone "DOS" line, which only happens when the
 * table header has been broken into individual cells. Detected per FILE, not
 * per claim, because one bad extraction affects every claim in it.
 */
export function detectUnrecognisedLayout(text, claims) {
  const rowRe = /\b\d{2}\s+\d{2}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}\s+[A-Z]\d{3,4}\b/;
  const lines = String(text ?? '').split('\n');
  // a header cell on its own line is the columnar tell
  const columnar = lines.some((l) => l.trim() === 'DOS');
  const anyRow = lines.some((l) => rowRe.test(l));
  const zeroItem = (claims ?? []).filter((c) => !c.line_items?.length).length;
  const unrecognised = columnar && !anyRow && zeroItem > 0;
  return {
    layout_unrecognised: unrecognised,
    layout_reason: unrecognised
      ? `columnar text layer: ${zeroItem} of ${(claims ?? []).length} claim(s) yielded no service rows`
      : null,
  };
}

export default { parseRemittance, parseBlock, parseLineItem, visitTimes };
