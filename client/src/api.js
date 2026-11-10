// Respect Vite's base path (e.g. /billing/) so subpath hosting works.
const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

const TOKEN_KEY = 'billing_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

export function clearToken() {
  setToken(null);
}

async function request(path, options = {}) {
  // FormData must NOT get a Content-Type header — the browser sets it, along
  // with the multipart boundary.
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = isFormData
    ? { ...(options.headers ?? {}) }
    : { 'Content-Type': 'application/json', ...(options.headers ?? {}) };

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  login: (body) => request('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  demoLogin: () => request('/auth/login', { method: 'POST', body: JSON.stringify({ demo: true }) }),
  superadminAgencies: () => request('/superadmin/agencies'),
  auditData: (global = false) =>
    request(`/admin/audit-data${global ? '?global=true' : ''}`),
  toggleDemoAi: (enabled) =>
    request('/superadmin/demo-ai', { method: 'POST', body: JSON.stringify({ enabled }) }),
  superadminUpdateAgency: (id, body) =>
    request(`/superadmin/agencies/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  changePassword: (body) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify(body) }),
  signup: (body) => request('/auth/signup', { method: 'POST', body: JSON.stringify(body) }),
  me: () => request('/auth/me'),
  mode: () => request('/mode'),
  week: (start) => request(`/week${start ? `?start=${start}` : ''}`),

  searchClients: (q, opts = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (opts.includeInactive) params.set('active', '0');
    // Archived clients are hidden unless explicitly requested.
    if (opts.includeArchived) params.set('archived', '1');
    if (opts.limit) params.set('limit', String(opts.limit));
    return request(`/clients?${params}`);
  },
  getClient: (id, opts = {}) =>
    request(`/clients/${id}${opts.archived ? '?archived=1' : ''}`),
  createClient: (body) => request('/clients', { method: 'POST', body: JSON.stringify(body) }),
  deleteClient: (id) => request(`/clients/${id}`, { method: 'DELETE' }),
  claimDeleteCheck: (id) => request(`/claims/${id}/delete-check`),
  bulkArchiveClaims: (ids) =>
    request('/claims/bulk-archive', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkUnarchiveClaims: (ids) =>
    request('/claims/bulk-unarchive', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkUnarchiveCheck: (ids) =>
    request('/claims/bulk-unarchive-check', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkDeleteCheck: (ids) =>
    request('/claims/bulk-delete-check', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkDeleteClaims: (ids) =>
    request('/claims/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  setClaimArchived: (id, archived) =>
    request(`/claims/${id}`, { method: 'PUT', body: JSON.stringify({ archived: archived ? 1 : 0 }) }),
  clientDeleteCheck: (id) => request(`/clients/${id}/delete-check`),
  // Soft delete: archived clients leave the default list but keep all history.
  setClientArchived: (id, archived) =>
    request(`/clients/${id}`, { method: 'PUT', body: JSON.stringify({ archived: archived ? 1 : 0 }) }),

  // Re-derive a claim's totals from its day entries (Draft claims only).
  regenerateClaim: (id) => request(`/claims/${id}/regenerate`, { method: 'POST' }),
  // Unlock a Submitted/Paid claim by returning it to Draft.
  revertClaimToDraft: (id) => request(`/claims/${id}/revert`, { method: 'POST' }),
  // PUT (the backend also accepts PATCH for the same partial update).
  updateClient: (id, body) =>
    request(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  createAgreement: (body) => request('/agreements', { method: 'POST', body: JSON.stringify(body) }),
  updateAgreement: (id, body) =>
    request(`/agreements/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  getAgreement: (id) => request(`/agreements/${id}`),

  /**
   * Upload a DHS Service Agreement PDF.
   *
   * `dryRun` parses and returns the preview without writing anything; the real
   * call is the same request minus the flag, so the preview shows exactly what
   * saving will do.
   */
  uploadServiceAgreement: (clientId, file, { dryRun = false } = {}) => {
    const body = new FormData();
    body.append('file', file);
    return request(
      `/clients/${clientId}/service-agreement${dryRun ? '?dryRun=1' : ''}`,
      { method: 'POST', body }
    );
  },
  /** The auth number lives on the PARENT service agreement, not on a line. */
  /* ------------------------------------------------------------- tasks */
  tasks: () => request('/tasks'),
  createNewHire: (body) =>
    request('/tasks/new-hire', { method: 'POST', body: JSON.stringify(body) }),
  explainDenial: (id) => request(`/denials/${id}/explain`, { method: 'POST' }),
  ask: (query) => request('/ask', { method: 'POST', body: JSON.stringify({ query }) }),
  ytdClaims: () => request('/metrics/ytd-claims'),
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),
  verifyRa: (file) => {
    const body = new FormData();
    body.append('file', file);
    return request('/ai/verify-ra', { method: 'POST', body });
  },
  verifyRaBulk: (files) => {
    const body = new FormData();
    for (const file of files) body.append('files', file);
    return request('/ai/verify-ra-bulk', { method: 'POST', body });
  },
  debugStatus: () => request('/ai/debug-status'),
  testDocIntel: (file) => {
    const body = new FormData();
    body.append('file', file);
    return request('/ai/test-doc-intel', { method: 'POST', body });
  },
  verifyRaBulkJob: (jobId) => request(`/ai/verify-ra-bulk/${jobId}`),
  parseNewHire: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/tasks/parse-new-hire', { method: 'POST', body: fd });
  },
  createGeneralTask: (body, file) => {
    const fd = new FormData();
    Object.entries(body ?? {}).forEach(([k, v]) => {
      if (v != null) fd.append(k, v);
    });
    if (file) fd.append('file', file);
    return request('/tasks/general', { method: 'POST', body: fd });
  },
  uploadTaskItem: (taskId, itemId, file) => {
    const body = new FormData();
    body.append('file', file);
    return request(`/tasks/${taskId}/items/${itemId}/upload`, { method: 'POST', body });
  },
  patchServiceAgreement: (id, patch) =>
    request(`/service-agreements/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  patchAgreement: (id, patch) =>
    request(`/agreements/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),


  getWeekEntries: (clientId, start) => request(`/clients/${clientId}/weeks?start=${start}`),
  getSummary: (clientId, start, agreementId) => {
    const params = new URLSearchParams({ client_id: clientId, start });
    if (agreementId) params.set('agreement_id', agreementId);
    return request(`/day-entries/summary?${params}`);
  },
  saveDay: (body) => request('/day-entries', { method: 'POST', body: JSON.stringify(body) }),
  // Delete several days' entries in one call.
  bulkDeleteDayEntries: (body) =>
    request('/day-entries/bulk-delete', { method: 'POST', body: JSON.stringify(body) }),

  saveWeek: (days) => request('/day-entries/bulk', { method: 'POST', body: JSON.stringify({ days }) }),
  deleteDay: (id) => request(`/day-entries/${id}`, { method: 'DELETE' }),

  // Dates are optional: omitting them asks the server for the client's whole
  // unclaimed span, which is what the dialog uses as its default range.
  previewClaim: (clientId, periodStart, periodEnd) => {
    const params = new URLSearchParams({ client_id: clientId });
    if (periodStart && periodEnd) {
      params.set('period_start', periodStart);
      params.set('period_end', periodEnd);
    }
    return request(`/claims/preview?${params}`);
  },
  generateClaim: (body) => request('/claims', { method: 'POST', body: JSON.stringify(body) }),
  updateClaim: (id, body) =>
    request(`/claims/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteClaim: (id) => request(`/claims/${id}`, { method: 'DELETE' }),

  // Local PDF attachment (Week 3 phase 1).
  claimPdfUrl: (id) => `${BASE}/claims/${id}/pdf`,
  claimPdfInfo: (id) => request(`/claims/${id}/pdf/info`),
  uploadClaimPdf: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/claims/${id}/pdf`, { method: 'POST', body: form });
  },
  deleteClaimPdf: (id) => request(`/claims/${id}/pdf`, { method: 'DELETE' }),

  // Generated claim summary PDF (built by pdfkit from the claim's own data).
  generateClaimPdf: (id) => request(`/claims/${id}/pdf/generate`, { method: 'POST' }),
  claimGeneratedPdfUrl: (id, { download = false } = {}) =>
    `${BASE}/claims/${id}/pdf/generated${download ? '?download=1' : ''}`,
  deleteGeneratedClaimPdf: (id) =>
    request(`/claims/${id}/pdf/generated`, { method: 'DELETE' }),
  payerStats: () => request('/claims/payer-stats'),

  // Caretakers — the people who deliver care, recorded per day.
  caretakers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/caretakers${qs ? `?${qs}` : ''}`);
  },
  getCaretaker: (id) => request(`/caretakers/${id}`),
  caretakerSummary: (id, start) =>
    request(`/caretakers/${id}/summary${start ? `?start=${start}` : ''}`),
  caretakerSplits: (id, range, start) =>
    request(
      `/caretakers/${id}/client-splits?range=${range}${start ? `&start=${start}` : ''}`
    ),
  caretakerHistory: (id, params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return request(`/caretakers/${id}/work-history${q ? `?${q}` : ''}`);
  },
  caretakerCalendar: (id, month) =>
    request(`/caretakers/${id}/calendar${month ? `?month=${month}` : ''}`),

  createCaretaker: (body) => request('/caretakers', { method: 'POST', body: JSON.stringify(body) }),
  updateCaretaker: (id, body) =>
    request(`/caretakers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCaretaker: (id, { force = false } = {}) =>
    request(`/caretakers/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  // Case managers — assigned to a client.
  caseManagers: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/case-managers${qs ? `?${qs}` : ''}`);
  },
  createCaseManager: (body) =>
    request('/case-managers', { method: 'POST', body: JSON.stringify(body) }),
  updateCaseManager: (id, body) =>
    request(`/case-managers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteCaseManager: (id, { force = false } = {}) =>
    request(`/case-managers/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  payers: () => request('/payers'),
  updatePayer: (id, body) => request(`/payers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePayer: (id, { force = false } = {}) =>
    request(`/payers/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' }),

  // Backup + export download URLs (plain links, so the browser streams them).
  backupUrl: () => `${BASE}/backup`,
  claimsCsvUrl: (params = {}) => {
    const search = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = search.toString();
    return `${BASE}/claims/export.csv${qs ? `?${qs}` : ''}`;
  },

  // Home Dashboard.
  payPeriod: (start) =>
    request(`/dashboard/pay-period${start ? `?start=${start}` : ''}`),
  recentRa: () => request('/dashboard/recent-ra'),
  recentClients: () => request('/dashboard/recent-clients'),

  // Denials and rebill tasks.
  denials: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return request(`/denials${q ? `?${q}` : ''}`);
  },
  denial: (id) => request(`/denials/${id}`),
  denialMarkers: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/denials/markers?${q}`);
  },
  denialPdfUrl: (id) => `${BASE}/denials/${id}/pdf`,
  denialsCsvUrl: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return `${BASE}/denials/export.csv${q ? `?${q}` : ''}`;
  },
  denialSummary: () => request('/denials/summary'),
  rebillTasks: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
    return request(`/denials/rebill/tasks${q ? `?${q}` : ''}`);
  },
  raAudit: () => request('/import-ra/audit'),
  // FILE-ROW id
  raFilePdfUrl: (fileRowId) => `${BASE}/import-ra/file/${fileRowId}/pdf`,
  raStorage: () => request('/import-ra/storage'),
  // DRY RUN ONLY — reports what a cleanup would remove; deletes nothing.
  raCleanupPreview: () => request('/import-ra/cleanup-preview'),
  // Duplicate detection. Hashes are computed in the browser, so an exact
  // re-upload is caught before a single byte is sent.
  checkDuplicates: (hashes) =>
    request('/import-ra/check-duplicates', {
      method: 'POST',
      body: JSON.stringify({ hashes }),
    }),
  overwriteCheck: (importId) => request(`/import-ra/import/${importId}/overwrite-check`),
  raRunCleanup: () =>
    request('/import-ra/cleanup', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }),
  // Both take FILE-ROW ids (ra_import_files.id) — the id the audit table shows.
  // A live id and an empty id go through this one path; there is no second
  // endpoint and no branching on row type.
  raPreviewDeleteFileRows: (fileRowIds) =>
    request('/import-ra/bulk-delete-preview', {
      method: 'POST',
      body: JSON.stringify({ ids: fileRowIds }),
    }),
  raPreviewDeleteAllImports: () =>
    request('/import-ra/bulk-delete-preview', {
      method: 'POST',
      body: JSON.stringify({ all: true }),
    }),
  raDeleteAllImports: () =>
    request('/import-ra/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ all: true, confirm: 'DELETE' }),
    }),
  raDeleteFileRows: (fileRowIds, confirm) =>
    request('/import-ra/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: fileRowIds, confirm }),
    }),
  // FILE-ROW ids
  raBulkPdfsUrl: (fileRowIds) => `${BASE}/import-ra/bulk-pdfs?ids=${fileRowIds.join(',')}`,
  // FILE-ROW id
  raDeleteFileRow: (fileRowId) => request(`/import-ra/file/${fileRowId}`, { method: 'DELETE' }),

  claimsDump: () => request('/admin/claims-dump'),
  // FILE-ROW id
  raDiagnostic: (fileRowId) => request(`/import-ra/file/${fileRowId}/diagnostic`),
  // FILE-ROW id
  raReparse: (fileRowId, confirm) =>
    request(`/import-ra/file/${fileRowId}/reparse`, {
      method: 'POST',
      body: JSON.stringify({ confirm: Boolean(confirm) }),
    }),
  denialDeletePreview: (ids) =>
    request(`/denials/delete-preview?ids=${(Array.isArray(ids) ? ids : [ids]).join(',')}`),
  deleteDenial: (id) => request(`/denials/${id}`, { method: 'DELETE' }),
  bulkDeleteDenials: (ids) =>
    request('/denials/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  deleteRebillTask: (id) => request(`/rebill-tasks/${id}`, { method: 'DELETE' }),
  updateRebillTask: (id, body) =>
    request(`/denials/rebill/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Data maintenance.
  orphanedEntries: () => request('/admin/orphaned-entries'),
  orphanedCount: () => request('/admin/orphaned-entries/count'),
  cleanupOrphans: (confirm) =>
    request('/admin/orphaned-entries/cleanup', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),

  // Remittance Advice import. Parsing is read-only; only saveRa writes.
  parseRa: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/import-ra', { method: 'POST', body: form });
  },
  parseRaBatch: (files) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return request('/import-ra/batch', { method: 'POST', body: form });
  },
  matchRa: (client_name) =>
    request('/import-ra/match', { method: 'POST', body: JSON.stringify({ client_name }) }),
  raExisting: (body) =>
    request('/import-ra/existing', { method: 'POST', body: JSON.stringify(body) }),
  saveRa: (rows, file_name, meta = {}) =>
    request('/import-ra/save', {
      method: 'POST',
      body: JSON.stringify({ rows, file_name, ...meta }),
    }),

  // MPSMISC reporting spreadsheet (read-only preview + download).
  mpsmiscPreview: (params) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString();
    return request(`/exports/mpsmisc/preview${q ? `?${q}` : ''}`);
  },
  mpsmiscDownloadUrl: (params) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString();
    return `${BASE}/exports/mpsmisc.xlsx${q ? `?${q}` : ''}`;
  },

  // HHAeXchange flat-file exports (server sets the required file names).
  caregiverExportUrl: () => `${BASE}/exports/caregivers.csv`,
  visitExportUrl: () => `${BASE}/exports/visits.csv`,
  visitExportValidation: () => request('/exports/validation'),

  reports: (params = {}) => {
    const search = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const qs = search.toString();
    return request(`/reports${qs ? `?${qs}` : ''}`);
  },

  getSettings: () => request('/settings'),
  updateSettings: (body) => request('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  createPayer: (body) => request('/payers', { method: 'POST', body: JSON.stringify(body) }),
  claims: (params = {}) => {
    const search = new URLSearchParams(params);
    return request(`/claims?${search}`);
  },
};

export default api;
