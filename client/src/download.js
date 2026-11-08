/**
 * Trigger a browser download without leaving the page.
 * An anchor click is used rather than window.open so popup blockers stay out
 * of the way and the suggested filename is respected.
 */
export function download(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Expand a claim-name template the same way the server does, so the preview in
 * Settings matches the names that actually get generated.
 */
export function renderTemplate(template, parts) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (m, key) =>
    key in parts ? parts[key] : m
  );
}

export const SAMPLE_PARTS = {
  last: 'Smith',
  first: 'Alice',
  ma: '123456789',
  dos_start: '20260105',
  dos_end: '20260111',
  seq: '01',
};

export default download;
