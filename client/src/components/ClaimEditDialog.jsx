import React, { useEffect, useMemo, useState } from 'react';
import api from '../api.js';
import Modal from './Modal.jsx';
import ClaimPdfControl from './ClaimPdfControl.jsx';
import { formatLongDate, formatMoney, daysBetween, todayISO } from '../calc.js';

const STATUSES = ['Draft', 'Submitted', 'Paid', 'Denied'];

/**
 * Drives the Draft -> Submitted -> Paid lifecycle.
 * The server stamps submitted_date / expected_pay_date and stores the variance;
 * this dialog only shows what will happen.
 */
export default function ClaimEditDialog({
  claim,
  onClose,
  onSaved,
  onPdfChanged,
  onClaimChanged,
  onArchive,
  onDelete,
}) {
  // The claim as it stands right now. Regenerating or reverting updates the
  // figures in place, so the dialog stays open and shows the new totals.
  const [current, setCurrent] = useState(claim);
  const [busy, setBusy] = useState(null); // 'regenerate' | 'revert'
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({
    status: claim.status ?? 'Draft',
    submitted_date: claim.submitted_date ?? '',
    expected_pay_date: claim.expected_pay_date ?? '',
    paid_date: claim.paid_date ?? '',
    paid_amount: claim.paid_amount != null ? String(claim.paid_amount) : '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Follow the parent when it hands down a fresh copy of the claim (e.g. after
  // the list reloads), so the panel never shows a stale status or total.
  useEffect(() => {
    setCurrent(claim);
  }, [claim]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Entering a paid date settles the claim; move the dropdown with it so the
  // form shows what the server is about to store.
  const setPaidDate = (e) => {
    const value = e.target.value;
    setForm((f) => ({
      ...f,
      paid_date: value,
      status: value && f.status !== 'Denied' ? 'Paid' : f.status,
    }));
  };

  // Mirrors the server's rule so the number on screen matches what gets stored.
  const variancePreview = useMemo(() => {
    if (!form.paid_date) return null;
    const expected = form.expected_pay_date || claim.expected_pay_date;
    if (!expected) return null;
    return daysBetween(expected, form.paid_date);
  }, [form.paid_date, form.expected_pay_date, claim.expected_pay_date]);

  const willStampExpected =
    form.status === 'Submitted' && !form.expected_pay_date && !claim.expected_pay_date;

  const locked = current.status !== 'Draft';

  /**
   * Re-derive the claim's totals from its day entries. The server refuses
   * unless the claim is a Draft, so the button is disabled when locked.
   */
  async function regenerate() {
    setBusy('regenerate');
    setError(null);
    setNotice(null);
    try {
      const res = await api.regenerateClaim(current.id);
      setCurrent(res.claim);
      setNotice(
        [
          `Regenerated from ${res.aggregation.day_count} day entr${
            res.aggregation.day_count === 1 ? 'y' : 'ies'
          }: ${res.aggregation.total_units} units, ${formatMoney(res.aggregation.total_dollars)}.`,
          res.pdf.regenerated
            ? 'Claim PDF refreshed.'
            : `Claim PDF not refreshed (${res.pdf.reason}).`,
          res.aggregation.skipped_other_claims
            ? `${res.aggregation.skipped_other_claims} entr${
                res.aggregation.skipped_other_claims === 1 ? 'y' : 'ies'
              } belonging to another claim ${res.aggregation.skipped_other_claims === 1 ? 'was' : 'were'} left alone.`
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      );
      onClaimChanged?.(res.claim);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  /** Unlock a Submitted/Paid claim so it can be edited and regenerated. */
  async function revertToDraft() {
    setBusy('revert');
    setError(null);
    setNotice(null);
    try {
      const res = await api.revertClaimToDraft(current.id);
      setCurrent(res.claim);
      setForm((f) => ({ ...f, status: 'Draft', submitted_date: '', expected_pay_date: '' }));
      setNotice(
        res.kept_payment_record
          ? 'Reverted to Draft. The recorded payment was kept — clear the paid date and amount if this claim was not actually paid.'
          : 'Reverted to Draft. You can now regenerate this claim or edit its day entries.'
      );
      onClaimChanged?.(res.claim);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (form.paid_amount !== '' && !Number.isFinite(Number(form.paid_amount))) {
      setError('Paid amount must be a number.');
      return;
    }
    setSaving(true);
    try {
      const { claim: updated } = await api.updateClaim(claim.id, {
        status: form.status,
        submitted_date: form.submitted_date || null,
        expected_pay_date: form.expected_pay_date || null,
        paid_date: form.paid_date || null,
        paid_amount: form.paid_amount === '' ? null : Number(form.paid_amount),
      });
      onSaved?.(updated);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit claim"
      subtitle={claim.claim_name}
      onClose={onClose}
      width={620}
    >
      <form onSubmit={submit}>
        <div className="claim-context">
          <span>
            <span className="meta-label">Period</span>{' '}
            {formatLongDate(claim.period_start)} → {formatLongDate(claim.period_end)}
          </span>
          <span>
            <span className="meta-label">Units</span> <strong>{current.total_units ?? 0}</strong>
          </span>
          <span>
            <span className="meta-label">Billed</span>{' '}
            <strong>{formatMoney(current.total_dollars ?? 0)}</strong>
          </span>
          <span>
            <span className="meta-label">Status</span> {current.status}
          </span>
          {claim.payer_name && (
            <span>
              <span className="meta-label">Payer</span> {claim.payer_name}
              {claim.typical_days_to_pay != null && ` (net ${claim.typical_days_to_pay}d)`}
            </span>
          )}
        </div>

        <div className="grid-3">
          <label>
            Status
            <select name="status" value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Submitted date
            <input
              name="submitted_date"
              type="date"
              value={form.submitted_date}
              onChange={set('submitted_date')}
            />
          </label>
          <label>
            Expected pay date
            <input
              name="expected_pay_date"
              type="date"
              value={form.expected_pay_date}
              onChange={set('expected_pay_date')}
            />
          </label>
          <label>
            Paid date
            <input name="paid_date" type="date" value={form.paid_date} onChange={setPaidDate} />
          </label>
          <label>
            Paid amount ($)
            <input
              name="paid_amount"
              type="number"
              step="0.01"
              placeholder={String(claim.total_dollars ?? '')}
              value={form.paid_amount}
              onChange={set('paid_amount')}
            />
          </label>
          <div className="variance-box">
            <span className="meta-label">Variance</span>
            {variancePreview == null ? (
              <span className="muted small">record a paid date to see this</span>
            ) : (
              <span className={variancePreview > 0 ? 'variance-late' : 'variance-ok'}>
                {variancePreview > 0
                  ? `${variancePreview} day${variancePreview === 1 ? '' : 's'} late`
                  : variancePreview === 0
                    ? 'on time'
                    : `${Math.abs(variancePreview)} day${Math.abs(variancePreview) === 1 ? '' : 's'} early`}
              </span>
            )}
          </div>
        </div>

        <div className="pdf-section">
          <span className="meta-label">PDF attachment</span>
          <ClaimPdfControl claim={claim} onChanged={onPdfChanged} />
          <p className="muted small" style={{ margin: 0 }}>
            Stored locally under <span className="mono">data/claims/</span>. Nothing is uploaded
            anywhere yet.
          </p>
        </div>

        {willStampExpected && (
          <div className="alert warn">
            Setting this to <strong>Submitted</strong> will stamp today's date and compute the
            expected pay date from the payer's terms.
          </div>
        )}

        <div className="regen-panel" id="regenerate-panel">
          <div className="regen-head">
            <div>
              <h3>Claim totals</h3>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                Re-derives units and dollars from every day entry in this claim's period.
                {current.last_regenerated_at ? (
                  <>
                    {' '}
                    Last regenerated{' '}
                    <strong>{current.last_regenerated_at.replace('T', ' ')} UTC</strong>.
                  </>
                ) : (
                  ' Never regenerated.'
                )}
              </p>
            </div>
            {locked ? (
              <button
                type="button"
                className="btn"
                id="revert-to-draft"
                onClick={revertToDraft}
                disabled={busy !== null}
              >
                {busy === 'revert' ? 'Reverting…' : 'Revert to Draft'}
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                id="regenerate-claim"
                onClick={regenerate}
                disabled={busy !== null}
              >
                {busy === 'regenerate' ? 'Regenerating…' : 'Regenerate Claim'}
              </button>
            )}
          </div>

          {locked && (
            <div className="alert warn" id="claim-locked-warning">
              <strong>This claim is locked. Revert to Draft first to edit.</strong> A{' '}
              {current.status.toLowerCase()} claim is a record that has already gone to the payer, so
              its totals are not recalculated in place.
            </div>
          )}

          {notice && <div className="alert ok">{notice}</div>}
        </div>

        {error && <div className="alert error">{error}</div>}

        <div className="danger-zone" id="claim-danger-zone">
          <div className="danger-head">
            <div>
              <h3>Danger Zone</h3>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                Archiving hides this claim from the dashboard and the reports but keeps every
                record. Deleting is refused while day entries are still linked to it.
              </p>
            </div>
            <div className="danger-actions">
              {onArchive && (
                <button
                  type="button"
                  className="btn"
                  id="dialog-archive-claim"
                  onClick={() => onArchive(current)}
                  disabled={busy !== null}
                >
                  {current.archived ? 'Unarchive Claim' : 'Archive Claim'}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="btn danger"
                  id="dialog-delete-claim"
                  onClick={() => onDelete(current)}
                  disabled={busy !== null}
                >
                  Delete Claim
                </button>
              )}
              {current.archived && (
                <span className="pill archived" id="dialog-archived-badge">
                  Archived
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="form-actions">
          <button className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save claim'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <span className="muted small">Today is {formatLongDate(todayISO())}</span>
        </div>
      </form>
    </Modal>
  );
}
