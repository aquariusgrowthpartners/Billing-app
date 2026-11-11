import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api.js';
import { toast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import { useClaimActions } from '../components/ClaimActionModals.jsx';
import { useClientProfile } from '../hooks/useClientProfile.js';
import WeekCalendar from '../components/WeekCalendar.jsx';
import AgreementForm from '../components/AgreementForm.jsx';
import GenerateClaimDialog from '../components/GenerateClaimDialog.jsx';
import ClaimEditDialog from '../components/ClaimEditDialog.jsx';
import ClaimsTable from '../components/ClaimsTable.jsx';
import SkeletonPage from '../components/SkeletonPage.jsx';
import { formatClientName, formatLongDate, formatMoney, todayISO } from '../calc.js';

const STATUS_CLASS = {
  Draft: 'pill draft',
  Submitted: 'pill submitted',
  Paid: 'pill paid',
  Denied: 'pill denied',
};

const TAB_PROFILE = 'profile';
const TAB_SCHEDULE = 'schedule';

export default function ClientProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const clientId = Number(id);
  const validId = Number.isInteger(clientId) && clientId > 0;

  const [showArchivedClaims, setShowArchivedClaims] = useState(false);

  /* ------------------------------------------- service agreement scanner */
  const [preview, setPreview] = useState(null);
  const [scanFile, setScanFile] = useState(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanToast, setScanToast] = useState(null);
  // parent cards: which are expanded, which show their removed lines
  const [openParents, setOpenParents] = useState({});
  const [showRemoved, setShowRemoved] = useState({});
  const scanInputRef = useRef(null);

  const onPickAgreement = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScanError(null);
    setScanToast(null);
    setScanBusy(true);
    setScanFile(file);
    try {
      // dry run: parse only, nothing is written until Save
      const res = await api.uploadServiceAgreement(clientId, file, { dryRun: true });
      setPreview(res);
    } catch (err) {
      setScanError(err.message ?? 'Could not read that PDF.');
      setScanFile(null);
    } finally {
      setScanBusy(false);
    }
  };

  const cancelScan = () => {
    setPreview(null);
    setScanFile(null);
    setScanError(null);
  };

  const saveScan = async () => {
    if (!scanFile) return;
    setScanBusy(true);
    setScanError(null);
    try {
      const res = await api.uploadServiceAgreement(clientId, scanFile);
      setPreview(null);
      setScanFile(null);
      await reload();
      setScanToast(
        `${res.agreements_created} row${res.agreements_created === 1 ? '' : 's'} saved` +
          (res.agreements_updated ? `, ${res.agreements_updated} updated` : '')
      );
    } catch (err) {
      // the server sends a precise reason (wrong recipient etc.) — show it and
      // keep the panel open so the file can be corrected
      setScanError(err.message ?? 'The upload failed.');
    } finally {
      setScanBusy(false);
    }
  };

  const { data, loading, error, reload } = useClientProfile(validId ? clientId : null, {
    includeArchivedClaims: showArchivedClaims,
  });

  // Tab is plain component state — deliberately NOT stored in the URL.
  // URL-carried tab state survives refreshes, bookmarks and browser session
  // restore, which meant a stray ?tab=schedule could open the calendar
  // forever and bury the agreements screen. Every mount starts on Tab 1.
  // ?week=YYYY-MM-DD opens the schedule on that week — used by the caretaker
  // work-history rows to jump straight to a day.
  const [searchParams] = useSearchParams();
  const weekParam = searchParams.get('week') || undefined;
  const [tab, setTab] = useState(weekParam ? TAB_SCHEDULE : TAB_PROFILE);
  // B1/B2 — this client's denials, and the per-day markers for the calendar
  const [clientDenials, setClientDenials] = useState([]);
  const [denialsOpen, setDenialsOpen] = useState(false);
  const [denialDetail, setDenialDetail] = useState(null);
  const [denialMarkers, setDenialMarkers] = useState({});
  // Part 3 — Calendar | Rebill List, remembered across reloads
  // the week the calendar is actually showing, reported by WeekCalendar
  const [weekRange, setWeekRange] = useState(() => {
    const from = weekParam
      ? new Date(`${weekParam}T00:00:00`).toISOString().slice(0, 10)
      : todayISO();
    const to = new Date(`${from}T00:00:00`);
    to.setDate(to.getDate() + 6);
    return { from, to: to.toISOString().slice(0, 10) };
  });
  const [scheduleView, setScheduleView] = useState(() => {
    try {
      return localStorage.getItem('schedule-view') === 'rebill' ? 'rebill' : 'calendar';
    } catch {
      return 'calendar';
    }
  });
  // Part 4 — the Rebill List is a projection of the SAME markers call:
  // unrecovered days only, oldest first, including days with no day entry.
  const rebillItems = Object.values(denialMarkers)
    // scoped to the VISIBLE week: without this the badge counted every week
    .filter((m) => m.dos >= weekRange.from && m.dos <= weekRange.to)
    .filter((m) => m.state === 'unrecovered')
    .sort((a, b) => b.days_open - a.days_open);
  const weekStartISO = weekRange.from;

  const chooseView = (v) => {
    setScheduleView(v);
    try {
      localStorage.setItem('schedule-view', v);
    } catch {
      /* private mode */
    }
  };

  const [agreementId, setAgreementId] = useState(null);
  // null = closed | { mode: 'create' } | { mode: 'edit', agreement }
  const [agreementForm, setAgreementForm] = useState(null);
  const showAgreementForm = agreementForm !== null;
  const [editingClient, setEditingClient] = useState(false);
  const [showGenerateClaim, setShowGenerateClaim] = useState(false);
  const [caseManagerForm, setCaseManagerForm] = useState(null); // null | { mode, values }
  // Errors raised by actions on this page (assign/save). Fetch errors come from
  // the hook's `error`.
  const [actionError, setActionError] = useState(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [deleteCheck, setDeleteCheck] = useState(null); // { deletable, ... } | { blocked, ... }
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingClaim, setEditingClaim] = useState(null);
  const [savedFlash, setSavedFlash] = useState(null);
  const formRef = useRef(null);

  // Only trust data belonging to the id in the URL; the hook keeps the
  // previous client's payload while the next one is in flight.
  const profile = data && data.client && data.client.id === clientId ? data : null;

  // Archive / delete for the claims in this client's Claims section. Declared
  // with the other hooks (before any early return) and derives the client name
  // from `profile`, which is available here.
  const {
    requestArchive: requestClaimArchive,
    requestDelete: requestClaimDelete,
    modals: claimActionModals,
  } = useClaimActions({
    onChanged: reload,
    onError: setActionError,
    onNotify: flash,
    clientName: profile ? `${profile.client.first_name} ${profile.client.last_name}`.trim() : undefined,
  });

  useEffect(() => {
    setAgreementId(null);
    setAgreementForm(null);
    setEditingClient(false);
    setShowGenerateClaim(false);
    setEditingClaim(null);
    setCaseManagerForm(null);
    setActionError(null);
    setDeleteCheck(null);
    setConfirmDelete(false);
    // a ?week= link means the caller wants the schedule, not the profile
    setTab(weekParam ? TAB_SCHEDULE : TAB_PROFILE);
  }, [clientId, weekParam]);

  useEffect(() => {
    if (!profile) return;
    setAgreementId(
      (prev) => prev ?? profile.active_agreement?.id ?? profile.agreements[0]?.id ?? null
    );
    if (profile.agreements.length === 0) {
      setAgreementForm((prev) => prev ?? { mode: 'create' });
      setTab(TAB_PROFILE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // B1/B2 — this client's denials and the calendar's per-day markers.
  useEffect(() => {
    if (!clientId) return;
    api.denials({ client_id: clientId }).then((d) => setClientDenials(d.denials ?? [])).catch(() => {});
    api
      .denialMarkers({ client_id: clientId })
      .then((m) => setDenialMarkers(Object.fromEntries((m.markers ?? []).map((x) => [x.dos, x]))))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);


  function flash(message) {
    setSavedFlash(message);
    setTimeout(() => setSavedFlash(null), 2500);
  }

  function openAgreementForm(mode = 'create', agreement = null) {
    setTab(TAB_PROFILE);
    setAgreementForm(mode === 'edit' ? { mode: 'edit', agreement } : { mode: 'create' });
    requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  }

  function closeAgreementForm() {
    setAgreementForm(null);
  }

  async function handleClientSaved() {
    setEditingClient(false);
    await reload();
    flash('Client details saved');
  }

  function logTimeFor(id2) {
    setAgreementId(id2);
    setTab(TAB_SCHEDULE);
  }

  /** Assign (or clear) the client's case manager. */
  async function assignCaseManager(value) {
    try {
      await api.updateClient(client.id, {
        case_manager_id: value === '' ? null : Number(value),
      });
      setActionError(null);
      await reload();
      flash(value === '' ? 'Case manager removed' : 'Case manager assigned');
    } catch (e) {
      setActionError(e.message);
    }
  }

  /** Archive hides the client from the default list; nothing is removed. */
  async function toggleArchived() {
    setDangerBusy(true);
    setActionError(null);
    try {
      await api.setClientArchived(client.id, !client.archived);
      await reload();
      flash(client.archived ? 'Client unarchived' : 'Client archived');
    } catch (e) {
      setActionError(e.message);
    } finally {
      setDangerBusy(false);
    }
  }

  /**
   * Deletion is blocked while any billing history exists, so check first and
   * only ask for confirmation when it is actually safe to delete.
   */
  async function startDelete() {
    setDangerBusy(true);
    setActionError(null);
    try {
      const check = await api.clientDeleteCheck(client.id);
      if (!check.deletable) {
        setDeleteCheck({ ...check, blocked: true });
      } else {
        setDeleteCheck(check);
        setConfirmDelete(true);
      }
    } catch (e) {
      setActionError(e.message);
    } finally {
      setDangerBusy(false);
    }
  }

  async function doDelete() {
    setDangerBusy(true);
    try {
      await api.deleteClient(client.id);
      // The client no longer exists, so leave the page.
      navigate('/');
    } catch (e) {
      setConfirmDelete(false);
      setActionError(e.message);
    } finally {
      setDangerBusy(false);
    }
  }

  async function handleCaseManagerSaved(saved) {
    setCaseManagerForm(null);
    // A newly created manager is assigned to this client straight away.
    if (saved?.id && saved.id !== caseManager?.id) {
      await api.updateClient(client.id, { case_manager_id: saved.id });
    }
    await reload();
    flash('Case manager saved');
  }

  async function handleClaimGenerated(claim) {
    setShowGenerateClaim(false);
    await reload();
    flash(`Claim ${claim.claim_name} created`);
  }

  async function handleClaimSaved() {
    setEditingClaim(null);
    await reload();
    flash('Claim updated');
  }

  async function handleAgreementSaved(saved) {
    setAgreementForm(null);
    const fresh = await reload();
    if (saved?.id) setAgreementId(saved.id);
    else if (fresh) setAgreementId(fresh.active_agreement?.id ?? fresh.agreements[0]?.id ?? null);
    flash('Agreement saved');
    toast.success('Agreement saved');
  }

  if (!validId) {
    return (
      <div className="page">
        <BackLink />
        <div className="alert error">That client id is not valid.</div>
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="page">
        <BackLink />
        <div className="alert error">{error}</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="page">
        <BackLink />
        {loading ? <SkeletonPage /> : <div className="empty">Client not found.</div>}
      </div>
    );
  }

  const { client, agreements, claims, totals, case_manager: caseManager } = profile;
  const today = todayISO();
  const activeAgreement = agreements.find(
    (a) => (!a.start_date || a.start_date <= today) && (!a.end_date || a.end_date >= today)
  );

  return (
    <div className="page">
      <BackLink />

      <div className="page-head profile-head">
        <div>
          <h1>
            {client.first_name} {client.last_name}
          </h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            <span className="mono">{client.ma_number ?? 'no MA number'}</span>
            {' · '}
            {client.active ? 'Active' : 'Inactive'}
          </p>
          <span className="pill muted client-id-badge" id="client-id-badge">
            Client ID: {client.id}
          </span>
        </div>
        {savedFlash && <span className="pill ok">{savedFlash}</span>}
      </div>

      {actionError && (
        <div className="alert error">
          {actionError}{' '}
          <button className="link-inline" onClick={() => setActionError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Client sections">
        <button
          type="button"
          role="tab"
          id="tab-profile"
          aria-selected={tab === TAB_PROFILE}
          aria-controls="panel-profile"
          className={tab === TAB_PROFILE ? 'tab active' : 'tab'}
          onClick={() => setTab(TAB_PROFILE)}
        >
          Profile &amp; Agreements
          {agreements.length > 0 && <span className="tab-count">{agreements.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-schedule"
          aria-selected={tab === TAB_SCHEDULE}
          aria-controls="panel-schedule"
          className={tab === TAB_SCHEDULE ? 'tab active' : 'tab'}
          onClick={() => setTab(TAB_SCHEDULE)}
        >
          Schedule &amp; Time Entry
        </button>
      </div>

      {/* ---------------- Tab 1: Profile & Agreements (the default) --------- */}
      <div
        role="tabpanel"
        id="panel-profile"
        aria-labelledby="tab-profile"
        className="tab-panel"
        style={{ display: tab === TAB_PROFILE ? 'flex' : 'none' }}
      >
        <section className="card" id="client-info">
          <div className="card-head">
            <div>
              <h2>Client information</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                {editingClient
                  ? 'Editing — Save writes to the database'
                  : 'Name, date of birth, MA number and notes'}
              </p>
            </div>
            {!editingClient && (
              <button className="btn" onClick={() => setEditingClient(true)}>
                Edit Client
              </button>
            )}
          </div>

          {editingClient ? (
            <ClientEditForm
              client={client}
              onSaved={handleClientSaved}
              onCancel={() => setEditingClient(false)}
            />
          ) : (
            <>
              <div className="info-grid">
                <Field label="Name" value={formatClientName(client)} />
                <Field
                  label="Date of birth"
                  value={client.dob ? formatLongDate(client.dob) : '—'}
                />
                <Field label="MA number" value={client.ma_number ?? '—'} mono />
                <Field
                  label="Alternative names"
                  value={client.alternative_names ?? '—'}
                />
                <Field label="Diagnosis Code (DX)" value={client.diagnosis_code ?? '—'} mono />
                <Field label="Status" value={client.active ? 'Active' : 'Inactive'} />
              </div>
              {client.notes && (
                <div className="note-banner" style={{ margin: '0 16px 16px' }}>
                  {client.notes}
                </div>
              )}
            </>
          )}
        </section>

        <CaseManagerCard
          caseManager={caseManager}
          form={caseManagerForm}
          setForm={setCaseManagerForm}
          onAssign={assignCaseManager}
          onSaved={handleCaseManagerSaved}
          onError={setActionError}
        />

        <section className="card" ref={formRef} id="agreements">
          <div className="card-head">
            <div>
              <h2>Service Agreements</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                {agreements.length
                  ? `${agreements.length} on file — rate and minutes per unit are set here`
                  : 'None yet — add one to set the rate and minutes per unit'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={scanInputRef}
                type="file"
                accept="application/pdf"
                id="service-agreement-file"
                style={{ display: 'none' }}
                onChange={onPickAgreement}
              />
              <button
                className="btn"
                id="upload-service-agreement"
                disabled={scanBusy}
                onClick={() => scanInputRef.current?.click()}
              >
                {scanBusy ? 'Reading…' : '+ Upload Service Agreement PDF'}
              </button>
              <button
                className={showAgreementForm ? 'btn' : 'btn primary'}
                onClick={() =>
                  showAgreementForm ? closeAgreementForm() : openAgreementForm('create')
                }
              >
                {showAgreementForm ? 'Cancel' : '+ Add Agreement'}
              </button>
            </div>
          </div>

          {showAgreementForm && (
            <AgreementForm
              clientId={client.id}
              agreement={agreementForm?.mode === 'edit' ? agreementForm.agreement : undefined}
              onSaved={handleAgreementSaved}
              onCancel={closeAgreementForm}
            />
          )}

          {scanError && (
            <p className="error" id="scan-error" style={{ margin: '8px 0' }}>
              {scanError}
            </p>
          )}

          {preview && (
            <div className="card" id="scan-preview" style={{ margin: '10px 0', padding: 12 }}>
              <h3 style={{ marginTop: 0 }}>Preview — nothing saved yet</h3>
              <p className="muted small" style={{ margin: '0 0 8px' }}>
                DHS Service Agreement #: <strong id="preview-dhs">{preview.extracted?.dhs_service_agreement_num ?? '—'}</strong>
                {' · '}Recipient: <strong id="preview-recipient">{preview.extracted?.recipient_name ?? '—'}</strong>
                {' · '}Effective: <strong>{preview.extracted?.effective_date ?? '—'}</strong> →{' '}
                <strong>{preview.extracted?.through_date ?? '—'}</strong>
                {' · '}ICD-10: <strong id="preview-icd">{preview.extracted?.icd10_code ?? '—'}</strong>
              </p>
              <div className="table-scroll">
                <table className="table" id="scan-preview-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Code+Mod</th>
                      <th>Description</th>
                      <th className="num">Quantity</th>
                      <th className="num">Rate</th>
                      <th>Dates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.extracted?.lines ?? []).map((l) => (
                      <tr key={l.line_number}>
                        <td>{l.line_number}</td>
                        <td>
                          <code>{l.modifier ? `${l.procedure_code}:${l.modifier}` : l.procedure_code}</code>
                        </td>
                        <td>{l.description}</td>
                        <td className="num">{l.quantity ?? '—'}</td>
                        <td className="num">{l.rate_per_unit ?? '—'}</td>
                        <td>
                          {l.start_date ?? '—'} → {l.end_date ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn primary" id="scan-save" disabled={scanBusy} onClick={saveScan}>
                  {scanBusy ? 'Saving…' : 'Save'}
                </button>
                <button className="btn" id="scan-cancel" disabled={scanBusy} onClick={cancelScan}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {scanToast && (
            <p className="muted small" id="scan-toast" style={{ margin: '8px 0' }}>
              {scanToast}
            </p>
          )}

          {(profile.service_agreements ?? []).length === 0 ? (
            <p className="empty">
              No agreements on file. Use <strong>+ Add Agreement</strong> above to set the rate and
              minutes per unit — the schedule reads its terms from here.
            </p>
          ) : (
            (profile.service_agreements ?? []).map((sa) => {
              const key = sa.legacy ? `legacy-${sa.lines[0]?.id}` : `sa-${sa.id}`;
              const open = Boolean(openParents[key]);
              const removedOn = Boolean(showRemoved[key]);
              const active = sa.lines.filter((l) => !l.superseded_at);
              const removed = sa.lines.filter((l) => l.superseded_at);
              const shown = removedOn ? [...active, ...removed] : active;
              const pdf = sa.pdf_path ?? sa.lines.find((l) => l.service_agreement_pdf_path)?.service_agreement_pdf_path ?? null;
              const totalAuthorized = active.reduce(
                (sum, line) => sum + (Number(line.authorized_total_amount) || 0),
                0
              );

              return (
                <div className="card" key={key} id={`sa-card-${key}`} style={{ margin: '10px 0', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <strong id={`sa-dhs-${key}`}>{sa.dhs_service_agreement_num ?? '(no DHS #)'}</strong>
                    <span className="muted small">
                      {active.length ? 'Active' : 'Removed'} · {formatMoney(totalAuthorized)} ·{' '}
                      {sa.effective_date ? formatLongDate(sa.effective_date) : '—'} →{' '}
                      {sa.through_date ? formatLongDate(sa.through_date) : 'open'}
                    </span>
                  </div>

                  {!sa.legacy && (
                    <div style={{ margin: '8px 0 4px' }}>
                      <label className="small muted" htmlFor={`sa-auth-${sa.id}`}>
                        HHAeXchange Auth #
                      </label>
                      <input
                        className="input compact"
                        id={`sa-auth-${sa.id}`}
                        data-parent-id={sa.id}
                        defaultValue={sa.hhaexchange_auth_number ?? ''}
                        placeholder="e.g. 60699023752-08"
                        onBlur={async (e) => {
                          const before = sa.hhaexchange_auth_number ?? '';
                          const value = e.target.value.trim();
                          if (value === before) return;
                          try {
                            await api.patchServiceAgreement(sa.id, {
                              hhaexchange_auth_number: value,
                            });
                            e.target.style.borderColor = '#2e7d32';
                            setTimeout(() => { e.target.style.borderColor = ''; }, 1200);
                            setScanError(null);
                            await reload();
                          } catch (err) {
                            // revert — a field that silently keeps a value the
                            // server rejected is worse than an error
                            e.target.value = before;
                            e.target.style.borderColor = '#c62828';
                            setScanError(err.message ?? 'Could not save the auth number.');
                          }
                        }}
                      />
                      <div className="sub muted">Copy from HHAeXchange patient profile</div>
                    </div>
                  )}

                  <div className="muted small" style={{ margin: '6px 0' }}>
                    {sa.icd10_code ? `ICD-10: ${sa.icd10_code} · ` : ''}
                    PDF:{' '}
                    {pdf ? (
                      <a className="link" id={`sa-pdf-${key}`} href={`/${pdf}`} target="_blank" rel="noreferrer">
                        View
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button
                      className="btn tiny"
                      id={`sa-toggle-${key}`}
                      onClick={() => setOpenParents((p) => ({ ...p, [key]: !p[key] }))}
                    >
                      {open ? '▾' : '▸'} {active.length} active line{active.length === 1 ? '' : 's'}
                      {removed.length ? ` · ${removed.length} removed` : ''}
                    </button>
                    {removed.length > 0 && (
                      <label className="small muted">
                        <input
                          type="checkbox"
                          id={`sa-show-removed-${key}`}
                          checked={removedOn}
                          onChange={() => setShowRemoved((p) => ({ ...p, [key]: !p[key] }))}
                        />{' '}
                        Show removed
                      </label>
                    )}
                  </div>

                  {open && (
                    <div className="table-scroll">
                      <table className="table" id={`sa-lines-${key}`} style={{ marginTop: 8 }}>
                        <thead>
                          <tr>
                            <th>Line</th>
                            <th>Service</th>
                            <th>Term</th>
                            <th className="num">Units</th>
                            <th className="num">Rate</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((l) => (
                            <tr key={l.id} style={l.superseded_at ? { opacity: 0.55 } : undefined}>
                              <td>{l.id}</td>
                              <td className="mono">{l.service_code_with_modifier ?? l.service_code ?? '—'}</td>
                              <td>
                                {l.start_date ? formatLongDate(l.start_date) : '—'} →{' '}
                                {l.end_date ? formatLongDate(l.end_date) : 'open'}
                              </td>
                              <td className="num">
                                {l.authorized_units_per_week ?? '—'}
                                {l.authorized_total_amount != null && (
                                  <div className="sub muted">{formatMoney(l.authorized_total_amount)}</div>
                                )}
                              </td>
                              <td className="num dollars">{formatMoney(l.rate_per_unit)}</td>
                              <td>
                                {l.superseded_at ? (
                                  <span className="pill tiny">removed</span>
                                ) : (
                                  <span className="pill ok tiny">active</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {!sa.legacy && (
                    <div className="row-actions" style={{ marginTop: 8 }}>
                      <button
                        className="btn tiny"
                        onClick={() => openAgreementForm('edit', active[0] ?? sa.lines[0])}
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>

        <div className="stat-row">
          <Stat label="Logged days" value={totals.entry_count} />
          <Stat label="Total units" value={totals.total_units} />
          <Stat label="Total billed" value={formatMoney(totals.total_dollars)} />
          <Stat
            label="Rate in effect"
            value={
              activeAgreement
                ? `${formatMoney(activeAgreement.rate_per_unit)}/unit`
                : 'no active agreement'
            }
          />
        </div>

        <section className="card" id="claims">
          <div className="card-head">
            <div>
              <h2>Claims</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                {claims.length
                  ? `${claims.length} on file — Draft → Submitted → Paid`
                  : 'No claims yet — generate one from the days you have logged'}
              </p>
            </div>
            <div className="head-actions">
              <label className="checkbox" id="profile-claims-show-archived">
                <input
                  type="checkbox"
                  checked={showArchivedClaims}
                  onChange={(e) => setShowArchivedClaims(e.target.checked)}
                />
                Show Archived
              </label>
              <button className="btn primary" onClick={() => setShowGenerateClaim(true)}>
                Generate Claim
              </button>
            </div>
          </div>
          <ClaimsTable
            claims={claims}
            onEdit={setEditingClaim}
            onPdfChanged={async () => { await reload(); }}
            onArchive={requestClaimArchive}
            onDelete={requestClaimDelete}
            onChanged={reload}
            onError={setActionError}
            onNotify={flash}
            clientName={client ? `${client.first_name} ${client.last_name}`.trim() : undefined}
            emptyMessage="No claims yet. Use Generate Claim to sweep this client's logged days into a claim."
          />
        </section>

        {/* B1 — this client's denied / reversed claims. Hidden entirely at zero. */}
        {clientDenials.length > 0 && (
          <section className="card" id="client-denials">
            <div className="card-head">
              <div>
                <button
                  className="btn tiny ghost"
                  id="client-denials-toggle"
                  aria-expanded={denialsOpen}
                  onClick={() => setDenialsOpen((v) => !v)}
                >
                  {denialsOpen ? '▾' : '▸'} Denied / Reversed Claims ({clientDenials.length})
                </button>
              </div>
            </div>
            {denialsOpen && (
              <div className="table-scroll">
                <table className="ds-table" id="client-denials-table">
                  <thead>
                    <tr>
                      <th>Date</th><th>Status</th><th className="ds-num">Charge</th>
                      <th>Recovery</th><th>View</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientDenials.map((d) => (
                      <tr key={d.id} id={`client-denial-${d.id}`}>
                        <td className="nowrap">
                          {d.dos_start ? `${formatLongDate(d.dos_start)} – ${formatLongDate(d.dos_end)}` : '—'}
                        </td>
                        <td>
                          {d.claim_status === 'reversed' ? (
                            <span className="ds-badge ds-badge-solid-amber">REVERSED</span>
                          ) : (
                            <span className="ds-badge ds-badge-red">DENIED</span>
                          )}
                        </td>
                        <td className="ds-num">{formatMoney(d.total_charge)}</td>
                        <td>
                          {d.recovery_status === 'recovered' ? (
                            <span className="ds-badge ds-badge-green">Fully Recovered</span>
                          ) : d.recovery_status === 'partial' ? (
                            <span className="ds-badge ds-badge-amber">
                              Partial ({d.recovered ?? 0}/{d.items ?? 0})
                            </span>
                          ) : (
                            <span className="ds-badge ds-badge-red">
                              Unrecovered ({d.recovered ?? 0}/{d.items ?? 0})
                            </span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn tiny ghost"
                            id={`client-denial-view-${d.id}`}
                            onClick={async () => setDenialDetail(await api.denial(d.id))}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* the same detail modal the Denials tab uses */}
        {denialDetail && (
          <Modal
            title={`Denied claim ${denialDetail.denial?.ra_claim_number ?? ''}`}
            onClose={() => setDenialDetail(null)}
            width={720}
          >
            <div className="table-scroll">
              <table className="ds-table" id="client-denial-detail-table">
                <thead>
                  <tr><th>DOS</th><th>Procedure</th><th className="ds-num">Units</th><th className="ds-num">Billed</th><th>Recovered?</th></tr>
                </thead>
                <tbody>
                  {(denialDetail.line_items ?? []).map((li) => (
                    <tr key={li.id}>
                      <td className="nowrap">{formatLongDate(li.dos)}</td>
                      <td className="mono">{li.procedure_code ?? '—'}</td>
                      <td className="ds-num">{li.units ?? '—'}</td>
                      <td className="ds-num">{formatMoney(li.billed)}</td>
                      <td>{li.recovered ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button className="btn" onClick={() => setDenialDetail(null)}>Close</button>
            </div>
          </Modal>
        )}

        {/* ------------------------------------------------- danger zone */}
        <section className="card danger-zone" id="danger-zone">
          <div className="card-head">
            <div>
              <h2>Danger Zone</h2>
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                Archiving hides this client from the list and keeps every record. Deleting is
                permanent and is refused while any billing history exists.
              </p>
            </div>
          </div>
          <div className="danger-actions">
            <button
              className="btn"
              id="archive-client"
              onClick={toggleArchived}
              disabled={dangerBusy}
            >
              {client.archived ? 'Unarchive Client' : 'Archive Client'}
            </button>
            <button
              className="btn danger"
              id="delete-client"
              onClick={startDelete}
              disabled={dangerBusy}
            >
              Delete Client
            </button>
            {client.archived && (
              <span className="pill archived" id="profile-archived-badge">
                Archived
              </span>
            )}
          </div>
        </section>

      </div>

      {deleteCheck?.blocked && (
        <Modal
          title="Cannot delete this client"
          onClose={() => setDeleteCheck(null)}
          width={560}
        >
          <p id="delete-blocked-message">
            Cannot delete <strong>{deleteCheck.client_name}</strong>. They have{' '}
            <strong>{deleteCheck.claims}</strong> claim{deleteCheck.claims === 1 ? '' : 's'} and{' '}
            <strong>{deleteCheck.days}</strong> logged day
            {deleteCheck.days === 1 ? '' : 's'}. Please archive them instead to preserve billing
            history.
          </p>
          <div className="form-actions">
            <button
              className="btn primary"
              id="blocked-archive-instead"
              onClick={async () => {
                setDeleteCheck(null);
                await toggleArchived();
              }}
            >
              Archive instead
            </button>
            <button className="btn" onClick={() => setDeleteCheck(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && deleteCheck && (
        <Modal title="Delete client permanently?" onClose={() => setConfirmDelete(false)} width={560}>
          <p id="delete-confirm-message">
            Are you absolutely sure you want to permanently delete{' '}
            <strong>{deleteCheck.client_name}</strong>? This cannot be undone.
          </p>
          <p className="muted small">
            This client has no logged days and no claims, so no billing history will be lost.
            {deleteCheck.blockers?.agreements > 0 &&
              ` Their ${deleteCheck.blockers.agreements} agreement${
                deleteCheck.blockers.agreements === 1 ? '' : 's'
              } will be removed with them.`}
          </p>
          <div className="form-actions">
            <button className="btn" onClick={() => setConfirmDelete(false)} disabled={dangerBusy}>
              Cancel
            </button>
            <button className="btn danger" id="confirm-delete-client" onClick={doDelete} disabled={dangerBusy}>
              {dangerBusy ? 'Deleting…' : 'Permanently delete'}
            </button>
          </div>
        </Modal>
      )}

      {/*
        Tab 2 stays MOUNTED and is hidden with display:none rather than being
        unmounted. Unmounting would discard unsaved Hours/Minutes you had typed
        if you flicked over to the agreements tab and back.
      */}
      <div
        role="tabpanel"
        id="panel-schedule"
        aria-labelledby="tab-schedule"
        className="tab-panel"
        style={{ display: tab === TAB_SCHEDULE ? 'flex' : 'none' }}
      >
        <WeekCalendar
          initialWeek={weekParam}
          clientId={client.id}
          agreements={agreements}
          agreementId={agreementId}
          onSelectAgreement={setAgreementId}
          onRequestNewAgreement={openAgreementForm}
          onWeekChange={(from, to) => setWeekRange((w) => (w.from === from && w.to === to ? w : { from, to }))}
          denialMarkers={denialMarkers}
          scheduleView={scheduleView}
          onChooseView={chooseView}
          rebillCount={rebillItems.length}
          rebillSlot={
            <div className="card" id="rebill-list">
              <div className="card-head">
                <h2>Days needing rebill — Week of {formatLongDate(weekStartISO)}</h2>
              </div>
              {rebillItems.length === 0 ? (
                <div className="rebill-empty" id="rebill-empty">
                  <span className="tick" aria-hidden="true">✓</span>
                  <span>Nothing to rebill this week. All clear.</span>
                </div>
              ) : (
                <>
                  <div className="table-scroll">
                    <table className="ds-table" id="rebill-table">
                      <thead>
                        <tr>
                          <th>Date</th><th>Client</th><th>Procedure</th>
                          <th className="ds-num">Units</th><th className="ds-num">Billed</th>
                          <th className="ds-num">Days Open</th><th>View</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rebillItems.map((m) => (
                          <tr key={m.dos} id={`rebill-row-${m.dos}`}>
                            <td className="nowrap">{formatLongDate(m.dos)}</td>
                            <td>{m.client_name ?? '—'}</td>
                            <td className="mono">{m.procedure_code ?? '—'}</td>
                            <td className="ds-num">{m.units ?? '—'}</td>
                            <td className="ds-num">{formatMoney(m.billed ?? 0)}</td>
                            <td className="ds-num">
                              <span
                                className={
                                  m.days_open > 60
                                    ? 'days-open-red'
                                    : m.days_open >= 30
                                      ? 'days-open-amber'
                                      : 'days-open-gray'
                                }
                              >
                                {m.days_open}
                              </span>
                            </td>
                            <td>
                              <button
                                className="btn tiny ghost"
                                id={`rebill-view-${m.dos}`}
                                onClick={() => navigate(`/denials?open=${m.denied_claim_id}`)}
                              >
                                View
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted small" style={{ padding: '0 16px 14px' }}>
                    Recovered days in this week are shown in the{' '}
                    <button className="btn tiny ghost" id="rebill-to-calendar" onClick={() => chooseView('calendar')}>
                      Calendar
                    </button>{' '}
                    view.
                  </p>
                </>
              )}
            </div>
          }
        />
      </div>

      {showGenerateClaim && (
        <GenerateClaimDialog
          clientId={client.id}
          clientName={`${client.first_name} ${client.last_name}`}
          onClose={() => setShowGenerateClaim(false)}
          onGenerated={handleClaimGenerated}
        />
      )}

      {claimActionModals}

      {editingClaim && (
        <ClaimEditDialog
          claim={editingClaim}
          onClose={() => setEditingClaim(null)}
          onSaved={handleClaimSaved}
          onClaimChanged={() => reload()}
          onPdfChanged={async (updated) => {
            setEditingClaim(updated);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ClientEditForm({ client, onSaved, onCancel }) {
  const [form, setForm] = useState({
    first_name: client.first_name ?? '',
    last_name: client.last_name ?? '',
    dob: client.dob ?? '',
    ma_number: client.ma_number ?? '',
    middle_initial: client.middle_initial ?? '',
    diagnosis_code: client.diagnosis_code ?? '',
    alternative_names: client.alternative_names ?? '',
    notes: client.notes ?? '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First name and last name are required.');
      return;
    }
    setSaving(true);
    try {
      await api.updateClient(client.id, {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        dob: form.dob || null,
        ma_number: form.ma_number.trim() || null,
        middle_initial: form.middle_initial.trim() || null,
        diagnosis_code: form.diagnosis_code.trim() || null,
        alternative_names: form.alternative_names.trim() || null,
        notes: form.notes.trim() || null,
      });
      await onSaved?.();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form
      className="inline-form client-edit-form"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel?.();
      }}
    >
      <div className="grid-3">
        <label>
          First name <span className="required">required</span>
          <input
            name="first_name"
            value={form.first_name}
            onChange={set('first_name')}
            autoFocus
            required
          />
        </label>
        <label>
          Last name <span className="required">required</span>
          <input name="last_name" value={form.last_name} onChange={set('last_name')} required />
        </label>
        <label>
          Middle initial <span className="muted small">optional</span>
          <input
            name="middle_initial"
            value={form.middle_initial}
            maxLength={2}
            placeholder="E"
            onChange={set('middle_initial')}
          />
        </label>
        <label>
          Date of birth
          <input name="dob" type="date" value={form.dob} onChange={set('dob')} />
        </label>
        <label>
          MA number
          <input
            name="ma_number"
            value={form.ma_number}
            onChange={set('ma_number')}
            placeholder="123456789"
          />
        </label>
        <label className="span-2">
          Alternative Names / Nicknames{' '}
          <span className="muted small">comma-separated, e.g. Sarah Sims, Sarah Nnadikwe</span>
          <input
            name="alternative_names"
            value={form.alternative_names}
            onChange={set('alternative_names')}
            placeholder="Sarah Sims, Sarah Nnadikwe"
          />
        </label>
        <label className="span-2">
          Notes
          <input name="notes" value={form.notes} onChange={set('notes')} />
        </label>
        <label className="span-2">
          Diagnosis Code (DX) <span className="muted small">pipe-separated, e.g. F84.0|B19.10</span>
          <input
            name="diagnosis_code"
            value={form.diagnosis_code}
            onChange={set('diagnosis_code')}
            maxLength={208}
            placeholder="F84.0|B19.10"
          />
        </label>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="form-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <span className="muted small">Esc cancels</span>
      </div>
    </form>
  );
}

/* ------------------------------------------------------- case managers */

/**
 * Shows who coordinates this client's care, lets you reassign from the
 * existing list, and create a new case manager inline.
 */
function CaseManagerCard({ caseManager, form, setForm, onAssign, onSaved, onError }) {
  const [options, setOptions] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  const loadOptions = useCallback(async () => {
    setLoadingOptions(true);
    try {
      const d = await api.caseManagers();
      setOptions(d.case_managers);
    } catch {
      /* the dropdown degrades to just "none" */
    } finally {
      setLoadingOptions(false);
    }
  }, []);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const editing = form !== null;

  function openForm(mode) {
    setForm({
      mode,
      values: mode === 'edit' && caseManager
        ? {
            first_name: caseManager.first_name ?? '',
            last_name: caseManager.last_name ?? '',
            email: caseManager.email ?? '',
            phone: caseManager.phone ?? '',
            organization: caseManager.organization ?? '',
            notes: caseManager.notes ?? '',
            active: Boolean(caseManager.active),
          }
        : { first_name: '', last_name: '', email: '', phone: '', organization: '', notes: '', active: true },
    });
  }

  const fullName = (cm) => `${cm.first_name ?? ''} ${cm.last_name ?? ''}`.trim();

  return (
    <section className="card" id="case-manager">
      <div className="card-head">
        <div>
          <h2>Case Manager</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Who coordinates this client's care.
          </p>
        </div>
        {!editing && (
          <div className="head-actions">
            {caseManager && (
              <button className="btn" onClick={() => openForm('edit')}>
                Edit
              </button>
            )}
            <button className="btn primary" onClick={() => openForm('create')}>
              + Add Case Manager
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <CaseManagerForm
          title={form.mode === 'edit' ? 'Edit case manager' : 'Add case manager'}
          initial={form.values}
          existingId={form.mode === 'edit' ? caseManager?.id : null}
          onCancel={() => setForm(null)}
          onSaved={onSaved}
          onError={onError}
        />
      ) : (
        <>
          {caseManager ? (
            <div className="info-grid">
              <Field label="Name" value={fullName(caseManager)} />
              <Field label="Organization" value={caseManager.organization ?? '—'} />
              <Field label="Email" value={caseManager.email ?? '—'} />
              <Field label="Phone" value={caseManager.phone ?? '—'} />
            </div>
          ) : (
            <p className="empty">
              No case manager assigned. Pick one below or add a new one.
            </p>
          )}

          <div className="case-manager-assign">
            <label className="inline-label">
              Assign case manager
              <select
                name="case_manager_id"
                value={caseManager?.id ?? ''}
                onChange={(e) => onAssign(e.target.value)}
              >
                <option value="">— none —</option>
                {options.map((cm) => (
                  <option key={cm.id} value={cm.id}>
                    {fullName(cm)}
                    {cm.organization ? ` · ${cm.organization}` : ''}
                  </option>
                ))}
                {/* Keep an inactive-but-assigned manager selectable. */}
                {caseManager && !options.some((o) => o.id === caseManager.id) && (
                  <option value={caseManager.id}>{fullName(caseManager)} (inactive)</option>
                )}
              </select>
            </label>
            {loadingOptions && <span className="muted small">loading…</span>}
            {caseManager?.notes && (
              <span className="muted small">Notes: {caseManager.notes}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CaseManagerForm({ title, initial, existingId, onCancel, onSaved, onError }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First and last name are required.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        organization: form.organization.trim() || null,
        notes: form.notes.trim() || null,
        active: form.active,
      };
      const saved = existingId
        ? await api.updateCaseManager(existingId, body)
        : await api.createCaseManager(body);
      await onSaved?.(saved);
    } catch (err) {
      setError(err.message);
      onError?.(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="inline-form case-manager-form" onSubmit={submit}>
      <div className="form-title">
        <h3>{title}</h3>
      </div>
      <div className="grid-3">
        <label>
          First name <span className="required">required</span>
          <input name="cm_first_name" value={form.first_name} onChange={set('first_name')} autoFocus />
        </label>
        <label>
          Last name <span className="required">required</span>
          <input name="cm_last_name" value={form.last_name} onChange={set('last_name')} />
        </label>
        <label>
          Organization
          <input name="cm_organization" value={form.organization} onChange={set('organization')} />
        </label>
        <label>
          Email
          <input name="cm_email" type="email" value={form.email} onChange={set('email')} placeholder="name@example.org" />
        </label>
        <label>
          Phone
          <input name="cm_phone" value={form.phone} onChange={set('phone')} placeholder="555-0100" />
        </label>
        <label>
          Notes
          <input name="cm_notes" value={form.notes} onChange={set('notes')} />
        </label>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save case manager'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function BackLink() {
  return (
    <Link className="link-back" to="/clients" style={{ textDecoration: 'none' }}>
      ← Back to Client List
    </Link>
  );
}

function Field({ label, value, mono }) {
  return (
    <div className="info-field">
      <span className="meta-label">{label}</span>
      <span className={mono ? 'mono' : undefined}>{value}</span>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
