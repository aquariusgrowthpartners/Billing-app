import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import Modal from './Modal.jsx';
import {
  todayISO,
  weekStartSunday,
  addDays,
  formatLongDate,
  formatMoney,
} from '../calc.js';

/**
 * Generates a Draft claim for a date range.
 *
 * The default range is the client's ENTIRE unclaimed span (oldest day to newest
 * day), not a calendar week. A fixed week boundary silently drops whatever sits
 * just outside it — that is how a Sunday entry went missing from a total.
 * The range stays fully editable, and anything left out is called out.
 */
export default function GenerateClaimDialog({ clientId, clientName, onClose, onGenerated }) {
  const [periodStart, setPeriodStart] = useState(null);
  const [periodEnd, setPeriodEnd] = useState(null);
  const [preview, setPreview] = useState(null);
  const [resolvingDefaults, setResolvingDefaults] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Work out the starting range from the data itself.
  useEffect(() => {
    let cancelled = false;
    setResolvingDefaults(true);
    api
      .previewClaim(clientId)
      .then((d) => {
        if (cancelled) return;
        if (d.suggested_period_start) {
          setPeriodStart(d.suggested_period_start);
          setPeriodEnd(d.suggested_period_end);
        } else {
          // Nothing unclaimed — fall back to the current week so the pickers
          // still have sensible values.
          const s = weekStartSunday(todayISO());
          setPeriodStart(s);
          setPeriodEnd(addDays(s, 6));
        }
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setResolvingDefaults(false));
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // Live preview of the name and exactly what would be swept in.
  useEffect(() => {
    if (!periodStart || !periodEnd) return;
    if (periodEnd < periodStart) {
      setPreview(null);
      setError('The end date cannot be before the start date.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      api
        .previewClaim(clientId, periodStart, periodEnd)
        .then((d) => {
          if (cancelled) return;
          setPreview(d);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [clientId, periodStart, periodEnd]);

  const useRange = useCallback((start, end) => {
    setPeriodStart(start);
    setPeriodEnd(end);
  }, []);

  const useAllUnclaimed = useCallback(() => {
    if (preview?.suggested_period_start) {
      useRange(preview.suggested_period_start, preview.suggested_period_end);
    }
  }, [preview, useRange]);

  async function generate() {
    setSaving(true);
    setError(null);
    try {
      const { claim } = await api.generateClaim({
        client_id: clientId,
        period_start: periodStart,
        period_end: periodEnd,
      });
      onGenerated?.(claim);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  const overall = preview?.overall_unclaimed;
  const excluded = preview?.excluded_unclaimed_count ?? 0;
  const canGenerate = preview && preview.day_count > 0 && !saving;
  const nothingUnclaimed = !resolvingDefaults && overall && overall.day_count === 0;

  return (
    <Modal title="Generate claim" subtitle={clientName} onClose={onClose} width={660}>
      {nothingUnclaimed ? (
        <>
          <div className="alert warn">
            This client has no unclaimed days. Log some time on the Schedule tab first, or every day
            may already sit on an existing claim.
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="grid-3">
            <label>
              Start date
              <input
                name="period_start"
                type="date"
                value={periodStart ?? ''}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </label>
            <label>
              End date
              <input
                name="period_end"
                type="date"
                value={periodEnd ?? ''}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </label>
            <div className="quick-range">
              <span className="muted small">Quick pick</span>
              <div className="quick-range-buttons">
                <button type="button" className="btn tiny primary" onClick={useAllUnclaimed}>
                  All unclaimed days
                </button>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => {
                    const s = weekStartSunday(todayISO());
                    useRange(s, addDays(s, 6));
                  }}
                >
                  This week (Sun–Sat)
                </button>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => {
                    const s = addDays(weekStartSunday(todayISO()), -7);
                    useRange(s, addDays(s, 6));
                  }}
                >
                  Last week
                </button>
              </div>
            </div>
          </div>

          <div className="claim-preview">
            <span className="meta-label">Claim name preview</span>
            <div className="claim-name-preview mono">
              {resolvingDefaults || (loading && !preview) ? '…' : preview?.claim_name ?? '—'}
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Template <span className="mono">{'{last}_{ma}_{dos_start}_{dos_end}_{seq}'}</span>
            </p>
          </div>

          {preview && (
            <div className="stat-row" style={{ marginTop: 4 }}>
              <Stat
                label="Days in range"
                value={
                  overall && overall.day_count !== preview.day_count
                    ? `${preview.day_count} of ${overall.day_count}`
                    : preview.day_count
                }
              />
              <Stat label="Total units" value={preview.total_units} />
              <Stat label="Total dollars" value={formatMoney(preview.total_dollars)} />
              <Stat label="Sequence" value={`#${String(preview.seq).padStart(2, '0')}`} />
            </div>
          )}

          {excluded > 0 && (
            <div className="alert warn banner-action">
              <div>
                <strong>
                  {excluded} unclaimed day{excluded === 1 ? ' is' : 's are'} outside this range.
                </strong>{' '}
                {overall && (
                  <>
                    All unclaimed days total {overall.total_units} units /{' '}
                    {formatMoney(overall.total_dollars)} ({overall.day_count} days,{' '}
                    {formatLongDate(overall.first_date)} – {formatLongDate(overall.last_date)}).
                  </>
                )}
              </div>
              <button type="button" className="btn primary" onClick={useAllUnclaimed}>
                Include all unclaimed days
              </button>
            </div>
          )}

          {preview?.already_claimed_count > 0 && (
            <div className="alert warn">
              {preview.already_claimed_count} day
              {preview.already_claimed_count === 1 ? ' is' : 's are'} already on another claim in
              this period and will be skipped.
            </div>
          )}

          {preview && preview.day_count === 0 && excluded === 0 && (
            <div className="alert warn">
              No unclaimed days between {formatLongDate(periodStart)} and{' '}
              {formatLongDate(periodEnd)}. Widen the range or log some time first.
            </div>
          )}

          {error && <div className="alert error">{error}</div>}

          <div className="form-actions">
            <button className="btn primary" disabled={!canGenerate} onClick={generate}>
              {saving ? 'Generating…' : 'Generate claim'}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
