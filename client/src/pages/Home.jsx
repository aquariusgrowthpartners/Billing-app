import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { formatLongDate, formatMoney, formatClientName, todayISO } from '../calc.js';
import InsightBar from '../components/InsightBar.jsx';
import Skeleton from '../components/Skeleton.jsx';
import Tasks from './Tasks.jsx';

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

export default function Home({ user }) {
  const navigate = useNavigate();
  const [periodStart, setPeriodStart] = useState(null);
  const [periodEnd, setPeriodEnd] = useState(null);
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const [pickerStart, setPickerStart] = useState('');
  const [pickerEnd, setPickerEnd] = useState('');
  const [data, setData] = useState(null);
  const [denialAlert, setDenialAlert] = useState(null);
  const [ytd, setYtd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [onboarding, setOnboarding] = useState(null);
  const [onboardingOpen, setOnboardingOpen] = useState(true);

  const load = useCallback(async (start) => {
    setLoading(true);
    setError(null);
    try {
      const [d, dn, ytdData] = await Promise.all([
        api.payPeriod(start, periodEnd),
        api.denialSummary().catch(() => null),
        api.ytdClaims().catch(() => null),
      ]);
      if (!d || typeof d !== 'object') {
        throw new Error('Dashboard data was empty or invalid.');
      }
      setDenialAlert(dn);
      setYtd(ytdData);
      setData(d ?? null);
      setPeriodStart(d?.period?.start ?? null);
    } catch (e) {
      console.error('Dashboard fetch failed', e);
      setError(e.message || 'Dashboard fetch failed');
    } finally {
      setLoading(false);
    }
  }, [periodEnd]);

  useEffect(() => {
    load(periodStart);
    // Only re-run when the user pages the period.
  }, [periodStart, periodEnd, load]);

  // Refetch whenever something elsewhere changes the underlying data (an RA
  // import, for instance), so the figures here are never stale.
  useEffect(() => {
    const refresh = () => load(periodStart);
    window.addEventListener('data-updated', refresh);
    return () => window.removeEventListener('data-updated', refresh);
  }, [load, periodStart, periodEnd]);

  useEffect(() => {
    if (!user || user.is_demo) return undefined;
    let cancelled = false;
    api.onboarding().then((result) => { if (!cancelled) setOnboarding(result); }).catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    api.alerts()
      .then((result) => {
        if (!cancelled) setAlerts(Array.isArray(result?.alerts) ? result.alerts : []);
      })
      .catch(() => {
        if (!cancelled) setAlerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Keep the page from ever rendering with no dashboard payload. If the fetch
   * failed, show the reason instead of an eternal loading message.
   */
  if (!data) {
    return (
      <div className="page wide home" id="home-loading">
        <header className="home-top">
          <div>
            <h1 data-tour="home">Home</h1>
            <p className="home-sub">Pay period overview and recent activity</p>
          </div>
        </header>


      <InsightBar userName={user?.email} loading />

        {error ? (
          <div className="alert error" id="home-fetch-error">
            Home Page Error: {error}
          </div>
        ) : (
          <>
            <div className="sk-stat-row">
              <Skeleton variant="stat" />
              <Skeleton variant="stat" />
              <Skeleton variant="stat" />
            </div>
            <div className="card" style={{ padding: 24 }}>
              <Skeleton lines={4} />
            </div>
          </>
        )}
      </div>
    );
  }

  const period = data?.period && typeof data.period === 'object' ? data.period : null;
  const caretakers = Array.isArray(data?.caretakers) ? data.caretakers : [];
  const totals = data?.totals && typeof data.totals === 'object' ? data.totals : {};
  const unassigned =
    data?.unassigned && typeof data.unassigned === 'object' ? data.unassigned : {};
  const denial = denialAlert && typeof denialAlert === 'object' ? denialAlert : null;
  const byClientCount = Array.isArray(denial?.by_client) ? denial.by_client.length : 0;
  const hasDenialExposure =
    Number(denial?.unrecovered_days) > 0 || Number(denial?.unrecovered_dollars) > 0;
  const alertList = Array.isArray(alerts) ? alerts : [];

  return (
    <div className={`page wide home${onboarding && !onboarding.complete ? (onboardingOpen ? ' onboarding-open' : ' onboarding-closed') : ''}`}>
      {onboarding && !onboarding.complete && (
        <>
          <button
            type="button"
            className="onboarding-toggle"
            id="onboarding-toggle"
            onClick={() => setOnboardingOpen(true)}
          >
            ☰ Getting Started
          </button>
          {onboardingOpen && <div className="onboarding-scrim" onClick={() => setOnboardingOpen(false)} />}
        <aside className="card onboarding-card onboarding-drawer" id="onboarding-checklist">
          <div className="card-head">
            <div><h2>Getting started</h2><p className="muted small" style={{ margin: '2px 0 0' }}>Complete these steps to finish setting up.</p></div>
            <button type="button" className="btn tiny" aria-label="Collapse Getting Started" onClick={() => setOnboardingOpen(false)}>✕</button>
          </div>
          <ul className="onboarding-list">
            {[
              ['home', 'Explore Home dashboard', '/'],
              ['clients', 'Add or manage Clients', '/clients'],
              ['uploads_ra', 'Upload an RA', '/uploads?tab=ra'],
              ['uploads_claim', 'Upload a Claim Submission', '/uploads?tab=claims'],
              ['uploads_sa', 'Import a Service Agreement', '/uploads?tab=sa'],
              ['pending_claims', 'Review Pending Claims', '/pending-claims'],
              ['ask_ai', 'Ask Dundas AI a question', '/ask'],
              ['settings', 'Customize Settings', '/settings'],
            ].map(([key, label, href]) => (
              <li key={key} className={onboarding.checklist?.[key] ? 'done' : ''}>
                <span className="onboarding-check">{onboarding.checklist?.[key] ? '✓' : '○'}</span>
                <Link
                  to={href}
                  onClick={async () => {
                    if (onboarding.checklist?.[key]) return;
                    try {
                      const result = await api.completeOnboardingStep(key);
                      setOnboarding((prev) => ({ ...prev, ...result }));
                    } catch {}
                  }}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
        </>
      )}

      <div className="home-main">
      <header className="home-top">
        <div>
          <h1>Home</h1>
          <p className="home-sub">Pay period overview and recent activity</p>
        </div>
        <DueReminder />
      </header>


      <section className="card ytd-claims-card" id="ytd-paid-claims">
        <div className="ytd-claims-copy">
          <span className="metric-label">Year-to-date paid claims</span>
          <span className="muted small">
            Jan 1 – today{ytd ? ` · ${ytd.count ?? 0} paid claim${(ytd.count ?? 0) === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="ytd-claims-amount">
          <span className="metric-value ytd-claims-value" id="ytd-claims-total">
            {formatMoney(ytd?.total ?? 0)}
          </span>
          <span className="ytd-trend" aria-label="Active">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
              <path d="M3 11l4-4 3 3 3-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 5h3v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Active
          </span>
        </div>
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

      <Tasks embedded />

      <section className="card home-period-nav" id="period-nav">
        <button
          type="button"
          className="period-range-button"
          id="period-range"
          onClick={() => {
            setPickerStart(period?.start ?? '');
            setPickerEnd(period?.end ?? '');
            setPeriodPickerOpen((v) => !v);
          }}
        >
          <strong>
            {period?.start && period?.end
              ? `${formatLongDate(period.start)} → ${formatLongDate(period.end)}`
              : 'Choose date range'}
          </strong>
          <span className="muted small">{period?.is_current ? 'Current pay period' : 'Custom range'}</span>
        </button>
        {periodPickerOpen && (
          <div className="period-picker" id="period-picker">
            <label className="small">Start Date<input type="date" value={pickerStart} onChange={(e) => setPickerStart(e.target.value)} /></label>
            <label className="small">End Date<input type="date" value={pickerEnd} onChange={(e) => setPickerEnd(e.target.value)} /></label>
            <div className="period-picker-actions">
              <button className="btn" onClick={() => setPeriodPickerOpen(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!pickerStart || !pickerEnd || pickerStart > pickerEnd}
                onClick={() => {
                  setPeriodStart(pickerStart);
                  setPeriodEnd(pickerEnd);
                  setPeriodPickerOpen(false);
                }}
              >
                Apply Range
              </button>
            </div>
          </div>
        )}
      </section>



      {error && <div className="alert error">{error}</div>}


      <section className="card notifications-card" id="home-notifications">
        <div className="card-head">
          <div className="notifications-head">
            <span className="notifications-bell" aria-hidden="true">🔔</span>
            <h2>Notifications</h2>
            {((denial && Number(denial.open_tasks) > 0 && hasDenialExposure) || alertList.length > 0) && (
              <span className="notifications-dot" aria-label="Unread notifications" />
            )}
          </div>
        </div>
        <div className="card-body notifications-body">
      {/* Denials alert: shown only while there is unrecovered work. */}
      {denial && Number(denial.open_tasks) > 0 && hasDenialExposure && (
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

      {alertList.length > 0 && (
        <section className="home-alerts" id="home-alerts">
          {alertList.map((alert) => (
            <div className="home-alert" key={alert.id}>
              <button
                type="button"
                className="home-alert-main"
                onClick={() => navigate(alert.client_id ? `/clients/${alert.client_id}` : '/clients')}
              >
                <strong>{alert.title}</strong>
                <span>{alert.message}</span>
              </button>
              <button
                type="button"
                className="btn tiny"
                onClick={async () => {
                  await api.dismissAlert(alert.id);
                  setAlerts((current) => current.filter((a) => a.id !== alert.id));
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </section>
      )}

          {!((denial && Number(denial.open_tasks) > 0 && hasDenialExposure) || alertList.length > 0) && (
            <p className="empty">You&rsquo;re all caught up.</p>
          )}
        </div>
      </section>

      </div>
    </div>
  );
}
