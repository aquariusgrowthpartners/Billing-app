/**
 * "Ask Dundas" — natural language over the billing data.
 *
 * Security model: the AI never writes SQL. It returns a small JSON *plan*,
 * which is validated against a hard whitelist of tables, aggregates, columns
 * and filters; the SQL itself is assembled here from that whitelist with bound
 * parameters. An unrecognised table or column is rejected, not interpolated.
 *
 * Everything is read-only: a plan can only produce SELECTs.
 */
import express from 'express';
import db from '../db.js';
import { complete } from '../aiService.js';

const router = express.Router();

/* ------------------------------------------------------------------ plans */

/**
 * The only shapes a question may take. Each entry names the real column and
 * how a row is rendered as a citation.
 */
const TABLES = {
  day_entries: {
    date: 'work_date',
    sum: { units: 'units', dollars: 'dollars', minutes: 'minutes_worked' },
    label: (r) =>
      `${r.units ?? 0} units · ${fmtMoney(r.dollars)}`,
    link: (r) => (r.client_id ? `/clients/${r.client_id}` : null),
    type: 'day entry',
  },
  claims: {
    date: 'period_start',
    sum: { units: 'total_units', dollars: 'total_dollars', paid: 'paid_amount' },
    label: (r) => `${r.claim_name ?? 'Claim'} · ${fmtMoney(r.total_dollars)}`,
    link: () => '/claims',
    type: 'claim',
  },
  tasks: {
    date: 'due_date',
    sum: {},
    label: (r) => r.title ?? 'Task',
    link: () => '/tasks',
    type: 'task',
  },
};

const AGGREGATES = new Set(['sum', 'count', 'none']);

function fmtMoney(n) {
  return n == null ? '—' : `$${Number(n).toFixed(2)}`;
}

/* ------------------------------------------------------------------- help */

const GROUPINGS = new Set([null, 'month', 'client', 'caretaker']);

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function systemPlan() {
  const today = todayIso();
  const year = today.slice(0, 4);
  return `You are a data extraction assistant for a home-care billing database.
Today's date is ${today} (year ${year}).

Convert the user's question into a JSON object with keys:
  "table": one of "day_entries", "claims", "tasks"
  "aggregate": one of "sum", "count", "none"
  "column": for day_entries one of "units","dollars","minutes"; for claims one of "units","dollars","paid"; otherwise null
  "group_by": one of "month", "client", "caretaker", or null. Use "month" for any per-month / time-series question
              ("what months", "by month", "monthly trend"); "client" or "caretaker" for a breakdown by person.
  "filters": an object which may contain "date_from" (YYYY-MM-DD), "date_to" (YYYY-MM-DD),
             "client_name" (string), "caretaker_name" (string), "task_status" ("pending"|"completed")

If the user asks for a relative time like "last month", "this year" or just "January", assume the most
recent occurrence based on today's date (${today}). Never assume a past year when the current year has data.

## COLUMN SELECTION — STRICT RULES, APPLY IN ORDER

The two money columns are different numbers for the same month:
  claims.paid_amount    = what the payer actually PAID
  day_entries.dollars   = what was BILLED for work performed

These rules are mandatory. Do not substitute one for the other.

1. If the question mentions any of: "paid", "received", "cash", "money in", "remittance", "deposited",
   "collected", "reimbursed", "came in" — you MUST use table "claims", column "paid".
2. If the question mentions any of: "billed", "charged", "invoiced", "claimed", "work", "worked",
   "hours", "units" — you MUST use table "day_entries";
   use column "units" when the ask is units/hours, and column "dollars" when the ask is an amount.
3. If the question mentions "revenue" or "money" with NO other qualifying word, DEFAULT to
   table "claims", column "paid".
4. If the question is about tasks, use table "tasks" and aggregate "count" or "none".

Examples:
  "How much money came in during October?"  -> {"table":"claims","aggregate":"sum","column":"paid"}
  "How much was billed in October?"         -> {"table":"day_entries","aggregate":"sum","column":"dollars"}
  "How many units were worked in September?"-> {"table":"day_entries","aggregate":"sum","column":"units"}
  "What revenue did we make?"               -> {"table":"claims","aggregate":"sum","column":"paid"}

Return ONLY valid JSON. No prose. No markdown fences.
If the question cannot be answered from these tables, return {"table":null,"reason":"..."}.`;
}

function parseJson(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Reject anything the whitelist does not cover. */
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return { ok: false, reason: 'unparseable plan' };
  if (plan.table == null) {
    return { ok: false, reason: plan.reason || 'not answerable from this data' };
  }
  const spec = TABLES[plan.table];
  if (!spec) return { ok: false, reason: `unknown table "${plan.table}"` };

  const aggregate = String(plan.aggregate ?? 'none').toLowerCase();
  if (!AGGREGATES.has(aggregate)) return { ok: false, reason: `unknown aggregate "${aggregate}"` };

  const column = plan.column == null ? null : String(plan.column).toLowerCase();
  if (aggregate === 'sum' && !spec.sum[column]) {
    return { ok: false, reason: `cannot sum "${column}" from ${plan.table}` };
  }

  const f = plan.filters && typeof plan.filters === 'object' ? plan.filters : {};
  const filters = {};
  for (const k of ['date_from', 'date_to', 'client_name', 'caretaker_name', 'task_status']) {
    const v = f[k];
    if (v == null || String(v).trim() === '') continue;
    const s = String(v).trim();
    if (k === 'date_from' || k === 'date_to') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, reason: `bad ${k}` };
    }
    if (k === 'task_status' && !['pending', 'completed'].includes(s)) {
      return { ok: false, reason: 'bad task_status' };
    }
    /*
     * Tasks have no client link — the person on a task is its caretaker. The
     * model reliably emits client_name for "tasks for Sarah", so rewrite it to
     * caretaker_name instead of silently dropping it and letting the answer
     * claim a filter that never ran.
     */
    if (k === 'client_name' && plan.table === 'tasks') {
      if (!filters.caretaker_name) filters.caretaker_name = s;
      continue;
    }
    if (k === 'task_status' && plan.table !== 'tasks') continue;
    filters[k] = s;
  }

  let groupBy = plan.group_by == null ? null : String(plan.group_by).toLowerCase();
  if (groupBy === 'none' || groupBy === '') groupBy = null;
  if (!GROUPINGS.has(groupBy)) return { ok: false, reason: `unknown group_by "${plan.group_by}"` };
  // grouping only makes sense as a breakdown, never across tables that lack the key
  if (groupBy === 'client' && plan.table === 'tasks') groupBy = 'caretaker';
  if (groupBy === 'caretaker' && plan.table === 'claims') groupBy = null;

  return { ok: true, plan: { table: plan.table, aggregate, column, filters, group_by: groupBy } };
}

/** Build the parameterised SQL for a validated plan. */
function buildQuery({ table, aggregate, column, filters, group_by }, agencyId) {
  const spec = TABLES[table];
  const where = [];
  const params = {};

  /*
   * Every Ask Dundas plan is scoped to the asking agency. Pushed first so no
   * later branch can build a cross-tenant query.
   */
  where.push('t.agency_id = @agency');
  params.agency = agencyId;

  if (filters.date_from) {
    where.push(`t.${spec.date} >= @date_from`);
    params.date_from = filters.date_from;
  }
  if (filters.date_to) {
    where.push(`t.${spec.date} <= @date_to`);
    params.date_to = filters.date_to;
  }
  if (filters.task_status && table === 'tasks') {
    where.push('t.status = @task_status');
    params.task_status = filters.task_status;
  }
  if (filters.client_name && table !== 'tasks') {
    where.push("(cl.first_name || ' ' || cl.last_name) LIKE @client_name");
    params.client_name = `%${filters.client_name}%`;
  }
  if (filters.caretaker_name && (table === 'day_entries' || table === 'tasks')) {
    where.push("(ct.first_name || ' ' || ct.last_name) LIKE @caretaker_name");
    params.caretaker_name = `%${filters.caretaker_name}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const joins =
    table === 'day_entries'
      ? `LEFT JOIN clients cl ON cl.id = t.client_id
         LEFT JOIN caretakers ct ON ct.id = t.caretaker_id`
      : table === 'claims'
        ? 'LEFT JOIN clients cl ON cl.id = t.client_id'
        : 'LEFT JOIN caretakers ct ON ct.id = t.caretaker_id';

  /* ---------------- grouped (time-series / breakdown) ---------------- */
  if (group_by) {
    const bucket =
      group_by === 'month'
        ? `strftime('%Y-%m', t.${spec.date})`
        : group_by === 'client'
          ? `(cl.first_name || ' ' || cl.last_name)`
          : `(ct.first_name || ' ' || ct.last_name)`;

    const measure =
      aggregate === 'sum' ? `SUM(t.${spec.sum[column]})` : 'COUNT(*)';

    const grouped = `SELECT ${bucket} AS bucket,
                            ${measure} AS value,
                            COUNT(*) AS n
                       FROM ${table} t ${joins} ${whereSql}
                      ${group_by === 'month' ? `AND t.${spec.date} IS NOT NULL` : 'AND 1=1'}
                      GROUP BY bucket
                      ORDER BY bucket ${group_by === 'month' ? 'ASC' : 'DESC'}
                      LIMIT 60`;
    return { sql: grouped, params, grouped: true };
  }

  let select;
  if (aggregate === 'sum') {
    select = `SELECT SUM(t.${spec.sum[column]}) AS value, COUNT(*) AS n FROM ${table} t ${joins} ${whereSql}`;
  } else if (aggregate === 'count') {
    select = `SELECT COUNT(*) AS value, COUNT(*) AS n FROM ${table} t ${joins} ${whereSql}`;
  } else {
    /*
     * Only select the join aliases that actually exist for this table. `tasks`
     * joins caretakers only — selecting cl.* there is a SQL error, not a null.
     */
    const cols =
      table === 'day_entries'
        ? `cl.first_name AS cl_first, cl.last_name AS cl_last,
           ct.first_name AS ct_first, ct.last_name AS ct_last`
        : table === 'claims'
          ? 'cl.first_name AS cl_first, cl.last_name AS cl_last'
          : 'ct.first_name AS ct_first, ct.last_name AS ct_last';
    select = `SELECT t.*, ${cols}
                FROM ${table} t ${joins} ${whereSql}
               ORDER BY t.${spec.date} IS NULL, t.${spec.date} DESC LIMIT 50`;
  }
  return { sql: select, params };
}

/* ------------------------------------------------------------------ route */

router.post('/', async (req, res) => {
  const query = String(req.body?.query ?? '').trim();
  if (!query) return res.status(400).json({ error: 'A question is required.' });
  if (query.length > 500) return res.status(400).json({ error: 'That question is too long.' });

  try {
    /* Step A — intent */
    const a = await complete(query, { system: systemPlan(), timeoutMs: 20000 });
    if (a.source === 'none') {
      return res.json({
        answer:
          'AI Summary unavailable (no API key configured in settings). Add a provider and key in Settings → AI Configuration.',
        sources: [],
        unavailable: true,
      });
    }

    const parsed = parseJson(a.text);
    const v = validatePlan(parsed);
    if (!v.ok) {
      return res.json({
        answer: `I cannot answer that from your data — ${String(v.reason).replace(/\.$/, '')}. Try asking about day entries, claims or tasks, for example "How many units were worked in September 2026?"`,
        sources: [],
        understood: false,
      });
    }

    /* Step B — parameterised SQL */
    const { sql, params } = buildQuery(v.plan, req.agencyId);
    const rows = db.prepare(sql).all(params);

    const spec = TABLES[v.plan.table];
    const grouped = v.plan.group_by != null;
    const aggRow = rows[0] ?? {};

    /*
     * Three shapes come back from Step B:
     *   grouped   -> [{bucket, value, n}, ...] one row per month/client/caretaker
     *   aggregate -> [{value, n}]               one scalar
     *   rows      -> every matching record
     */
    const groups = grouped
      ? rows.map((r) => ({
          bucket: r.bucket ?? '(none)',
          value: r.value,
          records: r.n,
        }))
      : null;

    const aggregateValue = grouped
      ? null
      : v.plan.aggregate === 'none'
        ? null
        : (aggRow.value ?? null);

    const matchCount = grouped
      ? rows.reduce((sum, r) => sum + (r.n ?? 0), 0)
      : v.plan.aggregate === 'none'
        ? rows.length
        : (aggRow.n ?? rows.length);

    /* Citations always list the underlying records, never the group buckets,
       so "View record" points at something real. */
    let sourceRows = rows;
    if (v.plan.aggregate !== 'none' || grouped) {
      const src = buildQuery({ ...v.plan, aggregate: 'none', group_by: null }, req.agencyId);
      sourceRows = db.prepare(src.sql).all(src.params);
    }

    const sources = sourceRows.slice(0, 50).map((r) => {
      const isDay = v.plan.table === 'day_entries';
      const isTask = v.plan.table === 'tasks';
      const name = isTask
        ? [r.ct_first, r.ct_last].filter(Boolean).join(' ') || null
        : [r.cl_first ?? r.first_name, r.cl_last ?? r.last_name].filter(Boolean).join(' ') || null;
      return {
        id: r.id,
        type: spec.type,
        date: r[spec.date] ?? null,
        name,
        amount: isTask ? null : (r.dollars ?? r.total_dollars ?? null),
        units: isDay ? (r.units ?? null) : (r.total_units ?? null),
        label: spec.label(r),
        href: spec.link(r),
      };
    });

    /* Step C — synthesis */
    const rawData = {
      table: v.plan.table,
      aggregate: v.plan.aggregate,
      column: v.plan.column,
      filters: v.plan.filters,
      applied_filters: Object.keys(v.plan.filters),
      group_by: v.plan.group_by ?? null,
      grouped_totals: groups,
      result: aggregateValue,
      matching_rows: matchCount,
      rows: sourceRows.slice(0, 30),
    };

    const c = await complete(
      `The user asked: "${query}".\nThe database returned: ${JSON.stringify(rawData)}\n\n` +
        (groups
          ? 'The grouped_totals array contains the exact per-bucket totals computed by the database. Read those numbers directly and present them as a list rather than guessing or sampling from rows.\n\n'
          : '') +
        'Write a plain-English summary answering the question. Include the math used. Then list the exact records (dates and amounts) so the user can cross-check.',
      {
        system:
          'You answer questions about a home-care billing database. Be precise with numbers, show your arithmetic, and never invent records that are not in the data provided. Only claim a filter was applied if it appears in applied_filters.',
        timeoutMs: 25000,
      }
    );

    res.json({
      answer: c.text,
      sources,
      groups,
      plan: v.plan,
      understood: true,
      row_count: matchCount,
    });
  } catch (err) {
    console.error(`[ask] failed: ${err.message}`);
    res.status(500).json({ error: 'Could not answer that question.', detail: err.message });
  }
});

export default router;
