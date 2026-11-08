import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import Modal from '../components/Modal.jsx';
import { SkeletonCards } from '../components/Skeleton.jsx';
import { toast } from '../components/Toast.jsx';

const STEPS = ['Personal Info', 'Checklist', 'Save'];

/**
 * Tasks + new-hire onboarding.
 *
 * The wizard exists so a job that touches four tables feels like one action:
 * fill in a name, confirm the document list, done. Progress is always visible
 * on the card so nobody has to open a task to find out what is outstanding.
 */
export default function Tasks() {
  const [data, setData] = useState({ tasks: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [wizard, setWizard] = useState(null);
  const [general, setGeneral] = useState(null);
  const [uploading, setUploading] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.tasks();
      setData(d && Array.isArray(d.tasks) ? d : { tasks: [] });
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function autofillFromFile(file) {
    if (!file) return;
    setWizard((w) => (w ? { ...w, parsing: true, error: null } : w));
    try {
      const r = await api.parseNewHire(file);
      setWizard((w) => {
        if (!w) return w;
        const next = { ...w.form };
        let filled = 0;
        for (const [k, v] of Object.entries(r.fields ?? {})) {
          if (v) { next[k] = v; filled += 1; }
        }
        return { ...w, parsing: false, parsed: filled > 0, form: next };
      });
      if (r.extracted_any) toast.success('Form filled from the document.');
      else toast.error('Could not read any fields from that document.');
    } catch (e) {
      setWizard((w) => (w ? { ...w, parsing: false, error: e.message } : w));
      toast.error(e.message);
    }
  }

  async function openNewHire() {
    setMenuOpen(false);
    setWizard({
      step: 0,
      form: {
        first_name: '',
        last_name: '',
        dob: '',
        ssn: '',
        dl_number: '',
        street_address: '',
        city: '',
        state: 'MN',
        zip: '',
        phone: '',
        due_date: '',
      },
      busy: false,
      error: null,
      parsing: false,
      parsed: false,
    });
  }

  async function saveWizard() {
    const f = wizard.form;
    if (!f.first_name.trim() || !f.last_name.trim()) {
      setWizard((w) => ({ ...w, error: 'First and last name are required.' }));
      return;
    }
    setWizard((w) => ({ ...w, busy: true, error: null }));
    try {
      const res = await api.createNewHire(f);
      setWizard(null);
      toast.success(`Onboarding task created for ${f.first_name} ${f.last_name}.`);
      await load();
    } catch (e) {
      setWizard((w) => ({ ...w, busy: false, error: e.message }));
      toast.error(e.message);
    }
  }

  async function uploadItem(taskId, itemId, file) {
    if (!file) return;
    setUploading(`${taskId}:${itemId}`);
    setError(null);
    try {
      const res = await api.uploadTaskItem(taskId, itemId, file);
      await load();
      if (res.caretaker_activated) {
        toast.success('All documents received — caregiver is now Active.');
      } else if (res.npi_number) {
        toast.success(`NPI ${res.npi_number} captured from the letter.`);
      } else {
        toast.success('Document uploaded.');
      }
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setUploading(null);
    }
  }

  function openGeneral() {
    setMenuOpen(false);
    setGeneral({
      form: { title: '', due_date: '', notes: '' },
      file: null,
      busy: false,
      error: null,
    });
  }

  async function saveGeneral() {
    const f = general.form;
    if (!f.title.trim()) {
      setGeneral((g) => ({ ...g, error: 'A title is required.' }));
      return;
    }
    setGeneral((g) => ({ ...g, busy: true, error: null }));
    try {
      const res = await api.createGeneralTask(f, general.file);
      setGeneral(null);
      toast.success(
        res.ai_summary ? 'Task created and summarized.' : 'Task created.'
      );
      await load();
    } catch (e) {
      setGeneral((g) => ({ ...g, busy: false, error: e.message }));
      toast.error(e.message);
    }
  }

  const tasks = data.tasks ?? [];

  return (
    <div className="page wide" id="tasks-page">
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p className="muted">Onboarding checklists and outstanding work.</p>
        </div>
        <div className="head-actions" style={{ position: 'relative' }}>
          <button className="btn primary" id="new-task-toggle" onClick={() => setMenuOpen((v) => !v)}>
            + New Task
          </button>
          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="new-task-menu" id="new-task-menu">
                <button className="menu-item" id="menu-new-hire" onClick={openNewHire}>
                  New Hire
                </button>
                <button className="menu-item" id="menu-general-task" onClick={openGeneral}>
                  General Task
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {notice && (
        <div className="alert ok" id="tasks-notice">
          {notice}
        </div>
      )}

      {loading ? (
        <SkeletonCards count={3} />
      ) : tasks.length === 0 ? (
        <div className="card">
          <div className="empty-state" id="tasks-empty">
            <div className="empty-state-icon" aria-hidden="true">☑</div>
            <p className="empty-state-title">No tasks yet</p>
            <p className="muted small">Click <strong>+ New Task</strong> to get started.</p>
          </div>
        </div>
      ) : (
        <div className="task-cards" id="task-cards">
          {tasks.map((t) => {
            const done = t.completed_items ?? 0;
            const total = t.total_items ?? 0;
            const pct = total ? Math.round((done / total) * 100) : 0;
            const caretaker = [t.caretaker_first, t.caretaker_last].filter(Boolean).join(' ');
            return (
              <div className="task-card" key={t.id} id={`task-card-${t.id}`}>
                <div className="task-card-top">
                  <strong className="task-card-title">{t.title}</strong>
                  <span
                    className={`pill ${t.status === 'completed' ? 'ok' : 'pending'}`}
                    id={`task-status-${t.id}`}
                  >
                    {t.status === 'completed' ? 'Completed' : 'Pending'}
                  </span>
                </div>

                <div className="task-card-meta">
                  {caretaker && <span>{caretaker}</span>}
                  {t.due_date && <span>Due {t.due_date}</span>}
                  {t.caretaker_status && (
                    <span className={`pill tiny ${t.caretaker_status === 'Active' ? 'ok' : 'pending'}`}>
                      {t.caretaker_status}
                    </span>
                  )}
                </div>

                <div className="task-progress">
                  <div className="task-progress-bar">
                    <div className="task-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="task-progress-label">
                    {done}/{total} completed
                  </span>
                </div>

                <ul className="task-checklist">
                  {(t.items ?? []).map((i) => {
                    const busy = uploading === `${t.id}:${i.id}`;
                    return (
                      <li key={i.id} className={i.is_completed ? 'done' : ''}>
                        <span className="task-check">{i.is_completed ? '✓' : '○'}</span>
                        <span className="task-item-label">{i.label}</span>
                        {i.document_path ? (
                          <a
                            className="link small"
                            href={`/${i.document_path}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        ) : (
                          <label className="task-upload">
                            <input
                              type="file"
                              id={`upload-${t.id}-${i.id}`}
                              disabled={busy}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                uploadItem(t.id, i.id, f);
                              }}
                            />
                            <span className={`btn tiny ${busy ? '' : 'ghost'}`}>
                              {busy ? 'Uploading…' : 'Upload'}
                            </span>
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {t.ai_summary && (
                  <p className="task-summary" id={`task-summary-${t.id}`}>
                    {t.ai_summary}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {general && (
        <Modal title="General Task" onClose={() => setGeneral(null)} width={520}>
          <div className="wizard" id="general-task-form">
            {general.error && <div className="alert error">{general.error}</div>}
            <div className="wizard-body">
              <label>
                Title <span className="required">required</span>
                <input
                  id="general-title"
                  value={general.form.title}
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, form: { ...g.form, title: e.target.value } }))
                  }
                />
              </label>
              <label>
                Due date
                <input
                  type="date"
                  id="general-due"
                  value={general.form.due_date}
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, form: { ...g.form, due_date: e.target.value } }))
                  }
                />
              </label>
              <label>
                Notes
                <input
                  id="general-notes"
                  value={general.form.notes}
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, form: { ...g.form, notes: e.target.value } }))
                  }
                />
              </label>
              <label>
                Attach a document (optional)
                <input
                  type="file"
                  id="general-file"
                  onChange={(e) =>
                    setGeneral((g) => ({ ...g, file: e.target.files?.[0] ?? null }))
                  }
                />
              </label>
              <p className="muted small">
                If a document is attached, a two-sentence summary is generated automatically.
              </p>
            </div>
            <div className="wizard-actions">
              <button className="btn" onClick={() => setGeneral(null)} disabled={general.busy}>
                Cancel
              </button>
              <button
                className="btn primary"
                id="general-save"
                disabled={general.busy}
                onClick={saveGeneral}
              >
                {general.busy ? 'Creating…' : 'Create Task'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {wizard && (
        <Modal
          title="New Hire"
          onClose={() => setWizard(null)}
          width={560}
        >
          <div className="wizard" id="new-hire-wizard">
            <ol className="wizard-steps">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={i === wizard.step ? 'current' : i < wizard.step ? 'done' : ''}
                >
                  <span className="wizard-step-num">{i < wizard.step ? '✓' : i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>

            {wizard.error && <div className="alert error">{wizard.error}</div>}

            {wizard.step === 0 && (
              <div className="wizard-body">
                <div className="wizard-autofill" id="wizard-autofill">
                  <label htmlFor="wizard-autofill-file">
                    Upload ID or Resume to Auto-Fill
                  </label>
                  {wizard.parsing ? (
                    <span className="hint" id="wizard-autofill-busy">
                      AI is reading document…
                    </span>
                  ) : (
                    <>
                      <input
                        id="wizard-autofill-file"
                        type="file"
                        accept=".pdf,.txt,image/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          autofillFromFile(f);
                        }}
                      />
                      <span className="hint">
                        {wizard.parsed
                          ? 'Fields filled below — review and correct anything that looks wrong.'
                          : 'Optional. We will read the document and fill the fields below.'}
                      </span>
                    </>
                  )}
                </div>

                <div className="grid-2">
                  <label>
                    First name <span className="required">required</span>
                    <input
                      id="wizard-first"
                      value={wizard.form.first_name}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, first_name: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    Last name <span className="required">required</span>
                    <input
                      id="wizard-last"
                      value={wizard.form.last_name}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, last_name: e.target.value } }))
                      }
                    />
                  </label>
                </div>
                <div className="grid-2">
                  <label>
                    Date of birth
                    <input
                      type="date"
                      id="wizard-dob"
                      value={wizard.form.dob}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, dob: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    SSN
                    <input
                      id="wizard-ssn"
                      placeholder="XXX-XX-XXXX"
                      value={wizard.form.ssn}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, ssn: e.target.value } }))
                      }
                    />
                  </label>
                </div>
                <div className="grid-2">
                  <label>
                    Driver's licence
                    <input
                      id="wizard-dl"
                      value={wizard.form.dl_number}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, dl_number: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      id="wizard-phone"
                      value={wizard.form.phone}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, phone: e.target.value } }))
                      }
                    />
                  </label>
                </div>
                <label>
                  Street address
                  <input
                    id="wizard-street"
                    value={wizard.form.street_address}
                    onChange={(e) =>
                      setWizard((w) => ({ ...w, form: { ...w.form, street_address: e.target.value } }))
                    }
                  />
                </label>
                <div className="grid-3">
                  <label>
                    City
                    <input
                      id="wizard-city"
                      value={wizard.form.city}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, city: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    State
                    <input
                      id="wizard-state"
                      value={wizard.form.state}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, state: e.target.value } }))
                      }
                    />
                  </label>
                  <label>
                    ZIP
                    <input
                      id="wizard-zip"
                      value={wizard.form.zip}
                      onChange={(e) =>
                        setWizard((w) => ({ ...w, form: { ...w.form, zip: e.target.value } }))
                      }
                    />
                  </label>
                </div>
                <label>
                  Due date
                  <input
                    type="date"
                    id="wizard-due"
                    value={wizard.form.due_date}
                    onChange={(e) =>
                      setWizard((w) => ({ ...w, form: { ...w.form, due_date: e.target.value } }))
                    }
                  />
                </label>
              </div>
            )}

            {wizard.step === 1 && (
              <div className="wizard-body">
                <p className="muted small">
                  These documents will be created as checklist items. The caregiver becomes Active
                  when the last one is uploaded.
                </p>
                <ul className="wizard-checklist" id="wizard-checklist">
                  {[
                    'Background Check Clearance',
                    'Fingerprinting Completion',
                    'PCA/CFSS Worker Certificate',
                    'NPI Letter',
                  ].map((label, i) => (
                    <li key={label}>
                      <span className="wizard-check-num">{i + 1}</span>
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {wizard.step === 2 && (
              <div className="wizard-body">
                <p>
                  Create the caregiver record and the onboarding task together?
                </p>
                <dl className="wizard-summary">
                  <dt>Name</dt>
                  <dd>
                    {wizard.form.first_name} {wizard.form.last_name}
                  </dd>
                  <dt>Date of birth</dt>
                  <dd>{wizard.form.dob || '—'}</dd>
                  <dt>SSN</dt>
                  <dd>{wizard.form.ssn || '—'}</dd>
                  <dt>Driver's licence</dt>
                  <dd>{wizard.form.dl_number || '—'}</dd>
                  <dt>Address</dt>
                  <dd>
                    {[wizard.form.street_address, wizard.form.city, wizard.form.state, wizard.form.zip]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    <span className="pill pending">Pending</span> until all 4 documents are uploaded
                  </dd>
                </dl>
              </div>
            )}

            <div className="wizard-actions">
              {wizard.step > 0 && (
                <button
                  className="btn"
                  id="wizard-back"
                  disabled={wizard.busy}
                  onClick={() => setWizard((w) => ({ ...w, step: w.step - 1 }))}
                >
                  Back
                </button>
              )}
              {wizard.step < 2 ? (
                <button
                  className="btn primary"
                  id="wizard-next"
                  onClick={() => setWizard((w) => ({ ...w, step: w.step + 1, error: null }))}
                >
                  Continue
                </button>
              ) : (
                <button className="btn primary" id="wizard-save" disabled={wizard.busy} onClick={saveWizard}>
                  {wizard.busy ? 'Saving…' : 'Create New Hire'}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
