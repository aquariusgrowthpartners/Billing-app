/**
 * Case managers — the people who coordinate a client's care.
 * A client has at most one, stored as clients.case_manager_id.
 */
import express from 'express';
import db from '../db.js';

const router = express.Router();

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'organization', 'notes', 'active'];

function normalise(body) {
  const updates = {};
  for (const f of FIELDS) if (f in body) updates[f] = body[f];

  for (const f of ['first_name', 'last_name']) {
    if (f in updates && !String(updates[f] ?? '').trim()) {
      return { error: `${f.replace('_', ' ')} is required` };
    }
    if (f in updates) updates[f] = String(updates[f]).trim();
  }
  for (const f of ['email', 'phone', 'organization', 'notes']) {
    if (f in updates) {
      const v = String(updates[f] ?? '').trim();
      updates[f] = v || null;
    }
  }
  if ('email' in updates && updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
    return { error: 'That does not look like an email address' };
  }
  if ('active' in updates) {
    updates.active = updates.active === false || updates.active === 0 ? 0 : 1;
  }
  return { updates };
}

const fullName = (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();

/** GET /api/case-managers?active=0 */
router.get('/', (req, res) => {
  const activeOnly = req.query.active !== '0';
  const rows = db
    .prepare(
      `SELECT cm.*,
              (SELECT COUNT(*) FROM clients c WHERE c.case_manager_id = cm.id) AS client_count
       FROM case_managers cm
       ${activeOnly ? 'WHERE cm.active = 1' : ''}
       ORDER BY cm.active DESC, cm.last_name COLLATE NOCASE, cm.first_name COLLATE NOCASE`
    )
    .all();
  res.json({ case_managers: rows });
});

/** GET /api/case-managers/:id — includes the clients assigned to them. */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Case manager not found' });
  const clients = db
    .prepare(
      `SELECT id, first_name, last_name, ma_number FROM clients
       WHERE case_manager_id = ? ORDER BY last_name COLLATE NOCASE`
    )
    .all(id);
  res.json({ case_manager: row, clients });
});

/** POST /api/case-managers */
router.post('/', (req, res) => {
  const { updates, error } = normalise(req.body ?? {});
  if (error) return res.status(400).json({ error });
  if (!updates.first_name || !updates.last_name) {
    return res.status(400).json({ error: 'first_name and last_name are required' });
  }

  const info = db
    .prepare(
      `INSERT INTO case_managers
         (first_name, last_name, email, phone, organization, notes, active)
       VALUES (@first_name, @last_name, @email, @phone, @organization, @notes, @active)`
    )
    .run({
      first_name: updates.first_name,
      last_name: updates.last_name,
      email: updates.email ?? null,
      phone: updates.phone ?? null,
      organization: updates.organization ?? null,
      notes: updates.notes ?? null,
      active: updates.active ?? 1,
    });

  res
    .status(201)
    .json(db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(info.lastInsertRowid));
});

/** PUT and PATCH /api/case-managers/:id */
function updateCaseManager(req, res) {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Case manager not found' });

  const { updates, error } = normalise(req.body ?? {});
  if (error) return res.status(400).json({ error });
  if (!Object.keys(updates).length) return res.json(existing);

  const setSql = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE case_managers SET ${setSql} WHERE id = @id`).run({ ...updates, id });
  res.json(db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(id));
}

router.patch('/:id', updateCaseManager);
router.put('/:id', updateCaseManager);

/**
 * DELETE /api/case-managers/:id
 * clients.case_manager_id is ON DELETE SET NULL, so deleting would silently
 * unassign every client. Refuse unless forced.
 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM case_managers WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Case manager not found' });

  const assigned = db.prepare(`SELECT COUNT(*) n FROM clients WHERE case_manager_id = ?`).get(id).n;
  if (assigned > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `${fullName(existing)} is assigned to ${assigned} client${assigned === 1 ? '' : 's'}.`,
      assigned,
      hint: 'Re-send with ?force=1 to delete and unassign those clients.',
    });
  }

  if (assigned > 0) db.prepare(`UPDATE clients SET case_manager_id = NULL WHERE case_manager_id = ?`).run(id);
  db.prepare(`DELETE FROM case_managers WHERE id = ?`).run(id);
  res.json({ deleted: true, id, unassigned_clients: assigned });
});

export default router;
