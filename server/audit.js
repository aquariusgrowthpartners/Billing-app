import db from './db.js';

export function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  return String((Array.isArray(forwarded) ? forwarded[0] : forwarded) || req?.ip || '')
    .split(',')[0]
    .trim();
}

export function logAudit(req, action, resourceType, resourceId = null) {
  try {
    db.prepare(
      `INSERT INTO audit_logs (agency_id, user_id, action, resource_type, resource_id, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      req.agencyId,
      req.user?.id ?? null,
      String(action),
      String(resourceType),
      resourceId == null ? null : String(resourceId),
      clientIp(req) || null
    );
  } catch (err) {
    console.error('[AUDIT] write failed:', err.message);
  }
}
