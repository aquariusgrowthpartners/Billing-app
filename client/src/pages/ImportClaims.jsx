import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';

export default function ImportClaims() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);

  useEffect(() => {
    if (!query.trim()) { setClients([]); return undefined; }
    const timer = setTimeout(() => {
      api.searchClients(query, { limit: 10 }).then((r) => setClients(r.clients ?? [])).catch(() => setClients([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.kind === 'claim' && e.detail?.file) choose(e.detail.file);
    };
    window.addEventListener('demo-sample-file', handler);
    return () => window.removeEventListener('demo-sample-file', handler);
  }, []);

  async function choose(file) {
    if (!file) return;
    setFile(file); setBusy(true); setError(null); setParsed(null);
    try {
      const result = await api.parseClaimSubmission(file);
      setParsed(result);
      if (result.suggested_client) {
        setClient(result.suggested_client);
        setQuery(`${result.suggested_client.last_name}, ${result.suggested_client.first_name}`);
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const set = (key, value) => setParsed((p) => ({ ...p, extracted: { ...p.extracted, [key]: value } }));

  async function save() {
    if (!client) { setError('Select a client.'); return; }
    setBusy(true); setError(null);
    try {
      await api.saveClaimSubmission({ ...parsed.extracted, client_id: client.id });
      toast.success('Claim saved as pending.');
      navigate('/pending-claims');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const ex = parsed?.extracted;

  return (
    <div className="page" id="import-claims-page">
      <div className="page-head"><div><h1>Import Claim Submission</h1><p className="muted">Upload a 277 Claim Response Print and review the fields before saving.</p></div></div>
      {!parsed ? (
        <section className="card"><div className="card-head"><h2>Step 1 — Upload</h2></div><div className="card-body">
          <label className="sa-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files?.[0]); }}>
            <input type="file" accept="application/pdf" onChange={(e) => choose(e.target.files?.[0])} />
            <strong>{busy ? 'Extracting with Doc Intel…' : file ? file.name : 'Drop a 277 Claim Response PDF here'}</strong>
            <span className="muted small">or tap to choose a PDF</span>
          </label>
          {error && <div className="alert error">{error}</div>}
        </div></section>
      ) : (
        <>
          <section className="card"><div className="card-head"><h2>Step 2 — Pre-Check</h2></div><div className="card-body">
            <div className="sa-client-picker">
              <label>Client Profile <span className="required">required</span><input value={query} onChange={(e) => { setQuery(e.target.value); setClient(null); }} placeholder="Search client" /></label>
              {clients.length > 0 && <ul className="sa-client-results">{clients.map((c) => <li key={c.id}><button type="button" className="btn" onClick={() => { setClient(c); setQuery(`${c.last_name}, ${c.first_name}`); setClients([]); }}>{c.last_name}, {c.first_name} <span className="muted small">{c.ma_number ?? ''}</span></button></li>)}</ul>}
              {client && <p className="muted small">Linked to Client ID {client.id}</p>}
            </div>
            <div className="grid-3">
              <label>Subscriber ID<input value={ex.subscriber_id ?? ''} onChange={(e) => set('subscriber_id', e.target.value)} /></label>
              <label>Subscriber Name<input value={ex.subscriber_name ?? ''} onChange={(e) => set('subscriber_name', e.target.value)} /></label>
              <label>Patient Control Number<input value={ex.patient_control_number ?? ''} onChange={(e) => set('patient_control_number', e.target.value)} /></label>
              <label>Status Code<input value={ex.claim_status_code ?? ''} onChange={(e) => set('claim_status_code', e.target.value)} /></label>
              <label>Period Start<input type="date" value={ex.period_start ?? ''} onChange={(e) => set('period_start', e.target.value)} /></label>
              <label>Period End<input type="date" value={ex.period_end ?? ''} onChange={(e) => set('period_end', e.target.value)} /></label>
              <label>Total Charge<input type="number" step="0.01" value={ex.total_charge ?? ''} onChange={(e) => set('total_charge', e.target.value)} /></label>
              <label>Expected Payment<input type="number" step="0.01" value={ex.expected_payment ?? ''} onChange={(e) => set('expected_payment', e.target.value)} /></label>
            </div>
          </div></section>
          {error && <div className="alert error">{error}</div>}
          <div className="sa-save-bar"><span className="muted small">{client ? `Client ID ${client.id}` : 'Select a client'}</span><button className="btn primary" disabled={busy || !client} onClick={save}>{busy ? 'Saving…' : 'Confirm & Save Pending Claim'}</button></div>
        </>
      )}
      <p className="muted small"><Link to="/pending-claims">← Pending Claims</Link></p>
    </div>
  );
}
