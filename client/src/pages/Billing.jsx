import React, { useState } from 'react';
import { toast } from '../components/Toast.jsx';
import { formatMoney, formatLongDate } from '../calc.js';

const INVOICES = [
  { id: 'INV-2026-011', issued: '2026-11-01', due: '2026-11-15', status: 'Pending', amount: 2450.0 },
  { id: 'INV-2026-010', issued: '2026-10-01', due: '2026-10-15', status: 'Paid', amount: 3120.5 },
  { id: 'INV-2026-009', issued: '2026-09-01', due: '2026-09-15', status: 'Paid', amount: 2875.0 },
  { id: 'INV-2026-008', issued: '2026-08-01', due: '2026-08-15', status: 'Paid', amount: 2640.75 },
  { id: 'INV-2026-007', issued: '2026-07-01', due: '2026-07-15', status: 'Paid', amount: 3010.0 },
];

export default function Billing() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const visibleInvoices = from && to
    ? INVOICES.filter((invoice) => invoice.issued <= to && invoice.due >= from)
    : [];
  const paid = INVOICES.filter((i) => i.status === 'Paid').reduce((sum, i) => sum + i.amount, 0);
  const pending = INVOICES.filter((i) => i.status === 'Pending').reduce((sum, i) => sum + i.amount, 0);

  function download(invoice) {
    toast.info(`PDF export for ${invoice.id} is coming soon.`);
  }

  return (
    <div className="page wide" id="billing-page">
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p className="muted">Invoices, payment status and downloadable statements.</p>
        </div>
      </div>

      <div className="billing-summary">
        <div className="card billing-summary-card">
          <span className="metric-label">Paid this year</span>
          <span className="metric-value billing-amount">{formatMoney(paid)}</span>
        </div>
        <div className="card billing-summary-card">
          <span className="metric-label">Pending</span>
          <span className="metric-value billing-amount">{formatMoney(pending)}</span>
        </div>
      </div>

      <section className="card" id="invoice-list">
        <div className="card-head">
          <div>
            <h2>Invoices</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Statement history for your agency.
            </p>
          </div>
        </div>

        <div className="claim-date-filter" style={{ padding: '0 16px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {!from || !to ? (
          <p className="empty" id="billing-date-empty">Select a date range to view claims.</p>
        ) : (
        <>
        <div className="table-scroll hide-on-mobile">
          <table className="table billing-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td><strong>{invoice.id}</strong></td>
                  <td>{formatLongDate(invoice.issued)}</td>
                  <td>{formatLongDate(invoice.due)}</td>
                  <td>
                    <span className={`pill ${invoice.status === 'Paid' ? 'paid' : 'submitted'}`}>
                      {invoice.status}
                    </span>
                  </td>
                  <td className="num dollars">{formatMoney(invoice.amount)}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn tiny"
                      onClick={() => download(invoice)}
                    >
                      Download PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="show-on-mobile billing-cards">
          {visibleInvoices.map((invoice) => (
            <div className="billing-card" key={invoice.id}>
              <div className="billing-card-top">
                <strong>{invoice.id}</strong>
                <span className={`pill ${invoice.status === 'Paid' ? 'paid' : 'submitted'}`}>
                  {invoice.status}
                </span>
              </div>
              <div className="billing-card-meta">
                Issued {formatLongDate(invoice.issued)} · Due {formatLongDate(invoice.due)}
              </div>
              <div className="billing-card-bottom">
                <span className="billing-card-amount">{formatMoney(invoice.amount)}</span>
                <button type="button" className="btn tiny" onClick={() => download(invoice)}>
                  Download PDF
                </button>
              </div>
            </div>
          ))}
        </div>
        </>
        )}
      </section>
    </div>
  );
}
