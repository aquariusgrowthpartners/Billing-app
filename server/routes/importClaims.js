import express from 'express';
import multer from 'multer';
import db from '../db.js';
import { extractClaimSubmission } from '../claimSubmissionParser.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a 277 Claim Response PDF.' });
  if (req.file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ error: 'That file is not a PDF.' });
  }
  try {
    const extracted = await extractClaimSubmission(req.file.buffer);
    const ma = String(extracted.subscriber_id ?? '').replace(/\D/g, '');
    const client = ma
      ? db.prepare(`SELECT id, first_name, last_name FROM clients WHERE agency_id = ? AND REPLACE(COALESCE(ma_number,''),'-','') = ?`).get(req.agencyId, ma)
      : null;
    res.json({ extracted, suggested_client: client ?? null });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Could not parse the claim response.' });
  }
});

router.get('/pending', (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  const rows = db.prepare(
    `SELECT cl.*, c.first_name, c.last_name
       FROM claims cl JOIN clients c ON c.id = cl.client_id
      WHERE cl.agency_id = ? AND cl.status = 'pending'
        AND (? = '' OR COALESCE(cl.period_end, cl.period_start) >= ?)
        AND (? = '' OR COALESCE(cl.period_start, cl.period_end) <= ?)
      ORDER BY c.last_name, c.first_name, cl.period_start DESC, cl.id DESC`
  ).all(req.agencyId, from, from, to, to);
  res.json({ claims: rows });
});

router.post('/save', (req, res) => {
  const body = req.body ?? {};
  const clientId = Number(body.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) return res.status(400).json({ error: 'Select a client.' });
  const client = db.prepare('SELECT id, first_name, last_name FROM clients WHERE id = ? AND agency_id = ?').get(clientId, req.agencyId);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const status = body.claim_status_code === '46' ? 'pending' : 'submitted';
  try {
    const info = db.prepare(
      `INSERT INTO claims
         (claim_name, client_id, period_start, period_end, total_units, total_dollars,
          status, charge_amount, expected_payment, patient_control_number, claim_status_code,
          client_name_raw, agency_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      body.patient_control_number ? `277_${body.patient_control_number}` : `277_${Date.now()}`,
      clientId,
      body.period_start || null,
      body.period_end || null,
      Array.isArray(body.service_lines) ? body.service_lines.length : 0,
      Number(body.total_charge) || 0,
      status,
      Number(body.total_charge) || 0,
      Number(body.expected_payment) || null,
      body.patient_control_number || null,
      body.claim_status_code || null,
      body.subscriber_name || `${client.first_name} ${client.last_name}`,
      req.agencyId
    );
    res.json({ claim_id: Number(info.lastInsertRowid), status, client_id: clientId });
  } catch (err) {
    res.status(500).json({ error: `Could not save the claim: ${err.message}` });
  }
});

export default router;
