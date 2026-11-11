import express from 'express';
import db from '../db.js';
const router = express.Router();

router.get('/', (req, res) => {
  const alerts = db.prepare(
    `SELECT a.*, c.first_name, c.last_name
       FROM alerts a LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.agency_id = ? AND a.read_at IS NULL
      ORDER BY a.created_at DESC, a.id DESC LIMIT 20`
  ).all(req.agencyId);
  res.json({ alerts });
});

router.post('/:id/dismiss', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare(
    `UPDATE alerts SET read_at = datetime('now') WHERE id = ? AND agency_id = ?`
  ).run(id, req.agencyId);
  if (!info.changes) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

export default router;
