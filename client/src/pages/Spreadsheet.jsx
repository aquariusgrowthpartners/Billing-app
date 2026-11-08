import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { formatLongDate, formatMoney } from '../calc.js';

const today = () => new Date().toISOString().slice(0, 10);
const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Minnesota DHS "MPSMISC" monthly reporting spreadsheet.
 *
 * Two independent date ranges: what the spreadsheet's header says, and which
 * day entries supply the hours. Both come from our own database — the RA is
 * never involved.
 */
export default function Spreadsheet() {
  const [label, setLabel] = useState({ start: '', end: '' });
  const [work, setWork] = useState({ start: '', end: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seeded, setSeeded] = useState(false);

  const load = useCallback(async (l = label, w = work) => {
    setLoading(true);
    try {
      const d = await api.mpsmiscPreview({
        label_start: l.start,
        label_end: l.end,
        work_start: w.start,
        work_end: w.end,
      });
      setData(d);
      // First response supplies the server-computed defaults.
      if (!seeded) {
        setLabel(d.label_period);
        setWork(d.work_period);
        setSeeded(true);
      }
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [label, work, seeded]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data?.rows ?? [];
  const missingAgency = data?.missing_agency ?? [];
  const incomplete = rows.filter((r) => r.missing?.length);

  const download = () => {
    window.location.assign(
      api.mpsmiscDownloadUrl({
        label_start: label.start,
        label_end: label.end,
        work_start: work.start,
        work_end: work.end,
      })
    );
  };

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Monthly Spreadsheet</h1>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            The Minnesota DHS <strong>MPSMISC</strong> reporting spreadsheet. Hours and gross pay
            come from your day entries in this app, never from the RA.
          </p>
        </div>
        <div className="head-actions">
          <span className="pill ok tiny" id="row-count">
            {rows.length} worker{rows.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <section className="card" id="spreadsheet-periods">
        <div className="card-head">
          <h2>Periods</h2>
          <button className="btn tiny" id="reload-preview" onClick={() => load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh preview'}
          </button>
        </div>
        <div className="grid-3">
          <label>
            Report Label Period — start
            <input
              type="date"
              id="label-start"
              value={label.start}
              onChange={(e) => setLabel((v) => ({ ...v, start: e.target.value }))}
            />
          </label>
          <label>
            Report Label Period — end
            <input
              type="date"
              id="label-end"
              value={label.end}
              onChange={(e) => setLabel((v) => ({ ...v, end: e.target.value }))}
            />
          </label>
          <div className="muted small" style={{ alignSelf: 'end', paddingBottom: 6 }}>
            Goes in the spreadsheet header and the file name.
          </div>
          <label>
            Work Data Period — start
            <input
              type="date"
              id="work-start"
              value={work.start}
              onChange={(e) => setWork((v) => ({ ...v, start: e.target.value }))}
            />
          </label>
          <label>
            Work Data Period — end
            <input
              type="date"
              id="work-end"
              value={work.end}
              onChange={(e) => setWork((v) => ({ ...v, end: e.target.value }))}
            />
          </label>
          <div className="muted small" style={{ alignSelf: 'end', paddingBottom: 6 }}>
            Which day entries supply the hours.
          </div>
        </div>
      </section>

      {missingAgency.length > 0 && (
        <div className="alert warn" id="agency-warning">
          <strong>Agency information is incomplete.</strong> Missing: {missingAgency.join(', ')}.{' '}
          Fill it in under <strong>Settings → Agency information</strong>.
        </div>
      )}

      {incomplete.length > 0 && (
        <div className="alert warn" id="incomplete-warning">
          <strong>{incomplete.length}</strong> worker
          {incomplete.length === 1 ? ' is' : 's are'} missing required fields:{' '}
          {incomplete.map((r) => `${r.last_name}, ${r.first_name} (${r.missing.join(', ')})`).join('; ')}
        </div>
      )}

      <section className="card" id="spreadsheet-preview">
        <div className="card-head">
          <div>
            <h2>Preview</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }} id="preview-summary">
              {data
                ? `Label ${formatLongDate(data.label_period.start)} → ${formatLongDate(
                    data.label_period.end
                  )} · work data ${formatLongDate(data.work_period.start)} → ${formatLongDate(
                    data.work_period.end
                  )}`
                : '—'}
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="empty" id="preview-empty">
            No caretaker has recorded hours in the Work Data Period, so there is nothing to report.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table" id="mpsmisc-table">
              <thead>
                <tr>
                  <th>UMPI</th>
                  <th>Last</th>
                  <th>First</th>
                  <th>Middle</th>
                  <th>Street</th>
                  <th>City</th>
                  <th>State</th>
                  <th>ZIP</th>
                  <th>Phone</th>
                  <th>Hire Date</th>
                  <th>Term Date</th>
                  <th className="num">Hours</th>
                  <th className="num">Wage</th>
                  <th className="num">Gross Pay</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.caretaker_id}
                    id={`mpsmisc-row-${r.caretaker_id}`}
                    className={r.missing?.length ? 'row-unmatched' : ''}
                  >
                    <td className="mono">{r.umpi ?? <span className="muted">missing</span>}</td>
                    <td>{r.last_name}</td>
                    <td>{r.first_name}</td>
                    <td>{r.middle_name ?? '—'}</td>
                    <td>{r.street ?? <span className="muted">missing</span>}</td>
                    <td>{r.city ?? '—'}</td>
                    <td>{r.state ?? '—'}</td>
                    <td className="mono">{r.zip ?? '—'}</td>
                    <td className="mono">{r.phone ?? '—'}</td>
                    <td>{r.hire_date ?? '—'}</td>
                    <td>{r.termination_date ?? '—'}</td>
                    <td className="num">{r.hours.toFixed(2)}</td>
                    <td className="num">{r.wage == null ? '—' : formatMoney(r.wage)}</td>
                    <td className="num dollars">
                      {r.gross_pay == null ? '—' : formatMoney(r.gross_pay)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-actions">
          <button
            className="btn primary"
            id="download-spreadsheet"
            onClick={download}
            disabled={rows.length === 0}
            title={rows.length === 0 ? 'Nothing to export' : 'Download the .xlsx'}
          >
            Download Spreadsheet
          </button>
        </div>
      </section>
    </div>
  );
}
