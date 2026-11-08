/**
 * Bucket a claim's money across the months the WORK happened in.
 *
 * Importing a year of advices on one afternoon stamps every claim with the same
 * created_at and paid_date, so a cash-date chart collapses to a single bar. The
 * service dates are the only thing that actually spreads the work out.
 */
import { round2 } from './calc.js';

// Accepts YYYY-MM-DD and a bare YYYY-MM (treated as the 1st of that month),
// because the DOS axis mixes full dates with month-only fallbacks.
const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const utc = (iso) => {
  const m = ISO.exec(String(iso ?? '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1));
};
const monthOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const DAY = 86400000;

/**
 * [{ month, days }] for the inclusive range, split at month boundaries.
 * A one-day period yields a single entry.
 */
export function splitByMonth(startISO, endISO) {
  const a = utc(startISO);
  let b = utc(endISO);
  if (a == null) return [];
  if (b == null || b < a) b = a;
  const out = [];
  let cur = a;
  while (cur <= b) {
    const d = new Date(cur);
    // first instant of the next month
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const sliceEnd = Math.min(next - DAY, b);
    const days = Math.round((sliceEnd - cur) / DAY) + 1;
    out.push({ month: monthOf(cur), days });
    cur = next;
  }
  return out;
}

/**
 * Spread `amount` over the months a claim's period covers, by day count.
 *
 * The last slice absorbs the rounding residual so the parts always add back to
 * the whole — otherwise a chart total would drift from the summary cards.
 */
export function apportion(amount, startISO, endISO, fallbackMonth) {
  const parts = splitByMonth(startISO, endISO);
  const total = Number(amount) || 0;
  if (!parts.length) {
    // No service dates: the claim still has to appear somewhere, and the caller
    // flags it so the tooltip can say the month came from the import date.
    return fallbackMonth ? [{ month: fallbackMonth, value: round2(total), estimated: true }] : [];
  }
  const days = parts.reduce((s, p) => s + p.days, 0);
  let running = 0;
  return parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    const v = isLast ? round2(total - running) : round2((total * p.days) / days);
    running = round2(running + v);
    return { month: p.month, value: v, days: p.days, estimated: false };
  });
}

/** Every month from `from` to `to`, inclusive, as YYYY-MM. */
export function monthRange(fromISO, toISO) {
  const a = utc(fromISO);
  const b = utc(toISO);
  if (a == null || b == null || b < a) return [];
  const out = [];
  let cur = Date.UTC(new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), 1);
  const end = Date.UTC(new Date(b).getUTCFullYear(), new Date(b).getUTCMonth(), 1);
  while (cur <= end) {
    out.push(monthOf(cur));
    const d = new Date(cur);
    cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}
