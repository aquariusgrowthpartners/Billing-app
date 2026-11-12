import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'none', label: 'None' },
];

const blankForm = {
  name: '',
  agency_tax_id: '',
  office_npi: '',
  ai_enabled: true,
  ai_provider: 'deepseek',
  ai_api_key: '',
  azure_endpoint: '',
  azure_deployment: '',
  ai_key_set: false,
};

function DataHealthCard() {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [globalView, setGlobalView] = useState(false);

  const load = useCallback(async (global = false) => {
    setLoading(true);
    try {
      setAudit(await api.auditData(global));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const scopeLabel = audit?.scope === 'global' ? 'Global' : 'Agency';
  const metrics = [
    [`${scopeLabel} Clients`, audit?.total_clients],
    [`${scopeLabel} Claims`, audit?.total_claims],
    ['RAs Processed', audit?.total_ras_processed],
    ['Orphaned Claims', audit?.orphaned_claims],
  ];

  function changeScope(checked) {
    setGlobalView(checked);
    load(checked);
  }

  return (
    <section className="card" id="data-health">
      <div className="card-head">
        <div>
          <h2>
            Data Health
            {audit?.scope === 'global' && (
              <span className="pill ok data-health-badge" id="data-health-global-badge">
                Global View
              </span>
            )}
          </h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {audit?.scope === 'global'
              ? 'Cross-checks clients, claims and processed RAs across the platform.'
              : 'Cross-checks clients, claims and processed RAs for this agency.'}
          </p>
        </div>
        <div className="data-health-actions">
          {audit?.global_allowed && (
            <label className="checkbox data-health-scope">
              <input
                type="checkbox"
                id="data-health-global-toggle"
                checked={globalView}
                onChange={(e) => changeScope(e.target.checked)}
                disabled={loading}
              />
              Global View
            </label>
          )}
          <button className="btn" id="data-health-run" onClick={() => load(globalView)} disabled={loading}>
            {loading ? 'Checking…' : 'Run Integrity Check'}
          </button>
        </div>
      </div>
      <div className="card-body">
        {error && <div className="alert error">{error}</div>}
        <div className="data-health-grid" aria-live="polite">
          {metrics.map(([label, value], index) => (
            <div
              className={`data-health-metric${
                index === 3 && Number(value) > 0 ? ' danger' : ''
              }`}
              key={label}
            >
              <span>{label}</span>
              <strong>{loading ? '—' : (value ?? 0)}</strong>
            </div>
          ))}
        </div>
        {audit?.generated_at && (
          <p className="muted small" style={{ margin: 0 }}>
            Last checked {new Date(audit.generated_at).toLocaleString()}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Platform-owner view.
 *
 * The server enforces that this data is only available to the Agency 1 admin;
 * the navigation link is also hidden for every other user.
 */
export default function SuperAdmin() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.superadminAgencies());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleDemoAi(enabled) {
    setBusy(true);
    try {
      await api.toggleDemoAi(enabled);
      await load();
      toast.success(enabled ? 'Demo Agency now shares your AI key.' : 'Demo Agency AI key cleared.');
    } catch (e) {
      toast.error(e.message);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(agency) {
    setEditing(agency);
    setForm({
      name: agency.name ?? '',
      agency_tax_id: agency.agency_tax_id ?? '',
      office_npi: agency.office_npi ?? '',
      ai_enabled: String(agency.ai_enabled ?? '1') === '1',
      ai_provider: agency.ai_provider || 'none',
      ai_api_key: '',
      azure_endpoint: agency.azure_endpoint ?? '',
      azure_deployment: agency.azure_deployment ?? '',
      ai_key_set: Boolean(agency.ai_key_set),
    });
  }

  async function saveEdit(e) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await api.superadminUpdateAgency(editing.id, {
        name: form.name,
        agency_tax_id: form.agency_tax_id,
        office_npi: form.office_npi,
        ai_enabled: form.ai_enabled ? 1 : 0,
        ai_provider: form.ai_provider,
        ai_api_key: form.ai_api_key,
        azure_endpoint: form.azure_endpoint,
        azure_deployment: form.azure_deployment,
      });
      toast.success(`${form.name || editing.name} updated.`);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  const agencies = data?.agencies ?? [];

  return (
    <div className="page wide" id="superadmin-page">
      <div className="page-head">
        <div>
          <h1>Super Admin</h1>
          <p className="muted">Platform-wide agency usage and AI configuration.</p>
        </div>
        <button className="btn" onClick={load} disabled={loading || busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <section className="card" id="superadmin-agencies">
        <div className="card-head">
          <div>
            <h2>Agencies</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Counts are read directly from each tenant, never combined into one list.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Agency</th>
                <th className="num">Users</th>
                <th className="num">Clients</th>
                <th className="num">Claims</th>
                <th>AI provider</th>
                <th>AI status</th>
                <th>Key</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agencies.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    <div className="muted small">agency #{a.id}</div>
                  </td>
                  <td className="num">{a.users ?? 0}</td>
                  <td className="num">{a.clients ?? 0}</td>
                  <td className="num">{a.claims ?? 0}</td>
                  <td>{a.ai_provider || 'none'}</td>
                  <td>
                    {String(a.ai_enabled ?? '1') === '1' ? (
                      <span className="pill ok">Active</span>
                    ) : (
                      <span className="pill">Disabled</span>
                    )}
                  </td>
                  <td>
                    {a.ai_key_set ? (
                      <span className="pill ok">configured</span>
                    ) : (
                      <span className="pill">none</span>
                    )}
                  </td>
                  <td>
                    <button className="btn tiny" onClick={() => openEdit(a)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && agencies.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">No agencies found.</td>
                </tr>
              )}
              {loading && agencies.length === 0 && (
                <SkeletonRows rows={3} cols={8} />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <DataHealthCard />

      <section className="card" id="superadmin-demo-ai">
        <div className="card-head">
          <div>
            <h2>Demo account AI</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Let the public Demo Agency use your DeepSeek/OpenAI/Azure key.
            </p>
          </div>
        </div>
        <div className="card-body">
          <label className="checkbox" style={{ alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="share-demo-ai"
              checked={Boolean(data?.demo_ai_shared)}
              disabled={loading || busy || !data?.demo_agency_id}
              onChange={(e) => toggleDemoAi(e.target.checked)}
            />
            <span>Share my AI key with the Demo Account</span>
          </label>
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            {data?.demo_ai_shared
              ? 'The Demo Agency is currently using your key. Turning this off clears its stored key.'
              : 'The Demo Agency is using its own key (or no key).'}
            {!data?.super_ai_key_set && (
              <> Add an AI key in Settings → AI Configuration before sharing it.</>
            )}
          </p>
        </div>
      </section>

      {editing && (
        <Modal
          title={`Edit ${editing.name}`}
          subtitle={`agency #${editing.id}`}
          onClose={() => !saving && setEditing(null)}
          width={620}
        >
          <form onSubmit={saveEdit}>
            <label>
              Agency Name
              <input
                id="edit-agency-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </label>
            <div className="grid-2">
              <label>
                Tax ID
                <input
                  id="edit-agency-tax"
                  value={form.agency_tax_id}
                  onChange={(e) => setForm((f) => ({ ...f, agency_tax_id: e.target.value }))}
                />
              </label>
              <label>
                Office NPI
                <input
                  id="edit-agency-npi"
                  value={form.office_npi}
                  onChange={(e) => setForm((f) => ({ ...f, office_npi: e.target.value }))}
                />
              </label>
            </div>

            <label className="checkbox" style={{ marginTop: 12, alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                id="edit-ai-enabled"
                checked={form.ai_enabled}
                onChange={(e) => setForm((f) => ({ ...f, ai_enabled: e.target.checked }))}
              />
              <strong>Enable AI Features</strong>
            </label>

            {form.ai_enabled && (
              <div id="edit-ai-fields">
                <label>
                  AI Provider
                  <select
                    id="edit-ai-provider"
                    value={form.ai_provider}
                    onChange={(e) => setForm((f) => ({ ...f, ai_provider: e.target.value }))}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </label>

                {form.ai_provider !== 'none' && (
                  <label>
                    AI API Key
                    <input
                      id="edit-ai-key"
                      type="password"
                      autoComplete="off"
                      value={form.ai_api_key}
                      placeholder={form.ai_key_set ? 'Leave blank to keep the saved key' : 'Paste a key'}
                      onChange={(e) => setForm((f) => ({ ...f, ai_api_key: e.target.value }))}
                    />
                  </label>
                )}

                {form.ai_provider === 'azure' && (
                  <div className="grid-2">
                    <label>
                      Azure Endpoint URL
                      <input
                        id="edit-azure-endpoint"
                        value={form.azure_endpoint}
                        placeholder="https://your-resource.openai.azure.com"
                        onChange={(e) => setForm((f) => ({ ...f, azure_endpoint: e.target.value }))}
                      />
                    </label>
                    <label>
                      Azure Deployment Name
                      <input
                        id="edit-azure-deployment"
                        value={form.azure_deployment}
                        placeholder="gpt-4o-mini"
                        onChange={(e) => setForm((f) => ({ ...f, azure_deployment: e.target.value }))}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn primary" id="edit-agency-save" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <SecurityLogCard />
    </div>
  );
}

function SecurityLogCard() {
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState('');
  const [allow, setAllow] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const limit = 25;

  const load = useCallback(async (nextPage = page, nextAction = action) => {
    setBusy(true);
    try {
      const result = await api.auditLogs({ page: nextPage, limit, action: nextAction });
      setLogs(result.logs ?? []);
      setTotal(result.total ?? 0);
      setPage(nextPage);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [page, action]);

  useEffect(() => {
    load(1, '');
    api.getAllowlist().then((r) => setAllow(r.allowed_ips ?? '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAllowlist() {
    setBusy(true);
    try {
      const result = await api.setAllowlist(allow);
      setAllow(result.allowed_ips ?? '');
      toast.success('IP allowlist saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <section className="card" id="security-log">
        <div className="card-head">
          <div>
            <h2>Security Log</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              HIPAA audit trail for client views, RA downloads, and claim changes.
            </p>
          </div>
          <div className="head-actions">
            <input placeholder="Filter action" value={action} onChange={(e) => setAction(e.target.value)} />
            <button className="btn" onClick={() => load(1, action)} disabled={busy}>Filter</button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead>
            <tbody>
              {logs.map((row) => (
                <tr key={row.id}>
                  <td className="small">{row.timestamp}</td>
                  <td className="small">{row.email ?? '—'}</td>
                  <td>{row.action}</td>
                  <td className="mono small">{row.resource_type} {row.resource_id ?? ''}</td>
                  <td className="mono small">{row.ip_address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <button className="btn" disabled={page <= 1 || busy} onClick={() => load(page - 1, action)}>Previous</button>
          <span className="muted small">Page {page} of {pages}</span>
          <button className="btn" disabled={page >= pages || busy} onClick={() => load(page + 1, action)}>Next</button>
        </div>
      </section>

      <section className="card" id="ip-allowlist">
        <div className="card-head">
          <div>
            <h2>IP Allowlist</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              One IP per line or comma-separated. Empty allows all IPs.
            </p>
          </div>
        </div>
        <div className="card-body">
          <textarea rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="203.0.113.10" />
          <button className="btn primary" onClick={saveAllowlist} disabled={busy}>Save Allowlist</button>
        </div>
      </section>
    </>
  );
}
