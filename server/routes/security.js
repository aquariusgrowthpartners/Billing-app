import express from 'express';
import crypto from 'node:crypto';
import db from '../db.js';
import { generateTotpSecret, verifyTotp, otpauthUrl } from '../totp.js';
import { clientIp, logAudit } from '../audit.js';

const router = express.Router();

function isSuperAdmin(user) {
  return Boolean(user && ['admin', 'superadmin'].includes(user.role) && (user.agency_id === 1 || user.role === 'superadmin'));
}

router.get('/status', (req, res) => {
  const user = db.prepare('SELECT totp_enabled, totp_secret FROM users WHERE id = ?').get(req.user.id);
  const agency = db.prepare('SELECT baa_signed_at, baa_signed_name FROM agencies WHERE id = ?').get(req.agencyId);
  res.json({
    totp_enabled: Number(user?.totp_enabled ?? 0),
    totp_configured: Boolean(user?.totp_secret),
    baa_signed_at: agency?.baa_signed_at ?? null,
    baa_signed_name: agency?.baa_signed_name ?? null,
    is_superadmin: isSuperAdmin(req.user),
  });
});

router.post('/2fa/setup', async (req, res) => {
  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  const uri = otpauthUrl(secret, req.user.email);
  let qr = null;
  try {
    const QRCode = (await import('qrcode')).default;
    qr = await QRCode.toDataURL(uri, { width: 220, margin: 1 });
  } catch {
    /* QR library unavailable: the manual key still works. */
  }
  res.json({ secret, otpauth: uri, qr });
});

router.post('/2fa/verify', (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user?.totp_secret) return res.status(400).json({ error: 'Start 2FA setup first.' });
  if (!verifyTotp(user.totp_secret, token)) return res.status(400).json({ error: 'That code is not valid. Try the next one.' });
  const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
  const hashed = recovery.map((code) => crypto.createHash('sha256').update(code).digest('hex'));
  db.prepare('UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashed), req.user.id);
  logAudit(req, '2fa_enabled', 'user', req.user.id);
  res.json({ enabled: true, recovery_codes: recovery });
});

router.post('/baa', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const accepted = Boolean(req.body?.accepted);
  if (!accepted || name.length < 3) {
    return res.status(400).json({ error: 'Check the agreement box and type your full legal name.' });
  }
  db.prepare(
    `UPDATE agencies SET baa_signed_at = datetime('now'), baa_signed_name = ?, baa_signed_ip = ? WHERE id = ?`
  ).run(name, clientIp(req) || null, req.agencyId);
  logAudit(req, 'baa_signed', 'agency', req.agencyId);
  res.json({ signed_at: new Date().toISOString(), signed_name: name });
});

router.get('/allowlist', (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin access is required.' });
  const value = db.prepare(`SELECT value FROM settings WHERE agency_id = 1 AND key = 'allowed_ips'`).get()?.value ?? '';
  res.json({ allowed_ips: value });
});

router.put('/allowlist', (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin access is required.' });
  const value = String(req.body?.allowed_ips ?? '')
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .join(',');
  db.prepare(
    `INSERT INTO settings (agency_id, key, value, updated_at) VALUES (1, 'allowed_ips', ?, datetime('now'))
     ON CONFLICT(agency_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(value);
  logAudit(req, 'ip_allowlist_updated', 'settings', 'allowed_ips');
  res.json({ allowed_ips: value });
});

router.get('/audit', (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin access is required.' });
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const action = String(req.query.action ?? '').trim();
  const where = ['a.agency_id = 1'];
  const params = { offset: (page - 1) * limit, limit };
  if (action) {
    where.push('a.action LIKE @action');
    params.action = `%${action}%`;
  }
  const rows = db.prepare(
    `SELECT a.*, u.email
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.timestamp DESC, a.id DESC
      LIMIT @limit OFFSET @offset`
  ).all(params);
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_logs a WHERE ${where.join(' AND ')}`).get(params).n;
  res.json({ logs: rows, total, page, limit });
});

export default router;
