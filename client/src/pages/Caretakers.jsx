import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import CaretakerForm from '../components/CaretakerForm.jsx';
import EmptyState from '../components/EmptyState.jsx';

const blank = { first_name: '', last_name: '', npi_number: '', notes: '', active: true };

export default function Caretakers() {
  const [caretakers, setCaretakers] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [editing, setEditing] = useState(null); // caretaker being edited
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.caretakers({ active: showInactive ? '0' : '1' });
      setCaretakers(Array.isArray(d?.caretakers) ? d.caretakers : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  function note(message) {
    setFlash(message);
    setTimeout(() => setFlash(null), 2500);
  }

  async function toggleActive(row) {
    setBusy(true);
    try {
      await api.updateCaretaker(row.id, { active: row.active ? 0 : 1 });
      await load();
      note(row.active ? `${row.first_name} deactivated` : `${row.first_name} reactivated`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete ${row.first_name} ${row.last_name}?`)) return;
    setBusy(true);
    try {
      await api.deleteCaretaker(row.id);
      await load();
      note('Caretaker deleted');
    } catch (e) {
      if (e.status === 409 && window.confirm(`${e.message}\n\nDelete anyway and clear those links?`)) {
        try {
          await api.deleteCaretaker(row.id, { force: true });
          await load();
          note('Caretaker deleted');
        } catch (e2) {
          setError(e2.message);
        }
      } else if (e.status !== 409) {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Caretakers</h1>
          <p className="muted">
            The people who deliver care. Deactivating hides someone from the day-entry picker while
            keeping every day they already worked.
          </p>
        </div>
        <div className="head-actions">
          {flash && <span className="pill ok">{flash}</span>}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <button
            className={creating ? 'btn' : 'btn primary'}
            onClick={() => {
              setEditing(null);
              setCreating((v) => !v);
            }}
          >
            {creating ? 'Cancel' : '+ Add Caretaker'}
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {creating && (
        <CaretakerForm
          title="Add caretaker"
          initial={blank}
          onCancel={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
            note('Caretaker added');
          }}
          onError={setError}
        />
      )}

      {!loading && caretakers.length === 0 ? (
        <div className="card">
          <EmptyState icon="🧑‍⚕️" title="No caretakers yet" id="caretakers-empty">
            Click <strong>+ Add Caretaker</strong> to add the first person who delivers care.
          </EmptyState>
        </div>
      ) : (
      <div className="card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>NPI number</th>
                <th>SSN</th>
                <th>Gender</th>
                <th>Date of birth</th>
                <th>Notes</th>
                <th className="num">Days worked</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {caretakers.map((t) =>
                editing?.id === t.id ? (
                  <tr key={t.id} className="row-dirty">
                    <td colSpan={8} style={{ padding: 0 }}>
                      <CaretakerForm
                        title="Edit caretaker"
                        initial={t}
                        onCancel={() => setEditing(null)}
                        onSaved={async () => {
                          setEditing(null);
                          await load();
                          note('Caretaker updated');
                        }}
                        onError={setError}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id} className={t.active ? '' : 'row-inactive'}>
                    <td>
                      <Link to={`/caretakers/${t.id}`} id={`caretaker-link-${t.id}`}>
                        <strong>
                          {t.last_name}, {t.first_name}
                        </strong>
                      </Link>
                      {!t.active && <span className="pill muted tiny">inactive</span>}
                    </td>
                    <td className="mono">{t.npi_number ?? '—'}</td>
                    <td className="mono">{t.ssn ?? '—'}</td>
                    <td>{t.gender ?? '—'}</td>
                    <td>{t.dob ?? '—'}</td>
                    <td className="muted">{t.notes ?? '—'}</td>
                    <td className="num">{t.day_count ?? 0}</td>
                    <td>
                      {t.active ? <span className="pill ok">Active</span> : <span className="pill muted">Inactive</span>}
                    </td>
                    <td className="row-actions">
                      <button className="btn tiny" onClick={() => { setCreating(false); setEditing(t); }}>
                        Edit
                      </button>
                      <button className="btn tiny" disabled={busy} onClick={() => toggleActive(t)}>
                        {t.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                      <button className="btn tiny ghost" disabled={busy} onClick={() => remove(t)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              )}
              {loading && caretakers.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    Loading caretakers…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
