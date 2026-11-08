import React, { useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { clientHash } from '../route.js';
import { formatLongDate } from '../calc.js';

/**
 * "Week Calendar" entry point: pick a client, then land on their profile,
 * which is where the week calendar lives. There is deliberately no separate
 * calendar-only view — a client's schedule has exactly one address.
 */
export default function CalendarPage({ navigate }) {
  const [query, setQuery] = useState('');
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      api
        .searchClients(query.trim(), { limit: 25 })
        .then((d) => {
          if (cancelled) return;
          setClients(d.clients);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Week Calendar</h1>
          <p className="muted">
            Pick a client to open their schedule. The calendar lives on the client's own page,
            alongside their agreements and claims.
          </p>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="toolbar" style={{ padding: 14 }}>
          <div className="search-field">
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              ref={inputRef}
              type="search"
              placeholder="Search clients by name or MA number…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="clear" onClick={() => setQuery('')} title="Clear">
                ×
              </button>
            )}
          </div>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>MA number</th>
                <th>Date of birth</th>
                <th className="num">Agreements</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(clientHash(c.id))}>
                  <td>
                    <strong>
                      {c.last_name}, {c.first_name}
                    </strong>
                  </td>
                  <td className="mono">{c.ma_number ?? '—'}</td>
                  <td>{c.dob ? formatLongDate(c.dob) : '—'}</td>
                  <td className="num">{c.agreement_count}</td>
                  <td className="row-action">
                    <button
                      className="btn tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(clientHash(c.id));
                      }}
                    >
                      Open →
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && clients.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No clients match “{query}”.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={5} className="empty">
                    Searching…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
