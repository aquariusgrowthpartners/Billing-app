import express from 'express';
import Database from 'better-sqlite3';
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

/**
 * Build an agency-scoped copy of the database.
 *
 * A plain `db.backup()` copies the whole file — every agency's data. That is a
 * cross-tenant leak dressed up as a feature. Instead we clone the schema from
 * sqlite_master and copy only rows whose agency_id matches, from the tenant
 * tables only. `settings` is shared configuration, so it comes along whole.
 */
const GLOBAL_TABLES = new Set(['settings']);

async function scopedSnapshot(targetPath, agencyId) {
  const clone = new Database(targetPath);
  try {
    clone.pragma('journal_mode = DELETE');
    clone.pragma('foreign_keys = OFF');

    const schema = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .all();

    for (const { name, sql } of schema) clone.exec(sql);

    const tenantTables = [];
    for (const { name } of schema) {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
      const hasAgency = cols.includes('agency_id');

      if (name === 'agencies') {
        // only the tenant's own agency row
        const rows = db.prepare(`SELECT * FROM agencies WHERE id = ?`).all(agencyId);
        const ins = clone.prepare(
          `INSERT INTO agencies (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        );
        for (const r of rows) ins.run(...cols.map((c) => r[c]));
      } else if (name === 'users') {
        // only this tenant's users — never another agency's password hashes
        const rows = db.prepare(`SELECT * FROM users WHERE agency_id = ?`).all(agencyId);
        const ins = clone.prepare(
          `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        );
        for (const r of rows) ins.run(...cols.map((c) => r[c]));
      } else if (name === 'settings') {
        // shared config, but never ship the AI secret in a tenant backup
        const rows = db.prepare(`SELECT * FROM settings WHERE key <> 'ai_api_key'`).all();
        const ins = clone.prepare(
          `INSERT INTO settings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        );
        for (const r of rows) ins.run(...cols.map((c) => r[c]));
      } else if (GLOBAL_TABLES.has(name) || !hasAgency) {
        const rows = db.prepare(`SELECT * FROM ${name}`).all();
        const ins = cols.length
          ? clone.prepare(
              `INSERT INTO ${name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
            )
          : null;
        for (const r of rows) ins?.run(...cols.map((c) => r[c]));
      } else {
        tenantTables.push(name);
        const cols2 = cols;
        const rows = db.prepare(`SELECT * FROM ${name} WHERE agency_id = ?`).all(agencyId);
        const ins = clone.prepare(
          `INSERT INTO ${name} (${cols2.join(',')}) VALUES (${cols2.map(() => '?').join(',')})`
        );
        for (const r of rows) ins.run(...cols2.map((c) => r[c]));
      }
    }

    // indexes for the copied tables
    const indexes = db
      .prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type = 'index' AND name NOT LIKE 'sqlite_%'`)
      .all();
    for (const { sql } of indexes) {
      try {
        clone.exec(sql);
      } catch {
        /* index may reference a table we did not copy */
      }
    }
    return tenantTables.length;
  } finally {
    clone.close();
  }
}

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
    await scopedSnapshot(snapshotPath, req.agencyId);

    // 2. Counts for the manifest, so a backup can be sanity-checked later.
    const counts = {
      clients: db.prepare(`SELECT COUNT(*) n FROM clients WHERE agency_id = ?`).get(req.agencyId).n,
      payers: db.prepare(`SELECT COUNT(*) n FROM payers WHERE agency_id = ?`).get(req.agencyId).n,
      agreements: db.prepare(`SELECT COUNT(*) n FROM agreements WHERE agency_id = ?`).get(req.agencyId).n,
      day_entries: db.prepare(`SELECT COUNT(*) n FROM day_entries WHERE agency_id = ?`).get(req.agencyId).n,
      claims: db.prepare(`SELECT COUNT(*) n FROM claims WHERE agency_id = ?`).get(req.agencyId).n,
    };

    /*
     * Only this agency's documents travel with the backup. The folders are
     * shared across tenants, so listing them wholesale would ship other
     * agencies' claim PDFs and remittance advice.
     */
    const pdfFiles = db
      .prepare(
        `SELECT local_pdf_path AS p FROM claims
          WHERE agency_id = ? AND local_pdf_path IS NOT NULL AND local_pdf_path <> ''
         UNION
         SELECT generated_pdf_path AS p FROM claims
          WHERE agency_id = ? AND generated_pdf_path IS NOT NULL AND generated_pdf_path <> ''`
      )
      .all(req.agencyId, req.agencyId)
      .map((r) => path.basename(r.p))
      .filter((f) => f.toLowerCase().endsWith('.pdf'));

    const raFiles = db
      .prepare(`SELECT stored_path FROM ra_import_files WHERE agency_id = ? AND stored_path IS NOT NULL`)
      .all(req.agencyId)
      .map((r) => path.basename(r.stored_path));

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
      for (const f of pdfFiles) {
        const full = path.join(CLAIMS_DIR, f);
        if (fs.existsSync(full)) archive.file(full, { name: `claims/${f}` });
      }
    // The uploaded RA PDFs travel with the backup, so a restore can re-parse.
      for (const f of raFiles) {
        const full = path.join(RA_DIR, f);
        if (fs.existsSync(full)) archive.file(full, { name: `ra_uploads/${f}` });
      }
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
