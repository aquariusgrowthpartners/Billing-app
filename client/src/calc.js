/**
 * Client-side mirror of server/calc.js so the per-day preview updates on every
 * keystroke. The SERVER remains authoritative: after a save we always overwrite
 * the local row with what the API returned.
 */
export const DEFAULT_MINUTES_PER_UNIT = 15;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function computeEntry({ minutes_worked, minutes_per_unit, rate_per_unit, max_units_per_day }) {
  const mpu = Number(minutes_per_unit) > 0 ? Number(minutes_per_unit) : DEFAULT_MINUTES_PER_UNIT;
  const minutes = Math.max(0, Math.trunc(Number(minutes_worked) || 0));
  const rate = Number(rate_per_unit) || 0;

  const units = Math.floor(minutes / mpu);
  const dollars = round2(units * rate);
  const maxUnits = Number(max_units_per_day) || 0;

  return {
    minutes_worked: minutes,
    minutes_per_unit: mpu,
    units,
    rate_per_unit: rate,
    dollars,
    max_units_per_day: maxUnits > 0 ? maxUnits : null,
    over_max_units_per_day: maxUnits > 0 && units > maxUnits,
    remainder_minutes: minutes % mpu,
  };
}

export function toISODate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

/**
 * Sunday-based week start. Claim generation defaults to Sunday..Saturday.
 * (Note: the week CALENDAR is Monday-based — see weekStart below.)
 */
export function weekStartSunday(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(`${dateInput}T00:00:00`);
  d.setDate(d.getDate() - d.getDay()); // 0 = Sunday
  return toISODate(d);
}

/** '2026-01-05' -> '20260105' (the claim-name date format). */
export function compactDate(iso) {
  return String(iso ?? '').replace(/-/g, '');
}

/** Monday-based week start, matching Mon–Sun claim periods. */
export function weekStart(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(`${dateInput}T00:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Whole days from one ISO date to another (positive = later). */
export function daysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00`);
  const b = new Date(`${toISO}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

export function formatLongDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatMoney(n) {
  return (Number(n) || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function formatMinutes(mins) {
  const m = Number(mins) || 0;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * Display name with the optional middle initial: "Sarah E. N".
 * The initial is stored without its period, so one is added for display.
 */
export function formatClientName(person) {
  const first = person?.first_name ?? '';
  const last = person?.last_name ?? '';
  const mi = String(person?.middle_initial ?? '').trim();
  const middle = mi ? ` ${mi.endsWith('.') ? mi : `${mi}.`}` : '';
  return `${first}${middle} ${last}`.trim();
}
