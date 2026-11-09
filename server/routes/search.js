/**
 * Global, tenant-scoped search across clients, caretakers and claims.
 * Every query is parameterised and LIMITed; no schema/index changes required.
 */
import express from 'express';
import db from '../db.js';

const router = express.Router();

router.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ query: q, clients: [], caretakers: [], claims: [] });
  if (q.length > 100) return res.status(400).json({ error: 'Search is too long.' });

  const like = `%${q.toLowerCase()}%`;

  const clients = db
    .prepare(
      `SELECT id, first_name, last_name, ma_number, active
         FROM clients
        WHERE agency_id = ?
          AND COALESCE(archived, 0) = 0
          AND (lower(first_name) LIKE ? OR lower(last_name) LIKE ?
               OR lower(COALESCE(ma_number, '')) LIKE ?)
        ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
        LIMIT 10`
    )
    .all(req.agencyId, like, like, like);

  const caretakers = db
    .prepare(
      `SELECT id, first_name, last_name, npi_number, active
         FROM caretakers
        WHERE agency_id = ?
          AND (lower(first_name) LIKE ? OR lower(last_name) LIKE ?
               OR lower(COALESCE(npi_number, '')) LIKE ?)
        ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
        LIMIT 10`
    )
    .all(req.agencyId, like, like, like);

  const claims = db
    .prepare(
      `SELECT cl.id, cl.claim_name, cl.status, cl.total_dollars,
              cl.period_start, cl.period_end,
              cu.id AS client_id, cu.first_name, cu.last_name
         FROM claims cl
         JOIN clients cu ON cu.id = cl.client_id AND cu.agency_id = cl.agency_id
        WHERE cl.agency_id = ?
          AND (lower(COALESCE(cl.claim_name, '')) LIKE ?
               OR lower(cu.first_name) LIKE ? OR lower(cu.last_name) LIKE ?)
        ORDER BY cl.id DESC
        LIMIT 10`
    )
    .all(req.agencyId, like, like, like);

  res.json({ query: q, clients, caretakers, claims });
});

export default router;
