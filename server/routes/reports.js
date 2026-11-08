import express from 'express';
import db from '../db.js';
import { importFactors, netPaid, moneyReceived } from '../paidMath.js';
import { apportion, monthRange } from '../monthBuckets.js';
import { todayISO, daysBetween, round2 } from '../calc.js';

const router = express.Router();

const round1 = (n) => Math.round(Number(n) * 10) / 10;

function isISODate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** '2026-10' -> 'Oct 2026' (client can reformat; keep the key stable). */
function monthKey(iso) {
  return String(iso).slice(0, 7);
}

/** All month keys between two ISO dates, inclusive. */
/**
 * SQLite's datetime('now') is UTC. Convert it to the local calendar date, so a
 * claim created in the evening does not land on tomorrow's date.
 * Falls back to a plain slice for anything already date-shaped.
 */
function localDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(`${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthsBetween(startISO, endISO) {
  const out = [];
  const d = new Date(`${startISO.slice(0, 7)}-01T00:00:00`);
  const end = new Date(`${endISO.slice(0, 7)}-01T00:00:00`);
  while (d <= end) {
    out.push(monthKey(d.toISOString()));
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/**
 * GET /api/reports?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Window semantics (documented, so the numbers are explainable):
 *   - A/R aging and Outstanding are POINT-IN-TIME: every unpaid claim, as of
 *     today, regardless of the window. Hiding an old unpaid claim behind a
 *     date filter would defeat the point of aging.
 *   - Billed/Paid totals, payer performance and the monthly chart are WINDOWED:
 *     billed by the day the claim was created, paid by the day the money landed
 *     (falling back to submitted/created for legacy paid claims without a date).
 */
router.get('/', (req, res) => {
  const today = todayISO();
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const start = isISODate(req.query.start) ? req.query.start : yearStart;
  const end = isISODate(req.query.end) ? req.query.end : today;

  const rows = db
    .prepare(
      `SELECT cl.*, c.first_name, c.last_name, c.ma_number,
              a.agreement_number, a.service_code,
              p.id AS payer_id, p.name AS payer_name, p.typical_days_to_pay
       FROM claims cl
       JOIN clients c ON c.id = cl.client_id
       LEFT JOIN agreements a ON a.id = cl.agreement_id
       LEFT JOIN payers p ON p.id = a.payer_id
       -- Archived claims are superseded (an RA re-import replaced them), so
       -- counting them would double the same money.
       WHERE COALESCE(cl.archived, 0) = 0
           AND cl.agency_id = @agency
       ORDER BY cl.id`
    )
    .all({ agency: req.agencyId });

  const factors = importFactors(req.agencyId);
  const receivedTotal = moneyReceived({ start, end, agencyId: req.agencyId });
  const claims = rows.map((c) => {
    const paid = c.status === 'Paid' || Boolean(c.paid_date);
    const receivable = c.status === 'Submitted' && !c.paid_date;
    /*
     * Money actually received, not the header's idea of it.
     *
     * `paid_amount` is the advice's per-claim TOTAL PAYMENT, which does not net
     * out a forwarding balance, so summing it overstated this import by
     * $9,989.10 against the cheques themselves.
     */
    const netPaidAmount = netPaid(c, factors);
    // A legacy Paid claim may lack a paid_date; fall back to submitted/created
    // so it still lands in a window and a chart month.
    const cashDate = c.paid_date ?? c.submitted_date ?? String(c.created_at ?? '').slice(0, 10);
    return {
      ...c,
      // created_at is written by SQLite's datetime('now'), which is UTC. Slicing
      // it straight to a date gave a claim imported at 11pm local a UTC date of
      // TOMORROW, so a window ending "today" excluded everything imported today
      // while the month bucket still counted it. Convert to the agency's local
      // date first.
      created_date: localDate(c.created_at),
      net_paid_amount: netPaidAmount,
      is_paid: paid,
      is_receivable: receivable,
      is_draft: c.status === 'Draft',
      is_denied: c.status === 'Denied',
      paid_value: netPaidAmount,
      cash_date: cashDate,
      age_days: receivable && c.expected_pay_date ? daysBetween(c.expected_pay_date, today) : null,
    };
  });

  const inWindow = (iso) => Boolean(iso) && iso >= start && iso <= end;

  /* ----------------------------------------------------------- A/R aging */

  const receivable = claims.filter((c) => c.is_receivable);
  const buckets = {
    current: { label: 'Current (0–30 days)', claims: [] },
    days_31_60: { label: '31–60 days', claims: [] },
    days_61_90: { label: '61–90 days', claims: [] },
    days_90_plus: { label: '90+ days', claims: [] },
    no_expected_date: { label: 'No expected date', claims: [] },
  };

  for (const c of receivable) {
    if (!c.expected_pay_date) {
      buckets.no_expected_date.claims.push(c);
    } else if (c.age_days <= 30) {
      buckets.current.claims.push(c);
    } else if (c.age_days <= 60) {
      buckets.days_31_60.claims.push(c);
    } else if (c.age_days <= 90) {
      buckets.days_61_90.claims.push(c);
    } else {
      buckets.days_90_plus.claims.push(c);
    }
  }

  const claimRow = (c) => ({
    id: c.id,
    claim_name: c.claim_name,
    client_name: `${c.last_name ?? ''}, ${c.first_name ?? ''}`.trim(),
    ma_number: c.ma_number,
    payer_name: c.payer_name,
    status: c.status,
    submitted_date: c.submitted_date,
    expected_pay_date: c.expected_pay_date,
    age_days: c.age_days,
    total_dollars: c.total_dollars,
  });

  const aging = Object.fromEntries(
    Object.entries(buckets).map(([key, b]) => [
      key,
      {
        label: b.label,
        count: b.claims.length,
        total: round2(b.claims.reduce((s, c) => s + Number(c.total_dollars), 0)),
        claims: b.claims.map(claimRow),
      },
    ])
  );

  const drafts = claims.filter((c) => c.is_draft);
  const denied = claims.filter((c) => c.is_denied);

  /* --------------------------------------------------- monthly, by DOS */

  /*
   * The same money, bucketed by the month the work was performed rather than
   * the month it was imported or paid. Importing a year of advices in one
   * sitting stamps every claim with the same created_at, so the cash view
   * collapses into a single bar; this view spreads it back over the year.
   *
   * Totals are untouched — only the buckets differ. Each claim's amount is
   * split by day across the months its period covers, with the rounding
   * residual on the last slice so the parts always add back to the whole.
   */
  const dosStarts = claims.map((c) => c.period_start).filter(Boolean).sort();
  const dosEnds = claims.map((c) => c.period_end).filter(Boolean).sort();
  /*
   * Claims with no service dates are pinned to their import month. That month
   * has to be INSIDE the axis or their money silently drops out of the chart —
   * it did, to the tune of $7,774.94. So the range is widened to cover them.
   */
  const fallbackMonths = claims
    .filter((c) => !c.period_start || !c.period_end)
    .map((c) => monthKey(localDate(c.created_at)))
    .filter(Boolean)
    .sort();
  const dosRange = {
    start: [dosStarts[0] ?? start, fallbackMonths[0] ?? null].filter(Boolean).sort()[0] ?? start,
    end: [dosEnds[dosEnds.length - 1] ?? end, fallbackMonths[fallbackMonths.length - 1] ?? null]
      .filter(Boolean)
      .sort()
      .pop() ?? end,
  };
  const dosMonths = monthRange(dosRange.start, dosRange.end);
  const byDos = new Map(
    dosMonths.map((m) => [m, { month: m, billed: 0, paid: 0, billed_count: 0, paid_count: 0 }])
  );
  let estimatedMonths = 0;
  for (const c of claims) {
    const fallbackBilled = monthKey(localDate(c.created_at));
    if (!c.is_draft) {
      for (const p of apportion(c.total_dollars, c.period_start, c.period_end, fallbackBilled)) {
        const b = byDos.get(p.month);
        if (!b) continue;
        b.billed = round2(b.billed + p.value);
        b.billed_count += 1;
        if (p.estimated) estimatedMonths += 1;
      }
    }
    if (c.is_paid) {
      for (const p of apportion(c.net_paid_amount, c.period_start, c.period_end, monthKey(c.cash_date))) {
        const b = byDos.get(p.month);
        if (!b) continue;
        b.paid = round2(b.paid + p.value);
        b.paid_count += 1;
      }
    }
  }
  const monthlyDos = dosMonths.map((m) => byDos.get(m));

  /* -------------------------------------------------------------- monthly */

  const monthly = monthsBetween(start, end).map((month) => {
    const billedMonth = claims.filter(
      (c) => !c.is_draft && monthKey(c.created_date) === month
    );
    const paidMonth = claims.filter((c) => c.is_paid && monthKey(c.cash_date) === month);
    return {
      month,
      billed: round2(billedMonth.reduce((s, c) => s + Number(c.total_dollars), 0)),
      paid: round2(paidMonth.reduce((s, c) => s + c.paid_value, 0)),
      billed_count: billedMonth.length,
      paid_count: paidMonth.length,
    };
  });



  /* ------------------------------------------------------------ snapshot */

  /*
   * The window filters by DATE OF SERVICE, not by the day the file was
   * imported.
   *
   * Every claim in an import shares one created_at, so a created-date window
   * made the cards all-or-nothing: YTD showed everything, any other month
   * showed zero. The money belongs to the month the work was performed, which
   * is the same basis the monthly chart already uses.
   */
  const monthInWindow = (m) => m >= String(start).slice(0, 7) && m <= String(end).slice(0, 7);
  const overlapsDos = (c) =>
    !c.period_start || !c.period_end
      ? monthInWindow(monthKey(localDate(c.created_at)))   // undated: its import month
      : c.period_start <= end && c.period_end >= start;

  const billed = claims.filter((c) => !c.is_draft && overlapsDos(c));
  const paid = claims.filter((c) => c.is_paid && overlapsDos(c));

  // the windowed money comes from the DOS-apportioned months, so the cards and
  // the chart can never disagree
  const winDosMonths = monthlyDos.filter((m) => monthInWindow(m.month));
  const winCashMonths = monthly.filter((m) => monthInWindow(m.month));

  const snapshot = {
    billed: round2(winDosMonths.reduce((s, m) => s + m.billed, 0)),
    billed_count: billed.length,
    // = SUM(ra_imports.total_payment) apportioned to the window's months
    paid: round2(winDosMonths.reduce((s, m) => s + m.paid, 0)),
    paid_count: paid.length,
    outstanding: round2(receivable.reduce((s, c) => s + Number(c.total_dollars), 0)),
    outstanding_count: receivable.length,
  };

  /* ------------------------------------------------------ payer performance */

  const payerIds = [...new Set(claims.map((c) => c.payer_id).filter((x) => x != null))];
  const payers = payerIds
    .map((pid) => {
      const byPayer = claims.filter((c) => c.payer_id === pid);
      const submitted = byPayer.filter(
        (c) => c.status !== 'Draft' && inWindow(c.submitted_date)
      );
      const paid = byPayer.filter((c) => c.is_paid && inWindow(c.cash_date));
      const lags = paid
        .filter((c) => c.submitted_date)
        .map((c) => daysBetween(c.submitted_date, c.cash_date));
      const variances = paid.map((c) => c.variance_days).filter((v) => v != null);
      const outstanding = byPayer.filter((c) => c.is_receivable);

      const payer = db.prepare(`SELECT * FROM payers WHERE id = ? AND agency_id = ?`).get(pid, req.agencyId) ?? {};
      return {
        payer_id: pid,
        payer_name: payer.name ?? 'Unknown payer',
        typical_days_to_pay: payer.typical_days_to_pay ?? null,
        claims_submitted: submitted.length,
        total_paid: round2(paid.reduce((s, c) => s + c.paid_value, 0)),
        paid_count: paid.length,
        avg_days_to_pay: lags.length ? round1(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
        avg_variance_days: variances.length
          ? round1(variances.reduce((a, b) => a + b, 0) / variances.length)
          : null,
        outstanding: round2(outstanding.reduce((s, c) => s + Number(c.total_dollars), 0)),
        outstanding_count: outstanding.length,
      };
    })
    .sort((a, b) => (a.payer_name ?? '').localeCompare(b.payer_name ?? ''));

  const unassignedClaims = claims.filter((c) => c.payer_id == null);
  const unassigned = {
    claims: unassignedClaims.length,
    submitted: unassignedClaims.filter((c) => c.status !== 'Draft' && inWindow(c.submitted_date)).length,
    total_paid: round2(
      unassignedClaims.filter((c) => c.is_paid && inWindow(c.cash_date)).reduce((s, c) => s + c.paid_value, 0)
    ),
    outstanding: round2(
      unassignedClaims.filter((c) => c.is_receivable).reduce((s, c) => s + Number(c.total_dollars), 0)
    ),
  };

  res.json({
    range: { start, end, today },
    monthly_dos: winDosMonths,
    dos_range: dosRange,
    dos_estimated_claims: estimatedMonths,
    aging,
    drafts: {
      count: drafts.length,
      total: round2(drafts.reduce((s, c) => s + Number(c.total_dollars), 0)),
    },
    denied: {
      count: denied.length,
      total: round2(denied.reduce((s, c) => s + Number(c.total_dollars), 0)),
    },
    snapshot,
    payers,
    unassigned,
    monthly: winCashMonths,
  });
});

export default router;
