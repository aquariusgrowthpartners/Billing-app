import React, { useState } from 'react';
import api from '../api.js';

export default function BaaGate({ user, onSigned }) {
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function sign(e) {
    e.preventDefault();
    if (!accepted || name.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.signBaa({ accepted: true, name: name.trim() });
      onSigned?.({ ...user, baa_signed_at: result.signed_at, baa_signed_name: result.signed_name });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page" id="baa-gate">
      <form className="login-card" onSubmit={sign} style={{ maxWidth: 560 }}>
        <h1 className="login-title">Business Associate Agreement</h1>
        <p className="muted small login-sub">
          Before using Dundas Billing, review and sign the BAA for {user?.agency_name ?? 'your agency'}.
        </p>
        {error && <div className="alert error">{error}</div>}
        <div className="card" style={{ padding: 16, marginBottom: 12, maxHeight: 220, overflow: 'auto' }}>
          <p className="small" style={{ margin: 0 }}>
            Dundas Billing safeguards protected health information using administrative, physical,
            and technical controls, including access logging, encryption in transit, unique user
            accounts, and automatic session logoff. You agree to use the platform only for lawful
            treatment, payment, and healthcare operations.
          </p>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          I have read and agree to the Business Associate Agreement.
        </label>
        <label>
          Type your full legal name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full legal name" />
        </label>
        <button className="btn primary login-submit" disabled={busy || !accepted || name.trim().length < 3} type="submit">
          {busy ? 'Signing…' : 'Sign BAA and continue'}
        </button>
      </form>
    </div>
  );
}
