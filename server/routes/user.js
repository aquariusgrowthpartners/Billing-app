import express from 'express';
import db from '../db.js';
const router = express.Router();
const STEPS = [
  'home', 'clients', 'uploads_ra', 'uploads_claim',
  'uploads_sa', 'pending_claims', 'ask_ai', 'settings',
];

function computedChecklist(agencyId) {
  const count = (sql) => db.prepare(sql).get(agencyId)?.n ?? 0;
  return {
    home: false,
    clients: count('SELECT COUNT(*) n FROM clients WHERE agency_id = ?') > 0,
    uploads_ra: count('SELECT COUNT(*) n FROM ra_imports WHERE agency_id = ?') > 0,
    uploads_claim: count('SELECT COUNT(*) n FROM claims WHERE agency_id = ? AND claim_status_code = \'46\'') > 0,
    uploads_sa: count('SELECT COUNT(*) n FROM service_agreements WHERE agency_id = ?') > 0,
    pending_claims: count('SELECT COUNT(*) n FROM claims WHERE agency_id = ? AND status = \'pending\'') > 0,
    ask_ai: false,
    settings: false,
  };
}

router.get('/onboarding', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  let saved = {};
  try { saved = JSON.parse(user?.onboarding_checklist || '{}'); } catch {}
  const checklist = { ...computedChecklist(req.agencyId), ...saved };
  db.prepare('UPDATE users SET onboarding_checklist = ? WHERE id = ?').run(JSON.stringify(checklist), req.user.id);
  res.json({ checklist, complete: STEPS.every((step) => checklist[step]) });
});

router.post('/onboarding', (req, res) => {
  const step = String(req.body?.step ?? '');
  if (!STEPS.includes(step)) return res.status(400).json({ error: 'Unknown onboarding step.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  let checklist = {};
  try { checklist = JSON.parse(user?.onboarding_checklist || '{}'); } catch {}
  checklist[step] = true;
  db.prepare('UPDATE users SET onboarding_checklist = ? WHERE id = ?').run(JSON.stringify(checklist), req.user.id);
  res.json({ checklist, complete: STEPS.every((key) => checklist[key]) });
});

router.post('/tutorial', (req, res) => {
  db.prepare('UPDATE users SET tutorial_completed = 1 WHERE id = ?').run(req.user.id);
  res.json({ tutorial_completed: 1 });
});

export default router;
