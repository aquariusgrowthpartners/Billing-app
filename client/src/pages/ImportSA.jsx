import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';

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

  async function chooseFile(picked) {
    if (!picked) return;
    setFile(picked);
    setError(null);
    setParsed(null);
    setBusy(true);
    try {
      const result = await api.parseServiceAgreementImport(picked);
      setParsed(result);
      if (result.warnings?.length) toast.error(result.warnings[0]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
    </div>
  );
}
