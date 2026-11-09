import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import api from '../api.js';

const EMPTY = { clients: [], caretakers: [], claims: [] };

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 40);
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timerRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      setError(null);
      return undefined;
    }
    setLoading(true);
    timerRef.current = setTimeout(() => {
      api
        .search(q)
        .then((data) => {
          setResults({
            clients: Array.isArray(data?.clients) ? data.clients : [],
            caretakers: Array.isArray(data?.caretakers) ? data.caretakers : [],
            claims: Array.isArray(data?.claims) ? data.claims : [],
          });
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, 220);
    return () => clearTimeout(timerRef.current);
  }, [query, open]);

  function close() {
    setOpen(false);
    setQuery('');
    setResults(EMPTY);
    setError(null);
  }

  function go(path) {
    close();
    navigate(path);
  }

  const total = results.clients.length + results.caretakers.length + results.claims.length;

  return (
    <>
      <button
        type="button"
        className="topbar-search"
        id="global-search-open"
        aria-label="Search clients, caretakers and claims"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.9" />
          <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
        <span className="topbar-search-label">Search</span>
      </button>

      {open &&
        createPortal(
          <div className="global-search-overlay" role="dialog" aria-modal="true" aria-label="Search">
            <div className="global-search-head">
              <div className="global-search-field">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.9" />
                  <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  id="global-search-input"
                  type="search"
                  inputMode="search"
                  autoComplete="off"
                  placeholder="Search clients, caretakers, claims…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button type="button" className="global-search-cancel" onClick={close}>
                Cancel
              </button>
            </div>

            <div className="global-search-body">
              {loading && <p className="global-search-hint">Searching…</p>}
              {error && <div className="alert error">{error}</div>}

              {!loading && !error && query.trim().length < 2 && (
                <div className="global-search-empty">
                  <span className="global-search-empty-icon" aria-hidden="true">⌕</span>
                  <p>Search across your clients, caretakers and claims.</p>
                </div>
              )}

              {!loading && !error && query.trim().length >= 2 && total === 0 && (
                <div className="global-search-empty">
                  <p>No matches for “{query.trim()}”.</p>
                </div>
              )}

              {results.clients.length > 0 && (
                <section className="global-search-group">
                  <h2>Clients</h2>
                  {results.clients.map((c) => (
                    <button
                      type="button"
                      className="global-search-result"
                      key={`client-${c.id}`}
                      onClick={() => go(`/clients/${c.id}`)}
                    >
                      <span className="global-search-avatar">
                        {String(c.first_name ?? '?').charAt(0)}
                        {String(c.last_name ?? '').charAt(0)}
                      </span>
                      <span className="global-search-result-copy">
                        <strong>{c.last_name}, {c.first_name}</strong>
                        <span>{c.ma_number ? `MA ${c.ma_number}` : 'Client'}</span>
                      </span>
                      <span className="global-search-chevron">›</span>
                    </button>
                  ))}
                </section>
              )}

              {results.caretakers.length > 0 && (
                <section className="global-search-group">
                  <h2>Caretakers</h2>
                  {results.caretakers.map((c) => (
                    <button
                      type="button"
                      className="global-search-result"
                      key={`caretaker-${c.id}`}
                      onClick={() => go(`/caretakers/${c.id}`)}
                    >
                      <span className="global-search-avatar">
                        {String(c.first_name ?? '?').charAt(0)}
                        {String(c.last_name ?? '').charAt(0)}
                      </span>
                      <span className="global-search-result-copy">
                        <strong>{c.last_name}, {c.first_name}</strong>
                        <span>{c.npi_number ? `NPI ${c.npi_number}` : 'Caretaker'}</span>
                      </span>
                      <span className="global-search-chevron">›</span>
                    </button>
                  ))}
                </section>
              )}

              {results.claims.length > 0 && (
                <section className="global-search-group">
                  <h2>Claims</h2>
                  {results.claims.map((c) => (
                    <button
                      type="button"
                      className="global-search-result"
                      key={`claim-${c.id}`}
                      onClick={() => go('/claims')}
                    >
                      <span className="global-search-avatar claim">▤</span>
                      <span className="global-search-result-copy">
                        <strong>{c.claim_name ?? `Claim ${c.id}`}</strong>
                        <span>{c.last_name}, {c.first_name} · {c.status}</span>
                      </span>
                      <span className="global-search-chevron">›</span>
                    </button>
                  ))}
                </section>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
