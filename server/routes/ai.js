/**
 * AI-adjacent file endpoints.
 *
 * PDF verification uses the same parser as Import RA; images continue through
 * Document Intelligence.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import {
  extractRaWithAzureDocIntel,
  complete,
  RA_TEXT_SYSTEM_PROMPT,
} from '../aiService.js';
import { parseRemittance } from '../raImport.js';
import db from '../db.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const BULK_DIR = path.resolve('data', 'ra_bulk_uploads');
fs.mkdirSync(BULK_DIR, { recursive: true });

const bulkUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(BULK_DIR, req.bulkJobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').slice(0, 12);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 300 },
});

/*
 * In-memory queue, intentionally no Redis. The limit is global: at most two
 * files are processed at once across all jobs.
 */
const fileLimit = pLimit(2);

function allowedFile(file) {
  const name = String(file?.originalname ?? '');
  return (
    file?.mimetype === 'application/pdf' ||
    String(file?.mimetype ?? '').startsWith('image/') ||
    /\.(pdf|png|jpe?g|webp|heic|heif)$/i.test(name)
  );
}

/**
 * RA values may arrive as numbers, "$1,234.56", " 1234.56 ", etc.
 * Strip whitespace, dollar signs and thousands separators, then parseFloat.
 * NaN is preserved deliberately so the caller can route it to a mismatch.
 */
function parseCurrency(value) {
  if (typeof value === 'number') return value;
  const normalized = String(value ?? '')
    .replace(/\s/g, '')
    .replace(/\$/g, '')
    .replace(/,/g, '');
  return parseFloat(normalized);
}

/** Pending 277 claims have no paid_amount yet; use their expected payment. */
function claimPaidAmount(claim) {
  const paid = parseCurrency(claim?.paid_amount);
  if (Number.isFinite(paid)) return paid;
  if (String(claim?.status ?? '').toLowerCase() === 'pending') {
    const expected = parseCurrency(claim?.expected_payment);
    return Number.isFinite(expected) ? expected : null;
  }
  return null;
}

function money(value) {
  const n = parseCurrency(value);
  return Number.isFinite(n)
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
}

/** Parse ISO or US dates into an inclusive range. */
function parseDateRange(value) {
  const text = String(value ?? '');
  const isos = [...text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map(
    (m) => `${m[1]}-${m[2]}-${m[3]}`
  );
  if (isos.length) return { start: isos[0], end: isos[isos.length - 1] };

  const us = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)].map(
    (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  );
  if (us.length) return { start: us[0], end: us[us.length - 1] };

  // Minnesota RAs often use MM-DD-YY, including concatenated daily dates.
  const dashed = [...text.matchAll(/\b(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\b/g)].map((m) => {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  });
  if (dashed.length) return { start: dashed[0], end: dashed[dashed.length - 1] };

  return { start: null, end: null };
}

/** "MATTSON, SAMANTHA" or "SAMANTHA MATTSON" -> {last, first}. */
function splitClientName(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes(',')) {
    const [last, ...rest] = text.split(',');
    const first = rest.join(',').trim();
    if (!last.trim()) return null;
    return { last: last.trim(), first };
  }
  const parts = text.split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts.pop();
  return { last, first: parts.join(' ') };
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** Possible surnames in a full name or a first-last alternative name. */
function lastNameCandidates(value) {
  const tokens = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return [];
  return [...new Set([tokens[0], tokens[tokens.length - 1]])];
}

function sameSurname(a, b) {
  return levenshtein(String(a), String(b)) <= 1;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const row = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[n];
}

/** 0..1 similarity; sorted tokens make "Last, First" == "First Last". */
function nameSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

const NAME_MATCH_THRESHOLD = 0.8;
const DATE_WINDOW_DAYS = 14;

const DB_CLAIM_SELECT = `
  SELECT cl.id, cl.claim_name, cl.status, cl.period_start, cl.period_end,
         cl.date_of_service, cl.paid_amount, cl.expected_payment, cl.total_dollars,
         cu.id AS client_id, cu.first_name, cu.last_name, cu.ma_number,
         cu.alternative_names
    FROM claims cl
    JOIN clients cu ON cu.id = cl.client_id AND cu.agency_id = cl.agency_id
`;

/**
 * Find the closest claim for an extracted RA record.
 *
 * The query is a tenant-scoped ±14 day window. The extracted patient name is
 * compared against each database client name with Levenshtein similarity; the
 * best score above 80% wins. Provider/agency names naturally score poorly
 * against patient rows and are rejected.
 */
function findClaimForRecord(record, agencyId) {
  const range = parseDateRange(record?.date_of_service ?? record?.dateOfService);
  if (!range.start) return null;

  const raName = record?.client_name ?? record?.clientName;
  if (!normalizeName(raName)) return null;

  const from = addDays(range.start, -DATE_WINDOW_DAYS);
  const to = addDays(range.end || range.start, DATE_WINDOW_DAYS);
  const candidates = db
    .prepare(
      `${DB_CLAIM_SELECT}
        WHERE cl.agency_id = ?
          AND cl.period_start <= ?
          AND cl.period_end >= ?
        ORDER BY cl.period_start DESC, cl.id DESC`
    )
    .all(agencyId, to, from);

  let best = null;
  let bestScore = 0;
  let bestOverlapping = null;
  let bestOverlappingScore = 0;
  let bestExactDate = null;
  let bestExactDateScore = 0;

  for (const claim of candidates) {
    const primaryName = `${claim.first_name ?? ''} ${claim.last_name ?? ''}`;
    const alternativeNames = String(claim.alternative_names ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const raLasts = lastNameCandidates(raName);
    const dbLasts = [
      ...lastNameCandidates(claim.last_name),
      ...alternativeNames.flatMap((name) => lastNameCandidates(name)),
    ].filter(Boolean);
    // Rule 1: no surname gate, no match — never inspect the first name.
    if (!raLasts.some((raLast) => dbLasts.some((dbLast) => sameSurname(raLast, dbLast)))) {
      continue;
    }
    const score = Math.max(
      nameSimilarity(raName, primaryName),
      ...alternativeNames.map((name) => nameSimilarity(raName, name))
    );
    const claimStart = parseDateRange(claim.period_start).start;
    const claimEnd = parseDateRange(claim.period_end).end;
    const overlaps =
      claimStart &&
      claimEnd &&
      range.start <= claimEnd &&
      (range.end || range.start) >= claimStart;

    if (overlaps && score > bestOverlappingScore) {
      bestOverlapping = claim;
      bestOverlappingScore = score;
    }
    if (
      claim.date_of_service &&
      claim.date_of_service === range.start &&
      score > bestExactDateScore
    ) {
      bestExactDate = claim;
      bestExactDateScore = score;
    }
    if (score > bestScore) {
      best = claim;
      bestScore = score;
    }
  }

  if (bestExactDate && bestExactDateScore >= NAME_MATCH_THRESHOLD) {
    return bestExactDate;
  }
  if (bestOverlapping && bestOverlappingScore >= NAME_MATCH_THRESHOLD) {
    return bestOverlapping;
  }
  if (!best || bestScore < NAME_MATCH_THRESHOLD) return null;
  return best;
}

/**
 * Vision models sometimes return labels ("PATIENT/CLIENT", "Member ID") while
 * the text path returns snake_case keys. Canonicalize both before comparison.
 */
function normalizeRaRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  const value = (...keys) => {
    const aliases = new Set(keys.map(normalizeKey));
    for (const [key, candidate] of Object.entries(record)) {
      if (
        aliases.has(normalizeKey(key)) &&
        candidate !== undefined &&
        candidate !== null &&
        String(candidate).trim() !== ''
      ) {
        return candidate;
      }
    }
    return undefined;
  };

  return {
    ...record,
    member_id: value('member_id', 'memberId', 'Member ID', 'MemberId', 'member id'),
    client_name: value(
      'client_name',
      'clientName',
      'Client Name',
      'PATIENT/CLIENT',
      'Patient/Client',
      'Patient/Client Name',
      'Patient Name',
      'patient_name',
      'Client'
    ),
    date_of_service: value(
      'date_of_service',
      'dateOfService',
      'Date of Service',
      'Dates of Service',
      'Date(s) of Service',
      'date of service',
      'dates of service',
      'DOS'
    ),
    amount_paid: value(
      'amount_paid',
      'amountPaid',
      'Amount Paid',
      'amount paid',
      'Paid Amount',
      'PAID',
      'Paid'
    ),
  };
}

/**
 * Split a field containing multiple dates mashed together, e.g.
 * "03-20-2603-21-26" -> ["03-20-26", "03-21-26"].
 */
function splitConcatenatedDates(value) {
  const text = String(value ?? '').trim();
  const matches = [...text.matchAll(/(\d{2}-\d{2}-\d{2})/g)].map((m) => m[1]);
  if (matches.length < 2) return [text];
  const compact = text.replace(/[^0-9-]/g, '');
  if (compact !== matches.join('')) return [text];
  return matches;
}

/** Duplicate a record once per individual date before claim matching. */
function expandConcatenatedDateRecords(records) {
  const expanded = [];
  for (const record of records) {
    const normalized = normalizeRaRecord(record);
    const dates = splitConcatenatedDates(normalized.date_of_service);
    if (dates.length > 1) {
      console.log(
        `[PARSER] Split concatenated date "${normalized.date_of_service}" into ${dates.length} records`
      );
      for (const date of dates) {
        expanded.push({ ...normalized, date_of_service: date, dateOfService: date });
      }
    } else {
      expanded.push(normalized);
    }
  }
  return expanded;
}

/** Compare one extracted record with its DB claim. */
function verifyRecord(record, agencyId) {
  record = normalizeRaRecord(record);
  const claim = findClaimForRecord(record, agencyId);
  if (!claim) {
    return {
      ra_data: record,
      db_data: null,
      status: 'missing_in_db',
      discrepancy: 'No matching claim found in the database.',
    };
  }

  const raAmount = parseCurrency(record?.amount_paid ?? record?.amountPaid);
  const dbAmount = claimPaidAmount(claim);
  if (!Number.isFinite(raAmount) || !Number.isFinite(dbAmount)) {
    return {
      ra_data: record,
      db_data: claim,
      status: 'mismatch',
      discrepancy: 'Could not parse amount',
    };
  }

  if (Math.abs(raAmount - dbAmount) < 0.01) {
    return { ra_data: record, db_data: claim, status: 'match', discrepancy: null };
  }

  return {
    ra_data: record,
    db_data: claim,
    status: 'mismatch',
    discrepancy: `Amount mismatch: RA says ${money(raAmount)}, DB says ${money(dbAmount)}.`,
  };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Explain why a parsed RA row could not be attached to a DB claim.
 */
function logMatchFail(record, claim = null) {
  const dbDates = claim
    ? `${claim.period_start ?? '?'}..${claim.period_end ?? '?'}`
    : 'none';
  console.warn(
    `[MATCH-FAIL] Client: ${record?.client_name ?? 'unknown'}, RA Date: ${
      record?.date_of_service ?? 'unknown'
    }, DB Dates Searched: ${dbDates}, RA Amount: ${record?.amount_paid ?? 'unknown'}`
  );
}

/**
 * Group daily RA records by their DB claim, sum only dates inside the claim
 * period, and compare the aggregate to the claim total.
 */
export function groupRecordsByClaim(records, agencyId) {
  const groups = new Map();
  const unmatched = [];
  const needsReview = [];
  const deniedSuccess = [];

  for (const input of records) {
    const record = normalizeRaRecord(input);
    const statusText = String(record.claim_status ?? record.claimStatus ?? '').toUpperCase();
    const isDenied = statusText.includes('DENIED') || statusText.includes('DENY');
    const amount = isDenied ? 0 : parseCurrency(record.amount_paid);
    if (isDenied) record.amount_paid = 0;
    if (!Number.isFinite(amount)) {
      console.warn(`[VISION-MISSING-AMOUNT] ${JSON.stringify(input)}`);
      const claim = findClaimForRecord(record, agencyId);
      needsReview.push({
        ra_data: record,
        db_data: claim ?? null,
        status: 'needs_review',
        discrepancy: 'AI could not extract the paid amount for this date.',
      });
      continue;
    }
    const claim = findClaimForRecord(record, agencyId);
    if (!claim) {
      if (isDenied) {
        deniedSuccess.push({
          ra_data: record,
          db_data: null,
          status: 'denied_success',
          matched_to_db: false,
          is_denied: true,
          discrepancy: 'Claim was denied by the state. No payment expected.',
        });
        continue;
      }
      logMatchFail(record);
      unmatched.push(record);
      continue;
    }

    const periodStart = parseDateRange(claim.period_start).start;
    const periodEnd = parseDateRange(claim.period_end).end;
    const range = parseDateRange(record.date_of_service);
    const recordStart = range.start;
    const recordEnd = range.end || range.start;
    const fallsInside =
      !periodStart ||
      !periodEnd ||
      (recordStart && recordEnd && recordStart <= periodEnd && recordEnd >= periodStart);

    if (!fallsInside) {
      logMatchFail(record, claim);
      unmatched.push(record);
      continue;
    }

    const key = claim.date_of_service
      ? `${claim.client_id}|${claim.period_start}|${claim.period_end}`
      : String(claim.id);
    if (!groups.has(key)) groups.set(key, { claim, records: [] });
    groups.get(key).records.push({ record, claim });
  }

  const results = [...needsReview, ...deniedSuccess];
  for (const { claim, records: groupedRecords } of groups.values()) {
    const dailyGroup = groupedRecords.some((entry) => entry.claim.date_of_service);
    const claimRecords = groupedRecords.map((entry) => entry.record);
    const periodStart = parseDateRange(claim.period_start).start;
    const periodEnd = parseDateRange(claim.period_end).end;

    if (dailyGroup) {
      const daily = groupedRecords
        .map(({ record, claim: dayClaim }) => {
          const raAmount = parseCurrency(record.amount_paid);
          const dbAmount = claimPaidAmount(dayClaim);
          const statusText = String(
            record.claim_status ?? record.claimStatus ?? ''
          ).toUpperCase();
          const reversal = statusText.includes('REVERSAL') || raAmount < 0;
          const denied = statusText.includes('DENIED') || statusText.includes('DENY');
          let status = 'paid';
          let discrepancy = null;
          if (denied) {
            status = 'matched_denied';
            discrepancy = 'Claim was denied by the state. No payment expected.';
          } else if (reversal) {
            status = 'matched_reversal';
            discrepancy = `Reversal matched: The state took back ${money(Math.abs(raAmount))}.`;
          } else if (!Number.isFinite(raAmount) || !Number.isFinite(dbAmount)) {
            status = 'mismatch';
            discrepancy = 'Could not parse amount';
          } else if (Math.abs(raAmount - dbAmount) >= 0.01) {
            status = 'mismatch';
            discrepancy = `Amount mismatch: RA ${money(raAmount)}, DB ${money(dbAmount)}.`;
          }
          return {
            date_of_service: record.date_of_service,
            charge_amount: parseCurrency(record.charge_amount),
            amount_paid: raAmount,
            db_paid: dbAmount,
            db_claim_id: dayClaim.id,
            status,
            is_reversal: reversal,
            is_denied: denied,
            matched_to_db: true,
            discrepancy,
          };
        })
        .filter((day) => day.date_of_service);

      if (!daily.length) {
        unmatched.push(...claimRecords);
        continue;
      }

      const primaryRecord = groupedRecords[0].record;
      const printedPaid = parseCurrency(primaryRecord.claim_total_paid);
      const printedCharge = parseCurrency(primaryRecord.claim_total_charge);
      const summedPaid = roundMoney(
        daily.reduce((sum, day) => sum + (day.amount_paid || 0), 0)
      );
      console.log(
        `[MATH-FIX] Extracted Doc Intel Total: ${
          Number.isFinite(printedPaid) ? printedPaid : 'null'
        }. Calculated Daily Sum: ${summedPaid}.`
      );
      const raTotal = summedPaid;
      const chargeTotal = Number.isFinite(printedCharge)
        ? roundMoney(printedCharge)
        : roundMoney(daily.reduce((sum, day) => sum + (day.charge_amount || 0), 0));
      const dbTotal = roundMoney(daily.reduce((sum, day) => sum + (day.db_paid || 0), 0));
      const primary = daily[0];
      const statuses = new Set(daily.map((day) => day.status));
      let status = 'paid';
      let discrepancy = null;
      if (statuses.has('matched_reversal')) {
        status = 'matched_reversal';
        discrepancy =
          daily.find((day) => day.status === 'matched_reversal')?.discrepancy ?? null;
      } else if (statuses.has('matched_denied')) {
        status = 'matched_denied';
        discrepancy = 'Claim was denied by the state. No payment expected.';
      } else if (
        !Number.isFinite(raTotal) ||
        !Number.isFinite(dbTotal) ||
        Math.abs(raTotal - dbTotal) >= 0.01
      ) {
        status = 'mismatch';
        const difference = roundMoney(Math.abs(raTotal - dbTotal));
        discrepancy = `Amount mismatch: RA total ${money(raTotal)}, DB total ${money(
          dbTotal
        )} (Difference: ${money(difference)}).`;
      }

      const hasReversal = daily.some((day) => day.is_reversal);
      const hasDenied = daily.some((day) => day.is_denied);
      results.push({
        ra_data: {
          ...primaryRecord,
          claim_status: primaryRecord.claim_status ?? null,
          amount_paid: raTotal,
          charge_amount: chargeTotal,
          date_of_service:
            periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : primary.date_of_service,
          claim_period_start: periodStart,
          claim_period_end: periodEnd,
          daily_records: daily,
        },
        db_data: {
          ...claim,
          paid_amount: dbTotal,
          total_dollars: chargeTotal,
        },
        status,
        discrepancy,
        matched_to_db: true,
        ...(hasReversal
          ? {
              reversal: true,
              is_reversal: true,
              reversal_amount: Math.abs(raTotal),
            }
          : {}),
        ...(hasDenied ? { is_denied: true } : {}),
      });
      continue;
    }
    const eligible = periodStart && periodEnd
      ? claimRecords.filter((record) => {
          const range = parseDateRange(record.date_of_service);
          const start = range.start;
          const end = range.end || range.start;
          return start && end && start <= periodEnd && end >= periodStart;
        })
      : claimRecords;

    if (periodStart && periodEnd && eligible.length === 0) {
      for (const record of claimRecords) logMatchFail(record, claim);
      unmatched.push(...claimRecords);
      continue;
    }

    const amounts = eligible
      .map((record) => parseCurrency(record.amount_paid))
      .filter(Number.isFinite);
    const charges = eligible
      .map((record) => parseCurrency(record.charge_amount))
      .filter(Number.isFinite);
    const primary = eligible[0];
    const printedPaid = parseCurrency(primary.claim_total_paid);
    const printedCharge = parseCurrency(primary.claim_total_charge);
    const summedPaid = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
    console.log(
      `[MATH-FIX] Extracted Doc Intel Total: ${
        Number.isFinite(printedPaid) ? printedPaid : 'null'
      }. Calculated Daily Sum: ${summedPaid}.`
    );
    const raTotal = summedPaid;
    const chargeTotal = Number.isFinite(printedCharge)
      ? roundMoney(printedCharge)
      : roundMoney(charges.reduce((sum, amount) => sum + amount, 0));
    const dbAmount = claimPaidAmount(claim);
    const claimStatus = String(primary.claim_status ?? primary.claimStatus ?? '').toUpperCase();
    const isReversal = claimStatus.includes('REVERSAL') || claimStatus.includes('REVERSED') || raTotal < 0;
    const isDenied = claimStatus.includes('DENIED') || claimStatus.includes('DENY');
    const hasPriorDenial = db
      .prepare(
        `SELECT 1 FROM claims
          WHERE client_id = ? AND agency_id = ?
            AND status IN ('reversal', 'denied', 'Reversed')
            AND period_start <= ? AND period_end >= ?
          LIMIT 1`
      )
      .get(claim.client_id, agencyId, periodEnd, periodStart);
    let status;
    let discrepancy = null;

    if (!amounts.length || !Number.isFinite(dbAmount)) {
      status = 'mismatch';
      discrepancy = 'Could not parse amount';
    } else if (isDenied) {
      status = 'matched_denied';
      discrepancy = 'Claim was denied by the state. No payment expected.';
    } else if (isReversal) {
      const takenBack = roundMoney(Math.abs(raTotal));
      status = 'matched_reversal';
      discrepancy =
        Math.abs(takenBack - dbAmount) < 0.01
          ? `Reversal matched: The state took back ${money(takenBack)}.`
          : `Reversal matched: The state took back ${money(takenBack)}; DB shows ${money(
              dbAmount
            )}.`;
    } else if (Math.abs(raTotal - dbAmount) < 0.01 && hasPriorDenial) {
      status = 'rebilled';
      discrepancy = null;
    } else if (Math.abs(raTotal - dbAmount) < 0.01) {
      status = 'paid';
    } else {
      status = 'mismatch';
      const difference = roundMoney(Math.abs(raTotal - dbAmount));
      discrepancy = `Amount mismatch: RA total ${money(raTotal)}, DB total ${money(
        dbAmount
      )} (Difference: ${money(difference)}).`;
    }

    results.push({
      ra_data: {
        ...primary,
        claim_status: claimStatus || primary.claim_status || null,
        amount_paid: raTotal,
        charge_amount: chargeTotal,
        date_of_service:
          periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : primary.date_of_service,
        claim_period_start: periodStart,
        claim_period_end: periodEnd,
        daily_records: eligible.map((record) => ({
          date_of_service: record.date_of_service,
          charge_amount: parseCurrency(record.charge_amount),
          amount_paid: parseCurrency(record.amount_paid),
        })),
      },
      db_data: claim,
      status,
      discrepancy,
      matched_to_db: true,
      ...(isReversal
        ? {
            reversal: true,
            is_reversal: true,
            reversal_amount: roundMoney(Math.abs(raTotal)),
          }
        : {}),
      ...(isDenied ? { is_denied: true } : {}),
    });
  }

  // Reconcile 277 claims that were imported as pending.
  for (const result of results) {
    if (!['paid', 'mismatch', 'rebilled'].includes(result.status)) continue;
    const clientId = result.db_data?.client_id;
    const periodStart = result.ra_data?.claim_period_start ?? result.db_data?.period_start;
    const periodEnd = result.ra_data?.claim_period_end ?? result.db_data?.period_end;
    if (!clientId || !periodStart || !periodEnd) continue;
    const pending = db.prepare(
      `SELECT id, expected_payment FROM claims
        WHERE agency_id = ? AND client_id = ? AND status = 'pending'
          AND period_start <= ? AND period_end >= ?
        ORDER BY id LIMIT 1`
    ).get(agencyId, clientId, periodEnd, periodStart);
    if (!pending) continue;
    const paidAmount = parseCurrency(result.ra_data?.amount_paid);
    const expected = parseCurrency(pending.expected_payment);
    const nextStatus =
      result.status === 'paid' &&
      Number.isFinite(paidAmount) &&
      Number.isFinite(expected) &&
      Math.abs(paidAmount - expected) >= 0.01
        ? 'mismatch'
        : result.status;
    db.prepare(
      `UPDATE claims SET status = ?, paid_amount = ?, paid_date = date('now') WHERE id = ? AND agency_id = ?`
    ).run(nextStatus, Number.isFinite(paidAmount) ? paidAmount : null, pending.id, agencyId);
    console.log(
      `[RECONCILIATION] Pending claim moved to ${nextStatus} for ${
        result.ra_data?.client_name ?? 'unknown client'
      }.`
    );
  }

  if (unmatched.length) {
    const dates = unmatched
      .map((record) => parseDateRange(record.date_of_service))
      .flatMap((range) => [range.start, range.end].filter(Boolean))
      .sort();
    const amounts = unmatched
      .map((record) => parseCurrency(record.amount_paid))
      .filter(Number.isFinite);
    const total = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
    const first = unmatched[0];
    const count = unmatched.length;

    results.push({
      status: 'missing_in_db',
      client_name: first.client_name ?? first.clientName ?? '—',
      claim_period_start: dates[0] ?? null,
      claim_period_end: dates[dates.length - 1] ?? null,
      amount_paid: total,
      discrepancy: `${count} RA record${count === 1 ? '' : 's'} totaling ${money(
        total
      )} ${count === 1 ? 'has' : 'have'} no matching claim in the DB.`,
      unmatched: true,
      unmatched_count: count,
    });
  }

  console.log(
    `[RA] Grouped ${records.length} RA record(s) into ${results.length} result(s); unmatched: ${unmatched.length}.`
  );
  return results;
}

function parseJsonRecords(text) {
  const cleaned = String(text ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/**
 * Convert Doc Intel table cells into daily RA rows using the printed header
 * labels, never by guessing decimal positions.
 */
export function docIntelTableRows(tables) {
  const rows = [];
  (Array.isArray(tables) ? tables : []).forEach((table, tableIndex) => {
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    const grid = new Map();
    for (const cell of cells) {
      const row = Number(cell?.rowIndex) || 0;
      const col = Number(cell?.columnIndex) || 0;
      if (!grid.has(row)) grid.set(row, new Map());
      grid.get(row).set(col, String(cell?.content ?? '').trim());
    }
    const tableClient = cells
      .map((cell) => String(cell?.content ?? '').trim())
      .map((value) => value.match(/^PATIENT\s*:\s*([^\n]+)/im)?.[1]?.trim())
      .find(Boolean) ?? null;
    const ordered = [...grid.keys()].sort((a, b) => a - b);
    let current = null;
    const flush = () => {
      if (!current) return;
      const decimals = current.values
        .map((value) => String(value).match(/-?\d[\d,]*\.\d{2}/)?.[0])
        .filter(Boolean)
        .map((value) => Number(value.replace(/,/g, '')))
        .filter(Number.isFinite);
      if (decimals.length >= 2) {
        rows.push({
          tableIndex,
          client_name: tableClient,
          date: current.date,
          // CHARGE is the first decimal; PAYMENT is the last decimal across
          // continuation rows. The adjustment cell is never used as payment.
          paid: decimals[decimals.length - 1],
          charge: decimals[0],
        });
      }
      current = null;
    };

    for (const rowIndex of ordered) {
      const values = [...grid.get(rowIndex).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
      // Doc Intel sometimes puts the sequence and both dates in the same cell
      // ("12 02-12-26 02-12-26"), so inspect the first cell rather than
      // requiring a standalone two-digit cell.
      const hasSequence = /^\d{2}(?:\s|$)/.test(values[0] ?? '');
      const dateValue = values.find((value) => /\d{2}-\d{2}-\d{2}/.test(value));
      if (hasSequence && dateValue) {
        flush();
        current = { date: parseDateRange(dateValue).start, values: [...values] };
        continue;
      }
      // Continuation of a service row (split by Doc Intel). Do not append a
      // totals/PAT RESP row to the last service line.
      if (current && !/TOTAL|PAT\s+RESP/i.test(values.join(' '))) {
        current.values.push(...values);
      }
    }
    flush();
  });
  return rows;
}

function docIntelTableTotals(tables) {
  const totals = new Map();
  (Array.isArray(tables) ? tables : []).forEach((table, tableIndex) => {
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    const ordered = cells
      .map((cell) => ({
        row: Number(cell?.rowIndex) || 0,
        col: Number(cell?.columnIndex) || 0,
        content: String(cell?.content ?? '').trim(),
      }))
      .sort((a, b) => a.row - b.row || a.col - b.col);
    let paid = null;
    let charge = null;
    for (let i = 0; i < ordered.length; i += 1) {
      const cell = ordered[i];
      if (!/TOTAL\s+PAYMENT/i.test(cell.content)) continue;
      const inline = cell.content.match(/TOTAL\s+PAYMENT\s*:?\s*([\d,]+\.\d{2})/i);
      if (inline) {
        paid = Number(inline[1].replace(/,/g, ''));
        break;
      }
      const next = ordered.slice(i + 1).find((candidate) => /^[\d,]+\.\d{2}$/.test(candidate.content));
      if (next) {
        paid = Number(next.content.replace(/,/g, ''));
        break;
      }
    }
    for (const cell of ordered) {
      const match = cell.content.match(/TOTAL\s+CHARGE\s*:?\s*([\d,]+\.\d{2})/i);
      if (match) {
        charge = Number(match[1].replace(/,/g, ''));
        break;
      }
    }
    totals.set(tableIndex, { paid, charge });
  });
  return totals;
}

/**
 * Map Doc Intel layout tables plus parsed client metadata into daily RA
 * records. Reused by the HTTP pipeline and the 22-document regression suite.
 */
export function buildDocIntelRecords(extracted) {
  const rawText = String(extracted?.text ?? '').trim();
  const parsed = parseRemittance(rawText);
  const tableRows = docIntelTableRows(extracted?.tables);
  const tableTotals = docIntelTableTotals(extracted?.tables);
  console.log(`[DOC-INTEL] Structured table rows: ${tableRows.length}`);
  const tableIndices = [...new Set(tableRows.map((row) => row.tableIndex))].sort(
    (a, b) => a - b
  );
  const nameKey = (name) =>
    normalizeName(name)
      .split(' ')
      .filter((part) => part.length > 1)
      .sort()
      .join(' ');
  const clientByKey = new Map();
  const looksLikeClient = (candidate) =>
    candidate?.client_name &&
    !/[|]|CLAIM TYPE|PAYEE ID|PROV ID|CTRL NBR|ADJ RSN/i.test(candidate.client_name);
  for (const client of (parsed.clients ?? []).filter(
    (candidate) =>
      candidate.dos_start &&
      candidate.dos_end &&
      candidate.line_items?.length &&
      looksLikeClient(candidate)
  )) {
    // Doc Intel's table text can produce a second, partial client block. Keep
    // the fullest block for the same first/last name, and discard partial
    // blocks when the table names the real client.
    const key = nameKey(client.client_name);
    const current = clientByKey.get(key);
    if (!current || (client.line_items?.length ?? 0) > (current.line_items?.length ?? 0)) {
      clientByKey.set(key, client);
    }
  }
  const allClientKeys = [...clientByKey.keys()];
  const validClients = [...clientByKey.entries()]
    .filter(([key]) => {
      // "MATTSON" is a partial OCR block of "MATTSON SAMANTHA A"; drop it when
      // the fuller block exists.
      return !allClientKeys.some(
        (other) =>
          other !== key &&
          other.startsWith(`${key} `) &&
          (clientByKey.get(other)?.line_items?.length ?? 0) >=
            (clientByKey.get(key)?.line_items?.length ?? 0)
      );
    })
    .map(([, client]) => client);
  // Match each table to a parsed client using its PATIENT cell when present,
  // then its printed total and date range. This survives split tables that do
  // not repeat the patient header on a continuation page.
  const tableRecords = [];
  const seenClientDates = new Set();
  for (const index of tableIndices) {
    const rows = tableRows.filter((row) => row.tableIndex === index);
    if (!rows.length) continue;
    const tableClient = looksLikeClient({ client_name: rows.find((row) => row.client_name)?.client_name })
      ? rows.find((row) => row.client_name)?.client_name
      : null;
    const tableKey = tableClient ? nameKey(tableClient) : null;
    const total = tableTotals.get(index) ?? {};
    const tableDates = rows.map((row) => row.date).filter(Boolean).sort();
    const tableStart = tableDates[0] ?? null;
    const tableEnd = tableDates[tableDates.length - 1] ?? null;
    const scored = validClients
      .map((candidate) => {
        const key = nameKey(candidate.client_name);
        let score = 0;
        if (tableKey) {
          if (key === tableKey) score += 10;
          else if (key.startsWith(`${tableKey} `) || tableKey.startsWith(`${key} `)) score += 6;
          else return null;
        }
        if (candidate.dos_start === tableStart && candidate.dos_end === tableEnd) score += 3;
        if (Number.isFinite(total.paid) && Number(candidate.claim_total_paid) === Number(total.paid)) {
          score += 5;
        }
        return { candidate, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const client = scored[0]?.candidate;
    if (!client) continue;
    const tableDateSet = new Set(rows.map((row) => row.date));
    const lowerBound = tableStart ? addDays(tableStart, -1) : client.dos_start;
    const missingItems = (client.line_items ?? []).filter(
      (item) =>
        item.date &&
        (!lowerBound || item.date >= lowerBound) &&
        (!tableEnd || item.date <= tableEnd) &&
        !tableDateSet.has(item.date)
    );
    const periodDates = [...tableDates, ...missingItems.map((item) => item.date)];
    const periodStart = periodDates.sort()[0] ?? client.dos_start;
    const periodEnd = periodDates[periodDates.length - 1] ?? client.dos_end;
    for (const row of rows) {
      const clientDateKey = `${nameKey(client.client_name)}|${row.date}`;
      if (seenClientDates.has(clientDateKey)) continue;
      seenClientDates.add(clientDateKey);
      tableRecords.push({
        client_name: client.client_name,
        member_id: client.patient_id ?? null,
        claim_status: client.claim_status ?? null,
        claim_total_paid: total.paid ?? client.claim_total_paid ?? client.total_payment ?? null,
        claim_total_charge:
          total.charge ?? client.claim_total_charge ?? client.total_charge ?? null,
        claim_period_start: periodStart ?? client.dos_start ?? row.date,
        claim_period_end: periodEnd ?? client.dos_end ?? row.date,
        date_of_service: row.date,
        amount_paid: row.paid,
        charge_amount: row.charge,
        procedure_code: null,
      });
    }
    // A table split across a page can omit a service row. Backfill only the
    // missing dates from the parser's line items; the printed table total
    // remains authoritative.
    for (const item of missingItems) {
      const clientDateKey = `${nameKey(client.client_name)}|${item.date}`;
      if (seenClientDates.has(clientDateKey)) continue;
      seenClientDates.add(clientDateKey);
      tableRecords.push({
        client_name: client.client_name,
        member_id: client.patient_id ?? null,
        claim_status: client.claim_status ?? null,
        claim_total_paid: total.paid ?? client.claim_total_paid ?? client.total_payment ?? null,
        claim_total_charge:
          total.charge ?? client.claim_total_charge ?? client.total_charge ?? null,
        claim_period_start:
          periodStart && item.date >= periodStart ? periodStart : item.date,
        claim_period_end: periodEnd ?? item.date,
        date_of_service: item.date,
        amount_paid: item.paid,
        charge_amount: item.billed,
        procedure_code: item.procedure_code ?? null,
      });
    }
  }
  if (tableRecords.length) {
    return { records: tableRecords, rawText, parsed, tableRows };
  }

  const alignedTables = tableIndices.length === validClients.length;
  const records = [];

  for (const [clientIndex, client] of validClients.entries()) {
    const clientKey = nameKey(client.client_name);
    const matchingTableIndex = tableIndices.find((index) =>
      tableRows.some(
        (row) => row.tableIndex === index && row.client_name && nameKey(row.client_name) === clientKey
      )
    );
    const tableIndex = matchingTableIndex ?? (alignedTables ? tableIndices[clientIndex] : null);
    const tableRowsForClient = tableIndex != null
      ? tableRows.filter((row) => row.tableIndex === tableIndex)
      : [];
    const tableTotal = tableIndex != null ? tableTotals.get(tableIndex) ?? {} : {};
    console.log(
      `[PARSER-TOTALS] Client: ${client.client_name ?? 'unknown'}. Period: ${
        client.dos_start ?? '?'
      } to ${client.dos_end ?? '?'}. Extracted TOTAL PAYMENT: ${
        tableTotal.paid ?? client.claim_total_paid ?? client.total_payment ?? 'null'
      }`
    );
    const sourceItems = tableRowsForClient.length
      ? tableRowsForClient
      : (client.line_items ?? []).map((item) => ({
          date: item.date,
          paid: item.paid,
          charge: item.billed,
        }));
    const seenDates = new Set();
    for (const item of sourceItems) {
      const rawDate = item.date;
      const dateOfService = /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate ?? ''))
        ? rawDate
        : (() => {
            const match = /^(\d{2})-(\d{2})-(\d{2})$/.exec(String(rawDate ?? ''));
            return match ? `20${match[3]}-${match[1]}-${match[2]}` : null;
          })();
      if (!dateOfService || seenDates.has(dateOfService)) continue;
      seenDates.add(dateOfService);
      records.push({
        client_name: client.client_name,
        member_id: client.patient_id ?? null,
        claim_status: client.claim_status ?? null,
        claim_total_paid:
          tableTotal.paid ?? client.claim_total_paid ?? client.total_payment ?? null,
        claim_total_charge:
          tableTotal.charge ?? client.claim_total_charge ?? client.total_charge ?? null,
        claim_period_start: client.dos_start ?? dateOfService,
        claim_period_end: client.dos_end ?? dateOfService,
        date_of_service: dateOfService,
        amount_paid: item.paid,
        charge_amount: item.charge ?? item.billed ?? null,
        procedure_code: item.procedure_code ?? null,
      });
    }
  }

  return { records, rawText, parsed, tableRows };
}

/**
 * Process one uploaded RA file with the shared single-file/bulk pipeline.
 */
async function processRaFile(file, agencyId) {
  const isPdf =
    file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');

  if (isPdf) {
    let extracted;
    try {
      // PDFs go through Doc Intel's layout model. pdf-parse is no longer used
      // on this path because sideways RA columns cannot be trusted as a text
      // stream.
      extracted = await extractRaWithAzureDocIntel(file.buffer, 'application/pdf');
    } catch (err) {
      err.status = err.status || 502;
      throw err;
    }
    const rawText = String(extracted?.text ?? '').trim();
    console.log(`[DOC-INTEL] Extracted text length: ${rawText.length} characters.`);
    if (!rawText) {
      const err = new Error('Azure Document Intelligence returned no RA text.');
      err.status = 502;
      throw err;
    }

    const { records } = buildDocIntelRecords(extracted);

    if (!records.length) {
      const err = new Error(
        'Could not parse RA document. Please ensure it is a valid format.'
      );
      err.status = 422;
      throw err;
    }

    console.log(
      `[DOC-INTEL] Extracted ${records.length} daily record(s) from structured tables.`
    );
    return {
      records: groupRecordsByClaim(
        expandConcatenatedDateRecords(records),
        agencyId
      ),
      rawText,
    };
  }

  const mimeType = file.mimetype || 'image/png';
  const extracted = await extractRaWithAzureDocIntel(file.buffer, mimeType);
  const rawText = String(extracted?.text ?? '').trim();
  if (!rawText) {
    const err = new Error('Azure Document Intelligence failed to read this image.');
    err.status = 502;
    throw err;
  }
  console.log(`[DOC-INTEL] Final text length: ${rawText.length} characters`);

  const completion = await complete(
    `Here is the text extracted from an RA letter:\n\n${rawText.slice(
      0,
      15000
    )}\n\nExtract the records.`,
    {
      system: RA_TEXT_SYSTEM_PROMPT,
      timeoutMs: 60000,
      agencyId,
      maxOutputTokens: 4000,
    }
  );

  if (completion.source === 'none') {
    console.warn(
      '[AI-EMPTY-RESPONSE] completion source none:',
      completion.text || '(no response text)'
    );
    const err = new Error(completion.text || 'Azure text completion failed.');
    err.status = 502;
    throw err;
  }

  const records = parseJsonRecords(completion.text);
  if (!records) {
    console.warn('[AI-EMPTY-RESPONSE] Could not parse AI response:', completion.text);
    const err = new Error('Azure text completion returned no JSON records.');
    err.status = 502;
    throw err;
  }
  if (records.length === 0) {
    console.warn('[AI-EMPTY-RESPONSE]', completion.text);
  }

  return {
    records: groupRecordsByClaim(
      expandConcatenatedDateRecords(records),
      agencyId
    ),
    rawText,
  };
}

/** POST /api/ai/verify-ra — multipart field name: file */
router.post('/verify-ra', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than the 15 MB limit.'
          : 'The file could not be uploaded.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or image to verify.' });
    if (!allowedFile(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF or image file.' });
    }

    try {
      const { records, rawText } = await processRaFile(req.file, req.agencyId);
      res.json({
        status: 'success',
        records,
        ...(records.length === 0 ? { raw_text: rawText } : {}),
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[PDF-RENDER-ERROR] unhandled RA verification error:', err?.stack || err);
      return res.status(500).json({ error: err?.message || 'RA verification failed.' });
    }  });
});


/** GET /api/ai/debug-status — whether the optional Doc Intel debug panel is enabled. */
router.get('/debug-status', (req, res) => {
  res.json({ debug_mode: String(process.env.DEBUG_MODE ?? '').toLowerCase() === 'true' });
});

/** POST /api/ai/test-doc-intel — Doc Intel extraction only, no AI call. */
router.post('/test-doc-intel', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'The file could not be uploaded.' });
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or image.' });
    if (!allowedFile(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF or image file.' });
    }
    try {
      const extracted = await extractRaWithAzureDocIntel(
        req.file.buffer,
        req.file.mimetype || 'application/pdf'
      );
      const rawText = String(extracted?.text ?? '').trim();
      res.json({
        raw_text: rawText,
        length: rawText.length,
        tables: Array.isArray(extracted?.tables) ? extracted.tables : [],
        file: req.file.originalname,
      });
    } catch (e) {
      console.error('[DOC-INTEL] test extraction failed:', e?.stack || e);
      res.status(e.status || 500).json({ error: e.message || 'Doc Intel extraction failed.' });
    }
  });
});

/* ------------------------------------------------------------------ bulk */

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
console.warn('[bulk] in-memory RA queue enabled (concurrency 2); jobs will be lost on restart.');

const bulkSummaryCache = new Map();

function bulkSummaryCounts(results) {
  const records = results.flatMap((entry) => entry.records ?? []);
  const count = (status) => records.filter((record) => record.status === status).length;
  return {
    files: results.length,
    records: records.length,
    paid: count('paid') + count('match') + count('rebilled'),
    matched_reversals: count('matched_reversal'),
    matched_denials: count('matched_denied'),
    denied_success: count('denied_success'),
    mismatches: count('mismatch'),
    missing: count('missing_in_db') + count('needs_review'),
    total_paid: roundMoney(
      records.reduce((sum, record) => sum + (Number(record.ra_data?.amount_paid) || 0), 0)
    ),
    errors: records
      .filter((record) =>
        ['mismatch', 'missing_in_db', 'needs_review'].includes(record.status)
      )
      .map((record) => ({
        client: record.ra_data?.client_name ?? record.client_name ?? 'Unknown client',
        status: record.status,
        discrepancy: record.discrepancy ?? '',
      })),
  };
}

async function summarizeBulkResults(jobId, results, agencyId) {
  if (bulkSummaryCache.has(jobId)) return bulkSummaryCache.get(jobId);
  const counts = bulkSummaryCounts(results);
  const errorLines = counts.errors
    .slice(0, 12)
    .map((error) => `- ${error.client}: ${error.discrepancy || error.status}`)
    .join('\n');
  const fallback = `Processed ${counts.files} file${
    counts.files === 1 ? '' : 's'
  }. Found ${counts.mismatches} mismatch${counts.mismatches === 1 ? '' : 'es'} and ${
    counts.missing
  } missing claim${counts.missing === 1 ? '' : 's'}.`;
  const prompt = `RA batch result:
Files processed: ${counts.files}
Claims processed: ${counts.records}
Total RA paid: ${money(counts.total_paid)}
Paid/matched: ${counts.paid}
Matched reversals: ${counts.matched_reversals}
Matched denials: ${counts.matched_denials}
Successful $0 denials: ${counts.denied_success}
Mismatches: ${counts.mismatches}
Missing: ${counts.missing}
${errorLines ? `Critical errors:\n${errorLines}` : 'No critical errors.'}

Write a plain-English summary in 2 sentences. Highlight the most critical errors, naming the client and dollar amount when available. If there are no errors, say the batch matched cleanly.`;
  const { text } = await complete(prompt, {
    system:
      'You are a billing assistant. Summarize this RA batch processing result in 2 sentences. Highlight the most critical errors (e.g., "Samantha Mattson was short-paid by $92.54").',
    agencyId,
    timeoutMs: 15000,
    maxOutputTokens: 220,
  });
  const summary =
    text && !/^AI Summary unavailable/i.test(text) ? text.trim() : fallback;
  const payload = { summary, source: summary === fallback ? 'fallback' : 'ai' };
  bulkSummaryCache.set(jobId, payload);
  return payload;
}

function jobIsTimedOut(row) {
  if (!row || !['queued', 'processing'].includes(row.status)) return false;
  const created = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
  return Number.isFinite(created) && Date.now() - created > JOB_TIMEOUT_MS;
}

function markJobTimedOut(jobId) {
  db.prepare(
    `UPDATE ra_verification_jobs
        SET status = 'failed', error = 'Job timed out', updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'processing')`
  ).run(jobId);
}

function parseResults(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runBulkJob(job) {
  try {
    const row = db
      .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
      .get(job.id);
    if (!row) return;
    if (jobIsTimedOut(row)) {
      markJobTimedOut(job.id);
      return;
    }

    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'processing', updated_at = datetime('now')
        WHERE id = ?`
    ).run(job.id);

    let stopped = false;
    await Promise.all(
      job.files.map((file, index) =>
        fileLimit(async () => {
          if (stopped) return;

          const current = db
            .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
            .get(job.id);
          if (jobIsTimedOut(current)) {
            stopped = true;
            markJobTimedOut(job.id);
            return;
          }

          let entry;
          console.log(
            `[BULK-WORKER] Starting file ${index + 1} of ${job.files.length}: ${file.originalname}`
          );
          try {
            const buffer = fs.readFileSync(file.path);
            const processed = await withTimeout(
              processRaFile(
                {
                  buffer,
                  originalname: file.originalname,
                  mimetype: file.mimetype,
                },
                job.agencyId
              ),
              120000,
              'Azure API request timed out.'
            );
            entry = {
              file_name: file.originalname,
              status: 'completed',
              records: processed.records,
              ...(processed.records.length === 0 ? { raw_text: processed.rawText } : {}),
            };
          } catch (err) {
            entry = {
              file_name: file.originalname,
              status: 'error',
              records: [],
              error: err?.message || 'File processing failed.',
            };
          }

          console.log(
            `[BULK-WORKER] Finished file ${index + 1} with status: ${entry.status}`
          );
          if (stopped) return;
          job.results.push(entry);
          db.prepare(
            `UPDATE ra_verification_jobs
                SET processed_files = processed_files + 1,
                    results_json = ?,
                    updated_at = datetime('now')
              WHERE id = ?`
          ).run(JSON.stringify(job.results), job.id);
        })
      )
    );

    if (stopped) return;

    const finalRow = db
      .prepare(`SELECT status, created_at FROM ra_verification_jobs WHERE id = ?`)
      .get(job.id);
    if (jobIsTimedOut(finalRow)) {
      markJobTimedOut(job.id);
      return;
    }

    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'completed',
              processed_files = ?,
              results_json = ?,
              error = NULL,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(job.files.length, JSON.stringify(job.results), job.id);

    fs.rm(path.join(BULK_DIR, job.id), { recursive: true, force: true }, () => {});
  } catch (err) {
    console.error('[bulk] job failed:', err?.stack || err);
    db.prepare(
      `UPDATE ra_verification_jobs
          SET status = 'failed', error = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(err?.message || 'Bulk job failed.', job.id);
  }
}

/** POST /api/ai/verify-ra-bulk — multipart field name: files (max 300). */
router.post(
  '/verify-ra-bulk',
  (req, _res, next) => {
    req.bulkJobId = crypto.randomUUID();
    next();
  },
  (req, res) => {
    bulkUpload.array('files', 300)(req, res, (err) => {
      const dir = path.join(BULK_DIR, req.bulkJobId);
      if (err) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Each file must be 15 MB or smaller.'
            : err.code === 'LIMIT_FILE_COUNT'
              ? 'You can upload at most 300 files at once.'
              : 'The files could not be uploaded.';
        return res.status(400).json({ error: message });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({ error: 'Choose at least one PDF or image.' });
      }
      const invalid = files.find((file) => !allowedFile(file));
      if (invalid) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        return res.status(400).json({ error: `Unsupported file: ${invalid.originalname}` });
      }

      const jobId = req.bulkJobId;
      try {
        db.prepare(
          `INSERT INTO ra_verification_jobs
             (id, agency_id, status, total_files, processed_files, results_json, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, 0, '[]', datetime('now'), datetime('now'))`
        ).run(jobId, req.agencyId, files.length);
      } catch (dbError) {
        console.error('[bulk] could not create job:', dbError);
        fs.rm(dir, { recursive: true, force: true }, () => {});
        return res.status(500).json({ error: 'Could not create the bulk job.' });
      }

      const job = {
        id: jobId,
        agencyId: req.agencyId,
        files: files.map((file) => ({
          path: file.path,
          originalname: file.originalname,
          mimetype: file.mimetype,
        })),
        results: [],
      };

      // Return before processing. The global p-limit(2) controls concurrency.
      res.status(202).json({ jobId, status: 'queued' });
      runBulkJob(job).catch((err) => {
        console.error('[bulk] unhandled worker error:', err?.stack || err);
      });
    });
  }
);

/** GET /api/ai/verify-ra-bulk/:jobId — tenant-scoped progress/results. */
router.get('/verify-ra-bulk/:jobId', async (req, res) => {
  let row = db
    .prepare(
      `SELECT id, status, total_files, processed_files, results_json, error, created_at
         FROM ra_verification_jobs
        WHERE id = ? AND agency_id = ?`
    )
    .get(req.params.jobId, req.agencyId);

  if (!row) return res.status(404).json({ error: 'Bulk job not found.' });

  if (jobIsTimedOut(row)) {
    markJobTimedOut(row.id);
    row = db
      .prepare(
        `SELECT id, status, total_files, processed_files, results_json, error, created_at
           FROM ra_verification_jobs
          WHERE id = ? AND agency_id = ?`
      )
      .get(req.params.jobId, req.agencyId);
  }

  const results = parseResults(row.results_json);
  const bulkSummary =
    row.status === 'completed'
      ? await summarizeBulkResults(row.id, results, req.agencyId)
      : null; 

  res.json({
    status: row.status,
    total_files: row.total_files,
    processed_files: row.processed_files,
    results,
    error: row.error,
    summary: bulkSummary?.summary ?? null,
    summary_source: bulkSummary?.source ?? null,
  });
});

export default router;
