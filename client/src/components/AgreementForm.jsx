import React, { useEffect, useMemo, useState } from 'react';
import api from '../api.js';
import { computeEntry, todayISO, formatMoney, DEFAULT_MINUTES_PER_UNIT } from '../calc.js';

const BLANK = (today) => ({
  agreement_number: '',
  service_code: 'T1019',
  payer_id: '',
  start_date: today,
  end_date: '',
  minutes_per_unit: String(DEFAULT_MINUTES_PER_UNIT),
  rate_per_unit: '',
  max_units_per_day: '16',
});

const NEW_PAYER = '__new__';

/** An existing agreement row -> editable form values. */
const fromAgreement = (a) => ({
  agreement_number: a.agreement_number ?? '',
  service_code: a.service_code ?? '',
  payer_id: a.payer_id != null ? String(a.payer_id) : '',
  start_date: a.start_date ?? '',
  end_date: a.end_date ?? '',
  minutes_per_unit: String(a.minutes_per_unit ?? DEFAULT_MINUTES_PER_UNIT),
  rate_per_unit: a.rate_per_unit != null ? String(a.rate_per_unit) : '',
  max_units_per_day: a.max_units_per_day != null ? String(a.max_units_per_day) : '',
});

/**
 * Add or edit one agreement.
 *   - no `agreement` prop  -> create mode (POST)
 *   - `agreement` provided -> edit mode (PUT), pre-filled from that row
 */
export default function AgreementForm({ clientId, agreement, onCreated, onSaved, onCancel, onPayersChanged }) {
  const editing = Boolean(agreement);
  const [form, setForm] = useState(() =>
    agreement ? fromAgreement(agreement) : BLANK(todayISO())
  );
  const [payers, setPayers] = useState([]);
  const [newPayer, setNewPayer] = useState({ name: '', typical_days_to_pay: '30' });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .payers()
      .then((d) => setPayers(d.payers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setForm(agreement ? fromAgreement(agreement) : BLANK(todayISO()));
    setError(null);
  }, [agreement]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setPayerField = (k) => (e) => setNewPayer((p) => ({ ...p, [k]: e.target.value }));

  const creatingPayer = form.payer_id === NEW_PAYER;

  /** Live preview of what one day would bill at these terms. */
  const preview = useMemo(() => {
    const mpu = Number(form.minutes_per_unit) || DEFAULT_MINUTES_PER_UNIT;
    const rate = Number(form.rate_per_unit);
    if (!Number.isFinite(rate) || form.rate_per_unit === '') return null;
    const sample = mpu * 4; // a typical 4-unit visit
    const c = computeEntry({
      minutes_worked: sample,
      minutes_per_unit: mpu,
      rate_per_unit: rate,
      max_units_per_day: form.max_units_per_day,
    });
    return { sample, ...c };
  }, [form.minutes_per_unit, form.rate_per_unit, form.max_units_per_day]);

  async function submit(e) {
    e.preventDefault();
    setError(null);

    // Validate before touching the API so a blank rate can never save as $0.
    const mpu = Number(form.minutes_per_unit);
    if (!Number.isFinite(mpu) || mpu <= 0) {
      setError('Minutes per unit must be greater than 0.');
      return;
    }
    if (form.rate_per_unit === '' || !Number.isFinite(Number(form.rate_per_unit))) {
      setError('Rate per unit is required — enter the dollar amount the payer allows per unit.');
      return;
    }
    if (Number(form.rate_per_unit) < 0) {
      setError('Rate per unit cannot be negative.');
      return;
    }
    if (creatingPayer && !newPayer.name.trim()) {
      setError('Enter a name for the new payer, or pick an existing one.');
      return;
    }

    setSaving(true);
    try {
      let payerId = form.payer_id || null;

      // Create the payer first, then attach the agreement to it.
      if (creatingPayer) {
        const created = await api.createPayer({
          name: newPayer.name.trim(),
          typical_days_to_pay:
            newPayer.typical_days_to_pay === '' ? null : Number(newPayer.typical_days_to_pay),
        });
        payerId = created.id;
        onPayersChanged?.();
      }

      const payload = {
        client_id: clientId,
        agreement_number: form.agreement_number.trim() || null,
        service_code: form.service_code.trim() || null,
        payer_id: payerId,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        minutes_per_unit: mpu,
        rate_per_unit: Number(form.rate_per_unit),
        max_units_per_day: numOrNull(form.max_units_per_day),
      };

      const saved = editing
        ? await api.updateAgreement(agreement.id, payload)
        : await api.createAgreement(payload);

      // onSaved is the current prop name; onCreated kept for older callers.
      (onSaved ?? onCreated)?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="inline-form agreement-form" onSubmit={submit}>
      <div className="form-title">
        <h3>{editing ? 'Edit agreement' : 'Add agreement'}</h3>
        <span className="muted small">
          Terms are snapshotted onto each day you log, so later edits never change past claims.
        </span>
      </div>

      <div className="grid-3">
        <label>
          Agreement number
          <input
            name="agreement_number"
            value={form.agreement_number}
            onChange={set('agreement_number')}
            placeholder="AGR-2026-001"
          />
        </label>

        <label>
          Payer
          <select name="payer_id" value={form.payer_id} onChange={set('payer_id')}>
            <option value="">— none —</option>
            {payers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.typical_days_to_pay != null ? ` (net ${p.typical_days_to_pay}d)` : ''}
              </option>
            ))}
            <option value={NEW_PAYER}>+ Add a new payer…</option>
          </select>
        </label>

        <label>
          Service code
          <input name="service_code" value={form.service_code} onChange={set('service_code')} placeholder="T1019" />
        </label>

        <label>
          Start date
          <input name="start_date" type="date" value={form.start_date} onChange={set('start_date')} />
        </label>

        <label>
          End date <span className="muted">(blank = open-ended)</span>
          <input name="end_date" type="date" value={form.end_date} onChange={set('end_date')} />
        </label>

        <label>
          Minutes per unit
          <input
            name="minutes_per_unit"
            type="number"
            min="1"
            required
            value={form.minutes_per_unit}
            onChange={set('minutes_per_unit')}
          />
        </label>

        <label>
          Rate per unit ($) <span className="required">required</span>
          <input
            name="rate_per_unit"
            type="number"
            step="0.01"
            min="0"
            required
            className={form.rate_per_unit === '' ? 'needs-value' : ''}
            value={form.rate_per_unit}
            onChange={set('rate_per_unit')}
            placeholder="18.50"
          />
        </label>

        <label>
          Max units per day
          <input
            name="max_units_per_day"
            type="number"
            min="0"
            value={form.max_units_per_day}
            onChange={set('max_units_per_day')}
            placeholder="16"
          />
        </label>
      </div>

      {creatingPayer && (
        <div className="sub-form">
          <h4>New payer</h4>
          <div className="grid-3">
            <label>
              Payer name <span className="required">required</span>
              <input
                name="payer_name"
                value={newPayer.name}
                onChange={setPayerField('name')}
                placeholder="State Medicaid"
                autoFocus
              />
            </label>
            <label>
              Typical days to pay
              <input
                name="payer_typical_days_to_pay"
                type="number"
                min="0"
                value={newPayer.typical_days_to_pay}
                onChange={setPayerField('typical_days_to_pay')}
                placeholder="30"
              />
            </label>
            <div className="sub-form-note muted small">
              Used later to set the expected payment date when a claim is submitted.
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="preview">
          <strong>Preview:</strong> a {preview.sample}-minute visit = {preview.units} unit
          {preview.units === 1 ? '' : 's'} = <strong>{formatMoney(preview.dollars)}</strong>
          {preview.remainder_minutes > 0 && (
            <span className="muted"> ({preview.remainder_minutes}m not billable)</span>
          )}
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      <div className="form-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save agreement'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
