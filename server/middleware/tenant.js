/**
 * Resolve which agency the request belongs to.
 *
 * Order of precedence:
 *   1. A valid `Authorization: Bearer <jwt>` — the token's agency_id wins.
 *   2. DEMO_MODE — always agency 1. The public demo is one shared workspace.
 *   3. Loopback — agency 1, so local development keeps working without a login.
 *
 * Anything else is 401: an unauthenticated request from a remote host must not
 * be able to read any tenant's data.
 */
import { verifyToken } from '../auth.js';
import db from '../db.js';

const isLoopback = (ip) =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '::ffff:127.0.0.1';

export function tenant(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (token) {
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    const user = db.prepare('SELECT id, agency_id, email, role FROM users WHERE id = ?').get(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    req.user = user;
    req.agencyId = user.agency_id;
    return next();
  }

  /* no token */
  if (String(process.env.DEMO_MODE ?? '').toLowerCase() === 'true') {
    req.agencyId = 1;
    req.user = null;
    return next();
  }

  const ip = req.socket?.remoteAddress ?? '';
  if (isLoopback(ip)) {
    req.agencyId = 1;
    req.user = null;
    return next();
  }

  return res.status(401).json({ error: 'Authentication required.' });
}

export default tenant;
