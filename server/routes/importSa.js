import express from 'express';
import multer from 'multer';
import db from '../db.js';
import { extractServiceAgreement } from '../saExtraction.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a Service Agreement PDF.' });
  if (req.file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ error: 'That file is not a PDF.' });
  }
  try {
    const extracted = await extractServiceAgreement(req.file.buffer);
    return res.json({
      extracted,
      missing: {
        case_manager_email: !extracted.case_manager_email,
        case_manager_phone: !extracted.case_manager_phone,
        modifiers: extracted.lines.every((line) => !line.modifier_1),
      },
      warnings: extracted.lines.length ? [] : ['No APPROVED service lines found.'],
    });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || 'Could not extract the Service Agreement.' });
  }
});

router.post('/save', (req, res) => {
  const body = req.body ?? {};
  const clientId = Number(body.client_id);
  const dhs = String(body.dhs_service_agreement_num ?? '').trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!Number.isInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'Select a client.' });
  }
  if (!dhs) return res.status(400).json({ error: 'Service Agreement Number is required.' });
  if (!lines.length) return res.status(400).json({ error: 'At least one service line is required.' });
  const client = db.prepare('SELECT id FROM clients WHERE id = ? AND agency_id = ?').get(clientId, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const parentParams = {
    client_id: clientId,
    dhs,
    effective_date: body.effective_date || null,
    through_date: body.through_date || null,
    case_manager_name: body.case_manager_name || null,
    case_manager_phone: body.case_manager_phone || null,
    case_manager_email: body.case_manager_email || null,
    agency: req.agencyId,
  };
  const existing = db
    .prepare('SELECT id FROM service_agreements WHERE client_id = ? AND dhs_service_agreement_num = ? AND agency_id = ?')
    .get(clientId, dhs, req.agencyId);

  const run = db.transaction(() => {
    let parentId = existing?.id;
    if (parentId) {
      db.prepare(
        `UPDATE service_agreements
            SET effective_date=@effective_date, through_date=@through_date,
                case_manager_name=@case_manager_name, case_manager_phone=@case_manager_phone,
                case_manager_email=@case_manager_email
          WHERE id=@id AND agency_id=@agency`
      ).run({ ...parentParams, id: parentId });
      db.prepare('DELETE FROM agreements WHERE service_agreement_id = ? AND agency_id = ?').run(parentId, req.agencyId);
    } else {
      const info = db.prepare(
        `INSERT INTO service_agreements
           (client_id, dhs_service_agreement_num, effective_date, through_date,
            case_manager_name, case_manager_phone, case_manager_email, agency_id)
         VALUES (@client_id, @dhs, @effective_date, @through_date,
                 @case_manager_name, @case_manager_phone, @case_manager_email, @agency)`
      ).run(parentParams);
      parentId = Number(info.lastInsertRowid);
    }

    const insert = db.prepare(
      `INSERT INTO agreements
         (client_id, agreement_number, start_date, end_date, authorized_units_per_week,
          minutes_per_unit, rate_per_unit, max_units_per_day, service_code, service_code_with_modifier,
          authorized_total_amount, service_agreement_id, procedure_description,
          modifier_1, modifier_2, modifier_3, modifier_4, total_units, agency_id)
       VALUES
         (@client_id, @agreement_number, @start_date, @end_date, @total_units,
          15, @rate_per_unit, NULL, @procedure_code, @code_with_modifier,
          @total_amount, @parent_id, @procedure_description,
          @modifier_1, @modifier_2, @modifier_3, @modifier_4, @total_units, @agency)`
    );
    for (const line of lines) {
      insert.run({
        client_id: clientId,
        agreement_number: dhs,
        start_date: line.start_date || parentParams.effective_date,
        end_date: line.end_date || parentParams.through_date,
        total_units: line.total_units == null ? null : Number(line.total_units),
        rate_per_unit: line.rate_per_unit == null ? 0 : Number(line.rate_per_unit),
        procedure_code: line.procedure_code || null,
        code_with_modifier: [line.procedure_code, line.modifier_1, line.modifier_2, line.modifier_3, line.modifier_4]
          .filter(Boolean).join(':'),
        total_amount: line.total_amount == null ? null : Number(line.total_amount),
        parent_id: parentId,
        procedure_description: line.procedure_description || null,
        modifier_1: line.modifier_1 || null,
        modifier_2: line.modifier_2 || null,
        modifier_3: line.modifier_3 || null,
        modifier_4: line.modifier_4 || null,
        agency: req.agencyId,
      });
    }
    return parentId;
  });

  try {
    const parentId = run();
    res.json({
      service_agreement_id: parentId,
      lines_created: lines.length,
      client_id: clientId,
    });
  } catch (err) {
    res.status(500).json({ error: `Could not save the Service Agreement: ${err.message}` });
  }
});

export default router;
