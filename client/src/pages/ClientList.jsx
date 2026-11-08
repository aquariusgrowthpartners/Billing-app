import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { SkeletonCards } from '../components/Skeleton.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { formatLongDate } from '../calc.js';

/** The add-client form's starting state. */
const BLANK = {
  first_name: '',
  last_name: '',
  dob: '',
  ma_number: '',
  middle_initial: '',
  diagnosis_code: '',
  notes: '',
  active: true,
};

export default function ClientList() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.searchClients('', { includeArchived: showArchived });
      setClients(Array.isArray(data?.clients) ? data.clients : []);
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

  function note(message) {
    setFlash(message);
    setTimeout(() => setFlash(null), 2500);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="muted">{clients.length} on file. Click a name to open their profile.</p>
        </div>
        <div className="head-actions">
          {flash && <span className="pill ok">{flash}</span>}
          <label className="checkbox" id="show-archived-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show Archived
          </label>
          <button
            className={adding ? 'btn' : 'btn primary'}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
          >
            {adding ? 'Cancel' : '+ Add Client'}
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {adding && (
        <AddClientForm
          onCancel={() => setAdding(false)}
          onError={setError}
          onSaved={async (client) => {
            setAdding(false);
            await load();
            note(`${client.first_name} ${client.last_name} added`);
          }}
        />
      )}

      {!loading && clients.length === 0 ? (
        <div className="card">
          <EmptyState icon="👤" title="No clients yet" id="clients-empty">
            Click <strong>+ Add Client</strong> to create your first client.
          </EmptyState>
        </div>
      ) : (
      <div className="card">
        <div className="table-scroll hide-on-mobile">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>MA number</th>
                <th>Date of birth</th>
                <th className="num">Agreements</th>
                <th className="num">Claims</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className={[client.active ? '' : 'row-inactive', client.archived ? 'row-archived' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td>
                    <Link className="client-link" to={`/clients/${client.id}`}>
                      {client.last_name}, {client.first_name}
                    </Link>
                    {client.archived ? (
                      <span className="pill archived" id={`archived-badge-${client.id}`}>
                        Archived
                      </span>
                    ) : null}
                    {client.notes && <div className="sub">{client.notes}</div>}
                  </td>
                  <td className="mono">{client.ma_number ?? '—'}</td>
                  <td>{client.dob ? formatLongDate(client.dob) : '—'}</td>
                  <td className="num">{client.agreement_count}</td>
                  <td className="num">{client.claim_count}</td>
                  <td>
                    {client.active ? (
                      <span className="pill ok">Active</span>
                    ) : (
                      <span className="pill muted">Inactive</span>
                    )}
                  </td>
                </tr>
              ))}
              {loading && (
                <tr>
                  <td colSpan={6} className="empty">
                    Loading clients…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {loading && <SkeletonCards count={4} />}

        {/* Mobile: one card per client — a 6-column table is unreadable at 375px */}
        {!loading && clients.length > 0 && (
          <div className="show-on-mobile client-cards" id="client-cards">
            {clients.map((client) => (
              <div
                className={[
                  'client-card',
                  client.active ? '' : 'client-card-inactive',
                  client.archived ? 'client-card-archived' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={client.id}
              >
                <div className="client-card-top">
                  <Link className="client-card-name" to={`/clients/${client.id}`}>
                    {client.last_name}, {client.first_name}
                  </Link>
                  <span className="client-card-dob">
                    {client.dob ? formatLongDate(client.dob) : '—'}
                  </span>
                </div>
                <div className="client-card-ma">{client.ma_number ?? 'no MA number'}</div>
                {(client.archived || !client.active) && (
                  <div className="client-card-flags">
                    {client.archived && <span className="pill archived">Archived</span>}
                    {!client.active && <span className="pill muted">Inactive</span>}
                  </div>
                )}
                {client.notes && <div className="client-card-notes sub">{client.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** Add a client. First/last name are required; everything else is optional. */
function AddClientForm({ onCancel, onSaved, onError }) {
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setLocalError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setLocalError('First name and last name are required.');
      return;
    }
    setSaving(true);
    try {
      const saved = await api.createClient({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        middle_initial: form.middle_initial.trim() || null,
        dob: form.dob.trim() || null,
        ma_number: form.ma_number.trim() || null,
        diagnosis_code: form.diagnosis_code.trim() || null,
        notes: form.notes.trim() || null,
        active: form.active ? 1 : 0,
      });
      await onSaved?.(saved);
    } catch (err) {
      setLocalError(err.message);
      onError?.(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="inline-form add-client-form" onSubmit={submit}>
      <div className="form-title">
        <h3>Add client</h3>
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
          Middle initial <span className="muted small">optional</span>
          <input
            name="middle_initial"
            value={form.middle_initial}
            maxLength={2}
            placeholder="E"
            onChange={set('middle_initial')}
          />
        </label>
        <label>
          Date of birth
          <input name="dob" type="date" value={form.dob} onChange={set('dob')} />
        </label>
        <label>
          MA number
          <input name="ma_number" value={form.ma_number} onChange={set('ma_number')} placeholder="123456789" />
        </label>
        <label className="span-2">
          Diagnosis Code (DX) <span className="muted small">pipe-separated</span>
          <input
            name="diagnosis_code"
            value={form.diagnosis_code}
            onChange={set('diagnosis_code')}
            maxLength={208}
            placeholder="F84.0|B19.10"
          />
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
            Currently receiving services
          </span>
        </label>
      </div>
      {localError && <div className="alert error">{localError}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : 'Add client'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
