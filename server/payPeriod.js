import { addDays, toISODate } from './calc.js';

/**
 * A fixed Sunday that anchors the fortnight parity. Any Sunday works — it only
 * decides which weeks pair up, so it must never change once chosen.
 */
export const PAY_PERIOD_ANCHOR = '2024-01-07';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Sunday on or before a date. Parsed as local time on purpose. */
export function sundayOf(dateISO) {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Sunday
  return toISODate(d);
}

/**
 * The bi-weekly Sunday→Saturday pay period containing a date.
 *
 * Both the Home Dashboard and the caretaker snapshot call this, so they can
 * never disagree about which fortnight it is.
 */
export function payPeriodFor(dateISO) {
  const sunday = sundayOf(dateISO);
  const weeks = Math.round(
    (new Date(`${sunday}T00:00:00`) - new Date(`${PAY_PERIOD_ANCHOR}T00:00:00`)) / (7 * DAY_MS)
  );
  const index = Math.floor(weeks / 2);
  const start = addDays(PAY_PERIOD_ANCHOR, index * 14);
  return { start, end: addDays(start, 13) };
}

/** Move a whole number of fortnights from a period. */
export function shiftPayPeriod(period, fortnights) {
  return {
    start: addDays(period.start, fortnights * 14),
    end: addDays(period.end, fortnights * 14),
  };
}

/**
 * The one place that decides whether a day entry counts.
 *
 * Every day entry counts. A day entry is a record of work actually performed,
 * and none of the three flags around it un-works those hours:
 *
 *  - the entry carries a single `claim_id`, so it can only ever be counted once;
 *  - archiving the claim that held it, or the client it was for, is a
 *    book-keeping action, not an erasure of the shift;
 *  - `source` is irrelevant — RA-imported hours are hours.
 *
 * Filtering on any of them made real work vanish from the ranking. (Archived
 * claims ARE excluded from Reports, where an archived claim plus its
 * replacement would double-count money — a different question.)
 *
 * The aliases `d` (day_entries), `cu` (clients) and `cl` (claims) are required;
 * `cl` must be LEFT JOINed.
 */
export const COUNTS_PREDICATE = `
  1 = 1
`;

/**
 * The validity rule for a day entry, exactly as the Home Dashboard applies it:
 * the entry must be reachable through a client that still exists and is not
 * archived, and its agreement reference must resolve.
 *
 * Requires the aliases `d` (day_entries), `cu` (clients) and `a` (agreements),
 * with `cu` INNER JOINed and `a` LEFT JOINed.
 */
export const VALID_ENTRY_SQL = `
  cu.id IS NOT NULL
  AND COALESCE(cu.archived, 0) = 0
  AND (d.agreement_id IS NULL OR a.id IS NOT NULL)
`;

/** The matching FROM clause. Keeping the two together prevents drift. */
/**
 * Entry FROM clause, scoped to one agency.
 *
 * The extra joins some callers need are part of the fragment rather than
 * appended after it: a `JOIN` cannot follow a `WHERE`, and the agency filter
 * has to come last. Returns a clause that already contains
 * `WHERE d.agency_id = @agency`, so callers must append `AND`, never `WHERE`.
 */
export function entryFrom({ caretaker = false, claim = false } = {}) {
  const parts = [
    'FROM day_entries d',
    'JOIN clients cu ON cu.id = d.client_id AND cu.agency_id = d.agency_id',
    'LEFT JOIN agreements a ON a.id = d.agreement_id AND a.agency_id = d.agency_id',
  ];
  if (caretaker) parts.push('JOIN caretakers t ON t.id = d.caretaker_id AND t.agency_id = d.agency_id');
  if (claim) parts.push('LEFT JOIN claims cl ON cl.id = d.claim_id AND cl.agency_id = d.agency_id');
  return `${parts.join('\n  ')}\n  WHERE d.agency_id = @agency`;
}

/** Backwards-compatible base clause (no extra joins). */
export const VALID_ENTRY_FROM = entryFrom();

/** Calendar-month bounds around a date, as ISO strings. */
export function monthBounds(dateISO) {
  const d = new Date(`${dateISO}T00:00:00`);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: toISODate(first), end: toISODate(last) };
}

/** Calendar-year bounds around a date, as ISO strings. */
export function yearBounds(dateISO) {
  const y = new Date(`${dateISO}T00:00:00`).getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** The FROM clause every counting query shares. */
/** Counting variant that joins claims instead of agreements. */
export const COUNTS_FROM = entryFrom({ claim: true });
