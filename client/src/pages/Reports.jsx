import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import api from '../api.js';
import Skeleton from '../components/Skeleton.jsx';
import { formatMoney, formatLongDate, todayISO, toISODate } from '../calc.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (month) => {
  const [y, m] = String(month).split('-');
  return `${MONTHS[Number(m) - 1]} ${String(y).slice(2)}`;
};

const PRESETS = [
  { key: 'ytd', label: 'YTD' },
  { key: '6m', label: 'Last 6 months' },
  { key: 'thisq', label: 'This quarter' },
  { key: 'lastq', label: 'Last quarter' },
  { key: 'all', label: 'All time' },
];

export default function Reports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [start, setStart] = useState(`${new Date().getFullYear()}-01-01`);
  const [end, setEnd] = useState(todayISO());
  const [preset, setPreset] = useState('ytd');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.reports({ start, end });
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  // Debounce rapid edits to the date inputs.
  useEffect(() => {
    const handle = setTimeout(load, 200);
    return () => clearTimeout(handle);
  }, [load]);

  function applyPreset(key) {
    setPreset(key);
    const today = new Date();
    switch (key) {
      case 'ytd':
        setStart(`${today.getFullYear()}-01-01`);
        setEnd(todayISO());
        break;
      case '6m': {
        const d = new Date();
        d.setMonth(d.getMonth() - 5);
        d.setDate(1);
        setStart(toISODate(d));
        setEnd(todayISO());
        break;
      }
      case 'thisq': {
        const q = Math.floor(today.getMonth() / 3);
        setStart(toISODate(new Date(today.getFullYear(), q * 3, 1)));
        setEnd(todayISO());
        break;
      }
      case 'lastq': {
        const q = Math.floor(today.getMonth() / 3);
        setStart(toISODate(new Date(today.getFullYear(), (q - 1) * 3, 1)));
        setEnd(toISODate(new Date(today.getFullYear(), q * 3, 0)));
        break;
      }
      case 'all':
        setStart('2000-01-01');
        setEnd(todayISO());
        break;
      default:
    }
  }

  /*
   * Importing a year of advices in one sitting stamps every claim with the same
   * created_at and paid_date, so a cash-date chart collapses into a single bar.
   * The default view buckets by the month the work was performed instead.
   */
  const [bucket, setBucket] = useState('dos');
  const byDos = bucket === 'dos';
  const chartData = (data?.[byDos ? 'monthly_dos' : 'monthly'] ?? []).map((m) => ({
    name: monthLabel(m.month),
    Billed: m.billed,
    Paid: m.paid,
  }));

  const agingOrder = ['current', 'days_31_60', 'days_61_90', 'days_90_plus', 'no_expected_date'];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            Financial health at a glance. Window: {formatLongDate(data?.range.start)} →{' '}
            {formatLongDate(data?.range.end)}
          </p>
        </div>
        <div className="report-filter">
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={preset === p.key ? 'btn tiny primary' : 'btn tiny'}
                onClick={() => applyPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="date-pair">
            <input
              type="date"
              aria-label="Report start date"
              value={start}
              onChange={(e) => {
                setPreset('custom');
                setStart(e.target.value);
              }}
            />
            <span className="muted">→</span>
            <input
              type="date"
              aria-label="Report end date"
              value={end}
              onChange={(e) => {
                setPreset('custom');
                setEnd(e.target.value);
              }}
            />
          </div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {loading && !data && (
        <div className="sk-report" id="reports-skeleton" aria-busy="true">
          <div className="sk-stat-row">
            <Skeleton variant="stat" />
            <Skeleton variant="stat" />
            <Skeleton variant="stat" />
          </div>
          <Skeleton variant="card" style={{ height: 220 }} />
        </div>
      )}

      {data && (
        <>
          {/* ------------------------------------------------ snapshot */}
          <div className="stat-row">
            <Stat
              label={`Total billed (window)`}
              value={formatMoney(data.snapshot.billed)}
              sub={`Sum of claims.total_dollars · ${data.snapshot.billed_count} claim${
                data.snapshot.billed_count === 1 ? '' : 's'
              }`}
            />
            <Stat
              label="Total paid (window)"
              value={formatMoney(data.snapshot.paid)}
              sub={`Sum of RA PAYMENT AMOUNT lines, money actually received · ${
                data.snapshot.paid_count
              } payment${data.snapshot.paid_count === 1 ? '' : 's'}`}
            />
            <Stat
              label="Total outstanding (as of today)"
              value={formatMoney(data.snapshot.outstanding)}
              sub={`${data.snapshot.outstanding_count} claim${data.snapshot.outstanding_count === 1 ? '' : 's'}`}
              tone={data.snapshot.outstanding > 0 ? 'warn' : null}
            />
          </div>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Monthly revenue</h2>
                <p className="muted small" style={{ margin: '2px 0 0' }}>
                  {byDos
                    ? 'Billed by the month the work was performed.'
                    : 'Billed by the month the claim was created, paid by the month the money landed.'}
                </p>
              </div>
              <div className="head-actions">                <div className="chart-toggle" id="chart-bucket-toggle">
                  <button
                    className={`btn tiny ${byDos ? 'primary' : ''}`}
                    id="bucket-dos"
                    onClick={() => setBucket('dos')}
                  >
                    By date of service
                  </button>
                  <button
                    className={`btn tiny ${!byDos ? 'primary' : ''}`}
                    id="bucket-cash"
                    onClick={() => setBucket('cash')}
                  >
                    By cash received
                  </button>
                </div>
</div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={280}>

                <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} width={70} />
                  <Tooltip
                    formatter={(value) => formatMoney(value)}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="chart-tip">
                          <strong>{label}</strong>
                          {payload.map((p) => (
                            <div key={p.name} style={{ color: p.color }}>
                              {p.name}: {formatMoney(p.value)}
                            </div>
                          ))}
                          <div className="chart-tip-note">
                            Based on {byDos ? 'date of service' : 'cash received'}
                          </div>
                        </div>
                      ) : null
                    }
                  />
                  <Legend />
                  <Bar dataKey="Billed" fill="#1f5fd6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Paid" fill="#1a7f45" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* ------------------------------------------------- aging */}
          <section className="card" id="aging">
            <div className="card-head">
              <div>
                <h2>A/R aging</h2>
                <p className="muted small" style={{ margin: '2px 0 0' }}>
                  Every unpaid, submitted claim as of today, grouped by how far past its expected
                  payment date it is. This section intentionally ignores the date window — an old
                  unpaid claim must never disappear behind a filter.
                </p>
              </div>
            </div>

            {(data.drafts.total > 0 || data.denied.total > 0) && (
              <div className="aging-note">
                {data.drafts.total > 0 && (
                  <span>
                    Drafts not yet submitted: {formatMoney(data.drafts.total)} ({data.drafts.count})
                  </span>
                )}
                {data.denied.total > 0 && (
                  <span>
                    Denied: {formatMoney(data.denied.total)} ({data.denied.count})
                  </span>
                )}
              </div>
            )}

            <div className="table-scroll">
              <table className="table aging-table">
                <tbody>
                  {agingOrder.map((key) => {
                    const b = data.aging[key];
                    const overdue = key !== 'current' && key !== 'no_expected_date' && b.count > 0;
                    return (
                      <React.Fragment key={key}>
                        <tr className="aging-head">
                          <td colSpan={6}>
                            <strong>{b.label}</strong>
                            <span className={overdue ? 'pill overdue' : 'pill'}>
                              {b.count} claim{b.count === 1 ? '' : 's'} · {formatMoney(b.total)}
                            </span>
                          </td>
                        </tr>
                        {b.claims.length === 0 ? (
                          <tr className="aging-empty">
                            <td colSpan={6}>—</td>
                          </tr>
                        ) : (
                          b.claims.map((c) => (
                            <tr key={c.id} className={overdue ? 'row-overdue' : ''}>
                              <td className="mono">{c.claim_name}</td>
                              <td>
                                {c.client_name}
                                {c.ma_number && <span className="sub mono"> {c.ma_number}</span>}
                              </td>
                              <td className="muted">{c.payer_name ?? 'no payer'}</td>
                              <td className="nowrap">
                                expected {c.expected_pay_date ? formatLongDate(c.expected_pay_date) : '—'}
                              </td>
                              <td className="num">
                                {c.age_days == null ? (
                                  <span className="muted">—</span>
                                ) : (
                                  <strong className={c.age_days > 30 ? 'variance-late' : ''}>
                                    {c.age_days <= 0
                                      ? `due in ${Math.abs(c.age_days)}d`
                                      : `${c.age_days}d overdue`}
                                  </strong>
                                )}
                              </td>
                              <td className="num dollars">{formatMoney(c.total_dollars)}</td>
                            </tr>
                          ))
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ----------------------------------------- payer performance */}
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Payer performance</h2>
                <p className="muted small" style={{ margin: '2px 0 0' }}>
                  Within the selected window, plus each payer's outstanding balance as of today.
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payer</th>
                    <th className="num">Claims submitted</th>
                    <th className="num">Total paid</th>
                    <th className="num">Avg days to pay</th>
                    <th className="num">Avg vs expected</th>
                    <th className="num">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payers.map((p) => (
                    <tr key={p.payer_id}>
                      <td>
                        <strong>{p.payer_name}</strong>
                        {p.typical_days_to_pay != null && (
                          <div className="sub">configured: {p.typical_days_to_pay} days</div>
                        )}
                      </td>
                      <td className="num">{p.claims_submitted}</td>
                      <td className="num dollars">{formatMoney(p.total_paid)}</td>
                      <td className="num">
                        {p.avg_days_to_pay == null ? (
                          '—'
                        ) : (
                          <strong className={p.avg_days_to_pay > (p.typical_days_to_pay ?? 30) ? 'variance-late' : 'variance-ok'}>
                            {p.avg_days_to_pay}d
                          </strong>
                        )}
                      </td>
                      <td className="num">
                        {p.avg_variance_days == null ? (
                          '—'
                        ) : (
                          <span className={p.avg_variance_days > 0 ? 'variance-late' : 'variance-ok'}>
                            {p.avg_variance_days > 0 ? '+' : ''}
                            {p.avg_variance_days}d
                          </span>
                        )}
                      </td>
                      <td className="num dollars">
                        {p.outstanding > 0 ? (
                          <strong className="variance-late">{formatMoney(p.outstanding)}</strong>
                        ) : (
                          <span className="muted">{formatMoney(p.outstanding)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.unassigned?.claims > 0 && (
                    <tr className="row-dirty">
                      <td>
                        <strong>No payer assigned</strong>
                      </td>
                      <td className="num">{data.unassigned.submitted}</td>
                      <td className="num dollars">{formatMoney(data.unassigned.total_paid)}</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                      <td className="num dollars">{formatMoney(data.unassigned.outstanding)}</td>
                    </tr>
                  )}
                  {data.payers.length === 0 && data.unassigned?.claims === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">
                        No claims in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`stat${tone === 'warn' ? ' stat-warn' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}
