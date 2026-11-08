/**
 * Service Agreement parents.
 *
 * The HHAeXchange authorization number belongs to the AGREEMENT, not to any one
 * service line — one auth covers T1019, T1019:UA, T1019:U9 and the rest. It is
 * therefore edited here, on the parent, and read by the export from the parent.
 */
import express from 'express';
import db from '../db.js';

const router = express.Router();

/** Only these keys may be patched. Anything else is a client bug, not a typo. */
const EDITABLE = new Set(['hhaexchange_auth_number']);

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'A valid service agreement id is required' });
  }

  const body = req.body ?? {};
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !EDITABLE.has(k));
  if (unknown.length || keys.length === 0) {
    return res.status(400).json({
      error: unknown.length
        ? `Only ${[...EDITABLE].join(', ')} may be edited here (got: ${unknown.join(', ')})`
        : 'Nothing to update',
      editable: [...EDITABLE],
    });
  }

  const existing = db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Service agreement not found' });

  const value = body.hhaexchange_auth_number;
  db.prepare('UPDATE service_agreements SET hhaexchange_auth_number = ? WHERE id = ?').run(
    value == null || value === '' ? null : String(value).trim(),
    id
  );

  res.json(db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(id));
});

export default router;
