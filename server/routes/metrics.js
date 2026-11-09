/**
 * Small, read-only aggregate endpoints used by the dashboard.
 * All filters are parameterised and scoped to the tenant.
 */
import express from 'express';
import db from '../db.js';
import { todayISO, round2 } from '../calc.js';

const router = express.Router();

/** GET /api/metrics/ytd-claims — paid claims from Jan 1 through today. */
router.get('/ytd-claims', (req, res) => {
  const year = new Date().getFullYear();
  const start = `${year}-01-01`;
  const end = todayISO();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(paid_amount), 0) AS total,
              COUNT(*) AS count
         FROM claims
        WHERE agency_id = ?
          AND paid_date IS NOT NULL
          AND paid_date >= ?
          AND paid_date <= ?`
    )
    .get(req.agencyId, start, end);

  res.json({
    year,
    start,
    end,
    total: round2(row?.total ?? 0),
    count: Number(row?.count ?? 0),
  });
});

export default router;
