import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';
import { MODES, PRESETS, getStored, setTheme, resolveHex, getContrastColor } from '../theme.js';
import { clearToken } from '../api.js';
import { download, renderTemplate, SAMPLE_PARTS } from '../download.js';
import Modal from '../components/Modal.jsx';
import { SkeletonCards } from '../components/Skeleton.jsx';
import { formatLongDate, formatMoney } from '../calc.js';

/**
 * The cleanup preview has had two server shapes (`items` and `imports`).
 * Normalise once so the render never dereferences a missing array.
 */
function shapeCleanup(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const imports = Array.isArray(payload.imports)
    ? payload.imports
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  return { ...payload, imports };
}

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [template, setTemplate] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const [orphans, setOrphans] = useState(null); // { entries, count, totals }
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanTyped, setOrphanTyped] = useState('');
  const [orphanSummary, setOrphanSummary] = useState(null);
  const [notice, setNotice] = useState(null);
  const [agency, setAgency] = useState({});
  const [agencyBusy, setAgencyBusy] = useState(false);
  const [audit, setAudit] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [raStorage, setRaStorage] = useState(null);
  const [cleanup, setCleanup] = useState(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupText, setCleanupText] = useState('');
  // bulk selection + the two confirmation flows
  const [auditSel, setAuditSel] = useState([]);
  const [bulkModal, setBulkModal] = useState(null); // { ids, preview, mode }
  // IMPORT ids (ra_imports.id) driving the modal — deliberately separate from
  // auditSel, which holds audit-ROW ids (ra_import_files.id) for the checkboxes.
  const [pendingDeleteIds, setPendingDeleteIds] = useState([]);
  const [confirmText, setConfirmText] = useState('');
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getSettings();
      const s = d?.settings ?? {};
      setSettings(s);
      setTokens(d?.template_tokens ?? []);
      setTemplate(s.claim_name_template ?? '');
      setAgency({
        agency_name: s.agency_name ?? '',
        agency_street_address: s.agency_street_address ?? '',
        agency_city: s.agency_city ?? '',
        agency_state: s.agency_state ?? '',
        agency_zip: s.agency_zip ?? '',
      });
      setError(null);
      api.raAudit().then(setAudit).catch(() => {});
      api.raCleanupPreview().then((p) => setCleanup(shapeCleanup(p))).catch(() => {});
      api.raStorage().then(setRaStorage).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function note(message) {
    setFlash(message);
    setTimeout(() => setFlash(null), 3000);
  }

  const preview = useMemo(() => renderTemplate(template, SAMPLE_PARTS), [template]);
  const dirty = settings && template !== settings.claim_name_template;

  async function saveTemplate() {
    setTemplateError(null);
    setSavingTemplate(true);
    try {
      const d = await api.updateSettings({ claim_name_template: template });
      const saved = d?.settings ?? {};
      setSettings(saved);
      setTemplate(saved.claim_name_template ?? template);
      note('Naming template saved');
    } catch (e) {
      setTemplateError(e.message);
    } finally {
      setSavingTemplate(false);
    }
  }

  function startBackup() {
    setBackingUp(true);
    download(api.backupUrl());
    setTimeout(() => setBackingUp(false), 2500);
  }

  async function saveAgency() {
    setAgencyBusy(true);
    try {
      const d = await api.updateSettings({
        agency_name: agency.agency_name ?? '',
        agency_street_address: agency.agency_street_address ?? '',
        agency_city: agency.agency_city ?? '',
        agency_state: agency.agency_state ?? '',
        agency_zip: agency.agency_zip ?? '',
      });
      setSettings(d?.settings ?? {});
      setNotice('Agency information saved');
      setTimeout(() => setNotice(null), 2600);
    } catch (e) {
      setError(e.message);
    } finally {
      setAgencyBusy(false);
    }
  }

  /* ------------------------------------------------ RA import audit */

  async function loadAudit() {
    setAuditBusy(true);
    try {
      setAudit(await api.raAudit());
      setRaStorage(await api.raStorage());
    } catch (e) {
      setError(e.message);
    } finally {
      setAuditBusy(false);
    }
  }

  const [diag, setDiag] = useState(null);
  const [diagFile, setDiagFile] = useState(null);
  const [ignoredOpen, setIgnoredOpen] = useState(false);

  // ONE selection pool: audit-ROW ids (ra_import_files.id), live or empty.
  const auditIds = (audit?.files ?? []).map((f) => f.id);
  const allSelected = auditIds.length > 0 && auditIds.every((id) => auditSel.includes(id));

  function toggleAudit(id) {
    setAuditSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  /**
   * Open the shared confirmation modal.
   *
   * mode 'purge'  — one or more live rows; requires typing DELETE
   * mode 'all'    — the Danger Zone; requires typing DELETE ALL
   * mode 'orphan' — an empty record; nothing at risk, so no typing
   */
  async function openBulkModal(ids, mode = 'purge', fileName) {
    setConfirmText('');
    if (!ids.length) {
      setError(mode === 'orphan' ? 'That record is already gone.' : 'Nothing is selected.');
      return;
    }
    setPendingDeleteIds(ids);
    const requireText = mode === 'orphan' ? '' : mode === 'all' ? 'DELETE ALL' : 'DELETE';
    if (mode === 'orphan') {
      // Nothing is at risk, so no counts and no preview round-trip.
      setBulkModal({ ids, preview: null, mode, fileName, requireText });
      return;
    }
    try {
      const preview = await api.raPreviewDeleteFileRows(ids);
      setBulkModal({ ids, preview, mode, fileName, requireText });
    } catch (e) {
      setError(e.message);
    }
  }

  async function confirmModal() {
    const m = bulkModal;
    if (!m) return;
    setAuditBusy(true);
    try {
      if (m.mode === 'orphan') {
        await api.raDeleteFileRow(m.ids[0]);
        setBulkModal(null);
        setConfirmText('');
        await loadAudit();
        window.dispatchEvent(new Event('data-updated'));
        setNotice('Deleted the empty import record. No claims were touched.');
        return;
      }
      // m.ids is already the import-id list captured when the modal opened.
      const r = await api.raDeleteFileRows(m.ids, 'DELETE');
      setBulkModal(null);
      setConfirmText('');
      setAuditSel([]);
      await loadAudit();
      window.dispatchEvent(new Event('data-updated'));
      setNotice(`Deleted ${r.deleted_imports} imports, ${r.claims} claims, ${r.day_entries} day entries.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setAuditBusy(false);
    }
  }

  async function loadCleanup() {
    try {
      setCleanup(shapeCleanup(await api.raCleanupPreview()));
    } catch (e) {
      setError(e.message);
    }
  }

  async function viewDetail(file) {
    setDiagFile(file);
    setDiag({ loading: true });
    try {
      setDiag(await api.raDiagnostic(file.id));
    } catch (e) {
      setDiag({ error: e.message });
    }
  }

  /**
   * Re-parse from the STORED PDF. The old data is purged and the new rows
   * written inside one transaction by /save, so a failure changes nothing.
   */
  async function reparse(file, confirmed) {
    setAuditBusy(true);
    try {
      const r = await api.raReparse(file.id, confirmed);
      const rows = (r.clients ?? []).map((c) => ({
        client_id: c.suggested_client?.id ?? '',
        action: c.paid === false ? 'save_denials' : 'create_claim',
        resolution: 'skip',
        overwrite_import_id: r.import_id,
        claim_number: c.claim_number,
        claim_status: c.claim_status,
        paid: c.paid,
        dos_start: c.dos_start,
        dos_end: c.dos_end,
        total_payment: c.total_payment,
        rendered_provider_id: c.rendered_provider_id,
        line_items: c.line_items,
      }));
      const usable = rows.filter((x) => x.client_id || x.action === 'save_denials');
      if (!usable.length) {
        setError('None of the claims in that file could be matched to a client.');
        return;
      }
      const saved = await api.saveRa(usable, file.file_name, {
        file_hash: r.file_hash,
        check_eft_number: r.header?.check_eft_number,
        check_date: r.header?.check_date,
        prod_date: r.header?.prod_date,
        vendor_number: r.header?.vendor_number,
        files: [{
          file_name: file.file_name,
          stored_path: r.stored_path,
          file_hash: r.file_hash,
          check_date: r.header?.check_date,
          prod_date: r.header?.prod_date,
          vendor_number: r.header?.vendor_number,
          check_eft_number: r.header?.check_eft_number,
          payment_amount: r.header?.payment_amount,
          forwarding_balance: r.header?.forwarding_balance,
          // the paids become claims, the rest become denials
          claim_count: usable.filter((x) => x.action !== 'save_denials').length,
          denial_count: usable.filter((x) => x.action === 'save_denials').length,
          client_count: r.client_count,
        }],
      });
      setNotice(
        `Re-parsed ${file.file_name}: purged ${saved.summary.purged_claims} claims and ` +
          `${saved.summary.purged_day_entries} entries, imported ` +
          `${saved.summary.created_claims + saved.summary.updated_claims} fresh.`
      );
      window.dispatchEvent(new Event('data-updated'));
      await loadAudit();
    } catch (e) {
      if (e.needs_upload) {
        setError('Original file not stored. Please re-upload manually.');
      } else if (e.needs_confirmation || /downstream activity/i.test(e.message)) {
        const ok = window.confirm(
          `"${file.file_name}" has downstream activity that will be destroyed:\n\n` +
            `  • ${e.touched?.paid_claims ?? 0} claims marked Paid\n` +
            `  • ${e.touched?.recovered_denials ?? 0} denials partially recovered\n` +
            `  • ${e.touched?.edited_entries ?? 0} day entries edited manually\n\n` +
            `Overwrite anyway?`
        );
        if (ok) await reparse(file, true);
      } else {
        setError(e.message);
      }
    } finally {
      setAuditBusy(false);
    }
  }

  async function findOrphans() {
    setOrphanBusy(true);
    setOrphanSummary(null);
    try {
      setOrphans(await api.orphanedEntries());
    } catch (e) {
      setError(e.message);
    } finally {
      setOrphanBusy(false);
    }
  }

  async function cleanOrphans() {
    setOrphanBusy(true);
    try {
      const r = await api.cleanupOrphans(orphanTyped);
      setOrphanSummary(r);
      setOrphanTyped('');
      setOrphans(await api.orphanedEntries());
      setNotice(`Deleted ${r.deleted} orphaned entries. Preserved ${r.preserved} valid entries.`);
      // the dashboard reads these entries, so tell it they moved
      window.dispatchEvent(new Event('data-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setOrphanBusy(false);
    }
  }


  return (
    <div className="page" id="settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Backups, claim naming and payers.</p>
        </div>
        {flash && <span className="pill ok">{flash}</span>}
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* ------------------------------------------------ app settings */}
      {settings && (
        <AppSettingsCard
          settings={settings}
          onSaved={async (saved) => {
            setSettings((prev) => ({ ...prev, ...saved }));
            note('App settings saved');
          }}
          onError={setError}
        />
      )}

      {settings && <AppearanceCard settings={settings} />}

      {settings && (
        <AiConfigCard
          settings={settings}
          onSaved={async (saved) => {
            setSettings((prev) => ({ ...prev, ...saved }));
            note('AI settings saved');
            toast.success('AI settings saved');
          }}
          onError={(m) => {
            setError(m);
            toast.error(m);
          }}
        />
      )}

      <AccountSecurityCard />

      {/* -------------------------------------------- HHAeXchange export */}
      <HhaExportsCard onError={setError} />

      {/* ------------------------------------------------------- backup */}
      <section className="card" id="backup">
        <div className="card-head">
          <div>
            <h2>Backup data</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              A single zip with the database and every stored PDF.
            </p>
          </div>
          <button className="btn primary" onClick={startBackup} disabled={backingUp}>
            {backingUp ? 'Preparing…' : 'Backup Data'}
          </button>
        </div>
        <div className="card-body">
          <ul className="plain-list">
            <li>
              <span className="mono">billing.db</span> — a consistent snapshot taken with SQLite's
              backup API, so recent entries are included even if they are still in the write-ahead
              log.
            </li>
            <li>
              <span className="mono">claims/</span> — every claim PDF, generated and uploaded.
            </li>
            <li>
              <span className="mono">backup-info.json</span> — record counts and restore notes.
            </li>
          </ul>
          <p className="muted small" style={{ margin: 0 }}>
            Downloads as <span className="mono">billing_backup_YYYY-MM-DD.zip</span>. Restore by
            stopping the app, replacing <span className="mono">data/billing.db</span>, and unzipping{' '}
            <span className="mono">claims/</span> back into <span className="mono">data/claims/</span>.
          </p>
        </div>
      </section>

      {/* --------------------------------------------- naming template */}
      <section className="card" id="naming">
        <div className="card-head">
          <div>
            <h2>Claim naming template</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Used for every new claim name and its PDF filename.
            </p>
          </div>
          <button className="btn primary" onClick={saveTemplate} disabled={!dirty || savingTemplate}>
            {savingTemplate ? 'Saving…' : 'Save template'}
          </button>
        </div>
        <div className="card-body">
          <label>
            Template
            <input
              name="claim_name_template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              spellCheck={false}
              className="mono"
            />
          </label>

          <div className="claim-preview" style={{ marginTop: 12 }}>
            <span className="meta-label">Example</span>
            <div className="claim-name-preview mono">{preview || '—'}</div>
          </div>

          <div className="token-list">
            <span className="meta-label">Available tokens</span>
            <div className="token-chips">
              {tokens.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  className="token-chip"
                  title={t.description}
                  onClick={() => setTemplate((v) => `${v}${t.token}`)}
                >
                  <span className="mono">{t.token}</span>
                  <span className="muted"> {t.description}</span>
                </button>
              ))}
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Click a token to append it. Unknown tokens are rejected, so a name can never contain a
              stray <span className="mono">{'{...}'}</span>.
            </p>
          </div>

          {templateError && <div className="alert error">{templateError}</div>}
        </div>
      </section>


      {/* ---------------------------------------------- data maintenance */}
      <section className="card" id="data-maintenance">
        <div className="card-head">
          <div>
            <h2>Data Maintenance</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Finds day entries that can no longer be reached through a valid, active client: a
              missing client, an archived client, or a claim that no longer exists.
            </p>
          </div>
          <div className="head-actions">
            <button className="btn" id="find-orphans" onClick={findOrphans} disabled={orphanBusy}>
              {orphanBusy ? 'Working…' : 'Find Orphaned Entries'}
            </button>
          </div>
        </div>

        {(notice || orphanSummary) && (
          <div className="alert ok" id="orphan-notice">
            {notice ??
              `Deleted ${orphanSummary.deleted} orphaned entries. Preserved ${orphanSummary.preserved} valid entries.`}
          </div>
        )}

        {orphans && (
          <>
            <p id="orphan-summary">
              <strong>{orphans.count}</strong> orphaned day {orphans.count === 1 ? 'entry' : 'entries'}
              {orphans.count > 0 && (
                <>
                  {' '}
                  — {orphans.totals.hours.toFixed(1)} hrs, {formatMoney(orphans.totals.dollars)}
                </>
              )}
              .
            </p>

            {orphans.count === 0 ? (
              <p className="empty" id="orphan-none">
                Nothing to clean up. Every day entry belongs to a valid, active client.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="table" id="orphan-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Client</th>
                      <th className="num">Hours</th>
                      <th className="num">Billed</th>
                      <th>Source</th>
                      <th>Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orphans.entries.map((e) => (
                      <tr key={e.id} id={`orphan-row-${e.id}`}>
                        <td className="nowrap">{formatLongDate(e.work_date)}</td>
                        <td>
                          {e.client_exists
                            ? `${e.last_name}, ${e.first_name}`
                            : `missing client #${e.client_id}`}
                          {e.client_exists && e.client_archived && (
                            <span className="pill archived tiny"> archived</span>
                          )}
                        </td>
                        <td className="num">{((e.minutes_worked || 0) / 60).toFixed(1)} hrs</td>
                        <td className="num dollars">{formatMoney(e.dollars)}</td>
                        <td>{e.source}</td>
                        <td className="orphan-problems">
                          {e.problems.map((pr) => (
                            <span className="pill overdue tiny" key={pr}>
                              {pr}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {orphans.count > 0 && (
              <div className="danger-zone" id="orphan-cleanup">
                <div className="danger-head">
                  <div>
                    <h3>Clean up orphaned entries</h3>
                    <p className="muted small" style={{ margin: '2px 0 0' }}>
                      Permanently deletes the {orphans.count} entr
                      {orphans.count === 1 ? 'y' : 'ies'} listed above. Anything whose client exists
                      and is not archived is preserved. This cannot be undone — consider taking a
                      backup first.
                    </p>
                  </div>
                </div>
                <label className="delete-type">
                  Type DELETE to confirm:
                  <input
                    type="text"
                    id="orphan-confirm-input"
                    name="orphan-confirm-input"
                    value={orphanTyped}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="DELETE"
                    onChange={(ev) => setOrphanTyped(ev.target.value)}
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="btn danger"
                    id="clean-orphans"
                    onClick={cleanOrphans}
                    disabled={orphanTyped !== 'DELETE' || orphanBusy}
                    title={orphanTyped === 'DELETE' ? '' : 'Type DELETE to enable'}
                  >
                    {orphanBusy ? 'Deleting…' : 'Clean Up Orphaned Entries'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {/* ------------------------------ clean up unparseable imports */}
        <div id="cleanup-unparseable" style={{ marginTop: 20 }}>
          <h3 className="ds-section" style={{ marginBottom: 8 }}>Clean Up Unparseable Imports</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Advices whose text layer is columnar produce header money but no service lines. Their
            phantom denials are safe to remove; the claims themselves are real revenue and are only
            flagged. <strong>Dry run only — nothing is deleted.</strong>
          </p>

          {!cleanup ? (
            <button className="btn" id="cleanup-preview" onClick={loadCleanup}>Preview Cleanup</button>
          ) : !(cleanup.imports ?? []).length ? (
            <div className="ds-empty" id="cleanup-empty">
              <span className="ds-empty-icon">✓</span>
              <div className="ds-empty-head">No unparseable imports</div>
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table className="ds-table" id="cleanup-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th className="ds-num">Phantom denials</th>
                      <th className="ds-num">Line items</th>
                      <th className="ds-num">Rebill tasks</th>
                      <th className="ds-num">Claims to flag (kept)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(cleanup.imports ?? []).map((i) => (
                      <tr key={i.ra_import_id} id={`cleanup-row-${i.ra_import_id}`}>
                        <td title={i.file_name}>{(i.file_name ?? '').slice(0, 60) || `import #${i.ra_import_id}`}</td>
                        <td className="ds-num">{i.denials}</td>
                        <td className="ds-num">{i.line_items}</td>
                        <td className="ds-num">{i.rebill_tasks}</td>
                        <td className="ds-num">{i.claims_to_flag}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ds-muted" id="cleanup-totals" style={{ marginTop: 8 }}>
                Would delete {cleanup.totals.denials} denials, {cleanup.totals.line_items} line items,{' '}
                {cleanup.totals.rebill_tasks} tasks. Would flag {cleanup.totals.claims_to_flag} claims.
              </p>
              <div className="form-actions" style={{ marginTop: 8 }}>
                <button className="btn" id="cleanup-refresh" onClick={loadCleanup}>Preview Cleanup</button>
                <button
                  className="btn danger"
                  id="cleanup-run"
                  disabled={cleanup.totals.denials === 0}
                  onClick={() => { setCleanupText(''); setCleanupOpen(true); }}
                >
                  Run Cleanup
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* --------------------------------------------- RA import audit */}
      <section className="card" id="ra-audit">
        <div className="card-head">
          <div>
            <h2>RA Import Audit</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              One row per RA file, earliest check date first. A file with no claims is shown in red
              — that is the signal the parser found nothing.
            </p>
          </div>
          <div className="head-actions">
            {raStorage && (
              <span className="muted small" id="ra-storage-stat">
                RA storage used: <strong>{raStorage.megabytes} MB</strong> across{' '}
                <strong>{raStorage.files}</strong> file{raStorage.files === 1 ? '' : 's'}
              </span>
            )}
            <button className="btn" id="audit-refresh" onClick={loadAudit} disabled={auditBusy}>
              {auditBusy ? 'Working…' : 'Refresh'}
            </button>
          </div>
        </div>

        {!audit ? (
          <div className="ds-skeleton">
            {[0, 1, 2].map((i) => (
              <div key={i} className="ds-skeleton-row" style={{ width: `${88 - i * 10}%` }} />
            ))}
          </div>
        ) : !audit.files.length ? (
          <div className="ds-empty" id="audit-empty">
            <span className="ds-empty-icon">🗂</span>
            <div className="ds-empty-head">No RA imports recorded yet</div>
          </div>
        ) : (
          <>
            <p className="muted small" id="audit-totals">
              {audit.totals.files} file{audit.totals.files === 1 ? '' : 's'} ·{' '}
              {audit.totals.claims} claims on file
              {audit.totals.orphaned ? (
                <strong className="ds-red" id="audit-orphan-total">
                  {' '}· {audit.totals.orphaned} orphaned (claims deleted since import)
                </strong>
              ) : (
                <> · {audit.totals.empty} produced nothing</>
              )}
              {audit.totals.unknown ? ` · ${audit.totals.unknown} with unknown counts` : ''}
            </p>
            <div className="table-scroll">
              <table className="table" id="audit-table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        className="day-check"
                        id="audit-select-all"
                        checked={allSelected}
                        onChange={() => setAuditSel(allSelected ? [] : auditIds)}
                      />
                    </th>
                    <th>File Name</th>
                    <th>Check Date</th>
                    <th>Last updated</th>
                    <th className="num">Claims</th>
                    <th className="num">Denials</th>
                    <th className="num">Check Amount</th>
                    <th>File stored?</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.files.map((f) => {
                    const orphaned = f.orphaned;
                    const failed =
                      !orphaned && f.counts_known && f.claim_count === 0 && f.denial_count === 0;
                    return (
                      <tr
                        key={f.id}
                        id={`audit-row-${f.id}`}
                        className={`row-clickable ${failed ? 'row-unmatched' : orphaned ? 'row-inactive' : ''}`}
                        onClick={(e) => {
                          if (e.target.closest('button, input, a, td.actions-cell')) return;
                          toggleAudit(f.id);
                        }}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="day-check"
                            name={`audit-select-${f.id}`}
                            checked={auditSel.includes(f.id)}
                            onChange={() => toggleAudit(f.id)}
                          />
                        </td>
                        <td title={f.file_name}>
                          {failed && (
                            <span className="ds-badge ds-badge-red" style={{ marginRight: 6 }}>
                              ⚠
                            </span>
                          )}
                          {f.file_name}
                          {f.layout_unrecognised && (
                            <span
                              className="ds-badge ds-badge-red"
                              id={`layout-badge-${f.id}`}
                              title="This advice's text layer is columnar, so its service lines could not be read."
                              style={{ marginLeft: 6 }}
                            >
                              Unparseable layout
                            </span>
                          )}
                          {orphaned && (
                            <span className="ds-badge ds-badge-gray" id={`orphan-badge-${f.id}`} style={{ marginLeft: 6 }}>
                              No claims on file
                            </span>
                          )}
                          {f.layout_unrecognised && f.denial_count > 0 && (
                            <span
                              className="muted small"
                              id={`layout-skipped-${f.id}`}
                              style={{ display: 'block', marginTop: 2 }}
                            >
                              {f.denial_count} unpaid block{f.denial_count === 1 ? '' : 's'} skipped
                            </span>
                          )}
                        </td>
                        <td className="nowrap">
                          {f.check_date ? (
                            f.check_date
                          ) : (
                            <>
                              {f.fallback_date}{' '}
                              <span className="ds-badge ds-badge-amber" id={`no-check-date-${f.id}`}>
                                no CHK/EFT DT
                              </span>
                            </>
                          )}
                        </td>
                        <td className="nowrap" title={f.updated_at ?? ''}>
                          {String(f.updated_at ?? '—').slice(0, 16)}
                        </td>
                        <td className="num">
                          {f.counts_known ? f.claim_count : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {f.layout_unrecognised ? (
                            <span className="muted" id={`denials-skipped-${f.id}`}>— skipped</span>
                          ) : f.counts_known ? (
                            f.denial_count
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num dollars">
                          {f.payment_amount == null ? <span className="muted">—</span> : formatMoney(f.payment_amount)}
                        </td>
                        <td className="nowrap">
                          {f.file_on_disk ? (
                            <span className="ds-badge ds-badge-green" id={`stored-ok-${f.id}`}>✓ on disk</span>
                          ) : (
                            <span
                              className="ds-badge ds-badge-red"
                              id={`stored-missing-${f.id}`}
                              title="Original file not stored. Re-upload manually."
                            >
                              ✕ missing
                            </span>
                          )}
                        </td>
                        <td className="nowrap actions-cell">
                          <button className="btn tiny ghost" id={`audit-detail-${f.id}`} onClick={() => viewDetail(f)}>
                            View Parse Detail
                          </button>{' '}
                          <button
                            className="btn tiny danger"
                            id={`audit-delete-${f.id}`}
                            disabled={auditBusy}
                            title={
                              orphaned
                                ? 'This row has no claims to delete'
                                : 'Deletes this import and everything it created'
                            }
                            onClick={() =>
                              // ONE id space and ONE path: this row's audit id.
                              // An empty row is just a row with nothing to purge.
                              openBulkModal([f.id], 'purge', f.file_name)
                            }
                          >
                            Delete
                          </button>{' '}
                          <button
                            className="btn tiny"
                            id={`audit-reparse-${f.id}`}
                            disabled={auditBusy || !f.file_on_disk}
                            title={
                              f.file_on_disk
                                ? 'Re-parse from the stored PDF'
                                : 'Original file not stored. Re-upload manually.'
                            }
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Re-parse "${f.file_name}"?\n\n` +
                                    `This deletes the claims, day entries and denials this file ` +
                                    `created and re-imports it from the stored PDF. ` +
                                    `Manual records are never touched.`
                                )
                              ) {
                                reparse(f, false);
                              }
                            }}
                          >
                            Re-parse
                          </button>{' '}
                          {f.file_on_disk && (
                            <a
                              className="btn tiny ghost"
                              id={`audit-download-${f.id}`}
                              href={api.raFilePdfUrl(f.id)}
                              title="Download the original PDF"
                            >
                              ⭳ PDF
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {audit.ignored.length > 0 && (
              <details id="audit-ignored" style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  Ignored files ({audit.ignored.length}) — test fixtures and known-bad names
                </summary>
                <ul className="rows" style={{ marginTop: 8 }}>
                  {audit.ignored.map((f) => (
                    <li key={f.id} className="row-item">
                      <span>{f.file_name}</span>
                      <span className="muted small">{f.claim_count} claims</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <p className="muted small" style={{ marginTop: 8 }}>
              Rows marked with a dash have unknown counts: they were imported before per-file
              counting existed, and their claims are recorded against the whole batch.
            </p>

            {/* ------------------------------------------ bulk actions */}
            {auditSel.length > 0 && (
              <div className="ds-bulk-bar" id="audit-bulk-bar">
                <span className="ds-bulk-count" id="audit-bulk-count">
                  {auditSel.length} import{auditSel.length === 1 ? '' : 's'} selected
                </span>
                <button
                  className="btn danger"
                  id="audit-bulk-purge"
                  disabled={auditBusy}
                  onClick={() => openBulkModal(auditSel, 'purge')}
                >
                  Purge Selected Imports
                </button>
                <a
                  className="btn"
                  id="audit-bulk-pdfs"
                  href={api.raBulkPdfsUrl(auditSel)}
                  onClick={() => setNotice('Preparing the PDF archive…')}
                >
                  ⭳ Download PDFs
                </a>
                <button className="btn" id="audit-bulk-clear" onClick={() => setAuditSel([])}>
                  Clear Selection
                </button>
              </div>
            )}

            {/* -------------------------------------------- danger zone */}
            <div className="ds-alert-card" id="ra-danger-zone" style={{ marginTop: 20 }}>
              <span className="ds-alert-icon" aria-hidden="true">⚠</span>
              <span className="ds-alert-text">
                <strong>Danger Zone</strong> — deleting an import removes everything it created.
                Manually-entered day entries and claims are never touched.
              </span>
              <button
                className="btn danger"
                id="danger-delete-all"
                disabled={auditBusy}
                onClick={() => openBulkModal(auditIds, 'all')}
              >
                Delete ALL RA Imports
              </button>
            </div>
          </>
        )}
      </section>

      {/* --------------------------------- cleanup confirmation (not wired) */}
      {cleanupOpen && cleanup && (
        <Modal title="Run Cleanup?" onClose={() => setCleanupOpen(false)} width={620}>
          <p>This would permanently delete:</p>
          <ul className="ds-confirm-list" id="cleanup-breakdown">
            <li>{cleanup.totals.denials} phantom denied claims</li>
            <li>{cleanup.totals.line_items} denied line items</li>
            <li>{cleanup.totals.rebill_tasks} rebill tasks</li>
          </ul>
          <div className="ds-confirm-reassure" id="cleanup-reassure">
            {cleanup.totals.claims_to_flag} real claims are <strong>kept</strong> and only flagged
            incomplete — their money stays in Reports.
            <br />
            Claims and day entries are never deleted. The import record stays for audit.
          </div>
          <label className="delete-type">
            Type DELETE to confirm:
            <input
              type="text" id="cleanup-input" autoComplete="off" spellCheck={false}
              placeholder="DELETE" value={cleanupText}
              onChange={(e) => setCleanupText(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="btn" id="cleanup-cancel" onClick={() => setCleanupOpen(false)}>Cancel</button>
            <button
              className="btn danger" id="cleanup-confirm"
              disabled={cleanupText !== 'DELETE'}
              onClick={async () => {
                try {
                  const r = await api.raRunCleanup();
                  setCleanupOpen(false);
                  setCleanupText('');
                  await loadCleanup();
                  setNotice(
                    `Deleted ${r.deleted_denials} denials, ${r.deleted_line_items} line items, ` +
                      `${r.deleted_rebill_tasks} tasks. Flagged ${r.flagged_claims} claims.`
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              Delete {cleanup.totals.denials} Denials
            </button>
          </div>
        </Modal>
      )}

      {/* ------------------------------------ shared delete confirmation */}
      {bulkModal && (
        <Modal
          title={
            bulkModal.mode === 'orphan'
              ? 'Delete This Empty Record?'
              : `⚠ Delete ${bulkModal.mode === 'all' ? 'ALL ' : ''}${bulkModal.ids.length} RA Import${
                  bulkModal.ids.length === 1 ? '' : 's'
                }?`
          }
          onClose={() => setBulkModal(null)}
          width={620}
        >
          {bulkModal.mode === 'orphan' ? (
            <>
              <div className="ds-confirm-rows" id="orphan-delete-summary">
                <div><dt>File</dt><dd>{bulkModal.fileName ?? 'this record'}</dd></div>
              </div>
              <div className="ds-confirm-reassure" id="orphan-delete-reassure">
                This record has <strong>no claims and no day entries</strong>. Deleting it removes
                only the empty audit row — nothing in your books changes.
              </div>
            </>
          ) : (
            <>
              {bulkModal.mode === 'all' && (
                <p id="bulk-delete-scary">
                  This will delete <strong>every RA import</strong>, every RA-imported claim, every
                  RA-imported day entry, and every denial. Manual data will survive.
                </p>
              )}
              <p>This will permanently delete:</p>
              <ul className="ds-confirm-list" id="bulk-delete-breakdown">
                <li>{bulkModal.preview?.claims ?? 0} claims</li>
                <li>{bulkModal.preview?.day_entries ?? 0} day entries (source: ra_import only)</li>
                <li>
                  {bulkModal.preview?.denied_claims ?? 0} denied claims
                  {bulkModal.preview?.denied_line_items
                    ? ` + ${bulkModal.preview.denied_line_items} line items`
                    : ''}
                </li>
                <li>{bulkModal.preview?.rebill_tasks ?? 0} rebill tasks</li>
                <li>{bulkModal.preview?.pdfs ?? 0} stored PDFs</li>
              </ul>
              <div className="ds-confirm-reassure" id="bulk-delete-reassure">
                Manually-entered day entries and claims will <strong>NOT</strong> be touched.
                This cannot be undone.
              </div>
            </>
          )}

          {bulkModal.requireText && (
            <label className="delete-type">
              Type {bulkModal.requireText} to confirm:
              <input
                type="text" id="bulk-delete-input" autoComplete="off" spellCheck={false}
                placeholder={bulkModal.requireText} value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </label>
          )}

          <div className="form-actions">
            <button className="btn" id="bulk-delete-cancel" onClick={() => setBulkModal(null)}>
              Cancel
            </button>
            <button
              className="btn danger" id="bulk-delete-confirm"
              disabled={
                auditBusy ||
                (bulkModal.requireText ? confirmText !== bulkModal.requireText : false)
              }
              onClick={confirmModal}
            >
              {bulkModal.mode === 'orphan'
                ? 'Delete Record'
                : `Delete ${bulkModal.mode === 'all' ? 'All ' : ''}${bulkModal.ids.length} Import${
                    bulkModal.ids.length === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        </Modal>
      )}

      {/* ------------------------------------------------- parse detail */}
      {diagFile && (
        <Modal
          title={`Parse detail — ${diagFile.file_name}`}
          onClose={() => { setDiagFile(null); setDiag(null); }}
          width={900}
        >
          {!diag || diag.loading ? (
            <div className="ds-skeleton">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ds-skeleton-row" style={{ width: `${90 - i * 10}%` }} />
              ))}
            </div>
          ) : diag.error ? (
            <div className="alert error" id="diag-error">{diag.error}</div>
          ) : (
            <>
              <div className="ds-modal-summary">
                <span>Raw text: {diag.raw_char_count} chars</span>
                <span>PATIENT: lines: {diag.counts.patients}</span>
                <span>CLM #: lines: {diag.counts.claims_in_text}</span>
                <span>PAYMENT AMOUNT: lines: {diag.counts.payment_amount_lines}</span>
                <span>parsed claims: {diag.claims.length}</span>
              </div>

              {diag.warnings.length > 0 && (
                <div className="alert warn" id="diag-warnings">
                  <strong>Skipped or incomplete:</strong>
                  <ul style={{ margin: '6px 0 0' }}>
                    {diag.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </div>
              )}

              <div className="table-scroll">
                <table className="ds-table" id="diag-claims">
                  <thead>
                    <tr>
                      <th>Patient</th><th>CLM #</th><th>Status</th>
                      <th>DOS</th><th className="ds-num">Charge</th><th className="ds-num">Payment</th>
                      <th className="ds-num">Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diag.claims.map((c, i) => (
                      <tr key={i} className={!c.dos_start || c.total_payment == null ? 'row-unmatched' : ''}>
                        <td>{c.client_name ?? '—'}</td>
                        <td className="mono">{c.claim_number ?? '—'}</td>
                        <td>{c.claim_status ?? '—'}</td>
                        <td className="nowrap">{c.dos_start ? `${c.dos_start} – ${c.dos_end}` : '—'}</td>
                        <td className="ds-num">{c.total_charge ?? '—'}</td>
                        <td className="ds-num">{c.total_payment ?? '—'}</td>
                        <td className="ds-num">{c.line_item_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>Raw extracted text</summary>
                <pre
                  id="diag-raw"
                  style={{
                    maxHeight: 300, overflow: 'auto', fontSize: 11,
                    background: 'var(--ds-gray-bg)', padding: 10, borderRadius: 8, marginTop: 8,
                  }}
                >
                  {diag.raw_text}
                </pre>
              </details>

              <div className="form-actions">
                <button className="btn" onClick={() => { setDiagFile(null); setDiag(null); }}>Close</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ------------------------------------------- agency identity */}      {/* ------------------------------------------- agency identity */}
      <section className="card" id="agency-info">
        <div className="card-head">
          <div>
            <h2>Agency information</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              Appears in the header of the MPSMISC reporting spreadsheet.
            </p>
          </div>
        </div>
        <div className="grid-3">
          <label className="span-2">
            Agency name
            <input
              name="agency_name"
              id="agency_name"
              value={agency.agency_name ?? ''}
              placeholder="Dundas Home Care LLC"
              onChange={(e) => setAgency((a) => ({ ...a, agency_name: e.target.value }))}
            />
          </label>
          <label className="span-2">
            Street address
            <input
              name="agency_street_address"
              id="agency_street_address"
              value={agency.agency_street_address ?? ''}
              onChange={(e) => setAgency((a) => ({ ...a, agency_street_address: e.target.value }))}
            />
          </label>
          <label>
            City
            <input
              name="agency_city"
              id="agency_city"
              value={agency.agency_city ?? ''}
              onChange={(e) => setAgency((a) => ({ ...a, agency_city: e.target.value }))}
            />
          </label>
          <label>
            State
            <input
              name="agency_state"
              id="agency_state"
              maxLength={2}
              value={agency.agency_state ?? ''}
              onChange={(e) => setAgency((a) => ({ ...a, agency_state: e.target.value }))}
            />
          </label>
          <label>
            ZIP
            <input
              name="agency_zip"
              id="agency_zip"
              maxLength={5}
              value={agency.agency_zip ?? ''}
              onChange={(e) => setAgency((a) => ({ ...a, agency_zip: e.target.value }))}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn primary" id="save-agency" onClick={saveAgency} disabled={agencyBusy}>
            {agencyBusy ? 'Saving…' : 'Save agency information'}
          </button>
        </div>
      </section>

      <Payers onError={setError} note={note} />
    </div>
  );
}

/* ------------------------------------------------------- app settings */

/**
 * Agency identity used by the HHAeXchange exports. Both fields are validated
 * server-side against the layout's exact digit counts.
 */
function AppSettingsCard({ settings, onSaved, onError }) {
  const [taxId, setTaxId] = useState(settings.agency_tax_id ?? '');
  const [officeNpi, setOfficeNpi] = useState(settings.office_npi ?? '');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    setTaxId(settings.agency_tax_id ?? '');
    setOfficeNpi(settings.office_npi ?? '');
  }, [settings.agency_tax_id, settings.office_npi]);

  const dirty =
    taxId !== (settings.agency_tax_id ?? '') || officeNpi !== (settings.office_npi ?? '');

  async function save() {
    setLocalError(null);
    setSaving(true);
    try {
      const d = await api.updateSettings({ agency_tax_id: taxId, office_npi: officeNpi });
      await onSaved?.({
        agency_tax_id: d?.settings?.agency_tax_id ?? '',
        office_npi: d?.settings?.office_npi ?? '',
      });
    } catch (e) {
      setLocalError(e.message);
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" id="app-settings">
      <div className="card-head">
        <div>
          <h2>App Settings</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Agency identity that appears in the HHAeXchange exports.
          </p>
        </div>
      </div>
      <div className="card-body">
        <div className="grid-3">
          <label>
            Agency Tax ID <span className="required">required · up to 12 characters</span>
            <input
              type="text"
              name="agency_tax_id"
              value={taxId}
              maxLength={12}
              placeholder="92-70505"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTaxId(e.target.value)}
            />
          </label>
          <label>
            Office NPI <span className="muted small">up to 20 characters</span>
            <input
              type="text"
              name="office_npi"
              value={officeNpi}
              maxLength={20}
              placeholder="M417128800"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setOfficeNpi(e.target.value)}
            />
          </label>
        </div>
        {localError && <div className="alert error">{localError}</div>}
        <div className="form-actions">
          <button className="btn primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save app settings'}
          </button>
          {!dirty && <span className="muted small">No changes</span>}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- HHAeXchange export */

/**
 * The two flat files. The visit export runs the pre-export validation first and
 * lists every blocking issue instead of producing a file that would be rejected.
 */
function HhaExportsCard({ onError }) {
  const [busy, setBusy] = useState(null);
  const [issues, setIssues] = useState(null);
  const [done, setDone] = useState(null);

  async function checkVisits() {
    setBusy('check');
    setDone(null);
    try {
      const d = await api.visitExportValidation();
      if (d.ok) {
        download(api.visitExportUrl());
        setDone(`Visit file generated from ${d.row_count} day entries.`);
      } else {
        setIssues(d);
      }
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" id="hha-exports">
      <div className="card-head">
        <div>
          <h2>HHAeXchange exports</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Flat files matching the V5 import layouts. Run the caregiver file first so the visit
            file&apos;s Caregiver Codes already exist.
          </p>
        </div>
      </div>
      <div className="card-body">
        <div className="export-row">
          <button
            className="btn primary"
            id="export-caregivers"
            onClick={() => {
              setDone(null);
              download(api.caregiverExportUrl());
            }}
            disabled={busy !== null}
          >
            Export Caregivers for HHAeXchange
          </button>
          <button
            className="btn primary"
            id="export-visits"
            onClick={checkVisits}
            disabled={busy !== null}
          >
            {busy === 'check' ? 'Checking…' : 'Export Visits for HHAeXchange'}
          </button>
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          <span className="mono">CaregiverImport_&#123;AgencyTaxID&#125;_YYYYMMDD.csv</span> ·{' '}
          <span className="mono">VISITS_&#123;AgencyTaxID&#125;_YYYYMMDDHHMMSS.CSV</span> — the visit
          file is text-qualified with CRLF line endings.
        </p>
        {done && (
          <div className="alert ok" id="export-done" style={{ marginTop: 12 }}>
            {done}
          </div>
        )}
      </div>

      {issues && (
        <Modal title="Visit export blocked" onClose={() => setIssues(null)} width={680}>
          <p id="export-validation-message">
            <strong>
              {issues.issues.length} issue{issues.issues.length === 1 ? '' : 's'} must be fixed
              before the visit file can be generated.
            </strong>{' '}
            Nothing was exported.
          </p>
          <div className="issue-list">
            {issues.issues.map((i) => (
              <div className="issue" key={i.code}>
                <div className="issue-head">
                  <span className="pill overdue tiny">{i.items?.length ?? 0}</span>
                  <strong>{i.message}</strong>
                </div>
                {i.items?.length > 0 && (
                  <ul className="issue-items">
                    {i.items.slice(0, 12).map((item, n) => (
                      <li key={n}>{item}</li>
                    ))}
                    {i.items.length > 12 && (
                      <li className="muted">…and {i.items.length - 12} more</li>
                    )}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setIssues(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ payers */

function Payers({ onError, note }) {
  const [payers, setPayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({
    name: '',
    typical_days_to_pay: '30',
    notes: '',
    hhaechange_payer_id: '',
  });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.payers();
      setPayers(d.payers);
    } catch (e) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  async function addPayer(e) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await api.createPayer({
        name: draft.name.trim(),
        typical_days_to_pay: draft.typical_days_to_pay === '' ? null : Number(draft.typical_days_to_pay),
        hhaechange_payer_id: draft.hhaechange_payer_id.trim() || null,
        notes: draft.notes.trim() || null,
      });
      setDraft({ name: '', typical_days_to_pay: '30', notes: '', hhaechange_payer_id: '' });
      await load();
      note('Payer added');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      await api.updatePayer(editing.id, {
        name: editing.name.trim(),
        typical_days_to_pay:
          editing.typical_days_to_pay === '' ? null : Number(editing.typical_days_to_pay),
        hhaechange_payer_id: (editing.hhaechange_payer_id ?? '').trim() || null,
        notes: editing.notes?.trim() || null,
      });
      setEditing(null);
      await load();
      note('Payer updated');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(payer) {
    if (!window.confirm(`Delete ${payer.name}?`)) return;
    setBusy(true);
    try {
      await api.deletePayer(payer.id);
      await load();
      note('Payer deleted');
    } catch (err) {
      // The server refuses while agreements still reference it.
      const usage = err.status === 409 ? err.message : null;
      if (usage && window.confirm(`${usage}\n\nDelete anyway and detach it from those agreements?`)) {
        try {
          await api.deletePayer(payer.id, { force: true });
          await load();
          note('Payer deleted');
        } catch (e2) {
          onError(e2.message);
        }
      } else if (!usage) {
        onError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="payers">
      <div className="card-head">
        <div>
          <h2>Payers</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Typical days to pay drives the expected payment date on submitted claims.
          </p>
        </div>
      </div>

      <div className="card-body" style={{ paddingBottom: 0 }}>
        <form className="payer-add" onSubmit={addPayer}>
          <label>
            Name
            <input
              name="payer_name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="State Medicaid"
            />
          </label>
          <label>
            Typical days to pay
            <input
              name="payer_days"
              type="number"
              min="0"
              value={draft.typical_days_to_pay}
              onChange={(e) => setDraft({ ...draft, typical_days_to_pay: e.target.value })}
            />
          </label>
          <label>
            HHAeXchange Payer ID <span className="required">10 digits</span>
            <input
              name="payer_hha_id"
              value={draft.hhaechange_payer_id}
              inputMode="numeric"
              maxLength={10}
              placeholder="1234567890"
              onChange={(e) =>
                setDraft({ ...draft, hhaechange_payer_id: e.target.value.replace(/\D/g, '') })
              }
            />
          </label>
          <label className="span-2">
            Notes
            <input
              name="payer_notes"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
          <div className="payer-add-action">
            <button className="btn primary" disabled={busy || !draft.name.trim()}>
              + Add payer
            </button>
          </div>
        </form>
      </div>

      {loading && !payers.length ? (
        <SkeletonCards count={3} />
      ) : (
        <div className="table-scroll hide-on-mobile">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Typical days to pay</th>
                <th>HHAeXchange Payer ID</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payers.map((p) =>
                editing?.id === p.id ? (
                  <tr key={p.id} className="row-dirty">
                    <td>
                      <input
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        aria-label="Payer name"
                      />
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        min="0"
                        style={{ width: 90, textAlign: 'right' }}
                        value={editing.typical_days_to_pay ?? ''}
                        onChange={(e) => setEditing({ ...editing, typical_days_to_pay: e.target.value })}
                        aria-label="Typical days to pay"
                      />
                    </td>
                    <td>
                      <input
                        value={editing.hhaechange_payer_id ?? ''}
                        inputMode="numeric"
                        maxLength={10}
                        style={{ width: 120 }}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            hhaechange_payer_id: e.target.value.replace(/\D/g, ''),
                          })
                        }
                        aria-label="HHAeXchange Payer ID"
                      />
                    </td>
                    <td>
                      <input
                        value={editing.notes ?? ''}
                        onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                        aria-label="Payer notes"
                      />
                    </td>
                    <td className="row-actions">
                      <button className="btn tiny primary" onClick={saveEdit} disabled={busy}>
                        Save
                      </button>
                      <button className="btn tiny" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                    </td>
                    <td className="num">{p.typical_days_to_pay ?? '—'}</td>
                    <td className="mono">
                      {p.hhaechange_payer_id ?? <span className="muted">—</span>}
                    </td>
                    <td className="muted">{p.notes ?? '—'}</td>
                    <td className="row-actions">
                      <button className="btn tiny" onClick={() => setEditing({ ...p })}>
                        Edit
                      </button>
                      <button className="btn tiny ghost" onClick={() => remove(p)} disabled={busy}>
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              )}
              {!payers.length && (
                <tr>
                  <td colSpan={5} className="empty">
                    No payers yet. Add one so submitted claims get an expected payment date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile: same data as stacked cards — a 5-column table is unreadable at 375px */}
      {!loading && payers.length > 0 && (
        <div className="show-on-mobile payer-cards" id="payer-cards">
          {payers.map((p) =>
            editing?.id === p.id ? (
              <div className="payer-card row-dirty" key={p.id}>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  aria-label="Payer name"
                  placeholder="Name"
                />
                <label className="small muted">
                  Typical days to pay
                  <input
                    type="number"
                    min="0"
                    value={editing.typical_days_to_pay ?? ''}
                    onChange={(e) =>
                      setEditing({ ...editing, typical_days_to_pay: e.target.value })
                    }
                    aria-label="Typical days to pay"
                  />
                </label>
                <label className="small muted">
                  HHAeXchange Payer ID
                  <input
                    value={editing.hhaechange_payer_id ?? ''}
                    inputMode="numeric"
                    maxLength={10}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        hhaechange_payer_id: e.target.value.replace(/\D/g, ''),
                      })
                    }
                    aria-label="HHAeXchange Payer ID"
                  />
                </label>
                <label className="small muted">
                  Notes
                  <input
                    value={editing.notes ?? ''}
                    onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                    aria-label="Payer notes"
                  />
                </label>
                <div className="payer-card-actions">
                  <button className="btn tiny primary" onClick={saveEdit} disabled={busy}>
                    Save
                  </button>
                  <button className="btn tiny" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="payer-card" key={p.id}>
                <div className="payer-card-top">
                  <strong>{p.name}</strong>
                  <span className="payer-card-days">
                    {p.typical_days_to_pay != null ? `${p.typical_days_to_pay} days` : '—'}
                  </span>
                </div>
                <div className="payer-card-id">
                  {p.hhaechange_payer_id ?? <span className="muted">no HHAeXchange ID</span>}
                </div>
                {p.notes && <div className="payer-card-notes muted small">{p.notes}</div>}
                <div className="payer-card-actions">
                  <button className="btn tiny" onClick={() => setEditing({ ...p })}>
                    Edit
                  </button>
                  <button className="btn tiny ghost" onClick={() => remove(p)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

    </section>
  );
}

/* ------------------------------------------------------------ AI config */

/**
 * Provider + key for document summarisation.
 *
 * The saved key is never sent to the browser, so the field always renders
 * empty with a "saved" affordance; typing a new value replaces it, and leaving
 * it blank keeps the existing one.
 */
function AiConfigCard({ settings, onSaved, onError }) {
  const [provider, setProvider] = useState(settings.ai_provider ?? 'none');
  const [key, setKey] = useState('');
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasKey = Boolean(settings.has_ai_key);

  useEffect(() => {
    setProvider(settings.ai_provider ?? 'none');
  }, [settings.ai_provider]);

  const dirty = provider !== (settings.ai_provider ?? 'none') || Boolean(key.trim());

  async function save() {
    setSaving(true);
    try {
      const d = await api.updateSettings({ ai_provider: provider, ai_api_key: key.trim() });
      await onSaved?.(d?.settings ?? {});
      setKey('');
      setChanging(false);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" id="ai-config">
      <div className="card-head">
        <div>
          <h2>AI Configuration</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Used to summarise documents attached to tasks.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <label>
          Provider
          <select
            id="ai-provider"
            value={provider}
            onChange={(e) => { setProvider(e.target.value); }}
          >
            <option value="none">None (Disabled)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>

        <label>
          API Key
          {hasKey && !changing ? (
            <div className="ai-key-saved" id="ai-key-saved">
              <span className="pill ok tiny">API Key Saved</span>
              <button className="btn tiny" id="ai-key-change" onClick={() => setChanging(true)}>
                Change Key
              </button>
            </div>
          ) : (
            <input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasKey ? 'Enter a new key to replace the saved one' : 'sk-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </label>
      </div>

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button
          className="btn primary"
          id="ai-save"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save AI settings'}
        </button>
      </div>
    </section>
  );
}


/* -------------------------------------------------- account security */

function AccountSecurityCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError('The new password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Password changed.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="account-security">
      <div className="card-head">
        <div>
          <h2>Account Security</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Change the password used to sign in to this account.
          </p>
        </div>
      </div>
      <form className="card-body" onSubmit={submit}>
        <div className="grid-3">
          <label>
            Current Password
            <input
              type="password"
              id="security-current-password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label>
            New Password
            <input
              type="password"
              id="security-new-password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
            />
          </label>
          <label>
            Confirm New Password
            <input
              type="password"
              id="security-confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
            />
          </label>
        </div>
        {error && <div className="alert error" id="security-error">{error}</div>}
        <div className="form-actions">
          <button className="btn primary" id="security-save" disabled={busy}>
            {busy ? 'Saving…' : 'Change Password'}
          </button>
        </div>
      </form>
    </section>
  );
}


/* ---------------------------------------------------------- appearance */

/**
 * Theme picker. Writes to localStorage immediately (so the change is instant
 * and per-device) and mirrors the choice into the settings table so it becomes
 * the default for a new browser.
 */
function AppearanceCard({ settings }) {
  const stored = getStored();
  const [mode, setMode] = useState(stored.mode ?? settings.theme_mode ?? 'light');
  const [color, setColor] = useState(stored.color ?? settings.theme_color ?? 'blue');
  const [hex, setHex] = useState(() => resolveHex(stored.color ?? settings.theme_color ?? 'blue'));
  const [saving, setSaving] = useState(false);

  function chooseMode(next) {
    setMode(next);
    setTheme(next, color);
  }

  function chooseColor(next) {
    const resolved = resolveHex(next);
    setColor(resolved);
    setHex(resolved);
    setTheme(mode, resolved);
  }

  async function saveAsDefault() {
    setSaving(true);
    try {
      await api.updateSettings({ theme_mode: mode, theme_color: color });
      toast.success('Appearance saved as the default.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" id="appearance">
      <div className="card-head">
        <div>
          <h2>Appearance</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Saved on this device. Save as default to apply it to new browsers.
          </p>
        </div>
      </div>

      <div className="appearance-row">
        <span className="appearance-label">Theme</span>
        <div className="segmented" id="theme-mode-toggle" role="group" aria-label="Theme mode">
          {MODES.map((m) => (
            <button
              key={m}
              id={`theme-mode-${m}`}
              className={m === mode ? 'active' : ''}
              aria-pressed={m === mode}
              onClick={() => chooseMode(m)}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-row">
        <span className="appearance-label">Accent colour</span>
        <div className="color-picker">
          <label className="color-wheel" title="Pick any colour">
            <input
              type="color"
              id="theme-color-wheel"
              value={hex}
              onChange={(e) => chooseColor(e.target.value)}
              aria-label="Pick any accent colour"
            />
            <span className="color-wheel-preview" style={{ background: hex }} />
          </label>
          <code className="color-hex" id="theme-color-hex">{hex}</code>
        </div>
      </div>

      <div className="appearance-row">
        <span className="appearance-label">Presets</span>
        <div className="swatches" id="theme-color-swatches" role="group" aria-label="Accent colour presets">
          {PRESETS.map((c) => (
            <button
              key={c.key}
              id={`theme-color-${c.key}`}
              className={`swatch ${resolveHex(color) === c.hex ? 'active' : ''}`}
              style={{ '--swatch': c.hex, '--swatch-ink': getContrastColor(c.hex) }}
              aria-label={c.label}
              aria-pressed={resolveHex(color) === c.hex}
              title={c.label}
              onClick={() => chooseColor(c.hex)}
            >
              {resolveHex(color) === c.hex ? '✓' : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button className="btn" id="theme-save-default" disabled={saving} onClick={saveAsDefault}>
          {saving ? 'Saving…' : 'Save as default'}
        </button>
        <button
          className="btn danger"
          id="logout-button"
          onClick={() => {
            clearToken();
            window.location.assign(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/login`);
          }}
        >
          Log out
        </button>
      </div>
    </section>
  );
}

