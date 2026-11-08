import React, { useState } from 'react';
import api from '../api.js';

export function CaretakerForm({ title, initial, onCancel, onSaved, onError }) {
  const [form, setForm] = useState({
    first_name: initial?.first_name ?? '',
    last_name: initial?.last_name ?? '',
    npi_number: initial?.npi_number ?? '',
    ssn: initial?.ssn ?? '',
    gender: initial?.gender ?? '',
    dob: initial?.dob ?? '',
    notes: initial?.notes ?? '',
    active: initial ? Boolean(initial.active) : true,
    // MPSMISC reporting spreadsheet fields
    street_address: initial?.street_address ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    zip: initial?.zip ?? '',
    phone: initial?.phone ?? '',
    hire_date: initial?.hire_date ?? '',
    termination_date: initial?.termination_date ?? '',
    hourly_wage_rate: initial?.hourly_wage_rate ?? '',
    union_member: initial ? Boolean(initial.union_member) : false,
    dues_deducted: initial?.dues_deducted ?? '',
    seiu_voluntary_dues: initial?.seiu_voluntary_dues ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setLocalError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setLocalError('First and last name are required.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        npi_number: form.npi_number.trim() || null,
        ssn: form.ssn.trim() || null,
        gender: form.gender || null,
        dob: form.dob || null,
        notes: form.notes.trim() || null,
        active: form.active,
        // MPSMISC reporting fields
        street_address: form.street_address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        zip: form.zip.trim() || null,
        phone: form.phone.trim() || null,
        hire_date: form.hire_date || null,
        termination_date: form.termination_date || null,
        hourly_wage_rate: form.hourly_wage_rate === '' ? null : Number(form.hourly_wage_rate),
        union_member: form.union_member,
        dues_deducted: form.dues_deducted === '' ? 0 : Number(form.dues_deducted),
        seiu_voluntary_dues:
          form.seiu_voluntary_dues === '' ? 0 : Number(form.seiu_voluntary_dues),
      };
      if (initial?.id) await api.updateCaretaker(initial.id, body);
      else await api.createCaretaker(body);
      await onSaved?.();
    } catch (err) {
      setLocalError(err.message);
      onError?.(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="inline-form caretaker-form" onSubmit={submit}>
      <div className="form-title">
        <h3>{title}</h3>
      </div>
      <div className="grid-3">
        <label>
          First name <span className="required">required</span>
          <input name="first_name" value={form.first_name} onChange={set('first_name')} autoFocus />
        </label>
        <label>
          Last name <span className="required">required</span>
          <input name="last_name" value={form.last_name} onChange={set('last_name')} />
        </label>
        <label>
          NPI number
          <input
            name="npi_number"
            value={form.npi_number}
            onChange={set('npi_number')}
            placeholder="1234567890"
            inputMode="numeric"
          />
        </label>
        <label>
          SSN <span className="muted small">XXX-XX-XXXX</span>
          <input
            name="ssn"
            value={form.ssn}
            onChange={set('ssn')}
            placeholder="123-45-6789"
            maxLength={11}
          />
        </label>
        <label>
          Gender
          <select name="gender" value={form.gender} onChange={set('gender')}>
            <option value="">—</option>
            <option value="M">M</option>
            <option value="F">F</option>
          </select>
        </label>
        <label>
          Date of birth
          <input name="dob" type="date" value={form.dob} onChange={set('dob')} />
        </label>
        <label className="span-2">
          Notes
          <input name="notes" value={form.notes} onChange={set('notes')} />
        </label>
        <label className="checkbox-field">
          <span>Active</span>
          <span className="checkbox">
            <input
              type="checkbox"
              name="active"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
            />
            Available for new day entries
          </span>
        </label>
      </div>
      <h4 className="form-section" id="caretaker-reporting-fields">
        MPSMISC reporting
      </h4>
      <div className="grid-3">
        <label className="span-2">
          Street address
          <input
            name="street_address"
            value={form.street_address}
            onChange={set('street_address')}
          />
        </label>
        <label>
          City
          <input name="city" value={form.city} onChange={set('city')} />
        </label>
        <label>
          State
          <input name="state" maxLength={2} placeholder="MN" value={form.state} onChange={set('state')} />
        </label>
        <label>
          ZIP
          <input name="zip" maxLength={5} placeholder="55433" value={form.zip} onChange={set('zip')} />
        </label>
        <label>
          Phone (10 digits)
          <input name="phone" maxLength={10} placeholder="6125551234" value={form.phone} onChange={set('phone')} />
        </label>
        <label>
          Hire date
          <input type="date" name="hire_date" value={form.hire_date} onChange={set('hire_date')} />
        </label>
        <label>
          Termination date
          <input
            type="date"
            name="termination_date"
            value={form.termination_date}
            onChange={set('termination_date')}
          />
        </label>
        <label>
          Hourly wage rate
          <input
            type="number"
            step="0.01"
            min="0"
            name="hourly_wage_rate"
            placeholder="18.00"
            value={form.hourly_wage_rate}
            onChange={set('hourly_wage_rate')}
          />
        </label>
        <label>
          Dues deducted
          <input
            type="number"
            step="0.01"
            min="0"
            name="dues_deducted"
            value={form.dues_deducted}
            onChange={set('dues_deducted')}
          />
        </label>
        <label>
          Additional voluntary dues to SEIU
          <input
            type="number"
            step="0.01"
            min="0"
            name="seiu_voluntary_dues"
            value={form.seiu_voluntary_dues}
            onChange={set('seiu_voluntary_dues')}
          />
        </label>
        <label className="checkbox-field">
          <span>Union member</span>
          <span className="checkbox">
            <input
              type="checkbox"
              name="union_member"
              checked={form.union_member}
              onChange={(e) => setForm((f) => ({ ...f, union_member: e.target.checked }))}
            />
            Dues are deducted from this worker
          </span>
        </label>
      </div>

      {localError && <div className="alert error">{localError}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Add caretaker'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default CaretakerForm;
