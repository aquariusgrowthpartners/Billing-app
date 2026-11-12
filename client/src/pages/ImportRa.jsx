import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api.js';
import Modal from '../components/Modal.jsx';
import { formatMoney } from '../calc.js';

/** The most PDFs one upload may carry. */
// Two files a second is a comfortable sequential pace, so a full batch of 30
// stays far inside the server's five-minute ceiling.
const MAX_BATCH = 30;

const ACTIONS = [
  { value: 'mark_paid', label: 'Mark as Paid' },
  { value: 'create_claim', label: 'Create New Claim' },
  { value: 'skip', label: 'Skip' },
];

/** One review-table row, built from a parsed client block. */
/** SHA-256 of a File, as lowercase hex — the key the server matches on. */
async function fileHash(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toRow(block, sourceFile) {
  return {
    key: `${block.client_name ?? 'unnamed'}-${Math.random().toString(36).slice(2)}`,
    // Which PDF this row came from, so a combined review can be checked.
    source_file: sourceFile ?? null,
    claim_status: block.claim_status ?? null,
    paid: block.paid !== false,
    // denied/reversed rows are archived, never billed
    denial: block.paid === false,
    client_name: block.client_name,
    member_id: block.patient_id ?? block.member_id ?? null,
    claim_number: block.claim_number,
    rendered_provider_name: block.rendered_provider_name ?? block.rendered_provider ?? null,
    // REND PROV ID is the caregiver's NPI — the key the backend matches on.
    rendered_provider_id: block.rendered_provider_id ?? null,
    npi_match_id: block.suggested_caretaker?.id ?? '',
    dos_start: block.dos_start ?? '',
    dos_end: block.dos_end ?? '',
    total_charge: block.total_charge ?? '',
    total_payment: block.total_payment ?? '',
    // A hand-made claim overlapping the period defaults the row to Skip: the
    // warning asks before anything is touched.
    action: block.paid === false ? 'save_denials' : block.manual_claim ? 'skip' : 'mark_paid',
    autoSkipped: Boolean(block.manual_claim),
    client_id: block.suggested_client?.id ?? '',
    // How sure the fuzzy matcher was: 'strong' | 'possible' | null (manual pick).
    match_confidence: block.suggested_client?.match_confidence ?? null,
    // Pre-select the caretaker matched by NPI; the user can override per line.
    line_items: (block.line_items ?? []).map((li) => ({
      ...li,
      caretaker_id: block.suggested_caretaker?.id ?? '',
    })),
    merged_pages: block.merged_pages ?? 1,
    // Duplicate detection from the parse; refreshed when the client or dates change.
    existing_claim: block.existing_claim ?? null,
    manual_claim: block.manual_claim ?? null,
    ra_import_entries: block.ra_import_entries ?? 0,
    resolution: 'skip',
  };
}

export default function ImportRa() {
  const [file, setFile] = useState(null);
  // One entry per selected PDF, with its own parse status so a single bad file
  // cannot hide the results of the others.
  const [queue, setQueue] = useState([]);
  const [results, setResults] = useState([]);
  // Batch progress for the mass import: 10 files at a time, counters that
  // survive across batches without a reload.
  const [cancelRef] = useState({ current: false });
  const [progress, setProgress] = useState(null); // { done, total }
  const [session, setSession] = useState({ files: 0, claims: 0, denials: 0 });
  const [batchNo, setBatchNo] = useState(1);
  const [capWarning, setCapWarning] = useState(null);
  // The raw parse blocks, one group per file. Component state rather than a
  // local, because parse() writes it and saveAll() reads it — as a `let` inside
  // parse() it was out of scope in saveAll and threw "rawBlocks is not defined".
  const [rawBlocks, setRawBlocks] = useState([]);
  // duplicate detection: per-file hash + match, and the OVERWRITE gate
  const [dupMatches, setDupMatches] = useState({});
  const [dupInBatch, setDupInBatch] = useState([]);
  const [overwriteQueue, setOverwriteQueue] = useState([]);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [overwriteText, setOverwriteText] = useState('');
  const dupCount = (queue ?? []).filter((f) => f.duplicate).length;
  // A ref, not state: parse() is re-invoked synchronously from the modal's
  // confirm handler, before a state update would have flushed.
  const overwriteOkRef = useRef(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [clients, setClients] = useState([]);
  const [details, setDetails] = useState(null);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState(null);
  const [caretakers, setCaretakers] = useState([]);

  const unmatched = useMemo(
    () => (rows ?? []).filter((r) => !r.client_id && r.action !== 'skip').length,
    [rows]
  );

  const precheckRows = useMemo(() => {
    const out = [];
    for (const row of rows ?? []) {
      const items = row.line_items?.length
        ? row.line_items
        : [
            {
              date: row.dos_start,
              procedure_code: '',
              billed: row.total_charge,
              paid: row.total_payment,
            },
          ];
      for (const [index, item] of items.entries()) {
        out.push({
          key: `${row.key}-${index}`,
          date: item.date ?? row.dos_start ?? '',
          client_name: row.client_name ?? '—',
          member_id: row.member_id ?? '—',
          charge: item.billed,
          paid: item.paid,
          code: item.procedure_code ?? '',
        });
        if (out.length >= 5) return out;
      }
    }
    return out;
  }, [rows]);

  const moneyOrDash = (value) =>
    value === null || value === undefined || value === '' ? '—' : formatMoney(Number(value));

  async function loadClients() {
    const d = await api.searchClients('', { includeInactive: true, limit: 200 });
    setClients(d.clients ?? []);
  }

  /** Inactive caretakers are included: a retired one may still have billed. */
  async function loadCaretakers() {
    const d = await api.caretakers({ active: '0' });
    setCaretakers(d.caretakers ?? []);
  }
  const enqueueFiles = useCallback((fileList) => {
    const all = Array.isArray(fileList) ? fileList : [...(fileList ?? [])];
    const picked = all.slice(0, MAX_BATCH);
    setCapWarning(
      all.length > MAX_BATCH
        ? `You selected ${all.length} files. Maximum is ${MAX_BATCH} per upload. Please upload in batches.`
        : null
    );
    setFile(picked[0] ?? null);
    const initial = picked.map((f, i) => ({
      key: `${f.name}-${f.size}-${i}`,
      name: f.name,
      file: f,
      status: 'hashing',
      error: null,
      hash: null,
      duplicate: null,
      choice: 'skip',
    }));
    setQueue(initial);
    setDupMatches({});
    setDupInBatch([]);
    (async () => {
      const hashes = [];
      const withHash = [];
      for (const item of initial) {
        try {
          const h = await fileHash(item.file);
          hashes.push(h);
          withHash.push({ ...item, hash: h });
        } catch {
          withHash.push({ ...item, status: 'ready' });
        }
      }
      try {
        const res = await api.checkDuplicates(hashes);
        const byHash = new Map((res.matches ?? []).map((m) => [m.hash, m]));
        setDupMatches(Object.fromEntries(byHash));
        setDupInBatch(res.duplicates_in_batch ?? []);
        setQueue((q) =>
          q.map((it) => {
            const h = it.hash ?? withHash.find((w) => w.key === it.key)?.hash ?? null;
            const m = byHash.get(h);
            return {
              ...it,
              hash: h,
              status: m ? 'duplicate-exact' : 'ready',
              duplicate: m ? { kind: 'exact', ...m, footprint: m.footprint ?? null, risks: m.risks ?? null } : null,
              choice: 'skip',
            };
          })
        );
      } catch {
        setQueue((q) => q.map((it) => ({ ...it, status: 'ready' })));
      }
    })();
    setRows(null);
    setResults([]);
    setError(null);
    setSummary(null);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.kind === 'ra' && e.detail?.file) enqueueFiles([e.detail.file]);
    };
    window.addEventListener('demo-sample-file', handler);
    return () => window.removeEventListener('demo-sample-file', handler);
  }, [enqueueFiles]);


  async function parse() {
    if (!queue.length) return;
    /*
     * A5 — an overwrite can destroy downstream activity, so ask first.
     *
     * Checked for EVERY overwrite-marked file before a single byte is parsed;
     * one modal per file that reports risk, shown in sequence.
     */
    const overwriteItems = queue.filter((f) => f.choice === 'overwrite' && f.duplicate?.ra_import_id);
    const risky = [];
    for (const item of overwriteItems) {
      try {
        const chk = await api.overwriteCheck(item.duplicate.ra_import_id);
        if (chk?.risks?.risky) risky.push({ item, chk });
      } catch {
        /* an unreachable check must not silently cancel an overwrite */
      }
    }
    if (risky.length && !overwriteOkRef.current) {
      setOverwriteQueue(risky);
      setOverwriteText('');
      setOverwriteOpen(true);
      return;
    }

    setParsing(true);
    setError(null);
    setNotice(null);
    setSummary(null);
    setRows(null);
    setCapWarning(null);
    cancelRef.current = false;

    setQueue((q) => q.map((f) => ({ ...f, status: 'pending', error: null })));
    await Promise.all([
      clients.length ? null : loadClients(),
      caretakers.length ? null : loadCaretakers(),
    ]);

    setProgress({ done: 0, total: queue.length });
    const collected = [];
    const log = [];
    // Declared out here so the summary below can report a partial batch.
    let batchMeta = { timed_out: false, processed: 0, file_count: queue.length };

    // The server parses the batch sequentially; here we drive the per-file
    // status so the list and the progress bar stay in step, and honour Cancel
    // between files — anything already parsed is kept.
    try {
      const batch = await api.parseRaBatch(queue.map((f) => f.file));
      setRawBlocks(batch.clients ?? []);
      batchMeta = {
        timed_out: Boolean(batch.timed_out),
        processed: batch.processed ?? queue.length,
        file_count: batch.file_count ?? queue.length,
      };
      const failedByName = new Map((batch.failed ?? []).map((f) => [f.filename, f.error]));
      for (const item of queue) {
        // A duplicate the user chose to skip is reported, never parsed.
        if (item.duplicate && item.choice !== 'overwrite') {
          log.push({ ...item, status: 'skipped' });
          setQueue((q) => q.map((f) => (f.key === item.key ? { ...f, status: 'skipped' } : f)));
          continue;
        }
        if (cancelRef.current) {
          log.push({ ...item, status: 'cancelled', error: 'Cancelled' });
          setQueue((q) => q.map((f) => (f.key === item.key ? { ...f, status: 'cancelled' } : f)));
          continue;
        }
        const err = failedByName.get(item.name);
        if (err) {
          log.push({ ...item, status: 'error', error: err });
          setQueue((q) => q.map((f) => (f.key === item.key ? { ...f, status: 'error', error: err } : f)));
        } else {
          const rowsForFile = (batch.clients ?? [])
            .filter((c) => (c.source_file ?? null) === item.name)
            .map((b) => toRow(b, item.name));
          collected.push(...rowsForFile);
          log.push({ ...item, status: 'ok', clients: rowsForFile.length });
          setQueue((q) => q.map((f) => (f.key === item.key ? { ...f, status: 'ok' } : f)));
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    } catch (e) {
      // A whole-request failure (too large, timeout) marks every file.
      for (const item of queue) {
        log.push({ ...item, status: 'error', error: e.message });
        setQueue((q) => q.map((f) => (f.key === item.key ? { ...f, status: 'error', error: e.message } : f)));
      }
      setError(e.message);
    }

    setResults(log);
    // No de-duplication: two advices may legitimately name the same client.
    setRows(collected);
    setFileName(log.filter((r) => r.status === 'ok').map((r) => r.name).join(', ') || null);

    const ok = log.filter((r) => r.status === 'ok').length;
    const cancelled = log.filter((r) => r.status === 'cancelled').length;
    setSession((v) => ({ ...v, files: v.files + ok }));
    setNotice(
      `${ok} of ${log.length} file${log.length === 1 ? '' : 's'} parsed successfully.` +
        (cancelled ? ` ${cancelled} cancelled.` : '') +
        (batchMeta.timed_out
          ? ` The server time limit was reached, so only ${batchMeta.processed} of ` +
            `${batchMeta.file_count} files were processed — re-run the batch for the rest.`
          : '') +
        ` ${collected.length} client row${collected.length === 1 ? '' : 's'} in total.`
    );
    setProgress(null);
    setParsing(false);
  }

  /** Stop after the file in flight; completed files keep their results. */
  function cancelBatch() {
    cancelRef.current = true;
  }

  /** Clear the review and reset the picker, ready for the next 10. */
  function nextBatch() {
    setQueue([]);
    setFile(null);
    setRows(null);
    setResults([]);
    setSummary(null);
    setNotice(null);
    setError(null);
    setCapWarning(null);
    setBatchNo((n) => n + 1);
    const input = document.getElementById('ra-file');
    if (input) input.value = '';
  }

  function setRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /**
   * Re-check for an earlier RA import whenever the client or the dates change.
   * A hand-made claim overlapping the period defaults the row to Skip — the
   * warning asks before anything proceeds.
   */
  async function refreshExisting(key, patch) {
    setRow(key, patch);
    const row = (rows ?? []).find((r) => r.key === key);
    const next = { ...row, ...patch };
    if (!next.client_id || !next.dos_start || !next.dos_end) {
      setRow(key, { existing_claim: null, manual_claim: null, ra_import_entries: 0 });
      return;
    }
    try {
      const d = await api.raExisting({
        client_id: Number(next.client_id),
        dos_start: next.dos_start,
        dos_end: next.dos_end,
      });
      const manual = d.manual_claim;
      const autoSkip = Boolean(manual) && (next.action === 'mark_paid' || next.autoSkipped);
      setRow(key, {
        existing_claim: d.existing_claim,
        manual_claim: manual,
        ra_import_entries: d.ra_import_entries ?? 0,
        resolution: d.existing_claim ? (next.resolution ?? 'skip') : 'skip',
        ...(autoSkip ? { action: 'skip', autoSkipped: true } : {}),
      });
    } catch (e) {
      setError(e.message);
    }
  }

  async function reMatch(row) {
    try {
      const d = await api.matchRa(row.client_name ?? '');
      await refreshExisting(row.key, { client_id: d.client?.id ?? '' });
    } catch (e) {
      setError(e.message);
    }
  }

  function setLineItem(rowKey, index, patch) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === rowKey
          ? { ...r, line_items: r.line_items.map((li, i) => (i === index ? { ...li, ...patch } : li)) }
          : r
      )
    );
    setDetails((prev) =>
      prev && prev.key === rowKey
        ? { ...prev, line_items: prev.line_items.map((li, i) => (i === index ? { ...li, ...patch } : li)) }
        : prev
    );
  }

  async function saveAll() {
    if (unmatched > 0) {
      setError('Every row needs a matched client before you can save. Rows in red are unresolved.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // BOTH of these must exist before the payload is built — the id has to
      // ride ON the payload, not be written to `rows` afterwards.
      const overwriteFor = new Map(
        queue
          .filter((f) => f.choice === 'overwrite' && f.duplicate?.ra_import_id)
          .map((f) => [f.name, f.duplicate.ra_import_id])
      );

      const payload = rows.map((r) => ({
        client_id: r.client_id ? Number(r.client_id) : null,
        client_name: r.client_name,
        member_id: r.member_id ?? null,
        // MUST ride the payload: the per-file overwrite id and the per-file
        // audit rows are both keyed on it, and it was being dropped here.
        source_file: r.source_file ?? null,
        action: r.action,
        dos_start: r.dos_start || null,
        dos_end: r.dos_end || null,
        total_charge: r.total_charge === '' ? null : Number(r.total_charge),
        total_payment: r.total_payment === '' ? null : Number(r.total_payment),
        rendered_provider_name: r.rendered_provider_name ?? null,
        rendered_provider_id: r.rendered_provider_id ?? null,
        // MUST ride the payload. Without it the server fell back to
        // `?? 'DENIED'` and stored every reversal as a denial — the parser and
        // classifyStatus were right all along; the input never arrived.
        claim_status: r.claim_status ?? null,
        paid: r.paid ?? null,
        resolution: r.resolution ?? 'skip',
        overwrite_import_id: overwriteFor.get(r.source_file ?? fileName) ?? null,
        line_items: r.line_items.map((li) => ({
          ...li,
          caretaker_id: li.caretaker_id === '' || li.caretaker_id == null ? null : Number(li.caretaker_id),
        })),
      }));
      /*
       * Per-file metadata.
       *
       * Without this the server's per-file recorder never ran on a normal
       * import, so the audit table stayed empty while the claims landed fine —
       * the two halves of the same operation were written by different paths.
       */
      // Declared BEFORE the loop that reads it: this was a temporal dead
      // zone error — the const sat 34 lines below its own use.
      // Derived from `queue` state, so it is recomputed on every Save All
      // and always reflects the current Skip/Overwrite radios.

      const byFile = new Map();
      for (const r of rows) {
        const name = r.source_file ?? fileName ?? 'unnamed.pdf';
        if (!byFile.has(name)) {
          const src = rawBlocks.find((b) => (b.source_file ?? null) === name) ?? {};
          byFile.set(name, {
            file_name: name,
            stored_path: src.stored_path ?? null,
            file_hash: src.file_hash ?? null,
            check_date: src.file_header?.check_date ?? null,
            prod_date: src.file_header?.prod_date ?? null,
            vendor_number: src.file_header?.vendor_number ?? null,
            check_eft_number: src.file_header?.check_eft_number ?? null,
            payment_amount: src.file_header?.payment_amount ?? null,
            forwarding_balance: src.file_header?.forwarding_balance ?? null,
            // tells the server this advice's text layer was columnar
            layout_unrecognised: Boolean(src.file_layout_unrecognised),
            layout_reason: src.file_layout_reason ?? null,
            claim_count: 0,
            denial_count: 0,
            client_count: 0,
          });
        }
        const f = byFile.get(name);
        if (r.action === 'save_denials' || r.paid === false) f.denial_count += 1;
        else if (r.action !== 'skip') f.claim_count += 1;
        f.client_count += 1;
      }
      const skipped = queue
        .filter((f) => f.duplicate && f.choice !== 'overwrite')
        .map((f) => f.name);
      const d = await api.saveRa(payload, fileName, {
        skip_filenames: skipped,
        files: [...byFile.values()],
        stored_path: [...byFile.values()][0]?.stored_path ?? null,
        file_hash: [...byFile.values()][0]?.file_hash ?? null,
        check_date: [...byFile.values()][0]?.check_date ?? null,
        check_eft_number: [...byFile.values()][0]?.check_eft_number ?? null,
        prod_date: [...byFile.values()][0]?.prod_date ?? null,
        vendor_number: [...byFile.values()][0]?.vendor_number ?? null,
      });
      setSummary(d.summary);
      setSession((v) => ({
        ...v,
        claims: v.claims + (d.summary?.created_claims ?? 0) + (d.summary?.updated_claims ?? 0),
        denials: v.denials + (d.summary?.denied_claims ?? 0),
      }));
      // The Home Dashboard's figures are derived from these entries, so tell
      // it (and anything else listening) that the data moved.
      window.dispatchEvent(new Event('data-updated'));
      setRows(null);
      setFileName(null);
      setFile(null);
      setNotice(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="ds-card" id="batch-progress" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span className="ds-badge ds-badge-gray" id="batch-number">Batch {batchNo}</span>
          <span className="ds-muted" id="session-counters">
            This session: <strong>{session.files}</strong> files uploaded,{' '}
            <strong>{session.claims}</strong> claims saved, <strong>{session.denials}</strong> denials
            recorded
          </span>
        </div>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="ds-muted" id="batch-progress-label">
              Parsing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </div>
            <div className="ds-bar-track" style={{ marginTop: 6, height: 8 }}>
              <span
                className="ds-bar-fill"
                style={{
                  width: `${Math.round((progress.done / progress.total) * 100)}%`,
                  background: 'var(--ds-green)',
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="page-head">
        <div>
          <h1>Import RA</h1>
          <p className="muted">
            Upload an MHCP Remittance Advice PDF. Nothing is written to the database until you
            press Save All.
          </p>
        </div>
      </div>

      {error && (
        <div className="alert error" id="import-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert ok" id="import-notice">
          {notice}
        </div>
      )}
      {summary && (
        <div className="alert ok" id="import-summary">
          Updated {summary.updated_claims} claims, created {summary.created_claims} claims, added{' '}
          {summary.added_entries} schedule entries, skipped {summary.skipped_entries} existing
          entries. Archived {summary.archived_claims ?? 0} old claims, overwrote{' '}
          {summary.overwritten_claims ?? 0}, skipped {summary.skipped_rows ?? 0}.
          {summary.warnings?.length > 0 && (
            <ul className="plain-list" style={{ margin: '8px 0 0' }}>
              {summary.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="card" id="ra-upload">
        <div className="card-head">
          <div>
            <h2>1. Choose the remittance advice</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              PDF only. One file can contain several clients.
            </p>
          </div>
        </div>
        <div className="card-body">
          {capWarning && (
            <div className="alert warn" id="ra-cap-warning">
              {capWarning}
            </div>
          )}
          {queue.length > 0 && (
            <ul className="file-list" id="ra-file-list">
              {/* A4 — duplicates summarised above the list */}
              {dupCount > 0 && (
                <li className="dup-banner" id="ra-dup-banner">
                  {dupCount} of {queue.length} files appear to be duplicates. {dupCount} will be
                  skipped unless you choose otherwise.
                </li>
              )}
              {dupInBatch.length > 0 && (
                <li className="dup-banner dup-banner-amber" id="ra-dup-inbatch">
                  Two selected files appear identical. Only the first will be processed.
                </li>
              )}
              {queue.map((f) => (
                <li key={f.key} className={`file-item file-${f.status}`} id={`ra-file-${f.key}`}>
                  <span className="file-name">{f.name}</span>
                  <span className="file-status" id={`ra-status-${f.key}`}>
                    {f.status === 'hashing' && <span className="muted small">Hashing…</span>}
                    {f.status === 'ready' && <span className="ds-badge ds-badge-green">Ready</span>}
                    {f.status === 'pending' && <span className="muted small">Pending</span>}
                    {f.status === 'duplicate-exact' && (
                      <span className="ds-badge ds-badge-red">Duplicate — Exact Match</span>
                    )}
                    {f.status === 'duplicate-batch' && (
                      <span className="ds-badge ds-badge-amber">Duplicate — Same Batch</span>
                    )}
                    {f.status === 'parsing' && (
                      <>
                        <span className="spinner" aria-hidden="true" />
                        <span className="muted small">Parsing…</span>
                      </>
                    )}
                    {f.status === 'ok' && <span className="ds-badge ds-badge-green">Done</span>}
                    {f.status === 'skipped' && (
                      <span className="ds-badge ds-badge-gray">Skipped (duplicate)</span>
                    )}
                    {f.status === 'error' && (
                      <span className="pill overdue tiny" title={f.error}>
                        Failed
                      </span>
                    )}
                  </span>

                  {/* A2 — what it collides with */}
                  {f.duplicate && (
                    <span className="dup-detail" id={`ra-dup-detail-${f.key}`}>
                      Matches: {f.duplicate.file_name}, imported{' '}
                      {String(f.duplicate.imported_at ?? '').slice(0, 10)}, {f.duplicate.claim_count}{' '}
                      claims, {f.duplicate.denial_count} denials.
                    </span>
                  )}

                  {/* A3 — Skip (default) or Overwrite */}
                  {f.duplicate && (
                    <span className="dup-choice" id={`ra-dup-choice-${f.key}`}>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${f.key}`}
                          id={`ra-skip-${f.key}`}
                          checked={f.choice !== 'overwrite'}
                          onChange={() =>
                            setQueue((q) => q.map((x) => (x.key === f.key ? { ...x, choice: 'skip' } : x)))
                          }
                        />
                        Skip this file
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${f.key}`}
                          id={`ra-overwrite-${f.key}`}
                          checked={f.choice === 'overwrite'}
                          onChange={() =>
                            setQueue((q) =>
                              q.map((x) => (x.key === f.key ? { ...x, choice: 'overwrite' } : x))
                            )
                          }
                        />
                        Overwrite previous import
                      </label>
                      {f.choice === 'overwrite' && (
                        <span className="alert warn dup-footprint" id={`ra-footprint-${f.key}`}>
                          Overwriting will permanently delete the{' '}
                          {f.duplicate.footprint?.claims ?? f.duplicate.claim_count} claims,{' '}
                          {f.duplicate.footprint?.day_entries ?? 0} day entries, and{' '}
                          {f.duplicate.footprint?.denials ?? f.duplicate.denial_count} denials created
                          by the previous import of this RA, then re-import fresh from this file. This
                          cannot be undone.
                        </span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="ra-upload-row">
            <input
              type="file"
              id="ra-file"
              name="ra-file"
              accept="application/pdf,.pdf"
              multiple
              onChange={(e) => enqueueFiles([...(e.target.files ?? [])])}
            />
            <button
              className="btn primary"
              id="ra-parse"
              onClick={parse}
              disabled={!queue.length || parsing}
            >
              {parsing
                ? 'Parsing…'
                : `Parse ${queue.length > 1 ? `${queue.length} PDFs` : 'PDF'}`}
            </button>
            {parsing && (
              <button className="btn" id="ra-cancel-batch" onClick={cancelBatch}>
                Cancel
              </button>
            )}
            {!parsing && rows && (
              <button className="btn" id="ra-next-batch" onClick={nextBatch}>
                Upload Next Batch
              </button>
            )}
            {parsing && <span className="spinner" id="ra-spinner" aria-label="Parsing" />}
          </div>
        </div>
      </section>

        {results.length > 1 && (
          <div className="alert warn" id="ra-file-summary">
            <strong>
              {results.filter((r) => r.status === 'ok').length} of {results.length} files parsed.
            </strong>
            {results.some((r) => r.status === 'error') && (
              <>
                {' '}
                Failed: {results.filter((r) => r.status === 'error').map((r) => r.name).join(', ')}
              </>
            )}
          </div>
        )}

      {rows && (
        <section className="card" id="ra-precheck">
          <div className="card-head">
            <div>
              <h2>Pre-Check Validation</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                First {precheckRows.length} extracted row{precheckRows.length === 1 ? '' : 's'}.
                Nothing is written until you confirm.
              </p>
            </div>
            <span className="pill ok">Pre-Check</span>
          </div>
          <div className="table-scroll">
            <table className="table" id="ra-precheck-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client Name</th>
                  <th>Member ID</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {precheckRows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date || '—'}</td>
                    <td>{row.client_name}</td>
                    <td className="mono">{row.member_id}</td>
                    <td className="num">{moneyOrDash(row.charge)}</td>
                    <td className="num">{moneyOrDash(row.paid)}</td>
                    <td className="mono">{row.code || '—'}</td>
                  </tr>
                ))}
                {!precheckRows.length && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No extracted rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="card-body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn primary"
              id="ra-precheck-confirm"
              onClick={saveAll}
              disabled={saving || unmatched > 0}
              title={unmatched > 0 ? 'Resolve every unmatched row first' : ''}
            >
              {saving ? 'Saving…' : 'Confirm & Save to Database'}
            </button>
          </div>
        </section>
      )}

      {rows && (
        <section className="card" id="ra-review">
          <div className="card-head">
            <div>
              <h2>2. Review before saving</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                Check the matched client and the amounts. Rows with no client are highlighted and
                must be resolved before saving.
              </p>
            </div>
            {unmatched > 0 && (
              <span className="pill overdue" id="ra-unmatched-count">
                {unmatched} row{unmatched === 1 ? '' : 's'} unresolved
              </span>
            )}
          </div>

          <div className="table-scroll">
            <table className="table ra-table">
              <thead>
                <tr>
                  <th>Source File</th>
                  <th>Status</th>
                  <th>Client Name (from PDF)</th>
                  <th>Matched Client</th>
                  <th>DOS Start</th>
                  <th>DOS End</th>
                  <th className="num">Total Charge</th>
                  <th className="num">Total Payment</th>
                  <th>Action</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .map((r) => {
                  const bad = !r.client_id && r.action !== 'skip';
                  return (
                    <tr key={r.key} className={bad ? 'row-unmatched' : ''} data-client={r.client_name}>
                      <td className="source-file" title={r.source_file ?? ''}>
                        {r.source_file ? r.source_file.replace(/\.pdf$/i, '') : '—'}
                      </td>
                      <td className="nowrap">
                        {r.denial ? (
                          <span
                            className={`pill tiny ${/REVERS/i.test(r.claim_status ?? '') ? 'warn' : 'overdue'}`}
                            id={`ra-status-${r.key}`}
                          >
                            {/REVERS/i.test(r.claim_status ?? '') ? 'REVERSED' : (r.claim_status ?? 'DENIED').toUpperCase()}
                          </span>
                        ) : (
                          <span className="pill ok tiny" id={`ra-status-${r.key}`}>PAID</span>
                        )}
                        {r.denial && (
                          <div className="muted small" id={`ra-denial-note-${r.key}`}>
                            This claim will be saved to the Denials archive, not to Claims.
                          </div>
                        )}
                      </td>
                      <td>
                        <strong>{r.client_name ?? '—'}</strong>
                        {r.merged_pages > 1 && (
                          <span className="pill muted tiny" title="Continued across a page break">
                            {r.merged_pages} pages
                          </span>
                        )}
                        <div className="sub mono">{r.claim_number ?? ''}</div>
                      </td>
                      <td>
                        <select
                          name={`match-${r.key}`}
                          aria-label={`Matched client for ${r.client_name}`}
                          value={r.client_id ?? ''}
                          onChange={(e) =>
                            refreshExisting(r.key, {
                              client_id: e.target.value ? Number(e.target.value) : '',
                              match_confidence: null,
                            })
                          }
                        >
                          <option value="">— select a client —</option>
                          {clients.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.last_name}, {c.first_name}
                            </option>
                          ))}
                        </select>
                        {r.client_id && r.match_confidence && (
                          <span
                            className={
                              r.match_confidence === 'strong'
                                ? 'pill ok tiny match-pill'
                                : 'pill overdue tiny match-pill'
                            }
                            id={`match-confidence-${r.key}`}
                            title={
                              r.match_confidence === 'strong'
                                ? 'Last name, first name and middle initial all agree'
                                : 'Matched, but the middle initial could not be confirmed'
                            }
                          >
                            {r.match_confidence === 'strong' ? 'Strong match' : 'Possible match'}
                          </span>
                        )}
                        {!r.client_id && r.action !== 'skip' && (
                          <button className="btn tiny" onClick={() => reMatch(r)}>
                            Re-match
                          </button>
                        )}
                      </td>
                      <td>
                        <input
                          type="date"
                          name={`dos-start-${r.key}`}
                          aria-label={`DOS start for ${r.client_name}`}
                          value={r.dos_start ?? ''}
                          onChange={(e) => refreshExisting(r.key, { dos_start: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          name={`dos-end-${r.key}`}
                          aria-label={`DOS end for ${r.client_name}`}
                          value={r.dos_end ?? ''}
                          onChange={(e) => refreshExisting(r.key, { dos_end: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          style={{ width: 100, textAlign: 'right' }}
                          name={`charge-${r.key}`}
                          aria-label={`Total charge for ${r.client_name}`}
                          value={r.total_charge ?? ''}
                          onChange={(e) => setRow(r.key, { total_charge: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          style={{ width: 100, textAlign: 'right' }}
                          name={`payment-${r.key}`}
                          aria-label={`Total payment for ${r.client_name}`}
                          value={r.total_payment ?? ''}
                          onChange={(e) => setRow(r.key, { total_payment: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          name={`action-${r.key}`}
                          aria-label={`Action for ${r.client_name}`}
                          value={r.action}
                          onChange={(e) =>
                            setRow(r.key, { action: e.target.value, autoSkipped: false })
                          }
                        >
                          {(r.denial
                            ? [
                                { value: 'save_denials', label: 'Save to Denials' },
                                { value: 'skip', label: 'Skip' },
                              ]
                            : ACTIONS
                          ).map((a) => (
                            <option key={a.value} value={a.value}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="row-actions">
                        <button className="btn tiny" onClick={() => setDetails(r)}>
                          View Details
                        </button>
                      </td>
                    </tr>
                    );
                  })
                  .flatMap((rowEl, i) => {
                    const r = rows[i];
                    const extras = [];
                    if (r.existing_claim) {
                      extras.push(
                        <tr className="row-duplicate" key={`${r.key}-dup`}>
                          <td colSpan={8}>
                            <div className="alert warn duplicate-banner" id={`existing-claim-${r.key}`}>
                              <div className="duplicate-line">
                                <span>
                                  ⚠ A previous RA import exists for this client/period (Claim:{' '}
                                  <strong>{r.existing_claim.claim_name}</strong>, Status:{' '}
                                  <strong>{r.existing_claim.status}</strong>). What would you like
                                  to do?
                                </span>
                                <select
                                  name={`resolution-${r.key}`}
                                  aria-label={`Resolution for ${r.client_name}`}
                                  value={r.resolution ?? 'skip'}
                                  onChange={(e) => setRow(r.key, { resolution: e.target.value })}
                                >
                                  <option value="skip">Skip — keep existing claim</option>
                                  <option value="overwrite">
                                    Overwrite — replace existing claim and schedule entries
                                  </option>
                                  <option value="archive_old">
                                    Archive old — keep the old claim archived, create new one
                                  </option>
                                </select>
                              </div>
                              {r.ra_import_entries > 0 && (
                                <div className="muted small">
                                  {r.ra_import_entries} existing RA schedule entr
                                  {r.ra_import_entries === 1 ? 'y' : 'ies'} fall in this period.
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    if (r.manual_claim) {
                      extras.push(
                        <tr className="row-manual-claim" key={`${r.key}-manual`}>
                          <td colSpan={8}>
                            <div className="alert warn duplicate-banner" id={`manual-claim-${r.key}`}>
                              A manually-created claim exists for this period (
                              <strong>{r.manual_claim.claim_name}</strong>). It will not be
                              overwritten. Do you want to proceed?
                              {r.action === 'skip' && (
                                <span className="muted small">
                                  {' '}
                                  This row is set to Skip until you choose otherwise.
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return extras.length ? [rowEl, ...extras] : [rowEl];
                  })}
              </tbody>
            </table>
          </div>

          <div className="card-body ra-actions">
            <button
              className="btn primary"
              id="ra-save-all"
              onClick={saveAll}
              disabled={saving || unmatched > 0}
              title={unmatched > 0 ? 'Resolve every unmatched row first' : ''}
            >
              {saving ? 'Saving…' : 'Save All'}
            </button>
            <button
              className="btn"
              id="ra-cancel"
              disabled={saving}
              onClick={() => {
                setRows(null);
                setFile(null);
                setNotice(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            {unmatched > 0 && (
              <span className="muted small">
                {unmatched} row{unmatched === 1 ? '' : 's'} still need a client.
              </span>
            )}
          </div>
        </section>
      )}

      {details && (
        <Modal
          title={`Line items — ${details.client_name ?? 'unnamed'}`}
          subtitle={details.claim_number ?? undefined}
          onClose={() => setDetails(null)}
          width={840}
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            Rendering provider: <strong>{details.rendered_provider_name ?? '—'}</strong>
            {' · NPI '}
            <span className="mono">{details.rendered_provider_id ?? '—'}</span>
            {details.rendered_provider_id &&
              (details.npi_match_id ? (
                <span className="pill ok tiny"> matched</span>
              ) : (
                <span className="pill overdue tiny" id="npi-unmatched">
                  no caretaker with this NPI
                </span>
              ))}
          </p>
          <div className="table-scroll">
            <table className="table" id="ra-details-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Procedure Code</th>
                  <th className="num">Units</th>
                  <th className="num">Minutes Worked</th>
                  <th className="num">Hours Worked</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th>Caretaker</th>
                </tr>
              </thead>
              <tbody>
                {details.line_items.map((li, i) => (
                  <tr key={i}>
                    <td>{li.date ?? '—'}</td>
                    <td className="mono">{li.procedure_code ?? '—'}</td>
                    <td className="num">{li.units ?? '—'}</td>
                    <td className="num">{li.minutes_worked ?? '—'}</td>
                    <td className="num">{li.hours_worked ?? '—'}</td>
                    <td className="num dollars">{li.billed == null ? '—' : formatMoney(li.billed)}</td>
                    <td className="num dollars">{li.paid == null ? '—' : formatMoney(li.paid)}</td>
                    <td>
                      <select
                        name={`line-caretaker-${i}`}
                        aria-label={`Caretaker for ${li.date}`}
                        value={li.caretaker_id ?? ''}
                        onChange={(e) =>
                          setLineItem(details.key, i, {
                            caretaker_id: e.target.value === '' ? '' : Number(e.target.value),
                          })
                        }
                      >
                        <option value="">— unassigned —</option>
                        {caretakers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.last_name}, {t.first_name}
                            {t.active ? '' : ' (inactive)'}
                          </option>
                        ))}
                      </select>
                      {li.caretaker_id === details.npi_match_id && details.npi_match_id !== '' && (
                        <span className="sub muted">from NPI</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!details.line_items.length && (
                  <tr>
                    <td colSpan={8} className="empty">
                      No line items were found for this client.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setDetails(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
      {/* A5 — downstream-activity gate for an overwrite */}
      {overwriteOpen && overwriteQueue.length > 0 && (
        <Modal
          title="Overwrite With Downstream Activity?"
          onClose={() => { setOverwriteOpen(false); setOverwriteQueue([]); }}
          width={620}
        >
          {(() => {
            const { item, chk } = overwriteQueue[0];
            return (
              <>
                <p id="overwrite-file"><strong>File:</strong> {item.name}</p>
                <p><strong>WARNING: This import has downstream data:</strong></p>
                <ul className="ds-confirm-list" id="overwrite-risks">
                  <li>{chk.risks.paid_claims} claims marked Paid</li>
                  <li>{chk.risks.recovered_denials} denials partially recovered</li>
                  <li>{chk.risks.edited_entries} day entries edited manually</li>
                </ul>
                <div className="ds-confirm-reassure">
                  Overwriting will delete this data and may cause inconsistencies in reports, the
                  Denials archive, or reconciliation history.
                </div>
                <label className="delete-type">
                  Type OVERWRITE to confirm:
                  <input
                    type="text" id="overwrite-input" autoComplete="off" spellCheck={false}
                    placeholder="OVERWRITE" value={overwriteText}
                    onChange={(e) => setOverwriteText(e.target.value)}
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="btn" id="overwrite-cancel"
                    onClick={() => { setOverwriteOpen(false); setOverwriteQueue([]); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn danger" id="overwrite-confirm"
                    disabled={overwriteText !== 'OVERWRITE'}
                    onClick={() => {
                      const rest = overwriteQueue.slice(1);
                      setOverwriteText('');
                      if (rest.length) setOverwriteQueue(rest);
                      else {
                        setOverwriteOpen(false);
                        setOverwriteQueue([]);
                        overwriteOkRef.current = true;
                        // confirmed: run the parse that was held back
                        parse();
                      }
                    }}
                  >
                    Overwrite Anyway
                  </button>
                </div>
              </>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}
