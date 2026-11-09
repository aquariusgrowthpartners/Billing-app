import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';

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

  const agencies = data?.agencies ?? [];

  return (
    <div className="page wide" id="superadmin-page">
      <div className="page-head">
        <div>
          <h1>Super Admin</h1>
          <p className="muted">Platform-wide agency usage and demo configuration.</p>
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
                <th>AI key</th>
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
                    {a.ai_key_set ? (
                      <span className="pill ok">configured</span>
                    ) : (
                      <span className="pill muted">none</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && agencies.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">No agencies found.</td>
                </tr>
              )}
              {loading && agencies.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">Loading agencies…</td>
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
              Let the public Demo Agency use your DeepSeek/OpenAI key.
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
    </div>
  );
}
