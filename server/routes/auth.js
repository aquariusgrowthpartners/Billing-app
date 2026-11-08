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
