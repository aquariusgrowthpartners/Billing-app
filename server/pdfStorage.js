/**
 * Local PDF storage for claims. Phase 1 keeps everything on disk under
 * data/claims/; Phase 2 will hand these same files to Google Drive.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

/** Absolute location of the attachment folder. */
export const CLAIMS_DIR = path.join(PROJECT_ROOT, 'data', 'claims');

/** Project-relative POSIX path, which is what gets stored in the database. */
export function relativePathFor(fileName) {
  return path.posix.join('data', 'claims', fileName);
}

export function ensureClaimsDir() {
  fs.mkdirSync(CLAIMS_DIR, { recursive: true });
  return CLAIMS_DIR;
}

/** Make an arbitrary claim name safe to use as a file name. */
export function safeFileName(value, fallback = 'claim') {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Absolute path for a stored relative path.
 * Refuses anything that resolves outside the claims folder, so a corrupted or
 * hostile value in the database can never read the rest of the disk.
 */
export function resolveStored(relativePath) {
  const root = path.resolve(CLAIMS_DIR);
  const abs = path.resolve(PROJECT_ROOT, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Refusing to touch a path outside the claims folder.');
  }
  return abs;
}

/**
 * A real PDF starts with the %PDF- magic bytes. The browser-supplied MIME type
 * is trivially spoofed, so check the content too.
 */
export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export default { CLAIMS_DIR, ensureClaimsDir, safeFileName, resolveStored, isPdfBuffer, relativePathFor };
