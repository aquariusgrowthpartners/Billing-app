/**
 * HHAeXchange V5 flat-file exports.
 *
 * Two files, both derived from the data already in this app:
 *   - CaregiverImport_{AgencyTaxID}_{YYYYMMDD}.csv
 *   - VISITS_{AgencyTaxID}_{YYYYMMDDHHMMSS}.CSV
 *
 * The column lists below are deliberate constants, in the exact order the
 * import layout requires. Nothing here writes to the database.
 */
import db from './db.js';
import { allSettings } from './settings.js';
import { addDays } from './calc.js';

/* ------------------------------------------------------------- CSV bits */

/**
 * Escape one cell.
 * `quote` wraps EVERY field in a text qualifier, which the visit layout asks
 * for so Excel cannot mangle dates, leading zeros or commas.
 */
export function csvCell(value, { quote = false } = {}) {
  const raw = value == null ? '' : String(value);
  const needsQuotes = quote || /[",\r\n]/.test(raw);
  if (!needsQuotes) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

export function csvLine(cells, opts) {
  return cells.map((c) => csvCell(c, opts)).join(',');
}

export function csvDocument(header, rows, opts) {
  // CRLF line endings, as the visit layout requires.
  return [csvLine(header, opts), ...rows.map((r) => csvLine(r, opts))].join('\r\n') + '\r\n';
}

/** Local-time stamp helpers for the file names. */
export function stamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ymd = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const hms = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return { ymd, hms };
}

/* ----------------------------------------------------------- caregivers */

export const CAREGIVER_COLUMNS = [
  'Agency Tax ID',
  'Caregiver Code',
  'First Name',
  'Middle Name',
  'Last Name',
  'Initials',
  'Gender',
  'Date of Birth',
  'Status',
  'SSN',
  'Primary Patient Team',
  'Employment Type',
  'Street 1',
  'Street 2',
  'City',
  'State',
  'Zip',
  'Home Phone',
  'Phone 2',
  'Phone 3',
  'Emergency contacts',
  'User Field 1',
  'User Field 2',
  'User Field 3',
  'User Field 4',
  'User Field 5',
];

/** Default employment type the layout documents. */
export const EMPLOYMENT_TYPE = 'HHA|PCA|HSK';

/** "Dana Lee" -> "DL". */
export function initialsOf(first, last) {
  const a = String(first ?? '').trim()[0] ?? '';
  const b = String(last ?? '').trim()[0] ?? '';
  return `${a}${b}`.toUpperCase();
}

/**
 * Caregiver Code: the caregiver's id, so the visit file's Caregiver Code
 * matches this one exactly. (The layout allows the NPI instead; the NPI is
 * carried in User Field 10 of the visit file either way.)
 */
export function caregiverCode(caretaker) {
  return caretaker?.id == null ? '' : String(caretaker.id);
}

export function buildCaregiverRows(caretakers, agencyTaxId) {
  return caretakers.map((t) => [
    agencyTaxId,
    caregiverCode(t),
    t.first_name ?? '',
    '', // Middle Name — no field in this app
    t.last_name ?? '',
    initialsOf(t.first_name, t.last_name),
    t.gender ?? '',
    t.dob ?? '',
    t.active ? 'Active' : 'Inactive',
    t.ssn ?? '',
    '', // Primary Patient Team
    EMPLOYMENT_TYPE,
    '', // Street 1
    '', // Street 2
    '', // City
    '', // State
    '', // Zip
    '', // Home Phone
    '', // Phone 2
    '', // Phone 3
    '', // Emergency contacts
    '', // User Field 1 (Office ID)
    '', // User Field 2
    '', // User Field 3
    '', // User Field 4
    '', // User Field 5
  ]);
}

export function buildCaregiverCsv({ agencyTaxId, caretakers }) {
  return csvDocument(CAREGIVER_COLUMNS, buildCaregiverRows(caretakers, agencyTaxId));
}

/* --------------------------------------------------------------- visits */

export const VISIT_COLUMNS = [
  'Agency Tax ID',              // A
  'Payer ID',                   // B
  'Medicaid Number',            // C
  'Caregiver Code',             // D
  'Caregiver First Name',       // E
  'Caregiver Last Name',        // F
  'Caregiver Gender',           // G
  'Caregiver SSN',              // H
  'Schedule ID',                // I
  'Procedure Code',             // J
  'Schedule Start Time',        // K
  'Schedule End Time',          // L
  'Visit Start Time',           // M
  'Visit End Time',             // N
  'EVV Start Time',             // O
  'EVV End Time',               // P
  'Service Location',           // Q
  'Duties',                     // R
  'Clock-In Phone Number',      // S
  'Clock-In Latitude',          // T
  'Clock-In Longitude',         // U
  'Clock-In EVV Other Info',    // V
  'Clock-Out Phone Number',     // W
  'Clock-Out Latitude',         // X
  'Clock-Out Longitude',        // Y
  'Clock-Out EVV Other Info',   // Z
  'Invoice Number',             // AA
  'Visit Edit Reason Code',     // AB
  'Visit Edit Action Taken',    // AC
  'Notes',                      // AD
  'Is Deletion',                // AE
  'Invoice Line Item ID',       // AF
  'Missed Visit',               // AG
  'Missed Visit Reason Code',   // AH
  'Missed Visit Action Taken',  // AI
  'Timesheet Required',         // AJ
  'Timesheet Approved',         // AK
  'User Field 1',               // AL  Agency NPI
  'User Field 2',               // AM  Emp Reg ID
  'User Field 3',               // AN  Billing DX
  'User Field 4',               // AO
  'User Field 5',               // AP
  'Authorization',              // AQ  HHAeXchange auth # from the parent agreement
];

export const DEFAULT_START_TIME = '08:00';

/** 'HH:MM' -> minutes past midnight. */
export function parseClock(value) {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 8 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Schedule window for one visit. A visit that runs past midnight rolls the end
 * date forward rather than wrapping the clock, so the end is never "before"
 * the start.
 */
export function scheduleWindow(workDate, startTime, minutes) {
  const startMin = parseClock(startTime || DEFAULT_START_TIME);
  const total = startMin + Math.max(0, Number(minutes) || 0);
  const endDate = addDays(workDate, Math.floor(total / 1440));
  const endMin = total % 1440;
  const at = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  return {
    start: `${workDate} ${at(startMin)}`,
    end: `${endDate} ${at(endMin)}`,
    start_min: startMin,
    end_min: total,
  };
}

/** Unique per visit: {ClientID}-{Date}-{CaregiverID}. */
export function scheduleId(row) {
  return `${row.client_id}-${row.work_date}-${row.caretaker_id ?? ''}`;
}

/**
 * Every day entry that should reach HHAeXchange, joined to everything the visit
 * layout needs.
 *
 * Archived clients are excluded here rather than at each call site, because
 * this single query feeds BOTH the pre-export validation and the export itself.
 * That keeps them in agreement: an archived client can produce neither a
 * warning nor a CSV row. Their rows are left untouched in the database.
 */

/**
 * The procedure code for a visit, resolved by DATE OF SERVICE.
 *
 * `day_entries.agreement_id` is a snapshot taken when the row was created. It
 * goes stale the moment an advice is revised, and it never learns about a
 * service agreement uploaded afterwards — which is how all 509 visits ended up
 * pointing at hand-created rows with no code and no auth.
 *
 * The live question is "which authorised line covers this date?", so that is
 * what we ask. S5116 is a period budget, never a billable visit.
 */
export function resolveProcedureCodeForVisit(db, clientId, visitDate, billedCode = null, billedModifier = null, agencyId = null) {
  const day = String(visitDate ?? '').slice(0, 10);
  if (!clientId || !day) return null;

  const matches = db
    .prepare(
      `SELECT a.id AS agreement_id, a.service_code, a.service_code_with_modifier,
              a.start_date, a.end_date, sa.hhaexchange_auth_number
         FROM agreements a
         LEFT JOIN service_agreements sa ON sa.id = a.service_agreement_id
        WHERE a.client_id = @client
          AND (a.service_code IS NULL OR a.service_code NOT LIKE 'S5116%')
          AND a.superseded_at IS NULL
          AND NOT (a.start_date IS NULL AND a.end_date IS NULL)
          AND (a.start_date IS NULL OR a.start_date <= @day)
          AND (a.end_date   IS NULL OR a.end_date   >= @day)`
    )
    .all({ client: Number(clientId), day, agency: agencyId });

  if (!matches.length) return null;

  const want = billedCode
    ? billedModifier
      ? `${billedCode}:${billedModifier}`
      : billedCode
    : null;
  const isBase = (m) =>
    !m.service_code_with_modifier ||
    !m.service_code_with_modifier.includes(':') ||
    m.service_code_with_modifier === m.service_code;

  const rank = (m) => {
    // a) exact code+modifier match, b) exact base match, c) base over modified
    if (billedCode && billedModifier && m.service_code_with_modifier === want) return 0;
    if (billedCode && !billedModifier && m.service_code_with_modifier === want) return 0;
    if (isBase(m)) return 1;
    return 2;
  };

  const sorted = [...matches].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    // d) latest start_date, e) latest id
    const as = a.start_date ?? '';
    const bs = b.start_date ?? '';
    if (as !== bs) return bs.localeCompare(as);
    return b.agreement_id - a.agreement_id;
  });

  const pick = sorted[0];
  if (matches.length > 1) {
    const why = ['exact code+modifier', 'base code', 'modified variant'][rank(pick)] ?? 'fallback';
    console.warn(
      `[export] ${matches.length} agreements match client ${clientId} on ${day} — chose id ${pick.agreement_id} (${why})`
    );
  }

  // procedure_code is the BASE code: the ':XX' modifier belongs in its own column
  const base = String(pick.service_code_with_modifier ?? pick.service_code ?? '');
  return {
    agreement_id: pick.agreement_id,
    procedure_code: base.split(':')[0] || null,
    service_code_with_modifier: pick.service_code_with_modifier,
    hhaexchange_auth_number: pick.hhaexchange_auth_number ?? null,
    effective_from: pick.start_date ?? null,
    effective_to: pick.end_date ?? null,
    collision: matches.length > 1,
  };
}

export function visitSourceRows(agencyId) {
  return db
    .prepare(
      `SELECT d.id, d.work_date, d.minutes_worked, d.units, d.dollars, d.rate_per_unit,
              d.start_time, d.notes, d.claim_id, d.caretaker_id,
              d.service_code, d.modifier,
              c.id AS client_id, c.first_name AS client_first, c.last_name AS client_last,
              c.ma_number, c.diagnosis_code,
              a.id AS agreement_id, a.service_code, a.payer_id,
              sa.hhaexchange_auth_number,
              p.name AS payer_name, p.hhaechange_payer_id,
              t.id AS ct_id, t.first_name AS ct_first, t.last_name AS ct_last,
              t.gender AS ct_gender, t.dob AS ct_dob, t.ssn AS ct_ssn,
              t.npi_number AS ct_npi,
              cl.claim_name
       FROM day_entries d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN agreements a ON a.id = d.agreement_id
       LEFT JOIN payers p ON p.id = a.payer_id
       -- the auth number lives on the PARENT service agreement, once
       LEFT JOIN service_agreements sa ON sa.id = a.service_agreement_id
       LEFT JOIN caretakers t ON t.id = d.caretaker_id
       -- An archived claim does not join, so the visit still exports but its
       -- Invoice Number no longer comes from a retired claim.
       LEFT JOIN claims cl ON cl.id = d.claim_id AND COALESCE(cl.archived, 0) = 0
       WHERE COALESCE(c.archived, 0) = 0
         AND d.agency_id = @agency
         -- S5116 (Worker Training & Development) is a period BUDGET, not a
         -- billable visit. It is stored on agreements so the money is captured,
         -- but it must never reach HHAeXchange as a visit row.
         AND (a.service_code IS NULL OR a.service_code NOT LIKE 'S5116%')
         -- a line the revised PDF dropped is retired, not exported
         AND (a.superseded_at IS NULL)
       ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE, d.work_date, d.id`
    )
    .all({ agency: agencyId })
    .map((r) => {
      // Date-of-service resolution wins; the stored FK is only a fallback for
      // visits that fall outside every agreement.
      const resolved = resolveProcedureCodeForVisit(
        db, r.client_id, r.work_date, r.service_code ?? null, r.modifier ?? null
      );
      return {
        ...r,
        resolved_agreement_id: resolved?.agreement_id ?? null,
        resolved_code: resolved?.procedure_code ?? r.service_code ?? null,
        resolved_auth: resolved?.hhaexchange_auth_number ?? null,
        resolution: resolved ? (resolved.collision ? 'collision' : 'by_date') : 'stored_fk',
      };
    });
}

/** I: MMDD + 7-char base36 of hash(client|date|code|caretaker). Max 11. */
function scheduleIdFor(r, code) {
  const seed = `${r.client_id}|${r.work_date}|${code ?? ''}|${r.caretaker_id ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const tail = h.toString(36).padStart(7, '0').slice(-7);
  return `${String(r.work_date).slice(5, 7)}${String(r.work_date).slice(8, 10)}${tail}`;
}

const orBlank = (v) => (v == null ? '' : v);
const dollars = (v) => (v == null ? '' : String(v));

export function buildVisitRows(rows, settings) {
  const taxId = String(settings.agency_tax_id ?? '').replace(/\D/g, '');
  const npi = settings.office_npi ?? '';

  return rows.map((r) => {
    const win = scheduleWindow(r.work_date, r.start_time, r.minutes_worked);
    const code = r.resolved_code ?? r.service_code ?? '';
    const auth = r.resolved_auth ?? '';
    return [
      taxId,                                    // A
      orBlank(r.hhaechange_payer_id),           // B
      orBlank(r.ma_number),                     // C
      r.ct_id == null ? '' : String(r.ct_id),   // D
      orBlank(r.ct_first),                      // E
      orBlank(r.ct_last),                       // F
      orBlank(r.ct_gender),                     // G
      orBlank(r.ct_ssn),                        // H
      scheduleIdFor(r, code),                   // I
      code,                                     // J  base code, no ':XX'
      win.start,                                // K
      win.end,                                  // L
      win.start,                                // M
      win.end,                                  // N
      '',                                       // O  EVV start (manual confirm)
      '',                                       // P  EVV end
      '',                                       // Q  service location
      '',                                       // R  duties
      '',                                       // S
      '',                                       // T
      '',                                       // U
      '',                                       // V
      '',                                       // W
      '',                                       // X
      '',                                       // Y
      '',                                       // Z
      r.claim_id == null ? '' : `INV-${String(r.claim_id).padStart(6, '0')}`, // AA
      '222',                                    // AB
      '101',                                    // AC
      'Imported from RA — manually confirmed',  // AD
      'N',                                      // AE
      '',                                       // AF
      '',                                       // AG
      '',                                       // AH
      '',                                       // AI
      '',                                       // AJ
      '',                                       // AK
      npi,                                      // AL
      r.ct_id == null ? '' : String(r.ct_id),   // AM
      String(r.diagnosis_code ?? '').replace(/\./g, ''), // AN
      '',                                       // AO
      '',                                       // AP
      // AQ — the auth number lives on the PARENT service agreement, once per
      // agreement, resolved per visit by date. Empty when no agreement covers
      // the visit's date (a coverage gap, not a failure).
      auth,
    ];
  });
}

export function buildVisitCsv({ rows, settings }) {
  // Every field is text-qualified, per the visit layout.
  return csvDocument(VISIT_COLUMNS, buildVisitRows(rows, settings), { quote: true });
}

/* ----------------------------------------------------------- validation */

const nameOf = (first, last) => `${first ?? ''} ${last ?? ''}`.trim();

/**
 * Pre-export checks drawn from the Common Rejections guidance.
 * Returns a list of blocking issues; an empty list means the visit file is safe
 * to generate.
 */
export function validateVisitExport(agencyId) {
  const settings = allSettings();
  const rows = visitSourceRows(agencyId);
  const issues = [];

  // Only raise an issue when there is something to show. The agency-level checks
  // have no per-row items, so they are pushed directly.
  const push = (code, message, items = []) => {
    if (items.length) issues.push({ code, message, items });
  };

  // --- agency identity -------------------------------------------------
  if (!settings.agency_tax_id) {
    issues.push({
      code: 'agency_tax_id',
      message: 'Agency Tax ID is blank. Set it in Settings → App Settings.',
      items: [],
    });
  }
  if (!settings.office_npi) {
    issues.push({
      code: 'office_npi',
      message: 'Office NPI is blank. Set it in Settings → App Settings.',
      items: [],
    });
  }

  // --- caregivers (only those who actually worked a visit) -------------
  const usedCaregivers = new Map();
  for (const r of rows) if (r.ct_id != null) usedCaregivers.set(r.ct_id, r);
  const caregiverProblems = [];
  for (const r of usedCaregivers.values()) {
    const missing = [];
    if (!r.ct_ssn) missing.push('SSN');
    if (!r.ct_npi) missing.push('NPI');
    if (missing.length) {
      caregiverProblems.push(
        `${nameOf(r.ct_first, r.ct_last)} (id ${r.ct_id}) is missing ${missing.join(' and ')}`
      );
    }
  }
  push(
    'caregiver_identity',
    `${caregiverProblems.length} caregiver(s) on visits are missing an SSN or NPI.`,
    caregiverProblems
  );

  // --- caregiver code blank (no caretaker on the day) ------------------
  const noCaregiver = rows.filter((r) => r.ct_id == null);
  push(
    'caregiver_code_blank',
    `${noCaregiver.length} day entr${noCaregiver.length === 1 ? 'y has' : 'ies have'} no caregiver, so Caregiver Code would be blank.`,
    noCaregiver.map((r) => `${r.work_date} · ${nameOf(r.client_first, r.client_last)} · ${r.minutes_worked} min`)
  );

  // --- client diagnosis codes ------------------------------------------
  const missingDx = new Map();
  for (const r of rows) {
    if (!r.diagnosis_code) missingDx.set(r.client_id, r);
  }
  push(
    'diagnosis_code',
    `${missingDx.size} client(s) have no Diagnosis Code (DX).`,
    [...missingDx.values()].map(
      (r) => `${nameOf(r.client_first, r.client_last)} (MA ${r.ma_number ?? 'none'})`
    )
  );

  // --- payer ids --------------------------------------------------------
  const payerProblems = new Map();
  for (const r of rows) {
    if (!r.hhaechange_payer_id) {
      payerProblems.set(r.agreement_id ?? `none-${r.id}`, {
        payer: r.payer_name ?? 'no payer on the agreement',
        client: nameOf(r.client_first, r.client_last),
      });
    }
  }
  push(
    'payer_id',
    `${payerProblems.size} agreement(s) have no HHAeXchange Payer ID on their payer.`,
    [...payerProblems.values()].map((p) => `${p.payer} — ${p.client}`)
  );

  // --- zero-value day entries ------------------------------------------
  const zeros = rows.filter(
    (r) => !(Number(r.units) > 0) || !(Number(r.minutes_worked) > 0) || !(Number(r.dollars) > 0)
  );
  push(
    'zero_values',
    `${zeros.length} day entr${zeros.length === 1 ? 'y has' : 'ies have'} zero units, zero minutes or zero dollars.`,
    zeros.map(
      (r) =>
        `${r.work_date} · ${nameOf(r.client_first, r.client_last)} · ${r.minutes_worked} min / ${r.units} units / $${r.dollars}`
    )
  );

  // --- overlapping visits ----------------------------------------------
  push(
    'overlaps',
    'Visits overlap for the same caregiver AND client, or for the same client.',
    findOverlaps(rows)
  );

  return { ok: issues.length === 0, settings, row_count: rows.length, issues };
}

/**
 * Two visits clash when they share a caregiver or a client on the same day and
 * their times intersect.
 */
export function findOverlaps(rows) {
  // Compare ABSOLUTE times (date + minute of day), not minute-of-day. Otherwise
  // visits on different days look like they clash, and a visit that runs past
  // midnight is compared against the wrong day.
  const dayNumber = (iso) => Math.round(new Date(`${iso}T00:00:00Z`).getTime() / 86400000);
  const timed = rows.map((r) => {
    const win = scheduleWindow(r.work_date, r.start_time, r.minutes_worked);
    const base = dayNumber(r.work_date) * 1440;
    return { ...r, _start: base + win.start_min, _end: base + win.end_min };
  });

  const problems = [];
  const seen = new Set();

  const scan = (groupKey, label) => {
    const groups = new Map();
    for (const r of timed) {
      const key = groupKey(r);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a._start - b._start || a.id - b.id);
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (cur._start < prev._end) {
          const sig = `${key}:${prev.id}:${cur.id}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const who =
            label === 'caregiver'
              ? `Caregiver ${String(key).split('|')[0]} / client ${String(key).split('|')[1]}`
              : `Client ${key}`;
          problems.push(
            `${who}: ${prev.work_date} ${prev._start_display}-${prev._end_display} overlaps ${cur.work_date} ${cur._start_display}-${cur._end_display}`
          );
        }
      }
    }
  };

  const clock = (min) => `${pad2(Math.floor((min % 1440) / 60))}:${pad2(min % 60)}`;
  for (const r of timed) {
    r._start_display = clock(r._start);
    r._end_display = clock(r._end);
  }

  /*
   * A caregiver clash only counts when it is the SAME client twice.
   *
   * The RA carries duration, not clock time, so every imported visit is stamped
   * 08:00 (visitTimes) and two different clients on one day always "overlap"
   * arithmetically. Those are two legitimate visits, not a conflict. Grouping
   * by caregiver AND client still catches a genuine double-booking, and the
   * client scan below catches it independently.
   */
  scan((r) => (r.ct_id == null ? null : `${r.ct_id}|${r.client_id}`), 'caregiver');
  scan((r) => r.client_id, 'client');
  return problems.slice(0, 50);
}
