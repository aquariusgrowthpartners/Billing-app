/**
 * App preferences, stored in the `settings` table as key/value rows.
 * Reading is always safe: an unknown key falls back to the built-in default.
 */
import db from './db.js';

/** Tokens a claim-name template may use, and what each expands to. */
export const TEMPLATE_TOKENS = [
  { token: '{last}', description: "Client's last name" },
  { token: '{first}', description: "Client's first name" },
  { token: '{ma}', description: 'MA number' },
  { token: '{dos_start}', description: 'Period start, as YYYYMMDD' },
  { token: '{dos_end}', description: 'Period end, as YYYYMMDD' },
  { token: '{seq}', description: 'Sequence for this client + period, zero padded' },
];

const DEFAULTS = {
  claim_name_template: '{last}_{ma}_{dos_start}_{dos_end}_{seq}',
};

export function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row?.value ?? DEFAULTS[key] ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')`
  ).run({ key, value });
  return getSetting(key);
}

export function allSettings() {
  const rows = db.prepare(`SELECT key, value, updated_at FROM settings`).all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Validate a claim-name template.
 * Unknown tokens are rejected rather than silently left in the name, because a
 * literal "{nope}" would end up in a filename and on a PDF.
 */
export function validateTemplate(template) {
  const value = String(template ?? '').trim();
  if (!value) return { ok: false, error: 'The template cannot be empty.' };
  if (value.length > 120) return { ok: false, error: 'The template is too long (max 120 characters).' };

  const found = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[0]);
  const known = new Set(TEMPLATE_TOKENS.map((t) => t.token));
  const unknown = [...new Set(found.filter((t) => !known.has(t)))];
  if (unknown.length) {
    return { ok: false, error: `Unknown token${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` };
  }
  if (!found.length) {
    return { ok: false, error: 'The template needs at least one token, or every claim would share a name.' };
  }
  if (value.includes('/') || value.includes('\\')) {
    return { ok: false, error: 'The template cannot contain slashes.' };
  }
  return { ok: true, value };
}

export default { getSetting, setSetting, allSettings, validateTemplate, TEMPLATE_TOKENS, DEFAULTS };
