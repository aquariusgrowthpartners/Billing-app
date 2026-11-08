import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { formatLongDate, formatMoney, formatClientName, todayISO } from '../calc.js';

/** "6.5 hrs" — one decimal, always. */
function hours(minutesOrHours) {
  const n = Number(minutesOrHours) || 0;
  return `${n.toFixed(1)} hrs`;
}

/**
 * Days until the reporting spreadsheet is due.
 *
 * The deadline is the 20th. Before the 20th that means this month; from the
 * 20th onwards it rolls to the 20th of next month, so the count is never
 * negative unless a caller explicitly asks about a past deadline.
 */
export function daysUntilDue(today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let due = new Date(t.getFullYear(), t.getMonth(), 20);
  if (t.getDate() >= 20) due = new Date(t.getFullYear(), t.getMonth() + 1, 20);
  return Math.round((due - t) / 86400000);
}

/** The reminder strip at the top of the dashboard. */
function DueReminder() {
  const days = daysUntilDue();
  let tone = 'ok';
  let text = `${days} day${days === 1 ? '' : 's'} till Claim spreadsheets are due`;
  if (days < 0) {
    tone = 'overdue';
    text = 'OVERDUE — Submit immediately';
  } else if (days <= 2) {
    tone = 'urgent';
  } else if (days <= 5) {
    tone = 'soon';
  }
  return (
    <div className={`due-reminder due-${tone}`} id="due-reminder" data-days={days}>
      {text}
    </div>
  );
}

function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A card heading with an optional right-hand slot. */
function Card({ title, hint, right, children, id }) {
  return (
    <section className="card" id={id}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {hint && <p className="muted small" style={{ margin: '2px 0 0' }}>{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [periodStart, setPeriodStart] = useState(null);
  const [data, setData] = useState(null);
  const [recentRa, setRecentRa] = useState([]);
  const [recentClients, setRecentClients] = useState([]);
  const [denialAlert, setDenialAlert] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (start) => {
    setLoading(true);
    setError(null);
    try {
      const [d, ra, rc, dn] = await Promise.all([
        api.payPeriod(start),
        api.recentRa(),
        api.recentClients(),
        api.denialSummary().catch(() => null),
      ]);
      setDenialAlert(dn);
      setData(d ?? null);
      setPeriodStart(d?.period?.start ?? null);
      setRecentRa(Array.isArray(ra?.imports) ? ra.imports : []);
      setRecentClients(Array.isArray(rc?.clients) ? rc.clients : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(periodStart);
    // Only re-run when the user pages the period.
  }, [periodStart, load]);

  // Refetch whenever something elsewhere changes the underlying data (an RA
  // import, for instance), so the figures here are never stale.
  useEffect(() => {
    const refresh = () => load(periodStart);
    window.addEventListener('data-updated', refresh);
    return () => window.removeEventListener('data-updated', refresh);
  }, [load, periodStart]);

  const period = data?.period && typeof data.period === 'object' ? data.period : null;
  const caretakers = Array.isArray(data?.caretakers) ? data.caretakers : [];
  const totals = data?.totals && typeof data.totals === 'object' ? data.totals : {};
  const unassigned =
    data?.unassigned && typeof data.unassigned === 'object' ? data.unassigned : {};
  const denial = denialAlert && typeof denialAlert === 'object' ? denialAlert : null;
  const byClientCount = Array.isArray(denial?.by_client) ? denial.by_client.length : 0;
  const recentRaList = Array.isArray(recentRa) ? recentRa : [];
  const recentClientsList = Array.isArray(recentClients) ? recentClients : [];

  // DEBUG (temporary): print the exact state feeding this page. This is the
  // fastest way to see which value is undefined on iOS Safari.
  console.log('[HOME DEBUG]', {
    user: window.__BILLING_USER__ ?? null,
    data,
    period,
    caretakers,
    totals,
    unassigned,
    recentRa: recentRaList,
    recentClients: recentClientsList,
    denialAlert: denial,
    settings: window.__BILLING_SETTINGS__ ?? null,
  });

  return (
    <div className="page wide home">
      <header className="home-top">
        <div>
          <h1>Home</h1>
          <p className="home-sub">Pay period overview and recent activity</p>
        </div>
        <DueReminder />
      </header>

      {error && <div className="alert error">{error}</div>}

      {/* Denials alert: shown only while there is unrecovered work. */}
      {denial && Number(denial.open_tasks) > 0 && (
        <div className="ds-alert-card" id="home-denial-alert">
          <span className="ds-alert-icon" aria-hidden="true">⚠</span>
          <span className="ds-alert-text">
            <strong>{denial.unrecovered_days ?? 0}</strong> unrecovered day
            {(denial.unrecovered_days ?? 0) === 1 ? '' : 's'} across{' '}
            <strong>{byClientCount}</strong> client
            {byClientCount === 1 ? '' : 's'} —{' '}
            <strong>{formatMoney(denial.unrecovered_dollars)}</strong> at risk.
          </span>
          <Link className="btn danger" to="/denials" id="home-denial-link">
            View Denials →
          </Link>
        </div>
      )}

      {/* the period navigator: label centred between the arrows */}
      <section className="card home-period-nav" id="period-nav">
        <button
          className="btn"
          id="period-prev"
          onClick={() => period && setPeriodStart(period.prev_start)}
          disabled={!period}
        >
          ← Prev
        </button>
        <div className="period-label">
          <span className="period-range" id="period-range">
            {period?.start && period?.end
              ? `${formatLongDate(period.start)} – ${formatLongDate(period.end)}`
              : 'Loading…'}
          </span>
          <span className="period-tag">
            {period?.is_current ? 'Current pay period' : 'Past pay period'}
          </span>
        </div>
        <button
          className="btn"
          id="period-next"
          onClick={() => period && setPeriodStart(period.next_start)}
          disabled={!period}
        >
          Next →
        </button>
        <button
          className="btn ghost period-current"
          id="period-current"
          onClick={() => setPeriodStart(null)}
          disabled={!period || period.is_current}
        >
          Jump to current
        </button>
      </section>

      {/* ---------------------------------------------- section B: totals */}
      <section className="card totals-bar" id="period-totals">
        <h2 className="home-section-title">Period totals</h2>
        <div className="metric">
          <span className="metric-label">Total hours</span>
          <span className="metric-value" id="total-hours">
            {hours(totals?.hours ?? 0)}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Total billed value</span>
          <span className="metric-value" id="total-dollars">
            {formatMoney(totals?.dollars ?? 0)}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Active caretakers</span>
          <span className="metric-value" id="total-caretakers">
            {totals?.active_caretakers ?? 0}
          </span>
        </div>
      </section>

      {/* ------------------------------------------- section A: caretakers */}
      <Card
        id="pay-period-caretakers"
        title="Caretakers this pay period"
        hint="Ranked by hours worked. Every recorded day counts, whatever its client or claim."
      >
        {loading && !data ? (
          <p className="empty">Loading…</p>
        ) : caretakers.length === 0 ? (
          <p className="empty">No caretaker hours recorded in this pay period.</p>
        ) : (
          <div className="table-scroll">
            <table className="table" id="caretaker-ranking">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Caretaker</th>
                  <th className="num">Hours</th>
                  <th className="num">Billed value</th>
                  <th className="num">Clients</th>
                </tr>
              </thead>
              <tbody>
                {caretakers.map((c, index) =>
                  c ? (
                    <tr
                      key={c.id ?? `caretaker-${index}`}
                      className="row-clickable"
                      id={`caretaker-row-${c.id}`}
                      onClick={() => navigate('/caretakers')}
                      title="Open the Caretakers tab"
                    >
                      <td className="num rank">{c.rank ?? '—'}</td>
                      <td>
                        <strong>
                          {c.last_name ?? ''}, {c.first_name ?? ''}
                        </strong>
                      </td>
                      <td className="num">{hours(c.hours)}</td>
                      <td className="num dollars">{formatMoney(c.dollars)}</td>
                      <td className="num">{c.clients ?? 0}</td>
                    </tr>
                  ) : null
                )}
              </tbody>
            </table>
          </div>
        )}

        {unassigned?.hours > 0 && (
          <p className="muted small" id="unassigned-hours" style={{ marginTop: 8 }}>
            Plus <strong>{hours(unassigned.hours)}</strong> and{' '}
            <strong>{formatMoney(unassigned.dollars)}</strong> with no caretaker recorded — counted
            in the totals above.
          </p>
        )}

        {data?.unassigned_entries > 0 && (
          <p className="muted small" id="unassigned-note" style={{ marginTop: 4 }}>
            {data.unassigned_entries} day {data.unassigned_entries === 1 ? 'entry has' : 'entries have'}{' '}
            no caretaker recorded, so {data.unassigned_entries === 1 ? 'it is' : 'they are'} counted in
            the totals above but cannot appear in the ranking.
          </p>
        )}
      </Card>

      <div className="split-2">
        {/* --------------------------------------- section C: recent RA */}
        <Card
          id="recent-ra"
          title="Recent RA submissions"
          hint="The last 5 saved remittance advices."
        >
          {recentRaList.length === 0 ? (
            <p className="empty">No RA imports saved yet.</p>
          ) : (
            <ul className="rows" id="recent-ra-list">
              {recentRaList.map((r, index) => {
                if (!r) return null;
                const claims = Array.isArray(r.claims) ? r.claims : [];
                return (
                  <li key={r.id ?? `ra-${index}`} className="row-item" id={`recent-ra-${r.id}`}>
                    <div className="row-main">
                      <strong>
                        {r.imported_at ? new Date(r.imported_at).toLocaleDateString() : '—'}
                      </strong>
                      <span className="muted small">
                        {r.num_clients ?? 0} client{(r.num_clients ?? 0) === 1 ? '' : 's'}
                        {r.file_name ? ` · ${r.file_name}` : ''}
                      </span>
                    </div>
                    <div className="row-side">
                      <span className="dollars">{formatMoney(r.total_payment)}</span>
                      {claims.length > 0 && (
                        <span className="muted small">
                          {claims.slice(0, 2).map((c, claimIndex) => (
                            <Link
                              key={c?.id ?? `claim-${claimIndex}`}
                              to="/claims"
                              className="claim-link"
                              title={`Open ${c?.claim_name ?? 'claim'}`}
                            >
                              {c?.claim_name ?? 'claim'}
                            </Link>
                          ))}
                          {claims.length > 2 && ` +${claims.length - 2}`}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ---------------------------------- section D: recently viewed */}
        <Card
          id="recent-clients"
          title="Recently viewed clients"
          hint="The last 8 profiles you opened."
        >
          {recentClientsList.length === 0 ? (
            <p className="empty">No clients opened yet.</p>
          ) : (
            <ul className="rows" id="recent-clients-list">
              {recentClientsList.map((c, index) => {
                if (!c) return null;
                return (
                  <li key={c.client_id ?? `recent-${index}`} className="row-item">
                    <Link
                      to={`/clients/${c.client_id ?? ''}`}
                      id={`recent-client-${c.client_id}`}
                      className="recent-client-link"
                    >
                      {formatClientName(c)}
                      {c.archived ? ' (archived)' : ''}
                    </Link>
                    <span className="muted small">
                      {c.viewed_at ? new Date(c.viewed_at).toLocaleDateString() : '—'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
