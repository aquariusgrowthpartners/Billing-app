/**
 * Money actually received.
 *
 * MHCP withholds a FORWARDING BALANCE from a check, and the per-claim
 * TOTAL PAYMENT lines do not net it out — so `SUM(claims.paid_amount)` runs
 * ABOVE the sum of the advices' PAYMENT AMOUNT lines. On the 08/25 advice the
 * per-claim total is $11,159.31 against a stated PAYMENT AMOUNT of $9,048.14,
 * and the $2,111.17 difference is exactly its forwarding balance.
 *
 * The authoritative figure is the check itself, recorded on the import as
 * `ra_imports.total_payment`. Each imported claim is therefore carried at its
 * share of that check, so per-claim values still add up to money received and
 * every card can simply SUM the same column.
 *
 * A claim with no import (entered by hand) keeps its own paid_amount — there is
 * no check to apportion.
 */
import db from './db.js';
import { round2 } from './calc.js';

/** import id -> factor that scales per-claim paid_amount down to the check. */
export function importFactors() {
  const rows = db
    .prepare(
      `SELECT i.id,
              i.total_payment AS check_total,
              (SELECT COALESCE(SUM(c.paid_amount), 0) FROM claims c WHERE c.ra_import_id = i.id) AS claim_total
       FROM ra_imports i`
    )
    .all();
  const factors = new Map();
  for (const r of rows) {
    const check = Number(r.check_total) || 0;
    const sum = Number(r.claim_total) || 0;
    // No check total (or nothing to scale) leaves the claims untouched.
    if (check > 0 && sum > 0) factors.set(r.id, check / sum);
  }
  return factors;
}

/**
 * claim id -> the exact amount that claim brought in.
 *
 * Apportioning the check across its claims and rounding each one leaves a few
 * cents adrift, so the LAST claim in each import absorbs the residual. That
 * makes SUM(net_paid_amount) equal ra_imports.total_payment to the cent, which
 * is what lets the Reports and Dashboard cards agree exactly rather than
 * to-within-rounding.
 */
let __map = null;
let __mapAt = 0;
export function netPaidMap() {
  if (__map && Date.now() - __mapAt < 5000) return __map;
  const out = new Map();
  for (const [importId, factor] of importFactors()) {
    const check = Number(
      db.prepare(`SELECT total_payment FROM ra_imports WHERE id = ?`).get(importId)?.total_payment
    ) || 0;
    const rows = db
      .prepare(`SELECT id, paid_amount FROM claims WHERE ra_import_id = ? ORDER BY id`)
      .all(importId);
    let running = 0;
    rows.forEach((r, i) => {
      const isLast = i === rows.length - 1;
      const v = isLast ? round2(check - running) : round2((Number(r.paid_amount) || 0) * factor);
      running = round2(running + v);
      out.set(r.id, v);
    });
  }
  __map = out;
  __mapAt = Date.now();
  return out;
}

/** The amount a claim actually brought in (falls back for hand-entered rows). */
export function netPaid(claim, _ignoredFactors) {
  const recorded = Number(claim.paid_amount) || 0;
  if (claim.ra_import_id == null) return round2(recorded);
  const v = netPaidMap().get(claim.id);
  return v == null ? round2(recorded) : v;
}

/** Total money received across every active import, plus manual claims. */
/**
 * SQLite's datetime('now') is UTC, but the report window is local.
 *
 * An import made after ~7pm local gets a UTC date of TOMORROW, so a window
 * ending "today" excluded it and the card read $0.00 while the rows were
 * plainly present. Same conversion the claims' created_date already uses.
 */
function localDay(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(`${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function moneyReceived({ start = null, end = null, factors = importFactors() } = {}) {
  const inWindow = (d) => {
    const day = localDay(d);
    if (!day) return true;
    return (!start || day >= start) && (!end || day <= end);
  };

  const ra = db
    .prepare(
      `SELECT id, total_payment, COALESCE(updated_at, imported_at) AS stamp
       FROM ra_imports WHERE status = 'active'`
    )
    .all()
    .filter((r) => inWindow(r.stamp))
    .reduce((s, r) => s + (Number(r.total_payment) || 0), 0);

  // Hand-entered claims have no check behind them, so they carry their own.
  const manual = db
    .prepare(
      `SELECT paid_amount FROM claims
       WHERE ra_import_id IS NULL AND COALESCE(archived,0) = 0`
    )
    .all()
    .reduce((s, c) => s + (Number(c.paid_amount) || 0), 0);

  return round2(ra + manual);
}
