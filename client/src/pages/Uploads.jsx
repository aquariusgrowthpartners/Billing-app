import React, { useState } from 'react';
import ImportRa from './ImportRa.jsx';
import ImportClaims from './ImportClaims.jsx';
import ImportSA from './ImportSA.jsx';

const TABS = [
  { id: 'ra', label: 'Remittance Advice (RA)' },
  { id: 'claims', label: 'Claim Submission' },
  { id: 'sa', label: 'Service Agreement (SA)' },
];

export default function Uploads() {
  const [tab, setTab] = useState('ra');
  return (
    <div className="page" id="uploads-page">
      <div className="page-head">
        <div>
          <h1>Uploads</h1>
          <p className="muted">Import remittances, claim responses, and service agreements.</p>
        </div>
      </div>
      <div className="ask-tabs" role="tablist" aria-label="Upload type">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`ask-tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {/* Keep all three mounted so a selected file/pre-check state survives tab switches. */}
      <div className="uploads-panel" hidden={tab !== 'ra'}><ImportRa /></div>
      <div className="uploads-panel" hidden={tab !== 'claims'}><ImportClaims /></div>
      <div className="uploads-panel" hidden={tab !== 'sa'}><ImportSA /></div>
    </div>
  );
}
