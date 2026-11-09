import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';

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
                <tr>
                  <td colSpan={8} className="empty">Loading agencies…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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
    </div>
  );
}
