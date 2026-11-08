import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api.js';
import Modal from '../components/Modal.jsx';
import { formatLongDate, formatMoney } from '../calc.js';

const PER_PAGE = 20;
const hours = (h) => `${(Number(h) || 0).toFixed(1)} hrs`;
const money = (v) => formatMoney(Number(v) || 0);

/** DENIED is solid red, REVERSED solid amber — the payer's own vocabulary. */
function StatusBadge({ status }) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'denied') return <span className="ds-badge ds-badge-solid-red">Denied</span>;
  if (s === 'reversed') return <span className="ds-badge ds-badge-solid-amber">Reversed</span>;
  return <span className="ds-badge ds-badge-gray">{s ? s.toUpperCase() : '—'}</span>;
}

/** Green / amber / red dot plus wording. */
function RecoveryBadge({ status, recovered, items }) {
  const total = Number(items) || 0;
  const done = Number(recovered) || 0;
  if (status === 'recovered') {
    return (
      <span className="ds-badge ds-badge-green">
        <i className="ds-dot ds-dot-green" /> Fully Recovered
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="ds-badge ds-badge-amber">
        <i className="ds-dot ds-dot-amber" /> Partial ({done}/{total})
      </span>
    );
  }
  return (
    <span className="ds-badge ds-badge-red">
      <i className="ds-dot ds-dot-red" /> Unrecovered ({done}/{total})
    </span>
  );
}

/** Days open: gray under 30, amber 30-60, red over 60. */
function DaysOpen({ days }) {
  const d = Number(days) || 0;
  const cls = d > 60 ? 'ds-days-red' : d >= 30 ? 'ds-days-amber' : 'ds-days-gray';
  return (
    <span className={cls} id={`days-open-${d}`}>
      {d}
      {d > 60 && <span className="ds-badge ds-badge-red" style={{ marginLeft: 6 }}>aged</span>}
    </span>
  );
}

/** Three grey shimmer rows, so a loading table keeps its shape. */
function Skeleton() {
  return (
    <div className="ds-skeleton" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="ds-skeleton-row" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

function EmptyState({ icon, head, sub, id }) {
  return (
    <div className="ds-empty" id={id}>
      <span className="ds-empty-icon">{icon}</span>
      <div className="ds-empty-head">{head}</div>
      {sub && <div className="ds-empty-sub">{sub}</div>}
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="alert error" id="denials-error">
      {message}{' '}
      <button className="btn tiny" id="denials-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}


/**
 * The provider returns light markdown. Only **bold** is handled — anything
 * fancier would need a real renderer, and plain paragraphs are the common case.
 */
function renderBold(text) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export default function Denials() {
  const [summary, setSummary] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [denials, setDenials] = useState([]);
  const [filters, setFilters] = useState({ client_id: '', caretaker_id: '', from: '', to: '' });
  const [explaining, setExplaining] = useState(null); // denial id in flight
  const [explainResult, setExplainResult] = useState(null); // { denial, explanation, source }

  async function explainDenial(d) {
    setExplaining(d.id);
    try {
      const r = await api.explainDenial(d.id);
      setExplainResult({ denial: d, ...r });
    } catch (e) {
      setExplainResult({ denial: d, explanation: e.message, source: 'error' });
    } finally {
      setExplaining(null);
    }
  }
  const [sort, setSort] = useState('dos_desc');
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const [detail, setDetail] = useState(null);
  // linked from the Rebill List as /denials?open=<denied_claim_id>
  const [searchParams, setSearchParams] = useSearchParams();
  const [noteFor, setNoteFor] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [confirm, setConfirm] = useState(null); // { kind, ids, preview }
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t, d] = await Promise.all([
        api.denialSummary(),
        api.rebillTasks({
          client_id: filters.client_id,
          caretaker_id: filters.caretaker_id,
          date_from: filters.from,
          date_to: filters.to,
        }),
        api.denials({ search }),
      ]);
      setSummary(s);
      setTasks(t.tasks ?? []);
      setDenials(d.denials ?? []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    api
      .denial(openId)
      .then(setDetail)
      .catch(() => {})
      .finally(() => {
        // consume it, so a later refresh does not reopen the modal
        const next = new URLSearchParams(searchParams);
        next.delete('open');
        setSearchParams(next, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // a filter or search change always starts you back at page one
  useEffect(() => {
    setSelected([]);
  }, [filters, search, chip, page]);

  function toast(m) {
    setFlash(m);
    setTimeout(() => setFlash(null), 3000);
  }

  async function submitTask(taskId, text) {
    try {
      await api.updateRebillTask(taskId, { status: 'submitted', notes: text || null });
      setNoteFor(null);
      setNoteText('');
      await load();
      window.dispatchEvent(new Event('data-updated'));
      toast('Rebill marked as submitted');
    } catch (e) {
      setError(e.message);
    }
  }

  async function submitSelected() {
    setBusy(true);
    try {
      for (const id of selected) await api.updateRebillTask(id, { status: 'submitted' });
      const n = selected.length;
      setSelected([]);
      await load();
      window.dispatchEvent(new Event('data-updated'));
      toast(`${n} rebill task${n === 1 ? '' : 's'} marked as submitted`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Open the right confirmation for either a denial or a task-only removal. */
  async function askDelete(kind, ids) {
    setTyped('');
    try {
      const preview = kind === 'task' ? null : await api.denialDeletePreview(ids);
      setConfirm({ kind, ids, preview });
    } catch (e) {
      setError(e.message);
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      if (confirm.kind === 'task') {
        await api.deleteRebillTask(confirm.ids[0]);
        setConfirm(null);
        await load();
        window.dispatchEvent(new Event('data-updated'));
        toast('Deleted 0 denials and 1 rebill task.');
      } else {
        const r = confirm.ids.length === 1
          ? await api.deleteDenial(confirm.ids[0])
          : await api.bulkDeleteDenials(confirm.ids);
        setConfirm(null);
        setSelected([]);
        await load();
        window.dispatchEvent(new Event('data-updated'));
        toast(
          `Deleted ${r.deleted_denial} denial${r.deleted_denial === 1 ? '' : 's'} and ` +
            `${r.deleted_rebill_tasks} rebill task${r.deleted_rebill_tasks === 1 ? '' : 's'}.`
        );
      }
    } catch (e) {
      setConfirm(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------ derived */

  const open = tasks.filter((t) => t.status === 'open');
  const sortedOpen = useMemo(() => {
    const rows = [...open];
    if (sort === 'dos_asc') rows.sort((a, b) => String(a.dos).localeCompare(String(b.dos)));
    else if (sort === 'billed') rows.sort((a, b) => (b.billed || 0) - (a.billed || 0));
    else if (sort === 'open') rows.sort((a, b) => (b.days_open || 0) - (a.days_open || 0));
    else rows.sort((a, b) => String(b.dos).localeCompare(String(a.dos)));
    return rows;
  }, [open, sort]);

  const filteredDenials = useMemo(() => {
    if (chip === 'all') return denials;
    return denials.filter((d) => {
      if (chip === 'denied' || chip === 'reversed') return String(d.claim_status) === chip;
      return d.recovery_status === chip;
    });
  }, [denials, chip]);

  const pages = Math.max(Math.ceil(filteredDenials.length / PER_PAGE), 1);
  const safePage = Math.min(page, pages);
  const pageRows = filteredDenials.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const allPageSelected = pageRows.length > 0 && pageRows.every((d) => selected.includes(d.id));

  const clients = [...new Map(denials.filter((d) => d.client_id).map((d) => [d.client_id, d.client_label])).entries()];
  const caretakers = [...new Map(tasks.filter((t) => t.caretaker_id).map((t) => [t.caretaker_id, t.caretaker_label])).entries()];
  const recoveredCount = denials.filter((d) => d.recovery_status === 'recovered').length;
  const partialCount = denials.filter((d) => d.recovery_status === 'partial').length;
  const byClient = summary?.by_client ?? [];
  const topClients = byClient.slice(0, 5);
  const maxDollars = Math.max(1, ...topClients.map((c) => c.dollars || 0));

  const notesFrom = (n) => (n === 1 ? '1 client' : `${n} clients`);

  return (
    <div className="page wide">
      <div className="page-head" style={{ gap: 16 }}>
        <div>
          <h1 className="ds-title">Denials</h1>
          <p className="ds-muted" style={{ margin: '4px 0 0' }}>
            Denied and reversed claims are tracked here. They never create day entries and never
            count as revenue.
          </p>
        </div>
        {flash && <span className="ds-badge ds-badge-green" id="denials-flash">{flash}</span>}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <div className="ds-stack">
        {/* ------------------------------------------------ section 1 */}
        <div className="ds-metrics" id="denial-metrics">
          <div className="ds-metric" id="metric-open-tasks">
            <span className="ds-metric-icon ds-red">⚑</span>
            <div className="ds-metric-label">Open rebill tasks</div>
            <div className={`ds-metric-value ${summary?.open_tasks > 0 ? 'ds-red' : 'ds-gray'}`}>
              {summary?.open_tasks ?? 0}
            </div>
            <div className="ds-metric-sub">days needing new claims</div>
          </div>
          <div className="ds-metric" id="metric-days">
            <span className="ds-metric-icon ds-red">▤</span>
            <div className="ds-metric-label">Unrecovered days</div>
            <div className={`ds-metric-value ${summary?.unrecovered_days > 0 ? 'ds-red' : 'ds-gray'}`}>
              {summary?.unrecovered_days ?? 0}
            </div>
            <div className="ds-metric-sub">across {notesFrom(byClient.length)}</div>
          </div>
          <div className="ds-metric" id="metric-dollars">
            <span className="ds-metric-icon ds-red">$</span>
            <div className="ds-metric-label">At risk</div>
            <div className={`ds-metric-value ${summary?.unrecovered_dollars > 0 ? 'ds-red' : 'ds-gray'}`}>
              {money(summary?.unrecovered_dollars)}
            </div>
            <div className="ds-metric-sub">unbilled revenue</div>
          </div>
          <div className="ds-metric" id="metric-total">
            <span className="ds-metric-icon ds-gray">◷</span>
            <div className="ds-metric-label">All-time denials</div>
            <div className="ds-metric-value ds-gray">{summary?.total_denied_claims ?? 0}</div>
            <div className="ds-metric-sub">
              {recoveredCount} recovered, {partialCount} partial, {open.length} open
            </div>
          </div>
        </div>

        <div className="ds-card" id="denial-by-client">
          <h2 className="ds-section" style={{ marginBottom: 14 }}>Unrecovered dollars by client</h2>
          {loading && !summary ? (
            <Skeleton />
          ) : !byClient.length ? (
            <EmptyState icon="✓" head="Nothing unrecovered" sub="Every denial has been rebilled." id="by-client-empty" />
          ) : (
            <>
              <div className="ds-bars" id="by-client-bars">
                {topClients.map((c) => (
                  <div className="ds-bar-row" key={c.client_id ?? 'none'}>
                    <span>{c.client_name}</span>
                    <span className="ds-bar-track">
                      <span
                        className="ds-bar-fill"
                        id={`bar-${c.client_id ?? 'none'}`}
                        style={{ width: `${Math.max((c.dollars / maxDollars) * 100, 2)}%` }}
                      />
                    </span>
                    <span className="ds-bar-value">{money(c.dollars)}</span>
                  </div>
                ))}
              </div>
              {byClient.length > 5 && (
                <p style={{ marginTop: 10 }}>
                  <button
                    className="btn tiny ghost"
                    id="view-all-clients"
                    onClick={() => setChip('unrecovered')}
                  >
                    View all {byClient.length} clients →
                  </button>
                </p>
              )}
            </>
          )}
        </div>

        {/* ------------------------------------------------ section 2 */}
        <div className="ds-card" id="rebill-tasks">
          <div className="card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 className="ds-section">Open Rebill Tasks</h2>
              <span className="ds-badge ds-badge-red" id="open-task-count">{open.length}</span>
            </div>
          </div>

          <div className="ds-filters">
            <label className="ds-field">
              Client
              <select id="task-client" value={filters.client_id}
                onChange={(e) => setFilters((f) => ({ ...f, client_id: e.target.value }))}>
                <option value="">All clients</option>
                {clients.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <label className="ds-field">
              Caretaker
              <select id="task-caretaker" value={filters.caretaker_id}
                onChange={(e) => setFilters((f) => ({ ...f, caretaker_id: e.target.value }))}>
                <option value="">All caretakers</option>
                {caretakers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <label className="ds-field">
              From
              <input type="date" id="task-from" value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
            </label>
            <label className="ds-field">
              To
              <input type="date" id="task-to" value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
            </label>
            <label className="ds-field">
              Sort
              <select id="task-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="dos_desc">Newest DOS</option>
                <option value="dos_asc">Oldest DOS</option>
                <option value="billed">Largest Billed</option>
                <option value="open">Longest Open</option>
              </select>
            </label>
          </div>

          {loading && !tasks.length ? (
            <Skeleton />
          ) : !sortedOpen.length ? (
            <EmptyState icon="✓" head="No open rebill tasks." sub="Everything's caught up." id="tasks-empty" />
          ) : (
            <div className="ds-sticky-first">
              <div className="table-scroll">
                <table className="ds-table" id="tasks-table">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>
                        <input type="checkbox" className="day-check" id="tasks-select-all"
                          checked={sortedOpen.every((t) => selected.includes(t.id))}
                          onChange={() =>
                            setSelected(sortedOpen.every((t) => selected.includes(t.id)) ? [] : sortedOpen.map((t) => t.id))
                          } />
                      </th>
                      <th>Client</th><th>Caretaker</th><th>DOS</th><th>Procedure</th>
                      <th className="ds-num">Units</th><th className="ds-num">Hours</th><th className="ds-num">Billed</th>
                      <th className="ds-num">Days Open</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedOpen.map((t) => (
                      <tr
                        key={t.id}
                        id={`task-row-${t.id}`}
                        className="row-clickable"
                        onClick={(e) => {
                          // the actions cell keeps its own clicks
                          if (e.target.closest('td.actions-cell')) return;
                          api.denial(t.denied_claim_id).then(setDetail);
                        }}
                      >
                        <td>
                          <input type="checkbox" className="day-check" name={`task-select-${t.id}`}
                            checked={selected.includes(t.id)}
                            onChange={() =>
                              setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))
                            } />
                        </td>
                        <td>{t.client_label}</td>
                        <td>{t.caretaker_label}</td>
                        <td className="nowrap">{formatLongDate(t.dos)}</td>
                        <td className="mono">{t.procedure_code ?? '—'}</td>
                        <td className="ds-num">{t.units ?? '—'}</td>
                        <td className="ds-num">{hours(t.hours)}</td>
                        <td className="ds-num">{money(t.billed)}</td>
                        <td className="ds-num"><DaysOpen days={t.days_open} /></td>
                        <td className="nowrap actions-cell">
                          <button className="btn tiny primary" id={`task-submit-${t.id}`}
                            onClick={(e) => { e.stopPropagation(); setNoteFor(t); setNoteText(''); }}>
                            Mark Submitted
                          </button>{' '}
                          <button className="btn-text-danger" id={`task-delete-${t.id}`}
                            onClick={(e) => { e.stopPropagation(); askDelete('task', [t.id]); }}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selected.length > 0 && (
                <div className="ds-bulk-bar" id="tasks-bulk-bar">
                  <span className="ds-bulk-count" id="tasks-bulk-count">{selected.length} selected</span>
                  <button className="btn primary" id="bulk-submit"
                    onClick={submitSelected} disabled={busy}>
                    Mark {selected.length} Selected as Submitted
                  </button>
                  <button className="btn danger" id="bulk-delete-tasks"
                    onClick={() => askDelete('bulk-tasks', selected)} disabled={busy}>
                    Delete {selected.length} Selected
                  </button>
                  <button className="btn" id="bulk-clear" onClick={() => setSelected([])}>Clear</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ------------------------------------------------ section 3 */}
        <div className="ds-card" id="denied-archive">
          <div className="card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 className="ds-section">Denied &amp; Reversed Claims</h2>
              <span className="ds-badge ds-badge-gray" id="archive-count">{denials.length}</span>
            </div>
          </div>

          <div className="ds-filters" style={{ marginBottom: 4 }}>
            <label className="ds-field" style={{ flex: 1 }}>
              Search
              <input
                type="search" id="denial-search" placeholder="Search by client or RA claim #"
                style={{ width: '100%' }}
                value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }}
              />
            </label>
            <button
              className="btn"
              id="download-all-filtered"
              onClick={() =>
                // every denial matching the filters, not just this page
                window.location.assign(
                  api.denialsCsvUrl({
                    search,
                    recovery_status: ['recovered', 'partial', 'unrecovered'].includes(chip) ? chip : '',
                    status: ['denied', 'reversed'].includes(chip) ? chip : '',
                  })
                )
              }
            >
              ⭳ Download All Filtered
            </button>
          </div>

          <div className="ds-chips" id="denial-chips">
            {[
              ['all', 'All'],
              ['denied', 'Denied'],
              ['reversed', 'Reversed'],
              ['recovered', 'Recovered'],
              ['partial', 'Partial'],
              ['unrecovered', 'Unrecovered'],
            ].map(([value, label]) => (
              <button
                key={value}
                id={`chip-${value}`}
                className={`ds-chip ${chip === value ? 'ds-chip-active' : ''}`}
                onClick={() => { setPage(1); setChip(value); }}
              >
                {label}
              </button>
            ))}
          </div>

          {loading && !denials.length ? (
            <Skeleton />
          ) : !pageRows.length ? (
            <EmptyState
              icon="🗂"
              head={search || chip !== 'all' ? 'Nothing matches those filters' : 'No denied or reversed claims'}
              sub={search || chip !== 'all' ? 'Try clearing the search or chips.' : 'Denied advices will appear here.'}
              id="archive-empty"
            />
          ) : (
            <>
              <div className="ds-sticky-first hide-on-mobile">
                <div className="table-scroll">
                  <table className="ds-table" id="archive-table">
                    <thead>
                      <tr>
                        <th style={{ width: 34 }}>
                          <input type="checkbox" className="day-check" id="archive-select-all"
                            checked={allPageSelected}
                            onChange={() =>
                              setSelected(allPageSelected ? [] : pageRows.map((d) => d.id))
                            } />
                        </th>
                        <th>RA Claim #</th><th>Client</th><th>Caretaker</th><th>DOS Range</th>
                        <th>Status</th><th className="ds-num">Charge</th><th>Recovery</th>
                        <th>Source File</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((d) => (
                        <tr key={d.id} id={`denial-row-${d.id}`} className="row-clickable"
                          onClick={(e) => {
                            if (e.target.closest('button, input, a, td.actions-cell')) return;
                            api.denial(d.id).then(setDetail);
                          }}>
                          <td onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" className="day-check" name={`denial-select-${d.id}`}
                              checked={selected.includes(d.id)}
                              onChange={() =>
                                setSelected((s) => (s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id]))
                              } />
                          </td>
                          <td className="mono">{d.ra_claim_number ?? '—'}</td>
                          <td>{d.client_label}</td>
                          <td>{d.caretaker_label ?? '—'}</td>
                          <td className="nowrap">
                            {d.dos_start ? `${formatLongDate(d.dos_start)} – ${formatLongDate(d.dos_end)}` : '—'}
                          </td>
                          <td><StatusBadge status={d.claim_status} /></td>
                          <td className="ds-num">{money(d.total_charge)}</td>
                          <td><RecoveryBadge status={d.recovery_status} recovered={d.recovered} items={d.items} /></td>
                          <td className="source-file" title={d.source_filename ?? ''}>{d.source_filename ?? '—'}</td>
                          <td className="nowrap actions-cell">
                            <button
                              className="btn tiny ghost"
                              id={`denial-download-${d.id}`}
                              title="Download this denial as a PDF"
                              aria-label="Download PDF"
                              onClick={(e) => { e.stopPropagation(); window.location.assign(api.denialPdfUrl(d.id)); }}
                            >
                              ⭳
                            </button>{' '}
                            <button
                              className="btn tiny explain-btn"
                              id={`denial-explain-${d.id}`}
                              disabled={explaining === d.id}
                              title="Explain this denial and how to fix it"
                              onClick={(e) => { e.stopPropagation(); explainDenial(d); }}
                            >
                              {explaining === d.id ? 'Thinking…' : '✨ Explain'}
                            </button>{' '}
                            <button className="btn-text-danger" id={`denial-delete-${d.id}`}
                              onClick={(e) => { e.stopPropagation(); askDelete('denial', [d.id]); }}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="denial-cards show-on-mobile" id="denial-cards">
                {pageRows.map((d) => {
                  const money = (n) =>
                    n == null ? '—' : `$${Number(n).toFixed(2)}`;
                  return (
                    <div className="denial-card" key={d.id} id={`denial-card-${d.id}`}>
                      <div className="denial-card-top">
                        <strong>{d.client_name_raw ?? 'Unknown client'}</strong>
                        <StatusBadge status={d.claim_status} />
                      </div>
                      <div className="denial-card-meta">
                        <span>{d.dos_start ?? '—'}{d.dos_end ? ` → ${d.dos_end}` : ''}</span>
                        {d.adjustment_code && (
                          <span className="denial-code" title="Adjustment code">
                            {d.adjustment_code}
                          </span>
                        )}
                      </div>
                      <div className="denial-card-amount">
                        {money(d.total_payment)}
                        <span className="muted small"> adjusted</span>
                      </div>
                      <button
                        className="btn explain-btn denial-card-explain"
                        id={`denial-card-explain-${d.id}`}
                        disabled={explaining === d.id}
                        onClick={() => explainDenial(d)}
                      >
                        {explaining === d.id ? 'Thinking…' : '✨ Explain'}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="ds-pager" id="archive-pager">
                <button className="ds-page-btn" id="page-prev" disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(p - 1, 1))}>← Prev</button>
                {Array.from({ length: pages }, (_, i) => i + 1)
                  .filter((n) => n === 1 || n === pages || Math.abs(n - safePage) <= 1)
                  .map((n) => (
                    <button key={n} id={`page-${n}`}
                      className={`ds-page-btn ${n === safePage ? 'ds-page-btn-active' : ''}`}
                      onClick={() => setPage(n)}>{n}</button>
                  ))}
                <button className="ds-page-btn" id="page-next" disabled={safePage >= pages}
                  onClick={() => setPage((p) => Math.min(p + 1, pages))}>Next →</button>
                <span className="ds-muted" style={{ marginLeft: 8 }} id="page-status">
                  Page {safePage} of {pages}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="ds-bulk-bar" id="archive-bulk-bar">
          <span className="ds-bulk-count" id="archive-bulk-count">{selected.length} selected</span>
          <button
            className="btn"
            id="bulk-download-denials"
            onClick={() => window.location.assign(api.denialsCsvUrl({ ids: selected.join(',') }))}
          >
            ⭳ Download {selected.length} Selected
          </button>
          <button className="btn danger" id="bulk-delete-denials"
            onClick={() => askDelete('denial', selected)} disabled={busy}>
            Delete {selected.length} Selected
          </button>
          <button className="btn" id="archive-bulk-clear" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {explainResult && (
        <Modal
          title="Denial explained"
          subtitle={
            explainResult.denial?.client_name_raw ||
            `Denial #${explainResult.denial?.id}`
          }
          onClose={() => setExplainResult(null)}
          width={620}
        >
          <div className="explain" id="denial-explain-modal">
            {explainResult.source === 'none' && (
              <div className="alert warn" id="explain-no-key">
                No AI provider is configured. Add a key in Settings → AI Configuration.
              </div>
            )}
            <div className="explain-body" id="explain-text">
              {String(explainResult.explanation ?? '')
                .split(/\n\n+/)
                .map((para, i) => (
                  <p key={i}>{renderBold(para)}</p>
                ))}
            </div>
            <div className="explain-actions">
              <button
                className="btn"
                id="explain-copy"
                onClick={() => {
                  navigator.clipboard?.writeText(String(explainResult.explanation ?? ''));
                }}
              >
                Copy to Clipboard
              </button>
              <button
                className="btn primary"
                id="explain-close"
                onClick={() => setExplainResult(null)}
              >
                Got it
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ------------------------------------------- note modal */}
      {noteFor && (
        <Modal title="Mark rebill as submitted" onClose={() => setNoteFor(null)} width={520}>
          <p className="ds-confirm-rows">
            <div><dt>Client</dt><dd>{noteFor.client_label}</dd></div>
            <div><dt>DOS</dt><dd>{formatLongDate(noteFor.dos)}</dd></div>
            <div><dt>Procedure</dt><dd>{noteFor.procedure_code ?? '—'}</dd></div>
          </p>
          <label className="delete-type">
            Note (optional)
            <input type="text" id="task-note" value={noteText} autoComplete="off"
              onChange={(e) => setNoteText(e.target.value)} />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => setNoteFor(null)}>Cancel</button>
            <button className="btn primary" id="task-note-confirm"
              onClick={() => submitTask(noteFor.id, noteText)}>
              Mark as Submitted
            </button>
          </div>
        </Modal>
      )}

      {/* ------------------------------------------- confirm modal */}
      {confirm && (
        <Modal
          title={confirm.kind === 'task' ? 'Remove Rebill Task?' : '⚠ Delete Denied Claim?'}
          onClose={() => setConfirm(null)}
          width={620}
        >
          {confirm.kind === 'task' ? (
            <>
              <p className="ds-confirm-rows">
                <div><dt>Client</dt><dd>{tasks.find((t) => t.id === confirm.ids[0])?.client_label ?? '—'}</dd></div>
                <div><dt>DOS</dt><dd>{formatLongDate(tasks.find((t) => t.id === confirm.ids[0])?.dos)}</dd></div>
              </p>
              <p className="ds-confirm-reassure">
                This removes the task from your open list but keeps the denial record in the archive.
                Use this if you've already rebilled outside the app and just want to clear the flag.
              </p>
              <div className="form-actions">
                <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                <button className="btn danger" id="confirm-delete-task" onClick={doDelete} disabled={busy}>
                  Remove Task
                </button>
              </div>
            </>
          ) : (
            <>
              {confirm.ids.length === 1 ? (
                <p className="ds-confirm-rows" id="delete-denial-summary">
                  {(() => {
                    const d = denials.find((x) => x.id === confirm.ids[0]) ?? {};
                    return (
                      <>
                        <div><dt>RA Claim</dt><dd>{d.ra_claim_number ?? '—'}</dd></div>
                        <div><dt>Client</dt><dd>{d.client_label ?? '—'}</dd></div>
                        <div><dt>DOS</dt><dd>{d.dos_start ? `${formatLongDate(d.dos_start)} – ${formatLongDate(d.dos_end)}` : '—'}</dd></div>
                        <div><dt>Status</dt><dd><StatusBadge status={d.claim_status} /></dd></div>
                      </>
                    );
                  })()}
                </p>
              ) : null}

              <p>This will permanently delete:</p>
              <ul className="ds-confirm-list" id="delete-denial-breakdown">
                <li>
                  {confirm.ids.length === 1
                    ? 'The denial record'
                    : `${confirm.preview?.denials ?? confirm.ids.length} denial records`}
                </li>
                <li>{confirm.preview?.line_items ?? 0} line items</li>
                <li>{confirm.preview?.rebill_tasks ?? 0} associated rebill tasks</li>
              </ul>
              <div className="ds-confirm-reassure" id="delete-denial-reassure">
                This does NOT delete any day entries, claims, or revenue data. It only removes this
                record from the Denials archive.
              </div>
              <label className="delete-type">
                Type DELETE to confirm:
                <input
                  type="text" id="denial-delete-input" value={typed} autoComplete="off"
                  spellCheck={false} placeholder="DELETE"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button className="btn" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
                <button className="btn danger" id="confirm-delete-denial"
                  onClick={doDelete} disabled={typed !== 'DELETE' || busy}>
                  Delete Permanently
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ------------------------------------------- detail modal */}
      {detail && (
        <Modal
          title={`Denied claim ${detail.denial.ra_claim_number ?? ''}`}
          onClose={() => setDetail(null)}
          width={780}
        >
          <div className="ds-modal-head">
            <div>
              <div style={{ fontWeight: 600 }}>{detail.denial.client_label}</div>
              <StatusBadge status={detail.denial.claim_status} />
            </div>
            <button className="btn-text-danger" id="detail-delete"
              onClick={() => { const id = detail.denial.id; setDetail(null); askDelete('denial', [id]); }}>
              🗑 Delete
            </button>
          </div>

          <div className="ds-modal-summary">
            <span>DOS: {detail.denial.dos_start ? `${formatLongDate(detail.denial.dos_start)} – ${formatLongDate(detail.denial.dos_end)}` : '—'}</span>
            <span>Caretaker: {detail.denial.caretaker_npi_raw ?? '—'}</span>
            <span>Total charge: {money(detail.denial.total_charge)}</span>
            <span>Source: {detail.denial.source_filename ?? '—'}</span>
          </div>

          <div className="table-scroll">
            <table className="ds-table" id="denial-detail-table">
              <thead>
                <tr>
                  <th>DOS</th><th>Procedure</th><th className="ds-num">Units</th><th className="ds-num">Hours</th>
                  <th className="ds-num">Billed</th><th>Recovered?</th><th>Recovered via</th>
                </tr>
              </thead>
              <tbody>
                {detail.line_items.map((li) => (
                  <tr key={li.id} id={`denial-item-${li.id}`}>
                    <td className="nowrap">{formatLongDate(li.dos)}</td>
                    <td className="mono">{li.procedure_code ?? '—'}</td>
                    <td className="ds-num">{li.units ?? '—'}</td>
                    <td className="ds-num">{(Number(li.minutes_worked || 0) / 60).toFixed(1)}</td>
                    <td className="ds-num">{money(li.billed)}</td>
                    <td>
                      {li.recovered ? (
                        <span className="ds-badge ds-badge-green"><i className="ds-dot ds-dot-green" /> Yes</span>
                      ) : li.recovery_status === 'written_off' ? (
                        <span className="ds-badge ds-badge-gray">Written off</span>
                      ) : (
                        <span className="ds-badge ds-badge-red"><i className="ds-dot ds-dot-red" /> Rebill needed</span>
                      )}
                    </td>
                    <td>
                      {li.recovered_by_day_entry_id ? (
                        <Link
                          to={`/clients/${detail.denial.client_id}?week=${li.recovered_dos ?? li.dos}`}
                          id={`denial-entry-link-${li.id}`}
                        >
                          View day entry →
                        </Link>
                      ) : (
                        <span className="ds-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="form-actions" style={{ justifyContent: 'space-between' }}>
            <button className="btn danger" id="detail-delete-footer"
              onClick={() => { const id = detail.denial.id; setDetail(null); askDelete('denial', [id]); }}>
              Delete Denial
            </button>
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
