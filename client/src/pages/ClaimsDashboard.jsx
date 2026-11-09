import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import ClaimsTable from '../components/ClaimsTable.jsx';
import ClaimEditDialog from '../components/ClaimEditDialog.jsx';
import { useClaimActions } from '../components/ClaimActionModals.jsx';
import { formatMoney, todayISO } from '../calc.js';
import { download } from '../download.js';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonCards } from '../components/Skeleton.jsx';
import InsightBar from '../components/InsightBar.jsx';

export default function ClaimsDashboard({ user }) {
  const [claims, setClaims] = useState([]);
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  // "Show reversed claims" narrows the list to claims a payer reversed.
  const [showReversed, setShowReversed] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        api.claims(showArchived ? { archived: '1' } : {}),
        api.payerStats(),
      ]);
      setClaims(Array.isArray(c?.claims) ? c.claims : []);
      setArchivedCount(c?.archived_count ?? 0);
      setStats((Array.isArray(s?.payers) ? s.payers : []).filter((p) => p.paid_claims > 0));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const pipeline = useMemo(() => {
    const sum = (rows) => ({
      count: rows.length,
      dollars: rows.reduce((s, c) => s + (c.total_dollars || 0), 0),
    });
    // The Paid card is money RECEIVED, so it sums net_paid_amount — the same
    // field Reports sums. It previously summed total_dollars (billed), which
    // made it render a duplicate of Reports' Total Billed.
    const sumReceived = (rows) => ({
      count: rows.length,
      dollars: rows.reduce((s, c) => s + Number(c.net_paid_amount || 0), 0),
    });
    return {
      draft: sum(claims.filter((c) => c.status === 'Draft')),
      submitted: sum(claims.filter((c) => c.status === 'Submitted' && !c.paid_date)),
      overdue: sum(claims.filter((c) => c.is_overdue)),
      paid: sumReceived(claims.filter((c) => c.paid_date)),
    };
  }, [claims]);

  /** Query params for the CSV so the file matches the current filter. */
  const exportParams = useMemo(() => {
    if (filter === 'overdue') return { overdue: 1 };
    if (filter === 'all') return {};
    return { status: filter[0].toUpperCase() + filter.slice(1) };
  }, [filter]);

  const visible = useMemo(() => {
    // "Show reversed claims" narrows to claims a payer reversed, and composes
    // with the status filter rather than replacing it.
    const base = showReversed ? claims.filter((c) => c.reversal_flag) : claims;
    if (filter === 'overdue') return base.filter((c) => c.is_overdue);
    if (filter === 'all') return base;
    return base.filter((c) => c.status.toLowerCase() === filter);
  }, [claims, filter, showReversed]);

  function note(message) {
    setFlash(message);
    setTimeout(() => setFlash(null), 2600);
  }

  // Archive / delete with the shared confirmation flow.
  const { requestArchive, requestDelete, modals: claimActionModals } = useClaimActions({
    onChanged: load,
    onError: setError,
    onNotify: note,
  });

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Claims Dashboard</h1>
          <p className="muted">
            Draft → Submitted → Paid pipeline. As of {todayISO()}.
          </p>
        </div>
        <div className="head-actions">
          {flash && <span className="pill ok" id="claims-flash">{flash}</span>}
          <label className="checkbox" id="claims-show-archived">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show Archived ({archivedCount})
          </label>
          <label className="checkbox" id="claims-show-reversed">
            <input
              type="checkbox"
              checked={showReversed}
              onChange={(e) => setShowReversed(e.target.checked)}
            />
            Show reversed claims
          </label>
        </div>
      </div>

      <InsightBar
        userName={user?.email}
        loading={loading}
        hasData={claims.length > 0}
        awaiting={pipeline.submitted.count}
      />

      {error && <div className="alert error">{error}</div>}

      <div className="pipeline">
        <PipeCard
          label="Draft"
          count={pipeline.draft.count}
          dollars={pipeline.draft.dollars}
          hint="not yet sent"
          onClick={() => setFilter('draft')}
          active={filter === 'draft'}
        />
        <PipeArrow />
        <PipeCard
          label="Submitted"
          count={pipeline.submitted.count}
          dollars={pipeline.submitted.dollars}
          hint="awaiting payment"
          onClick={() => setFilter('submitted')}
          active={filter === 'submitted'}
        />
        <PipeArrow />
        <PipeCard
          label="Paid"
          count={pipeline.paid.count}
          dollars={pipeline.paid.dollars}
          hint="money received"
          onClick={() => setFilter('paid')}
          active={filter === 'paid'}
        />
      </div>

      {pipeline.overdue.count > 0 && (
        <button
          className={filter === 'overdue' ? 'overdue-banner active' : 'overdue-banner'}
          onClick={() => setFilter(filter === 'overdue' ? 'all' : 'overdue')}
        >
          <strong>
            {pipeline.overdue.count} OVERDUE claim{pipeline.overdue.count > 1 ? 's' : ''}
          </strong>
          <span>
            {formatMoney(pipeline.overdue.dollars)} past the payer's expected date
            {filter === 'overdue' ? ' — click to show all' : ' — click to filter'}
          </span>
        </button>
      )}

      {stats.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Observed payer lag</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                Real payment behaviour from settled claims, versus the terms you configured.
              </p>
            </div>
          </div>
          <div className="table-scroll hide-on-mobile">
            <table className="table">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th className="num">Configured</th>
                  <th className="num">Real avg lag</th>
                  <th className="num">Avg variance</th>
                  <th className="num">Claims paid</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((p) => (
                  <tr key={p.payer_id}>
                    <td>{p.payer_name}</td>
                    <td className="num">{p.typical_days_to_pay ?? '—'} d</td>
                    <td className="num">{p.avg_lag_days ?? '—'} d</td>
                    <td className="num">
                      {p.avg_variance_days == null ? (
                        '—'
                      ) : (
                        <span className={p.avg_variance_days > 0 ? 'variance-late' : 'variance-ok'}>
                          {p.avg_variance_days > 0 ? '+' : ''}
                          {p.avg_variance_days} d
                        </span>
                      )}
                    </td>
                    <td className="num">{p.paid_claims}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked rows instead of a 4-column table */}
          <div className="show-on-mobile payer-lag-list" id="payer-lag-list">
            {stats.map((p) => (
              <div className="payer-lag-card" key={p.payer_id}>
                <div className="payer-lag-name">{p.payer_name}</div>
                <div className="payer-lag-meta">
                  <span>
                    Configured: <strong>{p.typical_days_to_pay ?? '—'} d</strong>
                  </span>
                  <span>
                    Real avg: <strong>{p.avg_lag_days ?? '—'} d</strong>
                  </span>
                </div>
              </div>
            ))}
            {!stats.length && <p className="empty">No paid claims yet.</p>}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>
              {filter === 'all' ? 'All claims' : `${filter[0].toUpperCase()}${filter.slice(1)} claims`}
            </h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              {visible.length} shown
              {filter !== 'all' && (
                <>
                  {' · '}
                  <button className="link-inline" onClick={() => setFilter('all')}>
                    clear filter
                  </button>
                </>
              )}
            </p>
          </div>
          <button
            className="btn"
            disabled={!visible.length}
            title="Download these claims as a CSV file"
            onClick={() => download(api.claimsCsvUrl(exportParams), `claims_export_${todayISO()}.csv`)}
          >
            Export Claims to CSV
          </button>
        </div>
        {loading && !claims.length ? (
          <SkeletonCards count={5} />
        ) : claims.length === 0 ? (
          <EmptyState icon="🧾" title="No claims yet" id="claims-empty">
            Open a <Link to="/clients">client</Link> → <strong>Generate Claim</strong> to create the
            first one.
          </EmptyState>
        ) : (
          <ClaimsTable
            onArchive={requestArchive}
            onDelete={requestDelete}
            onChanged={load}
            onError={setError}
            onNotify={note}
            claims={visible}
            showClient
            onEdit={setEditing}
            onPdfChanged={async () => { await load(); }}
            emptyMessage="No claims match this filter."
          />
        )}
      </section>

      {claimActionModals}

      {editing && (
        <ClaimEditDialog
          claim={editing}
          onClose={() => setEditing(null)}
          onClaimChanged={() => load()}
          onArchive={async (c) => {
            await requestArchive(c);
          }}
          onDelete={async (c) => {
            setEditing(null);
            await requestDelete(c);
          }}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onPdfChanged={async (updated) => {
            setEditing(updated);
            await load();
          }}
        />
      )}
    </div>
  );
}

function PipeCard({ label, count, dollars, hint, onClick, active }) {
  return (
    <button className={active ? 'pipe-card active' : 'pipe-card'} onClick={onClick}>
      <span className="pipe-label">{label}</span>
      <span className="pipe-count">{count}</span>
      <span className="pipe-dollars">{formatMoney(dollars)}</span>
      <span className="pipe-hint">{hint}</span>
    </button>
  );
}

function PipeArrow() {
  return (
    <span className="pipe-arrow" aria-hidden="true">
      →
    </span>
  );
}
