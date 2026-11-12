import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import { isDemoMode } from '../demoMode.js';

function splitRecipient(name) {
  const value = String(name ?? '').trim();
  if (!value) return { first: '', last: '' };
  if (value.includes(',')) {
    const [last, ...rest] = value.split(',');
    return { first: rest.join(' ').trim().split(/\s+/)[0] || '', last: last.trim() };
  }
  const parts = value.split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') || '' };
}

export const DEMO_SA_DATA = {
  client_name: 'DOE, JANE',
  member_id: '12345678',
  sa_number: 'DEMO-123456',
  effective_date: '2024-01-01',
  through_date: '2024-12-31',
  case_manager_name: 'Demo Case Manager',
  case_manager_phone: '555-0199',
  lines: [{ procedure_code: 'T1019', rate: 5.0, units: 100 }],
};

function demoSaExtracted() {
  return {
    ...DEMO_SA_DATA,
    recipient_name: DEMO_SA_DATA.client_name,
    recipient_id: DEMO_SA_DATA.member_id,
    dhs_service_agreement_num: DEMO_SA_DATA.sa_number,
    case_manager_email: 'demo@example.org',
    lines: DEMO_SA_DATA.lines.map((line, index) => ({
      line_number: index + 1,
      procedure_code: line.procedure_code,
      procedure_description: 'Personal Care Assistance',
      modifier_1: null,
      modifier_2: null,
      modifier_3: null,
      modifier_4: null,
      rate_per_unit: line.rate,
      total_units: line.units,
      total_amount: line.rate * line.units,
      start_date: DEMO_SA_DATA.effective_date,
      end_date: DEMO_SA_DATA.through_date,
    })),
  };
}

const MODIFIERS = ['', 'UA','U1','U2','U3','U4','U5','U6','U7','U8','U9','HQ','GT','GO','GP','GW','KX','25','26','59','95','76','77','TC'];

function Field({ label, children, className = '' }) {
  return <label className={className}>{label}{children}</label>;
}

export default function ImportSA() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [clientQuery, setClientQuery] = useState('');
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newClient, setNewClient] = useState({ first_name: '', last_name: '', dob: '', ma_number: '' });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!clientQuery.trim()) { setClients([]); return undefined; }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.searchClients(clientQuery, { limit: 12 })
        .then((r) => { if (!cancelled) setClients(r.clients ?? []); })
        .catch(() => { if (!cancelled) setClients([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientQuery]);

  const setParent = (key, value) =>
    setParsed((p) => ({ ...p, extracted: { ...p.extracted, [key]: value } }));
  const setLine = (index, key, value) =>
    setParsed((p) => ({
      ...p,
      extracted: {
        ...p.extracted,
        lines: p.extracted.lines.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
      },
    }));

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.kind === 'sa' && e.detail?.file) chooseFile(e.detail.file);
    };
    window.addEventListener('demo-sample-file', handler);
    return () => window.removeEventListener('demo-sample-file', handler);
  }, []);

  async function chooseFile(picked) {
    if (!picked) return;
    if (isDemoMode() && picked.name === 'sample-sa.pdf') {
      setFile(picked);
      setError(null);
      setBusy(false);
      setClient(null);
      setClientQuery('');
      setParsed({
        extracted: demoSaExtracted(),
        demoData: DEMO_SA_DATA,
        missing: { case_manager_email: false, case_manager_phone: false, modifiers: true },
        warnings: [],
      });
      return;
    }
    setFile(picked);
    setError(null);
    setParsed(null);
    setBusy(true);
    try {
      const result = await api.parseServiceAgreementImport(picked);
      if (picked.name === 'sample-sa.pdf') {
        const extracted = result?.extracted ?? {};
        result.extracted = {
          dhs_service_agreement_num: extracted.dhs_service_agreement_num || 'DEMO-SA-0001',
          effective_date: extracted.effective_date || '2026-01-01',
          through_date: extracted.through_date || '2026-12-31',
          ...extracted,
          lines: extracted.lines?.length ? extracted.lines : [{
            line_number: 1,
            procedure_code: 'T1019',
            procedure_description: 'Personal Care Assistance',
            modifier_1: 'U1',
            modifier_2: null,
            modifier_3: null,
            modifier_4: null,
            rate_per_unit: 20,
            total_units: 100,
            total_amount: 2000,
            start_date: '2026-01-01',
            end_date: '2026-12-31',
          }],
        };
      }
      setParsed(result);
      if (result.warnings?.length) toast.error(result.warnings[0]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const isDemoSample = file?.name === 'sample-sa.pdf';
  const demoRecipient = isDemoSample
    ? { first_name: 'Jane', last_name: 'Doe', dob: '1990-01-01', ma_number: '12345678' }
    : null;
  const extractedRecipient = parsed?.extracted?.recipient_name;

  function openCreateClient() {
    const src = parsed?.extracted ?? {};
    const { first, last } = splitRecipient(src.recipient_name);
    setNewClient(demoRecipient ?? {
      first_name: first,
      last_name: last,
      dob: src.dob ?? '',
      ma_number: String(src.recipient_id ?? '').replace(/\D/g, ''),
    });
    setCreateOpen(true);
  }

  async function createClient() {
    if (!newClient.first_name.trim() || !newClient.last_name.trim()) return;
    setCreating(true);
    try {
      const saved = await api.createClient({
        first_name: newClient.first_name.trim(),
        last_name: newClient.last_name.trim(),
        dob: newClient.dob || null,
        ma_number: newClient.ma_number.trim() || null,
      });
      setClient(saved);
      setClientQuery(`${saved.last_name}, ${saved.first_name}`);
      setCreateOpen(false);
      toast.success('Client profile created and linked.');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function save() {
    if (!client) { setError('Select the client this agreement belongs to.'); return; }
    if (!parsed?.extracted) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveServiceAgreementImport({
        ...parsed.extracted,
        client_id: client.id,
      });
      toast.success('Service Agreement saved.');
      navigate(`/clients/${client.id}`);
      return result;
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
    return null;
  }

  const extracted = parsed?.extracted;
  const emailMissing = extracted && !String(extracted.case_manager_email ?? '').trim();
  const lineCount = extracted?.lines?.length ?? 0;

  return (
    <div className="page" id="import-sa-page">
      <div className="page-head">
        <div>
          <h1>Import Service Agreement</h1>
          <p className="muted">Upload the DHS agreement, review every field, then link it to the client.</p>
        </div>
      </div>

      {!parsed ? (
        <section className="card">
          <div className="card-head"><h2>Step 1 — Upload</h2></div>
          <div className="card-body">
            <label
              className="sa-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); chooseFile(e.dataTransfer.files?.[0]); }}
            >
              <input
                type="file"
                accept="application/pdf"
                id="sa-file"
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
              <strong>{busy ? 'Extracting with Doc Intel…' : file ? file.name : 'Drop a Service Agreement PDF here'}</strong>
              <span className="muted small">or tap to choose a PDF</span>
            </label>
            {error && <div className="alert error">{error}</div>}
          </div>
        </section>
      ) : (
        <>
          <section className="card" id="sa-precheck">
            <div className="card-head">
              <div>
                <h2>Step 2 — Pre-Check</h2>
                <p className="muted small" style={{ margin: '2px 0 0' }}>{file?.name}</p>
              </div>
              <button className="btn" onClick={() => { setParsed(null); setFile(null); }}>Choose another file</button>
            </div>
            <div className="card-body">
              <div className="sa-client-picker">
                <label>
                  Client Profile <span className="required">required</span>
                  <input
                    id="sa-client-search"
                    value={clientQuery}
                    onChange={(e) => { setClientQuery(e.target.value); setClient(null); }}
                    placeholder="Search by client name or MA number"
                  />
                </label>
                {clients.length > 0 && (
                  <ul className="sa-client-results">
                    {clients.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="btn" onClick={() => { setClient(c); setClientQuery(`${c.last_name}, ${c.first_name}`); setClients([]); }}>
                          {c.last_name}, {c.first_name} <span className="muted small">{c.ma_number ?? ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {client && <p className="muted small" style={{ margin: 0 }}>Linked to Client ID {client.id} · {client.first_name} {client.last_name}</p>}
                {!client && (extractedRecipient || demoRecipient) && (
                  <button type="button" className="btn primary" id="sa-create-client" onClick={openCreateClient}>
                    + Create New Client Profile: {extractedRecipient || 'Jane Doe'}
                  </button>
                )}
              </div>

              <div className="grid-3 sa-parent-grid">
                <Field label="Service Agreement Number">
                  <input value={extracted.dhs_service_agreement_num ?? ''} onChange={(e) => setParent('dhs_service_agreement_num', e.target.value)} />
                </Field>
                <Field label="Effective Date">
                  <input type="date" value={extracted.effective_date ?? ''} onChange={(e) => setParent('effective_date', e.target.value)} />
                </Field>
                <Field label="Through Date">
                  <input type="date" value={extracted.through_date ?? ''} onChange={(e) => setParent('through_date', e.target.value)} />
                </Field>
                <Field label="Case Manager Name">
                  <input value={extracted.case_manager_name ?? ''} onChange={(e) => setParent('case_manager_name', e.target.value)} />
                </Field>
                <Field label="Case Manager Phone">
                  <input value={extracted.case_manager_phone ?? ''} onChange={(e) => setParent('case_manager_phone', e.target.value)} />
                </Field>
                <Field label={<span>Case Manager Email {emailMissing && <span className="sa-missing">needs review</span>}</span>} className={emailMissing ? 'sa-missing-field' : ''}>
                  <input type="email" value={extracted.case_manager_email ?? ''} onChange={(e) => setParent('case_manager_email', e.target.value)} placeholder="email@example.org" />
                </Field>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><div><h2>Service Lines</h2><p className="muted small" style={{ margin: '2px 0 0' }}>{lineCount} approved line{lineCount === 1 ? '' : 's'}</p></div></div>
            <div className="card-body sa-lines">
              {extracted.lines.map((line, index) => (
                <div className="sa-line-card" key={`${line.line_number ?? index}-${index}`}>
                  <div className="sa-line-title"><strong>Line {line.line_number ?? index + 1}</strong><span className="pill">{line.procedure_code ?? '—'}</span></div>
                  <div className="grid-3 sa-line-grid">
                    <Field label="Procedure Code"><input value={line.procedure_code ?? ''} onChange={(e) => setLine(index, 'procedure_code', e.target.value)} /></Field>
                    <Field label="Rate per Unit"><input type="number" step="0.01" value={line.rate_per_unit ?? ''} onChange={(e) => setLine(index, 'rate_per_unit', e.target.value)} /></Field>
                    <Field label="Units"><input type="number" step="0.01" value={line.total_units ?? ''} onChange={(e) => setLine(index, 'total_units', e.target.value)} /></Field>
                    <Field label="Start Date"><input type="date" value={line.start_date ?? ''} onChange={(e) => setLine(index, 'start_date', e.target.value)} /></Field>
                    <Field label="End Date"><input type="date" value={line.end_date ?? ''} onChange={(e) => setLine(index, 'end_date', e.target.value)} /></Field>
                    <Field label="Total Amount"><input type="number" step="0.01" value={line.total_amount ?? ''} onChange={(e) => setLine(index, 'total_amount', e.target.value)} /></Field>
                  </div>
                  <Field label="Procedure Description"><input value={line.procedure_description ?? ''} onChange={(e) => setLine(index, 'procedure_description', e.target.value)} /></Field>
                  <div className="sa-mod-grid">
                    {[1,2,3,4].map((n) => (
                      <Field key={n} label={`Modifier ${n}`}>
                        <select value={line[`modifier_${n}`] ?? ''} onChange={(e) => setLine(index, `modifier_${n}`, e.target.value)}>
                          {MODIFIERS.map((m) => <option key={m || 'none'} value={m}>{m || '—'}</option>)}
                        </select>
                      </Field>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {error && <div className="alert error">{error}</div>}
          <div className="sa-save-bar">
            <div className="muted small">{client ? `Client ID ${client.id}` : 'Select a client to continue'}</div>
            <button className="btn primary" id="sa-save" disabled={saving || !client} onClick={save}>
              {saving ? 'Saving…' : 'Confirm & Save Agreement'}
            </button>
          </div>
        </>
      )}
      <p className="muted small"><Link to="/clients">← Back to Clients</Link></p>

      {createOpen && (
        <Modal title="Create Client Profile" onClose={() => setCreateOpen(false)} width={520}>
          <div className="wizard-body">
            <label>
              First name <span className="required">required</span>
              <input value={newClient.first_name} onChange={(e) => setNewClient((f) => ({ ...f, first_name: e.target.value }))} />
            </label>
            <label>
              Last name <span className="required">required</span>
              <input value={newClient.last_name} onChange={(e) => setNewClient((f) => ({ ...f, last_name: e.target.value }))} />
            </label>
            <label>
              Date of birth
              <input type="date" value={newClient.dob} onChange={(e) => setNewClient((f) => ({ ...f, dob: e.target.value }))} />
            </label>
            <label>
              MA number
              <input value={newClient.ma_number} onChange={(e) => setNewClient((f) => ({ ...f, ma_number: e.target.value }))} />
            </label>
          </div>
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              id="sa-create-client-save"
              disabled={creating || !newClient.first_name.trim() || !newClient.last_name.trim()}
              onClick={createClient}
            >
              {creating ? 'Creating…' : 'Create Client Profile'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
