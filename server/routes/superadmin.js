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
  return (
    db
      .prepare(
        `SELECT a.id, a.name
           FROM agencies a
          WHERE a.name = 'Demo Agency'
             OR EXISTS (
               SELECT 1 FROM users u
                WHERE u.agency_id = a.id AND lower(u.email) = 'demo@dundas.com'
             )
          ORDER BY CASE WHEN a.name = 'Demo Agency' THEN 0 ELSE 1 END, a.id
          LIMIT 1`
      )
      .get() ?? null
  );
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
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'ai_enabled'), '1') AS ai_enabled,
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'agency_tax_id'), '') AS agency_tax_id,
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'office_npi'), '') AS office_npi,
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'azure_endpoint'), '') AS azure_endpoint,
              COALESCE((SELECT s.value FROM settings s
                         WHERE s.agency_id = a.id AND s.key = 'azure_deployment'), '') AS azure_deployment,
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

/** PUT /api/superadmin/agencies/:id — edit one agency's profile/AI config. */
router.put('/agencies/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid agency id.' });
  const agency = db.prepare(`SELECT id, name FROM agencies WHERE id = ?`).get(id);
  if (!agency) return res.status(404).json({ error: 'Agency not found.' });

  const b = req.body ?? {};
  const settingsUpdates = {};

  let name = null;
  if ('name' in b || 'agency_name' in b) {
    name = String(b.name ?? b.agency_name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Agency name cannot be empty.' });
    settingsUpdates.agency_name = name;
  }
  if ('agency_tax_id' in b) {
    settingsUpdates.agency_tax_id = String(b.agency_tax_id ?? '').trim();
  }
  if ('office_npi' in b) {
    settingsUpdates.office_npi = String(b.office_npi ?? '').trim();
  }
  if ('ai_provider' in b) {
    const raw = String(b.ai_provider ?? 'none').trim().toLowerCase();
    const provider = raw === 'azure-openai' || raw === 'azure_openai' ? 'azure' : raw;
    if (!['none', 'deepseek', 'openai', 'azure'].includes(provider)) {
      return res.status(400).json({ error: 'ai_provider must be none, deepseek, openai or azure.' });
    }
    settingsUpdates.ai_provider = provider;
  }
  if ('ai_api_key' in b) {
    const key = String(b.ai_api_key ?? '').trim();
    if (key) settingsUpdates.ai_api_key = key; // blank = keep existing key
  }
  if (b.clear_ai_key === true) settingsUpdates.ai_api_key = '';
  if ('azure_endpoint' in b) {
    settingsUpdates.azure_endpoint = String(b.azure_endpoint ?? '').trim();
  }
  if ('azure_deployment' in b) {
    settingsUpdates.azure_deployment = String(b.azure_deployment ?? '').trim();
  }
  if ('ai_enabled' in b) {
    settingsUpdates.ai_enabled =
      b.ai_enabled === false || b.ai_enabled === 0 || String(b.ai_enabled) === '0' ? '0' : '1';
  }

  const upsert = db.prepare(
    `INSERT INTO settings (agency_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(agency_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  );

  db.transaction(() => {
    if (name) db.prepare(`UPDATE agencies SET name = ? WHERE id = ?`).run(name, id);
    for (const [key, value] of Object.entries(settingsUpdates)) {
      upsert.run(id, key, value);
    }
  })();

  res.json({ ok: true, agency_id: id });
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
    const superEndpoint = valueFor(req.agencyId, 'azure_endpoint');
    const superDeployment = valueFor(req.agencyId, 'azure_deployment');
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
      if (superEndpoint) upsert.run(demo.id, 'azure_endpoint', superEndpoint);
      if (superDeployment) upsert.run(demo.id, 'azure_deployment', superDeployment);
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
