/**
 * Money / unit math. This module is the single source of truth — the API and
 * the UI both call the same rules so a preview can never disagree with a save.
 */

export const DEFAULT_MINUTES_PER_UNIT = 15;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * units  = Math.floor(minutes_worked / minutes_per_unit)
 * dollars = units * rate_per_unit
 * Flags when units exceed the agreement's max_units_per_day.
 */
export function computeEntry({ minutes_worked, minutes_per_unit, rate_per_unit, max_units_per_day }) {
  const mpu = toNumber(minutes_per_unit, 0) > 0 ? toNumber(minutes_per_unit) : DEFAULT_MINUTES_PER_UNIT;
  const minutes = Math.max(0, Math.trunc(toNumber(minutes_worked, 0)));
  const rate = toNumber(rate_per_unit, 0);

  const units = Math.floor(minutes / mpu);
  const dollars = round2(units * rate);

  const maxUnits = toNumber(max_units_per_day, 0);
  const overMax = maxUnits > 0 && units > maxUnits;

  return {
    minutes_worked: minutes,
    minutes_per_unit: mpu,
    units,
    rate_per_unit: rate,
    dollars,
    max_units_per_day: maxUnits > 0 ? maxUnits : null,
    over_max_units_per_day: overMax,
    // carried through for UI warnings
    remainder_minutes: minutes % mpu,
    reason: overMax
      ? `Units (${units}) exceed the agreement max of ${maxUnits}/day`
      : null,
  };
}

export function todayISO() {
  const d = new Date();
  return toISODate(d);
}

export function toISODate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday-based week start (ISO weeks), matching the Mon–Sun claim periods. */
export function weekStart(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(`${dateInput}T00:00:00`);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function daysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00`);
  const b = new Date(`${toISO}T00:00:00`);
  return Math.round((b - a) / 86400000);
}
