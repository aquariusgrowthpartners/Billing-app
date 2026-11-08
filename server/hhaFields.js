/**
 * Shared validation for the HHAeXchange flat-file fields.
 *
 * Every rule here mirrors a column constraint from the V5 Flat File Import
 * Layout. They are enforced at the API boundary so bad values are caught while
 * the record is being edited, not at export time when it is too late.
 */

/** Digits only, exact length. Returns { ok } or { error }. */
export function digitsOnly(value, { length, label, required = false, max }) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    if (required) return { error: `${label} is required` };
    return { ok: null };
  }
  if (!/^\d+$/.test(raw)) return { error: `${label} must be numeric` };
  if (length && raw.length !== length) {
    return { error: `${label} must be exactly ${length} digits (got ${raw.length})` };
  }
  if (max && raw.length > max) return { error: `${label} must be at most ${max} digits` };
  return { ok: raw };
}

/**
 * A free-form agency identifier: letters, digits and dashes.
 *
 * Real Agency Tax IDs and NPIs are not always purely numeric (e.g. "92-70505"
 * or "M417128800"), so these are stored verbatim rather than reformatted. Only
 * leading/trailing whitespace is removed, so what is saved is what was typed.
 */
export function identifier(value, { max, label, required = false } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    if (required) return { error: `${label} is required` };
    return { ok: '' };
  }
  if (raw.length > max) {
    return { error: `${label} must be at most ${max} characters (got ${raw.length})` };
  }
  if (!/^[A-Za-z0-9-]+$/.test(raw)) {
    return { error: `${label} may only contain letters, numbers and dashes` };
  }
  return { ok: raw };
}

/** XXX-XX-XXXX. */
export function ssn(value, { label = 'SSN', required = false } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    if (required) return { error: `${label} is required` };
    return { ok: null };
  }
  if (!/^\d{3}-\d{2}-\d{4}$/.test(raw)) {
    return { error: `${label} must look like XXX-XX-XXXX` };
  }
  return { ok: raw };
}

/** M or F. */
export function gender(value, { label = 'Gender' } = {}) {
  const raw = value == null ? '' : String(value).trim().toUpperCase();
  if (!raw) return { ok: null };
  if (raw !== 'M' && raw !== 'F') return { error: `${label} must be M or F` };
  return { ok: raw };
}

/** A YYYY-MM-DD date. */
export function isoDate(value, { label = 'Date', required = false } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    if (required) return { error: `${label} is required` };
    return { ok: null };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: `${label} must be YYYY-MM-DD` };
  return { ok: raw };
}

/** HH:MM on a 24-hour clock. */
export function clockTime(value, { label = 'Start time' } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return { ok: null };
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { error: `${label} must be HH:MM` };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return { error: `${label} must be a real 24-hour time (00:00-23:59)` };
  return { ok: `${String(h).padStart(2, '0')}:${m[2]}` };
}

/** Pipe-separated diagnosis codes, e.g. F84.0|B19.10. */
export function diagnosisCodes(value, { label = 'Diagnosis Code (DX)', max = 208 } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return { ok: null };
  if (raw.length > max) return { error: `${label} must be at most ${max} characters` };
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.some((p) => !p)) {
    return { error: `${label} has an empty code — remove stray or doubled "|"` };
  }
  // ICD-10 style: letter, digits, optional dot suffix.
  const bad = parts.find((p) => !/^[A-Za-z]\d{2}(\.[A-Za-z0-9]{1,4})?$/.test(p));
  if (bad) return { error: `${label}: "${bad}" is not a valid ICD-10 code` };
  return { ok: parts.join('|') };
}
