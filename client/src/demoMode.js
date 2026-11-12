/** True only while the active session is the public demo tenant. */
export function isDemoMode() {
  try {
    return window.__DUNDAS_DEMO__ === true;
  } catch {
    return false;
  }
}

export function setDemoMode(value) {
  try {
    window.__DUNDAS_DEMO__ = Boolean(value);
  } catch {
    /* ignore */
  }
}
