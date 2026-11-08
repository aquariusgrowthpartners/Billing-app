import React, { useRef, useState } from 'react';
import api from '../api.js';

/**
 * PDF documents for one claim. There are two independent slots:
 *
 *   generated — built by the server from the claim's own data (regenerable)
 *   upload    — a PDF you attached by hand (e.g. a signed scan)
 *
 * They are stored under different names so one never overwrites the other.
 * Everything stays on this machine.
 */
export default function ClaimPdfControl({ claim, onChanged, compact = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const uploaded = Boolean(claim.local_pdf_path);
  const generated = Boolean(claim.generated_pdf_path);
  const uploadedName = uploaded ? claim.local_pdf_path.split('/').pop() : null;
  const generatedName = generated ? claim.generated_pdf_path.split('/').pop() : null;

  function flashNote(message) {
    setNote(message);
    setTimeout(() => setNote(null), 2500);
  }

  /** Trigger a browser download without a popup blocker getting in the way. */
  function saveAs(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function generateAndDownload() {
    setError(null);
    setGenerating(true);
    try {
      const { claim: updated, file } = await api.generateClaimPdf(claim.id);
      onChanged?.(updated);
      saveAs(
        api.claimGeneratedPdfUrl(claim.id, { download: true }),
        file?.name ? file.name.replace(/_claim\.pdf$/, '.pdf') : undefined
      );
      flashNote('Claim PDF generated');
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  function viewGenerated() {
    window.open(api.claimGeneratedPdfUrl(claim.id), '_blank', 'noopener');
  }

  function viewUploaded() {
    window.open(api.claimPdfUrl(claim.id), '_blank', 'noopener');
  }

  async function pick(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // let the same file be re-picked after an error
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      const { claim: updated } = await api.uploadClaimPdf(claim.id, file);
      onChanged?.(updated);
      flashNote('Uploaded');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUpload() {
    setError(null);
    setBusy(true);
    try {
      const { claim: updated } = await api.deleteClaimPdf(claim.id);
      onChanged?.(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'pdf-control compact' : 'pdf-control'}>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        name={`pdf-${claim.id}`}
        onChange={pick}
      />

      <div className="pdf-group">
        <span className="pdf-tag" title="Generated from this claim's data">
          claim
        </span>
        <button
          type="button"
          className="btn tiny primary"
          disabled={generating}
          onClick={generateAndDownload}
          title="Build the claim summary PDF, save it locally and download it"
        >
          {generating ? 'Generating…' : generated ? 'Download claim PDF' : 'Download Claim PDF'}
        </button>
        {generated && (
          <button
            type="button"
            className="btn tiny"
            onClick={viewGenerated}
            title={generatedName}
          >
            View claim PDF
          </button>
        )}
      </div>

      <div className="pdf-group">
        <span className="pdf-tag" title="A PDF you attached yourself">
          upload
        </span>
        {uploaded && (
          <button type="button" className="btn tiny" onClick={viewUploaded} title={uploadedName}>
            View PDF
          </button>
        )}
        <button
          type="button"
          className="btn tiny"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Uploading…' : uploaded ? 'Replace PDF' : 'Attach PDF'}
        </button>
        {uploaded && (
          <button
            type="button"
            className="btn tiny ghost"
            disabled={busy}
            onClick={removeUpload}
            title="Remove the uploaded attachment"
          >
            ×
          </button>
        )}
        {compact && !uploaded && <span className="muted small">none</span>}
      </div>

      {!compact && (
        <div className="pdf-names">
          {generatedName && <div className="pdf-name mono">{generatedName}</div>}
          {uploadedName && <div className="pdf-name mono">{uploadedName}</div>}
          {!generatedName && !uploadedName && (
            <div className="muted small">No PDFs yet</div>
          )}
        </div>
      )}

      {note && <div className="pdf-note pill ok tiny">{note}</div>}
      {error && <div className="alert error tiny-alert">{error}</div>}
    </div>
  );
}
