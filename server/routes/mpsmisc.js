/**
 * The MPSMISC reporting spreadsheet: a read-only preview and a download.
 *
 * Nothing here writes to the database.
 */
import express from 'express';
import {
  previewRows,
  buildWorkbook,
  agencyBlock,
  cityStateZip,
  fileNameFor,
} from '../mpsmisc.js';
import { payPeriodFor } from '../payPeriod.js';
import { todayISO, addDays } from '../calc.js';

const router = express.Router();

/**
 * The two independent date ranges the screen controls.
 *
 * Label period: what the spreadsheet's header says. Defaults to the current pay
 * period shifted back two days, matching how the agency has been labelling it.
 * Work period: which day_entries supply the hours. Defaults to the pay period.
 */
function rangesFrom(query) {
  const p = payPeriodFor(todayISO());
  const labelStart = query.label_start || addDays(p.start, -2);
  const labelEnd = query.label_end || addDays(p.end, -2);
  const workStart = query.work_start || p.start;
  const workEnd = query.work_end || p.end;
  return { labelStart, labelEnd, workStart, workEnd, defaultPeriod: p };
}

/** GET /api/exports/mpsmisc/preview */
router.get('/mpsmisc/preview', (req, res) => {
  const { labelStart, labelEnd, workStart, workEnd } = rangesFrom(req.query);
  const rows = previewRows(workStart, workEnd, req.agencyId);
  const agency = agencyBlock();

  const missingAgency = [];
  if (!agency.umpi) missingAgency.push('Provider Identification Number (UMPI)');
  if (!agency.name) missingAgency.push('Provider Name');
  if (!agency.street) missingAgency.push('Street Address');
  if (!agency.city) missingAgency.push('City');
  if (!agency.state) missingAgency.push('State');
  if (!agency.zip) missingAgency.push('ZIP');

  res.json({
    label_period: { start: labelStart, end: labelEnd },
    work_period: { start: workStart, end: workEnd },
    agency: { ...agency, city_state_zip: cityStateZip(agency) },
    missing_agency: missingAgency,
    incomplete_count: rows.filter((r) => r.missing.length).length,
    rows,
  });
});

/** GET /api/exports/mpsmisc.xlsx — the download. */
router.get('/mpsmisc.xlsx', async (req, res) => {
  const { labelStart, labelEnd, workStart, workEnd } = rangesFrom(req.query);
  try {
    const { buffer, agency } = await buildWorkbook({
      labelStart,
      labelEnd,
      workStart,
      workEnd,
      agencyId: req.agencyId,
    });
    const name = fileNameFor(agency.umpi || 'UMPI', labelStart, labelEnd);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-File-Name', name);
    res.send(buffer);
  } catch (e) {
    console.error('[mpsmisc] build failed:', e);
    res.status(500).json({ error: `Could not build the spreadsheet: ${e.message}` });
  }
});

export default router;
