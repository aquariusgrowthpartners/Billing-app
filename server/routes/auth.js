/**
 * Signup / login / session.
 *
 * Signup creates the agency and its first admin in ONE transaction: a user
 * without an agency, or an agency with no admin, is an unreachable account.
 */
import express from 'express';
import db from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  isValidEmail,
  passwordProblem,
} from '../auth.js';

const router = express.Router();

function publicUser(user, agency) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    agency_id: user.agency_id,
    agency_name: agency?.name ?? null,
    is_demo: Number(agency?.is_demo ?? 0),
    tutorial_completed: Number(user.tutorial_completed ?? 0),
    onboarding_checklist: user.onboarding_checklist ?? null,
    must_change_password: user.must_change_password ?? 0,
  };
}

/* POST /api/auth/signup  { email, password, agency_name } */
router.post('/signup', (req, res) => {
  const b = req.body ?? {};
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  const agencyName = String(b.agency_name ?? '').trim();

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (agencyName.length < 2) return res.status(400).json({ error: 'Agency name is required.' });

  if (db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  try {
    const out = db.transaction(() => {
      const agencyId = Number(
        db.prepare('INSERT INTO agencies (name) VALUES (?)').run(agencyName).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO settings (agency_id, key, value) VALUES (?, 'ai_enabled', '1')
         ON CONFLICT(agency_id, key) DO NOTHING`
      ).run(agencyId);
      const userId = Number(
        db
          .prepare(
            `INSERT INTO users (agency_id, email, password_hash, role)
             VALUES (?, ?, ?, 'admin')`
          )
          .run(agencyId, email, hashPassword(password)).lastInsertRowid
      );
      return { agencyId, userId };
    })();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(out.userId);
    const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(out.agencyId);
    res.status(201).json({ token: signToken(user), user: publicUser(user, agency) });
  } catch (err) {
    console.error(`[auth] signup failed: ${err.message}`);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

const DEMO_EMAIL = 'demo@dundas.com';

/* POST /api/auth/login  { email, password }  or  { demo: true } */
router.post('/login', (req, res) => {
  const b = req.body ?? {};
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  const wantsDemo = b.demo === true || email === 'demo' || email === DEMO_EMAIL;

  if (wantsDemo) {
    /*
     * The public demo is a real tenant with a real agency_id, but it has no
     * password by design. Only this exact account is allowed through without
     * one; every other login still takes the normal bcrypt path below.
     */
    const user = db
      .prepare(`SELECT * FROM users WHERE lower(email) = ?`)
      .get(DEMO_EMAIL);
    if (!user) {
      return res.status(503).json({
        error: 'The demo account is still being prepared. Please try again in a moment.',
      });
    }
    const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(user.agency_id);
    // The public demo always starts from a blank slate. Only this agency is
    // touched; real tenants are never cleared by a demo login.
    if (Number(agency?.is_demo) === 1) {
      db.transaction(() => {
        db.prepare('DELETE FROM denied_claims WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM rebill_tasks WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM day_entries WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM claims WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM service_agreements WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM agreements WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM alerts WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM recent_clients WHERE agency_id = ?').run(user.agency_id);
        db.prepare('DELETE FROM clients WHERE agency_id = ?').run(user.agency_id);
      })();
      console.log('[DEMO] Reset demo data to a blank slate.');
    }
    return res.json({ token: signToken(user), user: publicUser(user, agency) });
  }

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
  // Same message either way: revealing which half was wrong helps attackers.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(user.agency_id);
  res.json({ token: signToken(user), user: publicUser(user, agency) });
});

/* POST /api/auth/change-password  { current_password, new_password } */
router.post('/change-password', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not signed in.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const b = req.body ?? {};
  const current = String(b.current_password ?? '');
  const next = String(b.new_password ?? '');

  if (!verifyPassword(current, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (current === next) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).run(hashPassword(next), user.id);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(fresh.agency_id);
  res.json({ user: publicUser(fresh, agency) });
});

/* GET /api/auth/me — used by the client to validate a stored token */
router.get('/me', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not signed in.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const agency = db.prepare('SELECT * FROM agencies WHERE id = ?').get(user.agency_id);
  res.json({ user: publicUser(user, agency) });
});

export default router;
