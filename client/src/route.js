/**
 * Route parsing for the hash router. Pure and side-effect free so it can be
 * unit tested without a DOM.
 *
 *   #/clients                    -> { name: 'clients' }
 *   #/clients/3                  -> { name: 'client', clientId: 3 }
 *   #/calendar                   -> { name: 'calendar' }
 *   #/calendar/3?week=2026-10-05 -> { name: 'calendar', clientId: 3, week: '2026-10-05' }
 */
export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '') || '/clients';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));

  const page = segments[0] ?? 'clients';
  const idPart = segments[1];
  const clientId = idPart != null && /^\d+$/.test(idPart) ? Number(idPart) : null;

  if (page === 'clients') {
    return clientId != null
      ? { name: 'client', clientId, query }
      : { name: 'clients', clientId: null, query };
  }

  if (page === 'calendar') {
    return { name: 'calendar', clientId, week: query.week ?? null, query };
  }

  // Unknown path — fall back to the client list rather than rendering nothing.
  return { name: 'clients', clientId: null, query };
}

export function clientHash(id) {
  return `#/clients/${id}`;
}

export function calendarHash(id, week) {
  const base = id ? `#/calendar/${id}` : '#/calendar';
  return week ? `${base}?week=${week}` : base;
}
