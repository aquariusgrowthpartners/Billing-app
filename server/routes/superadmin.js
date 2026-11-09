/**
 * Platform-owner endpoints.
 *
 * Only the original Agency 1 admin (or a future explicit superadmin role) may
 * use these. They intentionally expose cross-agency summary counts, but never
 * another agency's client records, claims, or AI key.
 */
import express from 'express';
import db from '../db.js';

const router = express.Router();

function isSuperAdmin(user) {
  return Boolean(
    user &&
      ['admin', 'superadmin'].includes(user.role) &&
      (user.agency_id === 1 || user.role === 'superadmin')
  );
}

router.use((req, res, next) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Super admin access is required.' });
  }
  next();
});

function demoAgency() {
  return db.prepare(`SELECT id, name FROM agencies WHERE name = 'Demo Agency'`).get() ?? null;
}

function valueFor(agencyId, key) {
  return db
    .prepare(`SELECT value FROM settings WHERE agency_id = ? AND key = ?`)
    .get(agencyId, key)?.value ?? '';
}

/** GET /api/superadmin/agencies */
router.get('/agencies', (req, res) => {
  const agencies = db
    .prepare(
      `SELECT a.id,
              a.name,
              a.created_at,
              (SELECT COUNT(*) FROM clients c WHERE c.agency_id = a.id) AS clients,
              (SELECT COUNT(*) FROM claims cl WHERE cl.agency_id = a.id) AS claims,
              (SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id) AS users,
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'ai_provider'), 'none') AS ai_provider,
              CASE WHEN EXISTS (
                SELECT 1 FROM settings s
                 WHERE s.agency_id = a.id
                   AND s.key = 'ai_api_key'
                   AND COALESCE(s.value, '') <> ''
              ) THEN 1 ELSE 0 END AS ai_key_set
         FROM agencies a
        ORDER BY a.id`
    )
    .all();

  const superKey = valueFor(req.agencyId, 'ai_api_key');
  const demo = demoAgency();
  const demoKey = demo ? valueFor(demo.id, 'ai_api_key') : '';

  res.json({
    agencies,
    demo_agency_id: demo?.id ?? null,
    demo_ai_shared: Boolean(superKey && demoKey && superKey === demoKey),
    super_ai_key_set: Boolean(superKey),
  });
});

/** POST /api/superadmin/demo-ai  { enabled: true|false } */
router.post('/demo-ai', (req, res) => {
  const demo = demoAgency();
  if (!demo) return res.status(404).json({ error: 'Demo Agency not found.' });

  const enabled = req.body?.enabled === true || req.body?.enabled === 1;
  if (enabled) {
    const superKey = valueFor(req.agencyId, 'ai_api_key');
    if (!superKey) {
      return res.status(400).json({
        error: 'Your agency has no AI key saved. Add one in Settings → AI Configuration first.',
      });
    }
    const superProvider = valueFor(req.agencyId, 'ai_provider') || 'deepseek';
    const upsert = db.prepare(
      `INSERT INTO settings (agency_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(agency_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );
    db.transaction(() => {
      upsert.run(demo.id, 'ai_api_key', superKey);
      upsert.run(demo.id, 'ai_provider', superProvider);
    })();
  } else {
    db.prepare(`DELETE FROM settings WHERE agency_id = ? AND key = 'ai_api_key'`).run(demo.id);
  }

  const demoKey = valueFor(demo.id, 'ai_api_key');
  const superKey = valueFor(req.agencyId, 'ai_api_key');
  res.json({
    ok: true,
    enabled,
    demo_agency_id: demo.id,
    demo_ai_shared: Boolean(superKey && demoKey && superKey === demoKey),
    demo_has_key: Boolean(demoKey),
  });
});

export default router;
