import React, { useState } from 'react';
import api from '../api.js';
import Modal from './Modal.jsx';
import { clientLabel } from './ClaimActionModals.jsx';

/**
 * Bulk archive / delete for the claims table.
 *
 * Rendered inside ClaimsTable, so the dashboard and the client profile each get
 * their own independent selection and bar.
 */
export default function BulkClaimActions({
  selected = [],
  onClear,
  onDone,
  onError,
  onNotify,
  clientName,
}) {
  const [mode, setMode] = useState(null); // 'archive' | 'unarchive' | 'delete' | 'blocked'
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [unarchiveNote, setUnarchiveNote] = useState(null);
  const [deleteNote, setDeleteNote] = useState(null);

  if (!selected.length) return null;

  const count = selected.length;
  const toArchive = selected.filter((c) => !c.archived);
  const alreadyArchived = count - toArchive.length;
  const archivedSelected = selected.filter((c) => c.archived);
  const nameFor = clientName ?? clientLabel(selected[0]);

  function close() {
    setMode(null);
    setTyped('');
    setNote(null);
    setUnarchiveNote(null);
  }

  /** Unarchive asks first, and warns when a new claim took over the days. */
  async function startUnarchive() {
    try {
      const check = await api.bulkUnarchiveCheck(selected.map((c) => c.id));
      setUnarchiveNote(check);
      setMode('unarchive');
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function confirmUnarchive() {
    setBusy(true);
    try {
      const r = await api.bulkUnarchiveClaims(selected.map((c) => c.id));
      close();
      onClear?.();
      await onDone?.();
      onNotify?.(
        r.skipped
          ? `${r.unarchived} claims restored. ${r.skipped} were not archived and were skipped.`
          : `${r.unarchived} claims restored.`
      );
    } catch (e) {
      close();
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmArchive() {
    setBusy(true);
    try {
      const ids = selected.map((c) => c.id);
      const r = await api.bulkArchiveClaims(ids);
      close();
      onClear?.();
      await onDone?.();
      onNotify?.(
        r.already_archived
          ? `${r.archived} claims archived. ${r.already_archived} were already archived.`
          : `${r.archived} claims archived.`
      );
    } catch (e) {
      close();
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Delete asks the backend first: one linked claim blocks the whole batch. */
  async function startDelete() {
    setNote(null);
    try {
      const check = await api.bulkDeleteCheck(selected.map((c) => c.id));
      if (!check.deletable) {
        setNote(check);
        setMode('blocked');
      } else {
        setDeleteNote(check);
        setTyped('');
        setMode('delete');
      }
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const r = await api.bulkDeleteClaims(selected.map((c) => c.id));
      close();
      onClear?.();
      await onDone?.();
      window.dispatchEvent(new Event('data-updated'));
      if (r.skipped) {
        onNotify?.(
          `${r.deleted_archived ?? r.deleted} archived claims deleted. ${r.skipped} non-archived ` +
            'claims skipped (archive them first).'
        );
      } else {
        onNotify?.(`${r.deleted} claims permanently deleted.`);
      }
    } catch (e) {
      close();
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bulk-bar" id="claims-bulk-bar">
        <div className="bulk-inner">
          <span className="bulk-count" id="claims-bulk-count">
            {count} claim{count === 1 ? '' : 's'} selected.
          </span>
          <button
            className="btn primary"
            id="bulk-archive-claims"
            onClick={() => setMode('archive')}
            disabled={toArchive.length === 0}
            title={toArchive.length === 0 ? 'All selected claims are already archived' : ''}
          >
            Archive Selected
          </button>
          {archivedSelected.length > 0 && (
            <button
              className="btn primary"
              id="bulk-unarchive-claims"
              onClick={startUnarchive}
            >
              Unarchive Selected
            </button>
          )}
          <button className="btn danger" id="bulk-delete-claims" onClick={startDelete}>
            Delete Selected
          </button>
          <button className="btn" id="bulk-clear-claims" onClick={onClear}>
            Clear Selection
          </button>
        </div>
      </div>

      {mode === 'archive' && (
        <Modal title="Archive Claims?" onClose={close} width={620}>
          {toArchive.length ? (
            <p id="bulk-archive-intro">
              You are about to archive <strong>{toArchive.length}</strong> claim
              {toArchive.length === 1 ? '' : 's'}.
            </p>
          ) : (
            <p id="bulk-archive-intro">
              <strong>All {count} selected claims are already archived.</strong>
            </p>
          )}
          <p style={{ marginBottom: 4 }}>
            <strong>This will:</strong>
          </p>
          <ul className="plain-list" id="bulk-archive-effects">
            <li>Remove them from the Claims Dashboard</li>
            <li>Hide them from client profiles</li>
            <li>Unlock the linked day entries on the calendar</li>
            <li>Exclude them from Reports and HHAeXchange exports</li>
          </ul>
          {alreadyArchived > 0 && (
            <div className="alert warn" id="bulk-archive-warning">
              {alreadyArchived} of these {alreadyArchived === 1 ? 'is' : 'are'} already archived.
            </div>
          )}
          <p className="muted small">
            This does NOT delete any data. You can unarchive them later.
          </p>
          <div className="form-actions">
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              id="confirm-bulk-archive"
              onClick={confirmArchive}
              disabled={busy || toArchive.length === 0}
            >
              {busy ? 'Archiving…' : `Archive ${toArchive.length} Claim${toArchive.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </Modal>
      )}

      {mode === 'unarchive' && (
        <Modal title="Restore Archived Claims?" onClose={close} width={620}>
          <p id="bulk-unarchive-intro">
            You are about to restore <strong>{unarchiveNote?.archived_count ?? 0}</strong> archived
            claim{(unarchiveNote?.archived_count ?? 0) === 1 ? '' : 's'}.
          </p>
          <p style={{ marginBottom: 4 }}>
            <strong>This will:</strong>
          </p>
          <ul className="plain-list" id="bulk-unarchive-effects">
            <li>Make them visible on the Claims Dashboard</li>
            <li>Show them on the client&apos;s profile</li>
            <li>Re-lock the linked day entries as &apos;on claim&apos;</li>
            <li>Include them in Reports and HHAeXchange exports</li>
          </ul>
          {(unarchiveNote?.not_archived_count ?? 0) > 0 && (
            <div className="alert warn" id="bulk-unarchive-skip-warning">
              {unarchiveNote.not_archived_count} of the selected claims are not archived and will be
              skipped.
            </div>
          )}
          {(unarchiveNote?.conflict_count ?? 0) > 0 && (
            <div className="alert warn" id="bulk-unarchive-conflict-warning">
              <strong>Warning:</strong> {unarchiveNote.conflict_count} day entr
              {unarchiveNote.conflict_count === 1 ? 'y is' : 'ies are'} in this claim&apos;s period
              now linked to another claim. Unarchiving may create a conflict.
              <ul className="plain-list" style={{ margin: '6px 0 0' }}>
                {unarchiveNote.conflicting_claims.map((c) => (
                  <li key={c.id}>
                    {c.claim_name ?? `#${c.id}`} — {c.entries} day
                    {c.entries === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              id="confirm-bulk-unarchive"
              onClick={confirmUnarchive}
              disabled={busy || !(unarchiveNote?.archived_count > 0)}
            >
              {busy
                ? 'Restoring…'
                : `Restore ${unarchiveNote?.archived_count ?? 0} Claim${
                    (unarchiveNote?.archived_count ?? 0) === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        </Modal>
      )}

      {mode === 'blocked' && (
        <Modal title="Cannot delete these claims" onClose={close} width={580}>
          <p id="bulk-delete-blocked">
            <strong>{note?.blocked_count}</strong> of the selected claims have linked day entries and
            cannot be deleted. Archive them instead?
          </p>
          <div className="form-actions">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn primary"
              id="bulk-archive-instead"
              onClick={() => setMode('archive')}
            >
              Archive Instead
            </button>
          </div>
        </Modal>
      )}

      {mode === 'delete' && (
        <Modal title="⚠ Permanently Delete Claims?" onClose={close} width={620}>
          <p id="bulk-delete-intro">
            ⚠ You are about to permanently delete <strong>{count}</strong> claim
            {count === 1 ? '' : 's'}. This is irreversible.
          </p>
          <p className="muted small">
            {nameFor} · {count} claim{count === 1 ? '' : 's'} will be removed from every view,
            Reports and HHAeXchange exports.
          </p>
          {(deleteNote?.blocked_count ?? 0) > 0 && (
            <div className="alert warn" id="bulk-delete-skip-warning">
              {deleteNote.blocked_count} non-archived claim
              {deleteNote.blocked_count === 1 ? '' : 's'} with linked day entries will be skipped
              (archive {deleteNote.blocked_count === 1 ? 'it' : 'them'} first).
            </div>
          )}
          <p className="muted small" id="bulk-delete-keep-note">
            Archived claims will be removed. Their <strong>{deleteNote?.ra_import_entries ?? 0}</strong>{' '}
            RA-imported schedule entr{(deleteNote?.ra_import_entries ?? 0) === 1 ? 'y' : 'ies'} will be
            deleted, and their <strong>{deleteNote?.manual_entries ?? 0}</strong> manually-entered day
            entr{(deleteNote?.manual_entries ?? 0) === 1 ? 'y' : 'ies'} preserved as unclaimed.
          </p>
          <label className="delete-type">
            Type DELETE to confirm:
            <input
              type="text"
              id="bulk-delete-input"
              name="bulk-delete-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder="DELETE"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn danger"
              id="confirm-bulk-delete"
              onClick={confirmDelete}
              disabled={typed !== 'DELETE' || busy}
              title={typed === 'DELETE' ? '' : 'Type DELETE to enable'}
            >
              {busy ? 'Deleting…' : `Delete ${count} Claim${count === 1 ? '' : 's'} Permanently`}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
