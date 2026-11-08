/**
 * Theme engine.
 *
 * Two independent axes on <html>:
 *   data-theme = light | dark   — surfaces, text, borders
 *   --primary   = any hex       — the accent, set as an inline CSS variable
 *
 * The accent is stored as a hex string so a colour wheel and the presets share
 * one representation. Named presets from older settings rows are still accepted.
 */

export const MODES = ['light', 'dark', 'system'];

export const PRESETS = [
  { key: 'blue', label: 'Blue', hex: '#1f5fd6' },
  { key: 'emerald', label: 'Emerald', hex: '#047857' },
  { key: 'violet', label: 'Violet', hex: '#6d28d9' },
  { key: 'rose', label: 'Rose', hex: '#be123c' },
  { key: 'amber', label: 'Amber', hex: '#b45309' },
  { key: 'slate', label: 'Slate', hex: '#334155' },
];

const DEFAULT_HEX = '#1f5fd6';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const KEY_MODE = 'theme_mode';
const KEY_COLOR = 'theme_color';

/* ------------------------------------------------------------------ colour */

export function isHex(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}

/** Accept a preset key ("emerald"), a hex, or nothing. */
export function resolveHex(color) {
  if (isHex(color)) return color.trim().toLowerCase();
  const preset = PRESETS.find((p) => p.key === color);
  return preset ? preset.hex : DEFAULT_HEX;
}

function toRgb(hex) {
  const h = resolveHex(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb) {
  return (
    '#' +
    rgb
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Mix toward black (amount < 0) or white (amount > 0). */
function shade(hex, amount) {
  const rgb = toRgb(hex);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return toHex(rgb.map((c) => c + (target - c) * t));
}

export function darken(hex, amount = 0.22) {
  return shade(hex, -amount);
}

export function tint(hex, amount = 0.88) {
  return shade(hex, amount);
}

/**
 * Readable text for a given background.
 * Uses WCAG relative luminance rather than a naive average, because a mid-tone
 * yellow and a mid-tone blue have the same average but need opposite text.
 */
export function getContrastColor(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? '#000000' : '#FFFFFF';
}

/* ------------------------------------------------------------------- state */

const mq = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function resolveMode(mode) {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return mq()?.matches ? 'dark' : 'light';
}

export function getStored() {
  try {
    return { mode: localStorage.getItem(KEY_MODE), color: localStorage.getItem(KEY_COLOR) };
  } catch {
    return { mode: null, color: null };
  }
}

/** Apply the theme to <html>. Safe before React paints. */
export function applyTheme(mode, color) {
  const root = document.documentElement;
  if (!root) return;

  const resolved = resolveMode(mode);
  root.setAttribute('data-theme', resolved);

  const hex = resolveHex(color);
  root.setAttribute('data-color', isHex(color) ? 'custom' : color || 'blue');

  // the whole accent family derives from the picked hex
  root.style.setProperty('--primary', hex);
  root.style.setProperty('--primary-hover', darken(hex));
  root.style.setProperty('--primary-soft', tint(hex));
  root.style.setProperty('--on-primary', getContrastColor(hex));
  root.style.setProperty('--primary-shadow', `rgba(${toRgb(hex).join(', ')}, 0.35)`);

  root.style.colorScheme = resolved;
}

export function setTheme(mode, color) {
  try {
    if (MODES.includes(mode)) localStorage.setItem(KEY_MODE, mode);
    if (color) localStorage.setItem(KEY_COLOR, color);
  } catch {
    /* private mode — the session still gets the change */
  }
  applyTheme(mode, color);
}

/** Boot before React renders: localStorage wins, settings table is the default. */
export async function initTheme() {
  const stored = getStored();
  let mode = stored.mode;
  let color = stored.color;

  if (!mode || !color) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/settings`);
      if (res.ok) {
        const d = await res.json();
        mode = mode ?? d?.settings?.theme_mode ?? 'light';
        color = color ?? d?.settings?.theme_color ?? 'blue';
      }
    } catch {
      /* offline: defaults are fine */
    }
  }

  mode = mode ?? 'light';
  color = color ?? 'blue';
  applyTheme(mode, color);
  return { mode, color };
}

export function watchSystem(mode, color) {
  const m = mq();
  if (!m || mode !== 'system') return () => {};
  const handler = () => applyTheme('system', color);
  m.addEventListener?.('change', handler);
  return () => m.removeEventListener?.('change', handler);
}
