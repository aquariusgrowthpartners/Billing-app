import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api.js';
import CaretakerForm from '../components/CaretakerForm.jsx';
import { formatLongDate, formatMoney, todayISO } from '../calc.js';

const hours = (h) => `${(Number(h) || 0).toFixed(1)} hrs`;

/** A metric card with a hover tooltip. */
function Metric({ label, value, hint, id }) {
  return (
    <div className="metric-card" title={hint} id={id}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-hint">{hint}</span>
    </div>
  );
}

/* --------------------------------------------- section E — the calendar */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * A month grid of the days this caretaker worked. Cell shading scales with the
 * hours recorded, so a heavy day is visibly darker than a light one.
 */
function WorkCalendar({ days, month, onPrev, onNext, onPick, selectedId }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.work_date, d])), [days]);
  const maxHours = useMemo(
    () => Math.max(1, ...days.map((d) => d.total_hours || 0)),
    [days]
  );

  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  // the grid starts on the Monday of the week containing the 1st
  const lead = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${month}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div id="work-calendar">
      <div className="cal-head">
        <button className="btn tiny" id="cal-prev" onClick={onPrev}>
          ← Prev
        </button>
        <strong id="cal-month">{label}</strong>
        <button className="btn tiny" id="cal-next" onClick={onNext}>
          Next →
        </button>
      </div>
      <div className="cal-grid cal-grid-head">
        {DAY_NAMES.map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((date, i) => {
          if (!date) return <div key={`e${i}`} className="cal-cell cal-empty" />;
          const day = byDate.get(date);
          const intensity = day ? 0.12 + 0.5 * ((day.total_hours || 0) / maxHours) : 0;
          return (
            <div
              key={date}
              className={`cal-cell${day ? ' cal-worked' : ''}${
                day && day.entries.some((e) => e.id === selectedId) ? ' cal-selected' : ''
              }`}
              id={`cal-day-${date}`}
              style={day ? { background: `rgba(37, 99, 235, ${intensity.toFixed(3)})` } : undefined}
              onClick={() => day && onPick(day)}
              title={day ? `${hours(day.total_hours)} — ${day.clients.join(', ')}` : ''}
            >
              <span className="cal-date">{Number(date.slice(-2))}</span>
              {day && (
                <>
                  <span className="cal-clients">{day.clients.join(', ')}</span>
                  <span className="cal-hours">{hours(day.total_hours)}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- the profile page */

export default function CaretakerProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const caretakerId = Number(id);

  const [caretaker, setCaretaker] = useState(null);
  const [summary, setSummary] = useState(null);
  const [splits, setSplits] = useState(null);
  const [history, setHistory] = useState(null);
  const [calendar, setCalendar] = useState(null);

  const [periodStart, setPeriodStart] = useState(null);
  const [range, setRange] = useState('period');
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [picked, setPicked] = useState(null);
  const [editing, setEditing] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);

  const [filters, setFilters] = useState({ from: '', to: '', client_id: '' });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  const note = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2600);
  };

  const loadHeader = useCallback(async () => {
    if (!caretakerId) return;
    try {
      const [c, s] = await Promise.all([
        api.getCaretaker(caretakerId),
        api.caretakerSummary(caretakerId, periodStart),
      ]);
      setCaretaker(c.caretaker ?? c);
      setSummary(s);
      // Deliberately NOT writing s.period.start back into periodStart: a slow
      // initial response would otherwise land after the user pressed Prev and
      // silently snap them back to the current period. `periodStart === null`
      // means "current", which is exactly what the endpoint already assumes.
    } catch (e) {
      setError(e.message);
    }
  }, [caretakerId, periodStart]);

  useEffect(() => {
    setLoading(true);
    loadHeader().finally(() => setLoading(false));
  }, [loadHeader]);

  /* Documents come from this caretaker's task checklists. */
  useEffect(() => {
    if (!caretakerId) {
      setLoadingDocs(false);
      return undefined;
    }
    let cancelled = false;
    api
      .tasks()
      .then((d) => {
        if (cancelled) return;
        const mine = (d.tasks ?? [])
          .filter((t) => t.caretaker_id === caretakerId)
          .flatMap((t) => t.items ?? []);
        setDocuments(mine);
      })
      .catch(() => !cancelled && setDocuments([]))
      .finally(() => !cancelled && setLoadingDocs(false));
    return () => {
      cancelled = true;
    };
  }, [caretakerId]);

  // splits follow the browsed pay period when the range is "period"
  useEffect(() => {
    if (!caretakerId) return;
    api
      .caretakerSplits(caretakerId, range, periodStart)
      .then(setSplits)
      .catch((e) => setError(e.message));
  }, [caretakerId, range, periodStart]);

  useEffect(() => {
    if (!caretakerId) return;
    api
      .caretakerCalendar(caretakerId, month)
      .then((c) => {
        setCalendar(c);
        setPicked(null);
      })
      .catch((e) => setError(e.message));
  }, [caretakerId, month]);

  useEffect(() => {
    if (!caretakerId) return;
    api
      .caretakerHistory(caretakerId, {
        ...filters,
        page,
        sort,
        per_page: 20,
      })
      .then(setHistory)
      .catch((e) => setError(e.message));
  }, [caretakerId, filters, page, sort]);

  function shiftMonth(delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  if (loading && !caretaker) return <div className="page wide"><p className="empty">Loading…</p></div>;
  if (!caretaker) return <div className="page wide"><p className="empty">{error ?? 'Caretaker not found.'}</p></div>;

  const p = summary?.period;
  const snap = summary?.in_period;
  const earn = summary?.earnings;

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <p className="muted small" style={{ margin: 0 }}>
            <Link to="/caretakers" className="link-back">
              ← Caretakers
            </Link>
          </p>
          <h1 id="caretaker-name">
            {caretaker.last_name}, {caretaker.first_name}{' '}
            <span
              className={`pill ${caretaker.status === 'Active' ? 'ok' : 'pending'}`}
              id="caretaker-status-badge"
            >
              {caretaker.status ?? (caretaker.active ? 'Active' : 'Pending')}
            </span>
          </h1>
        </div>
        {flash && <span className="pill ok">{flash}</span>}
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* -------------------------------------------------- section A */}
      <section className="card" id="caretaker-info">
        <div className="card-head">
          <h2>Profile</h2>
          <button className="btn tiny" id="edit-caretaker" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        {editing ? (
          <CaretakerForm
            title="Edit caretaker"
            initial={caretaker}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false);
              await loadHeader();
              note('Caretaker updated');
            }}
            onError={setError}
          />
        ) : (
          <div className="grid-3">
            <div><span className="metric-label">Name</span><div>{caretaker.first_name} {caretaker.last_name}</div></div>
            <div><span className="metric-label">NPI</span><div className="mono">{caretaker.npi_number ?? '—'}</div></div>
            <div><span className="metric-label">SSN</span><div className="mono">{caretaker.ssn ?? '—'}</div></div>
            <div><span className="metric-label">Gender</span><div>{caretaker.gender ?? '—'}</div></div>
            <div><span className="metric-label">Date of birth</span><div>{caretaker.dob ?? '—'}</div></div>
            <div>
              <span className="metric-label">Status</span>
              <div>
                <span className={`pill tiny ${caretaker.status === 'Active' ? 'ok' : 'pending'}`}>
                  {caretaker.status ?? (caretaker.active ? 'Active' : 'Pending')}
                </span>
              </div>
            </div>
            <div>
              <span className="metric-label">Driver's licence</span>
              <div className="mono">{caretaker.dl_number ?? '—'}</div>
            </div>
            <div className="span-2">
              <span className="metric-label">Notes</span>
              <div className="muted">{caretaker.notes ?? '—'}</div>
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------ documents */}
      <section className="card" id="caretaker-documents">
        <div className="card-head">
          <div>
            <h2>Documents</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Files uploaded against this caretaker's onboarding checklist.
            </p>
          </div>
        </div>
        {(() => {
          const docs = (documents ?? []).filter((d) => d.document_path);
          if (loadingDocs) return <p className="empty">Loading documents…</p>;
          if (!docs.length) {
            return (
              <p className="empty" id="no-documents">
                No documents uploaded yet.
              </p>
            );
          }
          return (
            <ul className="doc-list" id="caretaker-doc-list">
              {docs.map((d) => (
                <li key={d.id} className="doc-row">
                  <span className="doc-label">{d.label}</span>
                  <span className="muted small">{d.completed_at ?? ''}</span>
                  <a
                    className="link"
                    href={`/${d.document_path}`}
                    target="_blank"
                    rel="noreferrer"
                    id={`doc-view-${d.id}`}
                  >
                    View
                  </a>
                </li>
              ))}
            </ul>
          );
        })()}
      </section>

      {/* -------------------------------------------------- section B */}
      <section className="card" id="period-snapshot">
        <div className="card-head">
          <div>
            <h2>Current pay period</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }} id="snapshot-period">
              {p ? `${formatLongDate(p.start)} → ${formatLongDate(p.end)}${p.is_current ? ' (current)' : ''}` : '—'}
            </p>
          </div>
          <div className="head-actions">
            <button className="btn" id="snap-prev" onClick={() => p && setPeriodStart(p.prev_start)} disabled={!p}>
              ← Prev
            </button>
            <button className="btn" id="snap-current" onClick={() => setPeriodStart(null)} disabled={!p || p.is_current}>
              Current
            </button>
            <button className="btn" id="snap-next" onClick={() => p && setPeriodStart(p.next_start)} disabled={!p}>
              Next →
            </button>
          </div>
        </div>
        <div className="metric-row">
          <Metric label="Hours worked" value={hours(snap?.hours)} hint="Minutes recorded in this pay period ÷ 60" id="snap-hours" />
          <Metric label="Billed value" value={formatMoney(snap?.dollars ?? 0)} hint="Sum of day entry dollars for this pay period" id="snap-dollars" />
          <Metric label="Clients worked with" value={snap?.clients ?? 0} hint="Distinct clients with a day entry in this pay period" id="snap-clients" />
          <Metric
            label="Rank"
            value={snap?.rank ? `#${snap.rank} of ${snap.of}` : `— of ${snap?.of ?? 0}`}
            hint="Position among active caretakers by hours worked this pay period"
            id="snap-rank"
          />
        </div>
      </section>

      {/* -------------------------------------------------- section C */}
      <section className="card" id="earnings">
        <div className="card-head">
          <h2>Earnings</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Every figure comes from day entry dollars (units × rate per unit).
          </p>
        </div>
        <div className="metric-row">
          <Metric label="This pay period" value={formatMoney(earn?.period ?? 0)} hint="Billed value for the pay period shown above" id="earn-period" />
          <Metric label="Month to date" value={formatMoney(earn?.mtd ?? 0)} hint="Billed value for the current calendar month" id="earn-mtd" />
          <Metric label="Year to date" value={formatMoney(earn?.ytd ?? 0)} hint="Billed value for the current calendar year" id="earn-ytd" />
          <Metric label="Anticipated" value={formatMoney(earn?.anticipated ?? 0)} hint="Claims with status Submitted that are not paid yet" id="earn-anticipated" />
          <Metric label="Confirmed" value={formatMoney(earn?.confirmed ?? 0)} hint="Claims with status Paid" id="earn-confirmed" />
        </div>
      </section>

      {/* -------------------------------------------------- section D */}
      <section className="card" id="client-splits">
        <div className="card-head">
          <h2>Client splits</h2>
          <select id="split-range" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="period">This Pay Period</option>
            <option value="month">This Month</option>
            <option value="ytd">Year to Date</option>
            <option value="all">All Time</option>
          </select>
        </div>
        {!splits?.splits?.length ? (
          <p className="empty" id="splits-empty">No work recorded in this range.</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="table" id="splits-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="num">Hours</th>
                    <th className="num">Dollars</th>
                    <th className="num">% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {splits.splits.map((s) => (
                    <tr key={s.client_id} id={`split-row-${s.client_id}`}>
                      <td>
                        <Link to={`/clients/${s.client_id}`}>{s.client_name}</Link>
                      </td>
                      <td className="num">{hours(s.hours)}</td>
                      <td className="num dollars">{formatMoney(s.dollars)}</td>
                      <td className="num">{s.percentage.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bars" id="splits-bars">
              {splits.splits.map((s) => (
                <div className="bar-row" key={s.client_id}>
                  <span className="bar-label">{s.client_name}</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      id={`split-bar-${s.client_id}`}
                      style={{ width: `${Math.max(s.percentage, 1)}%` }}
                    />
                  </span>
                  <span className="bar-value">{s.percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* -------------------------------------------------- section E */}
      <section className="card" id="work-history-calendar">
        <div className="card-head">
          <div>
            <h2>Work calendar</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Only days with recorded work are shaded. Darker means more hours.
            </p>
          </div>
        </div>
        {calendar && (
          <WorkCalendar
            days={calendar.days}
            month={calendar.month}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            onPick={setPicked}
            selectedId={picked?.entries?.[0]?.id}
          />
        )}
        {picked && (
          <div className="day-popover" id="day-popover">
            <div className="card-head">
              <strong>{formatLongDate(picked.work_date)}</strong>
              <button className="btn tiny" id="close-popover" onClick={() => setPicked(null)}>
                Close
              </button>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Start</th>
                    <th>End</th>
                    <th className="num">Hours</th>
                    <th className="num">Units</th>
                    <th className="num">Billed</th>
                    <th>Claim</th>
                  </tr>
                </thead>
                <tbody>
                  {picked.entries.map((e) => (
                    <tr key={e.id} id={`popover-entry-${e.id}`}>
                      <td>{e.client_name}</td>
                      <td>{e.start_time ?? '—'}</td>
                      <td>{e.end_time ?? '—'}</td>
                      <td className="num">{hours(e.hours)}</td>
                      <td className="num">{e.units ?? '—'}</td>
                      <td className="num dollars">{formatMoney(e.dollars)}</td>
                      <td>{e.claim_status ?? <span className="muted">unclaimed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* -------------------------------------------------- section F */}
      <section className="card" id="work-history-log">
        <div className="card-head">
          <div>
            <h2>Work history</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              {history ? `${history.total} entr${history.total === 1 ? 'y' : 'ies'}` : '—'}
            </p>
          </div>
          <div className="head-actions">
            <select
              id="history-client"
              value={filters.client_id}
              onChange={(e) => {
                setPage(1);
                setFilters((f) => ({ ...f, client_id: e.target.value }));
              }}
            >
              <option value="">All clients</option>
              {(splits?.splits ?? []).map((s) => (
                <option key={s.client_id} value={String(s.client_id)}>
                  {s.client_name}
                </option>
              ))}
            </select>
            <input
              type="date"
              id="history-from"
              value={filters.from}
              onChange={(e) => {
                setPage(1);
                setFilters((f) => ({ ...f, from: e.target.value }));
              }}
            />
            <input
              type="date"
              id="history-to"
              value={filters.to}
              onChange={(e) => {
                setPage(1);
                setFilters((f) => ({ ...f, to: e.target.value }));
              }}
            />
            <button
              className="btn tiny"
              id="history-clear"
              onClick={() => {
                setPage(1);
                setFilters({ from: '', to: '', client_id: '' });
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {!history?.entries?.length ? (
          <p className="empty" id="history-empty">No entries match.</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="table" id="history-table">
                <thead>
                  <tr>
                    <th>
                      <button
                        className="th-sort"
                        id="history-sort-date"
                        onClick={() => {
                          setPage(1);
                          setSort((s) => (s === 'desc' ? 'asc' : 'desc'));
                        }}
                      >
                        Date {sort === 'desc' ? '↓' : '↑'}
                      </button>
                    </th>
                    <th>Client</th>
                    <th className="num">Hours</th>
                    <th className="num">Units</th>
                    <th className="num">Billed</th>
                    <th>Claim status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.entries.map((e) => (
                    <tr
                      key={e.id}
                      id={`history-row-${e.id}`}
                      className="row-clickable"
                      onClick={() => navigate(`/clients/${e.client_id}?week=${e.work_date}`)}
                      title="Open this day on the client's calendar"
                    >
                      <td className="nowrap">{formatLongDate(e.work_date)}</td>
                      <td>{e.client_name}</td>
                      <td className="num">{hours(e.hours)}</td>
                      <td className="num">{e.units ?? '—'}</td>
                      <td className="num dollars">{formatMoney(e.dollars)}</td>
                      <td>{e.claim_status ?? <span className="muted">unclaimed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager" id="history-pager">
              <button className="btn tiny" id="history-first" disabled={history.page <= 1} onClick={() => setPage(1)}>
                « First
              </button>
              <button className="btn tiny" id="history-prev" disabled={history.page <= 1} onClick={() => setPage((n) => n - 1)}>
                ← Prev
              </button>
              <span id="history-page">
                Page {history.page} of {history.pages}
              </span>
              <button className="btn tiny" id="history-next" disabled={history.page >= history.pages} onClick={() => setPage((n) => n + 1)}>
                Next →
              </button>
              <button className="btn tiny" id="history-last" disabled={history.page >= history.pages} onClick={() => setPage(history.pages)}>
                Last »
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
