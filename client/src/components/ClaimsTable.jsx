import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ClaimPdfControl from './ClaimPdfControl.jsx';
import BulkClaimActions from './BulkClaimActions.jsx';
import { formatLongDate, formatMoney } from '../calc.js';

const STATUS_CLASS = {
  Draft: 'pill draft',
  Submitted: 'pill submitted',
  Paid: 'pill paid',
  Denied: 'pill denied',
};

/**
 * Shared claims list. Overdue rows are flagged in red.
 *
 * `onArchive` / `onDelete` are optional: when they are supplied the row grows an
 * actions menu. The client profile passes neither, so its table is unchanged.
 */
/**
 * How a claim is LABELLED. The stored `claim_name` is untouched.
 *
 * Imported claims are named {last}_{ma}_{dos_start}_{dos_end}_{seq}. A claim
 * from a columnar advice has no service dates, so both halves are empty and
 * every such claim renders as "NNADIKWE_03276736___01" — four identical rows on
 * a client profile. When the DOS is missing the reversal's own CLM # is a
 * better discriminator, and failing that the row id always is.
 */
export function claimDisplayName(c) {
  const name = c?.claim_name ?? (c?.id != null ? `#${c.id}` : '');
  // a well-formed claim keeps exactly the name it was stored with
  if (c?.period_start || c?.dos_start) return name;
  const last = (
    c?.last_name ||
    String(c?.client_name ?? '').split(',')[0] ||
    String(name).split('_')[0] ||
    'CLAIM'
  ).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'CLAIM';
  const ma = c?.ma_number || c?.client_id || String(name).split('_')[1] || 'NA';
  const clm = c?.ra_claim_number || c?.claim_number;
  if (clm) return `${last}_${ma}_${clm}_01`;
  return `${last}_${ma}_INCOMPLETE_${c?.id ?? 'X'}`;
}

export default function ClaimsTable({
  claims,
  onEdit,
  onPdfChanged,
  onArchive,
  onDelete,
  onChanged,
  onError,
  onNotify,
  clientName,
  showClient = false,
  emptyMessage,
}) {
  const showActions = Boolean(onArchive || onDelete);
  // Bulk selection lives here, so the dashboard and the profile each keep their
  // own independent selection.
  const [selected, setSelected] = useState(() => new Set());
  const selectAllRef = useRef(null);

  // Drop ids that no longer exist (e.g. after a reload or a bulk action).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(claims.map((c) => c.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [claims]);

  const selectedClaims = useMemo(
    () => claims.filter((c) => selected.has(c.id)),
    [claims, selected]
  );

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = claims.length > 0 && selectedClaims.length === claims.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedClaims.length > 0 && !allSelected;
    }
  }, [selectedClaims.length, allSelected]);

  /** Row click toggles, but never when the click lands on a control. */
  function onRowClick(e, id) {
    if (!showActions) return;
    if (e.target.closest('input, select, button, textarea, a, label, details, summary')) return;
    if (window.getSelection?.()?.toString()) return;
    toggle(id);
  }
  if (!claims.length) {
    return <p className="empty">{emptyMessage ?? 'No claims yet.'}</p>;
  }

  return (
    <>
      <div className="table-scroll hide-on-mobile">
      <table className="table claims-table">
        <thead>
          <tr>
            {showActions && (
              <th className="select-col">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="day-check"
                  id="claims-select-all"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(claims.map((c) => c.id)))
                  }
                  aria-label="Select all claims"
                  title="Select all"
                />
              </th>
            )}
            <th>Claim</th>
            {showClient && <th>Client</th>}
            <th>Period</th>
            <th className="num">Units</th>
            <th className="num">Billed</th>
            <th>Status</th>
            <th>Submitted</th>
            <th>Expected</th>
            <th>Paid</th>
            <th>PDF</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => (
            <tr
              key={c.id}
              onClick={(e) => onRowClick(e, c.id)}
              className={[
                c.is_overdue ? 'row-overdue' : '',
                `row-status-${(c.status || '').toLowerCase()}`,
                c.archived ? 'row-archived' : '',
                selected.has(c.id) ? 'row-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {showActions && (
                <td className="select-col">
                  <input
                    type="checkbox"
                    className="day-check"
                    name={`claim-select-${c.id}`}
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select claim ${c.claim_name ?? c.id}`}
                  />
                </td>
              )}
              <td className="mono">
                {claimDisplayName(c)}
                {c.archived ? (
                  <span className="pill archived" id={`claim-archived-badge-${c.id}`}>
                    Archived
                  </span>
                ) : null}
                {c.parse_status === 'layout_incomplete' ? (
                  <span
                    className="ds-badge ds-badge-amber"
                    id={`claim-incomplete-${c.id}`}
                    title="Parsed from a file with an unreadable layout. DOS range and line items may be missing. Re-download from MN-ITS and re-import to fix."
                  >
                    INCOMPLETE
                  </span>
                ) : null}
                {c.reversal_flag ? (
                  <span
                    className="ds-badge ds-badge-solid-amber"
                    id={`claim-reversed-badge-${c.id}`}
                    title={`This claim was reversed${
                      c.reversal_date ? ` on ${c.reversal_date}` : ''
                    }. See Denials archive for details.`}
                  >
                    Reversed
                  </span>
                ) : null}
              </td>
              {showClient && (
                <td>
                  {c.last_name}, {c.first_name}
                </td>
              )}
              <td className="nowrap">
                {formatLongDate(c.period_start)} → {formatLongDate(c.period_end)}
              </td>
              <td className="num">{c.total_units ?? '—'}</td>
              <td className="num dollars">{formatMoney(c.total_dollars)}</td>
              <td className="nowrap">
                <span className={STATUS_CLASS[c.status] ?? 'pill'}>{c.status}</span>
                {c.is_overdue && (
                  <span className="pill overdue tiny" title={`Expected ${c.expected_pay_date}`}>
                    OVERDUE{c.days_overdue ? ` ${c.days_overdue}d` : ''}
                  </span>
                )}
              </td>
              <td className="nowrap">
                {c.submitted_date ? formatLongDate(c.submitted_date) : <span className="muted">—</span>}
              </td>
              <td className="nowrap">
                {c.expected_pay_date ? (
                  <>
                    {formatLongDate(c.expected_pay_date)}
                    {!c.paid_date && c.status === 'Submitted' && !c.is_overdue && (
                      <div className="sub">
                        {c.days_until_expected === 0
                          ? 'due today'
                          : `in ${c.days_until_expected} day${c.days_until_expected === 1 ? '' : 's'}`}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="nowrap">
                {c.paid_date ? (
                  <>
                    {formatLongDate(c.paid_date)}
                    {c.variance_days != null && (
                      <div className={c.variance_days > 0 ? 'sub variance-late' : 'sub variance-ok'}>
                        {c.variance_days > 0
                          ? `+${c.variance_days}d late`
                          : c.variance_days === 0
                            ? 'on time'
                            : `${Math.abs(c.variance_days)}d early`}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="pdf-cell">
                <ClaimPdfControl claim={c} onChanged={onPdfChanged} compact />
              </td>
              <td className="row-actions actions-cell">
                {showActions && (
                  <details className="actions-menu">
                    <summary
                      aria-label={`Actions for ${c.claim_name ?? `claim ${c.id}`}`}
                      title="Actions"
                    >
                      ⋯
                    </summary>
                    <div className="actions-items">
                      <button
                        type="button"
                        className="menu-item"
                        onClick={() => onEdit?.(c)}
                      >
                        Edit
                      </button>
                      {onArchive && (
                        <button
                          type="button"
                          className="menu-item"
                          id={`claim-archive-${c.id}`}
                          onClick={() => onArchive(c)}
                        >
                          {c.archived ? 'Unarchive' : 'Archive'}
                        </button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          className="menu-item danger"
                          id={`claim-delete-${c.id}`}
                          onClick={() => onDelete(c)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </details>
                )}
                {!showActions && (
                  <button className="btn tiny" onClick={() => onEdit?.(c)}>
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {/* Mobile: one card per claim — a 12-column table is unusable at 375px */}
    <div className="show-on-mobile claim-cards" id="claims-cards">
      {claims.map((c, index) => (
        <motion.div
          key={c.id}
          className={[
            'claim-card',
            c.is_overdue ? 'claim-card-overdue' : '',
            c.archived ? 'claim-card-archived' : '',
            selected.has(c.id) ? 'claim-card-selected' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={(e) => onRowClick?.(e, c.id)}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.24,
            delay: Math.min(index * 0.03, 0.24),
            ease: [0.4, 0, 0.2, 1],
          }}
        >
          <div className="claim-card-top">
            {showActions && (
              <input
                type="checkbox"
                className="day-check"
                id={`claim-card-select-${c.id}`}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select claim ${c.claim_name ?? c.id}`}
              />
            )}
            <span className="claim-card-name" title={claimDisplayName(c)}>
              {claimDisplayName(c)}
            </span>
            <span className={STATUS_CLASS[c.status] ?? 'pill'}>{c.status}</span>
          </div>

          <div className="claim-card-meta">
            {showClient && (
              <span>{c.last_name}, {c.first_name}</span>
            )}
            <span>
              {formatLongDate(c.period_start)} → {formatLongDate(c.period_end)}
            </span>
          </div>

          {(c.archived || c.parse_status === 'layout_incomplete' || c.reversal_flag || c.is_overdue) && (
            <div className="claim-card-flags">
              {c.archived && <span className="pill archived">Archived</span>}
              {c.parse_status === 'layout_incomplete' && (
                <span className="ds-badge ds-badge-amber">INCOMPLETE</span>
              )}
              {c.reversal_flag && <span className="ds-badge ds-badge-solid-amber">Reversed</span>}
              {c.is_overdue && (
                <span className="pill overdue tiny">
                  OVERDUE{c.days_overdue ? ` ${c.days_overdue}d` : ''}
                </span>
              )}
            </div>
          )}

          <div className="claim-card-bottom">
            <span className="claim-card-amount">{formatMoney(c.total_dollars)}</span>
            <span className="muted small">{c.total_units ?? '—'} units</span>
            <ClaimPdfControl claim={c} onChanged={onPdfChanged} compact />
          </div>

          {showActions && (
            <details className="actions-menu claim-card-actions">
              <summary aria-label={`Actions for ${c.claim_name ?? `claim ${c.id}`}`} title="Actions">
                ⋯ Actions
              </summary>
              <div className="actions-items">
                <button type="button" className="menu-item" onClick={() => onEdit?.(c)}>
                  Edit
                </button>
                {onArchive && (
                  <button type="button" className="menu-item" onClick={() => onArchive(c)}>
                    {c.archived ? 'Unarchive' : 'Archive'}
                  </button>
                )}
                {onDelete && (
                  <button type="button" className="menu-item" onClick={() => onDelete(c)}>
                    Delete
                  </button>
                )}
              </div>
            </details>
          )}
        </motion.div>
      ))}
      {!claims.length && <p className="empty">{emptyMessage ?? 'No claims yet.'}</p>}
    </div>

      {showActions && (
        <BulkClaimActions
          selected={selectedClaims}
          onClear={() => setSelected(new Set())}
          onDone={() => {
            setSelected(new Set());
            onChanged?.();
          }}
          onError={onError}
          onNotify={onNotify}
          clientName={clientName}
        />
      )}
    </>
  );
}
