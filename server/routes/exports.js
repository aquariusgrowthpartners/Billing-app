/**
 * HHAeXchange flat-file downloads.
 *
 * Both endpoints stream a CSV built on the fly; neither writes to the
 * database. The visit export refuses to produce a file while any blocking
 * validation issue remains, per the Common Rejections guidance.
 */
import express from 'express';
import db from '../db.js';
import { allSettings } from '../settings.js';
import {
  buildCaregiverCsv,
  buildVisitCsv,
  validateVisitExport,
  visitSourceRows,
  stamp,
} from '../hhaExport.js';

const router = express.Router();

/** Files are named exactly as the layouts require. */
function attach(res, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

/** GET /api/exports/validation — pre-flight for the visit export. */
router.get('/validation', (_req, res) => {
  const result = validateVisitExport();
  res.json({
    ok: result.ok,
    row_count: result.row_count,
    agency_tax_id_set: Boolean(result.settings.agency_tax_id),
    office_npi_set: Boolean(result.settings.office_npi),
    issues: result.issues,
  });
});

/**
 * GET /api/exports/caregivers.csv
 * CaregiverImport_{AgencyTaxID}_{YYYYMMDD}.csv
 */
router.get('/caregivers.csv', (req, res) => {
  const settings = allSettings();
  const taxId = settings.agency_tax_id ?? '';
  const caretakers = db
    .prepare(
      `SELECT * FROM caretakers
       ORDER BY active DESC, last_name COLLATE NOCASE, first_name COLLATE NOCASE`
    )
    .all();

  const body = buildCaregiverCsv({ agencyTaxId: taxId, caretakers });
  const { ymd } = stamp();
  attach(res, `CaregiverImport_${taxId}_${ymd}.csv`);
  res.send(body);
});

/**
 * GET /api/exports/visits.csv
 * VISITS_{AgencyTaxID}_{YYYYMMDDHHMMSS}.CSV
 *
 * Returns 422 with the issue list while validation fails, so the file can never
 * be produced in a state HHAeXchange would reject.
 */
router.get('/visits.csv', (req, res) => {
  const check = validateVisitExport();
  if (!check.ok) {
    return res.status(422).json({
      error: 'The visit export did not pass validation.',
      row_count: check.row_count,
      issues: check.issues,
    });
  }

  const settings = check.settings;
  const rows = visitSourceRows();
  const body = buildVisitCsv({ rows, settings });
  const { ymd, hms } = stamp();

  // EDI_<taxid digits only>_<YYYYMMDDHHMMSS>.CSV
  const taxDigits = String(settings.agency_tax_id ?? '').replace(/\D/g, '');
  attach(res, `EDI_${taxDigits}_${ymd}${hms}.CSV`);
  res.send(body);
});

export default router;
