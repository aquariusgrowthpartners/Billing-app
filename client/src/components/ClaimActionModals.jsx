import React, { useState } from 'react';
import api from '../api.js';
import Modal from './Modal.jsx';

/** Best-effort client label for a claim row. */
export function clientLabel(claim) {
  const fromRow = `${claim?.first_name ?? ''} ${claim?.last_name ?? ''}`.trim();
  if (fromRow) return fromRow;
  return claim?.client_name ?? 'this client';
}

/**
 * Archive / delete actions for a claim, with the confirmation flow.
 *
 * Shared by the Claims Dashboard and the client profile so both behave
 * identically. Returns the two request handlers plus the modals element to drop
 * into the page.
 *
 *   const { requestArchive, requestDelete, modals } = useClaimActions({...});
 */
export function useClaimActions({ onChanged, onError, onNotify, clientName }) {
  const [archiveTarget, setArchiveTarget] = useState(null); // { claim, linked_entries }
  const [deleteBlocked, setDeleteBlocked] = useState(null); // { claim, linked_entries }
  const [deleteTarget, setDeleteTarget] = useState(null); // { claim }
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  /** Archive asks first; unarchive is immediate (nothing is destructive). */
  async function requestArchive(claim) {
    if (claim.archived) {
      setBusy(true);
      try {
        await api.setClaimArchived(claim.id, false);
        await onChanged?.();
        onNotify?.('Claim restored.');
      } catch (e) {
        onError?.(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      const check = await api.claimDeleteCheck(claim.id);
      setArchiveTarget({ claim, linked_entries: check.linked_entries ?? 0 });
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function confirmArchive() {
    const claim = archiveTarget.claim;
    setBusy(true);
    try {
      await api.setClaimArchived(claim.id, true);
      setArchiveTarget(null);
      await onChanged?.();
      onNotify?.('Claim archived.');
    } catch (e) {
      setArchiveTarget(null);
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Delete is blocked outright while day entries still point at the claim. */
  async function requestDelete(claim) {
    try {
      const check = await api.claimDeleteCheck(claim.id);
      if (!check.deletable) {
        setDeleteBlocked({ claim, linked_entries: check.linked_entries ?? 0 });
      } else {
        setTyped('');
        // An archived claim gets its own wording: it will take its day entries
        // off the claim but leave them on the calendar.
        setDeleteTarget({
          claim,
          archived: Boolean(check.archived),
          linked_entries: check.linked_entries ?? 0,
          ra_import_entries: check.ra_import_entries ?? 0,
          manual_entries: check.manual_entries ?? 0,
        });
      }
    } catch (e) {
      onError?.(e.message);
    }
  }

  async function confirmDelete() {
    const claim = deleteTarget.claim;
    setBusy(true);
    try {
      await api.deleteClaim(claim.id);
      setDeleteTarget(null);
      setTyped('');
      await onChanged?.();
      // The calendar, caretaker totals and Home Dashboard all derive from the
      // entries this may have removed, so tell them to refetch.
      window.dispatchEvent(new Event('data-updated'));
      onNotify?.('Claim permanently deleted.');
    } catch (e) {
      setDeleteTarget(null);
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  const canDelete = typed === 'DELETE';

  const modals = (
    <>
      {archiveTarget && (
        <Modal title="Archive Claim?" onClose={() => setArchiveTarget(null)} width={600}>
          <p id="archive-confirm-intro">
            This will archive claim{' '}
            <strong>{archiveTarget.claim.claim_name ?? `#${archiveTarget.claim.id}`}</strong> for{' '}
            <strong>{clientName ?? clientLabel(archiveTarget.claim)}</strong>.
          </p>
          <p style={{ marginBottom: 4 }}>
            <strong>This action will:</strong>
          </p>
          <ul className="plain-list" id="archive-confirm-effects">
            <li>Remove the claim from the Claims Dashboard</li>
            <li>Hide it from the client&apos;s profile</li>
            <li>
              Unlock <strong>{archiveTarget.linked_entries}</strong> day entr
              {archiveTarget.linked_entries === 1 ? 'y' : 'ies'} on the calendar so a new claim can
              be generated
            </li>
            <li>Exclude it from Reports and HHAeXchange exports</li>
          </ul>
          <p className="muted small">
            This does NOT delete any data. You can unarchive it later.
          </p>
          <div className="form-actions">
            <button className="btn" onClick={() => setArchiveTarget(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              id="confirm-archive-claim"
              onClick={confirmArchive}
              disabled={busy}
            >
              {busy ? 'Archiving…' : 'Archive Claim'}
            </button>
          </div>
        </Modal>
      )}

      {deleteBlocked && (
        <Modal title="Cannot delete this claim" onClose={() => setDeleteBlocked(null)} width={560}>
          <p id="claim-delete-blocked">
            Cannot delete this claim. It has <strong>{deleteBlocked.linked_entries}</strong> linked
            day entr{deleteBlocked.linked_entries === 1 ? 'y' : 'ies'}. Archive it instead to
            preserve billing history.
          </p>
          <div className="form-actions">
            <button
              className="btn primary"
              id="claim-archive-instead"
              onClick={async () => {
                const claim = deleteBlocked.claim;
                setDeleteBlocked(null);
                await requestArchive(claim);
              }}
            >
              Archive Instead
            </button>
            <button className="btn" onClick={() => setDeleteBlocked(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && deleteTarget.archived && (
        <Modal
          title="⚠ Permanently Delete Archived Claim?"
          onClose={() => setDeleteTarget(null)}
          width={620}
        >
          <p id="delete-archived-intro">
            <strong>Claim:</strong> {deleteTarget.claim.claim_name ?? `#${deleteTarget.claim.id}`}
            <br />
            <strong>Client:</strong> {clientName ?? clientLabel(deleteTarget.claim)}
          </p>
          <p style={{ marginBottom: 4 }}>
            <strong>This will:</strong>
          </p>
          <ul className="plain-list" id="delete-archived-effects">
            <li>Permanently remove the claim</li>
            <li id="delete-archived-ra">
              DELETE the <strong>{deleteTarget.ra_import_entries}</strong> RA-imported schedule
              entr{deleteTarget.ra_import_entries === 1 ? 'y' : 'ies'} (hours, caretaker
              assignments, and calendar entries created by the RA import)
            </li>
            <li id="delete-archived-manual">
              PRESERVE <strong>{deleteTarget.manual_entries}</strong> manually-entered day entr
              {deleteTarget.manual_entries === 1 ? 'y' : 'ies'} (they will become unclaimed)
            </li>
            <li>Remove it from Reports totals</li>
            <li>Remove it from HHAeXchange exports</li>
          </ul>
          <label className="delete-type">
            Type DELETE to confirm:
            <input
              type="text"
              id="delete-confirm-input"
              name="delete-confirm-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder="DELETE"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => setDeleteTarget(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn danger"
              id="confirm-delete-claim"
              onClick={confirmDelete}
              disabled={!canDelete || busy}
              title={canDelete ? '' : 'Type DELETE to enable'}
            >
              {busy ? 'Deleting…' : 'Delete Permanently'}
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && !deleteTarget.archived && (
        <Modal title="⚠ Permanently Delete Claim?" onClose={() => setDeleteTarget(null)} width={600}>
          <p id="delete-confirm-intro">
            You are about to permanently delete claim{' '}
            <strong>{deleteTarget.claim.claim_name ?? `#${deleteTarget.claim.id}`}</strong> for{' '}
            <strong>{clientName ?? clientLabel(deleteTarget.claim)}</strong>.
          </p>
          <p style={{ marginBottom: 4 }}>
            <strong>This is irreversible. It will:</strong>
          </p>
          <ul className="plain-list" id="delete-confirm-effects">
            <li>Delete the claim from all views</li>
            <li>Remove it from Reports totals</li>
            <li>Remove it from HHAeXchange exports</li>
          </ul>
          <label className="delete-type">
            Type the word DELETE below to confirm:
            <input
              type="text"
              id="delete-confirm-input"
              name="delete-confirm-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder="DELETE"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => setDeleteTarget(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn danger"
              id="confirm-delete-claim"
              onClick={confirmDelete}
              disabled={!canDelete || busy}
              title={canDelete ? '' : 'Type DELETE to enable'}
            >
              {busy ? 'Deleting…' : 'Delete Permanently'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );

  return { requestArchive, requestDelete, modals };
}

export default useClaimActions;
