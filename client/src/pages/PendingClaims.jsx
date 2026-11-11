import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { formatLongDate, formatMoney } from '../calc.js';

export default function PendingClaims() {
  const [claims, setClaims] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    api.pendingClaims({ from, to }).then((r) => setClaims(r.claims ?? [])).catch((e) => setError(e.message));
  }, [from, to]);
  const grouped = claims.reduce((map, c) => {
    const key = c.client_id;
    if (!map[key]) map[key] = { name: `${c.first_name} ${c.last_name}`, claims: [] };
    map[key].claims.push(c);
    return map;
  }, {});
  return (
    <div className="page" id="pending-claims-page">
      <div className="page-head"><div><h1>Pending Claims</h1><p className="muted">Claims submitted with status code 46, awaiting an RA match.</p></div><Link className="btn primary" to="/import-claims">Import Claim</Link></div>
      <section className="card"><div className="card-body claim-date-filter" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(from || to) && <button className="btn tiny" onClick={() => { setFrom(''); setTo(''); }}>Clear</button>}
      </div></section>
      {error && <div className="alert error">{error}</div>}
      {Object.entries(grouped).map(([id, group]) => (
        <section className="card" key={id}>
          <div className="card-head"><h2>{group.name}</h2><span className="pill">Client ID {id}</span></div>
          <div className="table-scroll"><table className="table"><thead><tr><th>Period</th><th>Procedure</th><th className="num">Units</th><th className="num">Charge</th><th className="num">Expected</th><th>Patient Control #</th></tr></thead><tbody>
            {group.claims.map((c) => <tr key={c.id}><td>{formatLongDate(c.period_start)} → {formatLongDate(c.period_end)}</td><td className="mono">{c.procedure_code ?? '—'}</td><td className="num">{c.total_units ?? '—'}</td><td className="num">{formatMoney(c.charge_amount)}</td><td className="num">{formatMoney(c.expected_payment)}</td><td className="mono">{c.patient_control_number ?? '—'}</td></tr>)}
          </tbody></table></div>
        </section>
      ))}
      {!claims.length && !error && <p className="empty">No pending claims.</p>}
    </div>
  );
}
