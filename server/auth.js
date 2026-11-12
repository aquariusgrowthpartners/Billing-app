/**
 * JWT + password helpers.
 *
 * The signing secret comes from JWT_SECRET. Without it we fall back to a
 * generated per-process secret, which invalidates every token on restart — safe
 * for local development, and a deploy without JWT_SECRET is loudly warned
 * about rather than silently using a well-known default.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DEV_SECRET = crypto.randomBytes(32).toString('hex');

export const JWT_SECRET = process.env.JWT_SECRET || DEV_SECRET;
export const JWT_EXPIRES_IN = '7d';

if (!process.env.JWT_SECRET) {
  console.warn('  auth         JWT_SECRET not set — using an ephemeral secret (tokens die on restart)');
}

export function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

export function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(String(plain), String(hash));
  } catch {
    return false;
  }
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, agency_id: user.agency_id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function signChallenge(user) {
  return jwt.sign({ sub: user.id, purpose: '2fa' }, JWT_SECRET, { expiresIn: '5m' });
}

export function verifyChallenge(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload?.purpose === '2fa' ? payload : null;
  } catch {
    return null;
  }
}

/** Returns the decoded payload, or null when the token is missing/invalid. */
export function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Email shape check — deliberately permissive; the DB enforces uniqueness. */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email ?? '').trim());
}

export function passwordProblem(password) {
  const p = String(password ?? '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  return null;
}
