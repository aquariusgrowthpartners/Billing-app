import express from 'express';
import { ZipArchive } from 'archiver';
import { RA_DIR } from '../raStore.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db from '../db.js';
import { CLAIMS_DIR, ensureClaimsDir } from '../pdfStorage.js';
import { todayISO } from '../calc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TMP_ROOT = path.join(PROJECT_ROOT, '.cache');

const router = express.Router();

/**
 * GET /api/backup
 * Streams a zip containing a consistent snapshot of the database plus every
 * stored PDF.
 *
 * The database is snapshotted with better-sqlite3's backup API rather than by
 * copying the file: the database runs in WAL mode, so billing.db on its own can
 * be missing recent commits that still live in the -wal file. backup() produces
 * a single self-contained file with everything committed so far.
 */
router.get('/', async (req, res) => {
  const stamp = todayISO();
  const tmpDir = path.join(TMP_ROOT, `backup-${Date.now()}`);

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    ensureClaimsDir();

    // 1. Consistent database snapshot.
    const snapshotPath = path.join(tmpDir, 'billing.db');
    await db.backup(snapshotPath);

    // 2. Counts for the manifest, so a backup can be sanity-checked later.
    const counts = {
      clients: db.prepare(`SELECT COUNT(*) n FROM clients`).get().n,
      payers: db.prepare(`SELECT COUNT(*) n FROM payers`).get().n,
      agreements: db.prepare(`SELECT COUNT(*) n FROM agreements`).get().n,
      day_entries: db.prepare(`SELECT COUNT(*) n FROM day_entries`).get().n,
      claims: db.prepare(`SELECT COUNT(*) n FROM claims`).get().n,
    };

    const pdfFiles = fs.existsSync(CLAIMS_DIR)
      ? fs.readdirSync(CLAIMS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'))
      : [];

    const manifest = {
      created_at: new Date().toISOString(),
      backup_date: stamp,
      database: 'billing.db',
      pdf_folder: 'claims/',
      pdf_count: pdfFiles.length,
      pdf_files: pdfFiles,
      record_counts: counts,
      note:
        'Restore by stopping the app, replacing data/billing.db with this copy, ' +
        'and unzipping the claims/ folder back into data/claims/.',
    };

    // 3. Build the archive and stream it straight to the browser.
    const filename = `billing_backup_${stamp}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // archiver v8 exports classes rather than a factory function.
    const archive = new ZipArchive({ zlib: { level: 9 } });

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') console.warn('[backup] archiver warning:', err);
    });
    archive.on('error', (err) => {
      console.error('[backup] archiver error:', err);
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Could not build the backup.' });
      else res.destroy(err);
    });
    // Tidy up whether the download finished or the client went away.
    res.on('close', cleanup);

    archive.pipe(res);
    archive.file(snapshotPath, { name: 'billing.db' });
    if (pdfFiles.length) archive.directory(CLAIMS_DIR, 'claims');
    // The uploaded RA PDFs travel with the backup, so a restore can re-parse.
    if (fs.existsSync(RA_DIR)) archive.directory(RA_DIR, 'ra_uploads');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-info.json' });
    await archive.finalize();
  } catch (err) {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: `Backup failed: ${err.message}` });
    } else {
      res.destroy(err);
    }
  }
});

export default router;
