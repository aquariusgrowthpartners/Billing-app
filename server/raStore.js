/**
 * Uploaded RA PDFs are kept on disk so a file can be re-parsed without asking
 * for it again.
 *
 * Keyed by content hash: re-uploading the same bytes reuses one file, and a
 * regenerated copy of the same advice is stored separately (its bytes differ)
 * even though the parser recognises it as the same batch.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RA_DIR = path.join(__dirname, '..', 'data', 'ra_uploads');

export const hashOf = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Project-relative POSIX path, which is what goes in the database. */
export const relativePathFor = (hash) => path.posix.join('data', 'ra_uploads', `${hash}.pdf`);

/** Absolute path for a stored relative path, refusing anything outside RA_DIR. */
export function resolveStored(rel) {
  const abs = path.resolve(path.join(__dirname, '..', rel));
  const root = path.resolve(RA_DIR);
  if (!abs.startsWith(root)) throw new Error('refusing a path outside the upload store');
  return abs;
}

/** Save an upload, returning { hash, path }. Reuses an identical file. */
/** Every stored RA PDF: [{ name, bytes }]. */
export function listUploads() {
  try {
    return fs
      .readdirSync(RA_DIR)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((f) => ({ name: f, bytes: fs.statSync(path.join(RA_DIR, f)).size }));
  } catch {
    return [];
  }
}

/** Total bytes held, for the Settings storage stat. */
export function storageUsed() {
  const files = listUploads();
  return { files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/**
 * Remove a stored PDF, but ONLY when no other import still points at the same
 * file. Returns true when a file was actually unlinked.
 */
export function deleteUploadIfUnreferenced(rel, stillReferenced) {
  if (!rel || stillReferenced) return false;
  try {
    const abs = resolveStored(rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      return true;
    }
  } catch {
    /* a bad path is not worth failing a delete over */
  }
  return false;
}

export function storeUpload(buffer) {
  const hash = hashOf(buffer);
  const rel = relativePathFor(hash);
  const abs = resolveStored(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer);
  return { hash, path: rel };
}

/** Read a stored file back, or null when it is gone. */
export function readStored(rel) {
  if (!rel) return null;
  try {
    const abs = resolveStored(rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  } catch {
    return null;
  }
}
