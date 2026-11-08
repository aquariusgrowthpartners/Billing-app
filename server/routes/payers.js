import express from 'express';
import db from '../db.js';
import { digitsOnly } from '../hhaFields.js';

const router = express.Router();

/** GET /api/payers */
router.get('/', (_req, res) => {
  res.json({ payers: db.prepare(`SELECT * FROM payers ORDER BY name COLLATE NOCASE`).all() });
});

/** POST /api/payers */
router.post('/', (req, res) => {
  const b = req.body ?? {};
  const name = (b.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const payerId = digitsOnly(b.hhaechange_payer_id, {
    length: 10,
    label: 'HHAeXchange Payer ID',
  });
  if (payerId.error) return res.status(400).json({ error: payerId.error });

  const info = db
    .prepare(
      `INSERT INTO payers (name, typical_days_to_pay, notes, hhaechange_payer_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(name, num(b.typical_days_to_pay), b.notes ?? null, payerId.ok);

  res.status(201).json(db.prepare(`SELECT * FROM payers WHERE id = ?`).get(info.lastInsertRowid));
});

/**
 * DELETE /api/payers/:id
 * Agreements reference a payer with ON DELETE SET NULL, so deleting silently
 * detaches it from them. Refuse unless the caller confirms with ?force=1.
 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const payer = db.prepare(`SELECT * FROM payers WHERE id = ?`).get(id);
  if (!payer) return res.status(404).json({ error: 'Payer not found' });

  const inUse = db.prepare(`SELECT COUNT(*) n FROM agreements WHERE payer_id = ?`).get(id).n;
  if (inUse > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `${payer.name} is used by ${inUse} agreement${inUse === 1 ? '' : 's'}.`,
      in_use: inUse,
      hint: 'Re-send with ?force=1 to delete it anyway and detach it from those agreements.',
    });
  }

  db.prepare(`DELETE FROM payers WHERE id = ?`).run(id);
  res.json({ deleted: true, id, detached_from: inUse });
});

/** PUT and PATCH /api/payers/:id — both accepted, both partial. */
function updatePayer(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM payers WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Payer not found' });

  const updates = {};
  for (const f of ['name', 'typical_days_to_pay', 'notes']) {
    if (f in (req.body ?? {})) updates[f] = req.body[f];
  }
  if ('hhaechange_payer_id' in (req.body ?? {})) {
    const check = digitsOnly(req.body.hhaechange_payer_id, {
      length: 10,
      label: 'HHAeXchange Payer ID',
    });
    if (check.error) return res.status(400).json({ error: check.error });
    updates.hhaechange_payer_id = check.ok;
  }
  if (!Object.keys(updates).length) return res.json(existing);

  if ('name' in updates && !String(updates.name ?? '').trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if ('name' in updates) updates.name = String(updates.name).trim();
  if ('typical_days_to_pay' in updates) {
    const n = updates.typical_days_to_pay;
    updates.typical_days_to_pay = n === '' || n === null ? null : Number(n);
    if (updates.typical_days_to_pay !== null && !Number.isFinite(updates.typical_days_to_pay)) {
      return res.status(400).json({ error: 'typical_days_to_pay must be a number' });
    }
  }

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE payers SET ${setSql} WHERE id = @id`).run({ ...updates, id });
  res.json(db.prepare(`SELECT * FROM payers WHERE id = ?`).get(id));
}

router.patch('/:id', updatePayer);
router.put('/:id', updatePayer);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default router;
