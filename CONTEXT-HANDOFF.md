# Billing-app — Context Handoff

Last updated: 2026-11-06. Working directory: `/Users/james/Documents/Billing-app`

A local-first billing calendar for a small home-healthcare billing business
(DUNDAS HOME CARE LLC). Built incrementally over many sessions. The user tests
between layers and reports back.

---

## 1. Stack and how to run

- **Node.js + Express**, bound to `127.0.0.1`, API on **port 4000**
- **SQLite** via `better-sqlite3@13.0.3`, WAL mode, `foreign_keys=ON`
- **Vite 7 + React 19** frontend on **port 5173**
- ESM throughout
- DB file: `data/billing.db`

```bash
cd /Users/james/Documents/Billing-app
./run.sh                    # starts API (4000) + Vite (5173)
```

**Run it as a managed background job, not `nohup ... &`.** A backgrounded
command inside a one-shot shell dies when that shell exits — this caused a
"the page isn't loading" false alarm where the server was up at the instant I
checked and dead seconds later.

Bundled Node (if `node` isn't on PATH):
`/Users/james/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`
(ad-hoc re-signed copy at `./.runtime/node`)

---

## 2. Remote access (Tailscale path routing)

Set up in a separate session. The app is **not** at `/` — it is at `/billing`.

```
https://jamess-macbook-pro.taild02b07.ts.net (tailnet only)
|-- /            proxy http://127.0.0.1:3080      (DSH, do not touch)
|-- /billing     proxy http://127.0.0.1:5173/billing
|-- /billing-api proxy http://127.0.0.1:4000
```

- Local: `http://127.0.0.1:5173/billing/`
- iPhone: `https://jamess-macbook-pro.taild02b07.ts.net/billing/`

Three files were patched for subpath hosting (backup in
`.subpath-backup-20261105-195404/`):

- `client/vite.config.js` — `base = process.env.BASE_PATH ?? (command === 'serve' ? '/billing/' : '/')`, `allowedHosts` for `.ts.net`, `/billing` → `/billing/` redirect middleware, `/billing/api` proxy with prefix rewrite
- `client/src/api.js` — API URLs derive from `import.meta.env.BASE_URL`
- `client/src/App.jsx` — `<BrowserRouter basename={BASENAME}>`

**Gotcha:** `~/expose-app.sh billing 5173 /billing` — the third argument is
required. Without it, Serve points at `/` and the UI breaks.

---

## 3. Data model

Core tables: `clients`, `caretakers`, `agreements`, `service_agreements`,
`day_entries`, `claims`, `denied_claims`, `denied_line_items`, `rebill_tasks`,
`ra_imports`, `ra_import_files`, `payers`, `settings`.

### Parent/child service agreements

A Service Agreement is a **parent**; its service lines are **children**.

```
service_agreements            (one per client + DHS agreement number)
  id, client_id, dhs_service_agreement_num, hhaexchange_auth_number,
  effective_date, through_date, icd10_code, pdf_path, uploaded_at
  UNIQUE(client_id, dhs_service_agreement_num)

agreements                    (the lines)
  + service_agreement_id  → service_agreements(id)
  + superseded_at          (set when a revised PDF drops a line; never delete)
  + dhs_service_agreement_num, service_code_with_modifier,
    authorized_total_amount, hhaexchange_auth_number (legacy, no longer read)
```

**The auth number lives on the parent, once per agreement** — not per line.
The export reads it from the parent. Editing it on a child row has no effect.

### Current DB state

```
clients: 10 | claims: 51 | denied_claims: 13 | day_entries: 509
agreements: 18 (8 parented, 10 legacy) | service_agreements: 2
integrity_check: ok

service_agreements:
  id 1  client 97 (MATTSON)  dhs 60699023752  auth "60699023752-08"  2026-02-01..2027-01-31
  id 2  client 101 (SIMS)    dhs 50109003072  auth null              2024-12-01..2025-11-30

day_entries with service_code: 400 / 509
day_entries with modifier:     108 / 509

settings: agency_tax_id "92-70505", office_npi "M417128800"
```

---

## 4. What is built and verified

### RA (Remittance Advice) import — works
- Upload PDFs, parse, review, Save All
- Parser: `server/raImport.js`
- **`SERVICE_LINE_RE`** parses one service line; it is **one field per line**
  in the PDF text layer, so `\s+` spans newlines
- **`PAGE_FURNITURE_RE`** strips page headers that can bisect a row (a row
  whose second adjustment + payment land on the next page)
- Modifier is captured and bound; blank column → `""` not null
- **`statusAt` / status parsing reads the ORIGINAL text**, never the stripped
  copy, because the page furniture contains `CLAIM STATUS: PAID-PRIMARY`
- Verified on `2026-10-06_RA01`: MATTSON 14/14 lines all `T1019`/`U9`, sum
  $1,692.16; SIMS 14/14 all `T1019`/`""`, sum $452.90

### Backfill — committed
- `day_entries.service_code` + `modifier` populated from re-parsing RA files
- **400 of 509 rows updated**; 109 remain NULL (19 ambiguous across duplicate
  advices, 90 with no matching RA on disk)

### Service Agreement PDF scanner — works
- `server/serviceAgreementParser.js` — 14/14 assertions
- Endpoint: `POST /api/clients/:clientId/service-agreement` (multipart, `file`)
  - `?dryRun=1` parses and returns a preview without writing
  - matches `recipient_id` digits-only against `clients.ma_number`
  - **one `agreements` row per APPROVED line** — never merge
  - match key includes `service_code_with_modifier` (two lines can share a
    date window and differ only by modifier)
  - `rate_per_unit` is NOT NULL → bind `?? 0`; budget lines (S5116) store
    their money in `authorized_total_amount`
  - superseded lines are retired (`superseded_at`), never deleted
- `PATCH /api/service-agreements/:id` — allow-lists only
  `hhaexchange_auth_number`; 400 on any other key; 404 if missing
- UI: `client/src/pages/ClientProfile.jsx`, card `#agreements` — upload button,
  dry-run preview panel, one card per parent with expandable child table,
  inline auth field that reverts on error

### EDI export — built and verified
- `server/hhaExport.js`, route `GET /api/exports/visits.csv`
- **43 columns, A through AQ** (A–AP is the verified block; AQ is the additive
  Authorization column)
- Filename: `EDI_<taxid digits>_<YYYYMMDDHHMMSS>.CSV`
- CRLF, every field double-quoted, CSV primitives unchanged
- `resolveProcedureCodeForVisit(db, clientId, visitDate, billedCode, billedModifier)`
  resolves the agreement **by date of service**, not by the stored
  `day_entries.agreement_id` FK (which goes stale)
  - tie-break: exact code+modifier → exact base → base over modified →
    latest `start_date` → latest id
  - returns base code with any `:XX` stripped
  - S5116% excluded (period budget, not a visit)
  - `superseded_at IS NULL` filter
- Verified: 510 rows (1 header + 509), 43 columns per row, 0 wrong-width rows,
  CRLF 510 / bare LF 0, all quoted, 0 empty Procedure Codes, 0 S5116 rows
- **Sentinel test passed**: setting `agreements.hhaexchange_auth_number` on
  child rows to `CHILD-SENTINEL` never appears in AQ — proving the export reads
  from `service_agreements`

### Reports — works
- Windowed by **date of service**, not by import date
- Total Paid = `SUM(ra_imports.total_payment)` apportioned by DOS month
- `moneyReceived()` converts UTC stamps to local dates (an import after local
  midnight used to fall on "tomorrow" and vanish from the window)

---

## 5. What is NOT done / open

1. **NNADIKWE (client 6) has no parent service agreement — 228 of 509 visits.**
   Her only `agreements` row has `dhs_service_agreement_num NULL`, so it stayed
   parentless. Those visits export with an empty AQ. Fix = upload her DHS PDF
   at `/billing/clients/6`. This is also the first real end-to-end test of the
   upload flow.

2. **SIMS (client 101) parent auth is unset — 14 visits.** Parent id 2 exists;
   needs its HHAeXchange auth entered at `/billing/clients/101`.

3. **MATTSON's 65 historical visits (2025-11-14 → 2026-01-31)** export with
   empty AQ. **User ruled this correct** — historical, outside the current
   billing period. His only MATTSON PDF covers 2026-02-01 → 2027-01-31; no
   earlier document exists.

4. **The JSDOM 4-case import suite has never been run.** This has slipped every
   single round. It is the one verification that is genuinely missing. Do not
   claim the import path is verified without it.

5. **Export file readiness: NOT ready for portal.** Latest
   `exports/EDI_9270505_20261010035401.CSV` (172,413 bytes) is structurally
   valid but **307 of 509 AQ cells are empty** (228 NNADIKWE + 14 SIMS + 65
   MATTSON historical). Do not submit to `edi.hhaexchange.com` until 1 and 2
   are closed.

### Per-client AQ status

```
MATTSON   267 rows | AQ filled 202 | empty  65
NNADIKWE  228 rows | AQ filled   0 | empty 228
SIMS       14 rows | AQ filled   0 | empty  14
```

---

## 6. Hard-won gotchas — read these before writing code

**SQLite / DB**
- `cp data/billing.db` **loses recent writes** — WAL mode keeps them in
  `-wal`. Always build copies with `VACUUM INTO`.
- `server/db.js` reads `process.env.BILLING_DB`. Any script importing the app's
  `db` singleton must set `BILLING_DB=/tmp/...` or it silently opens **live**.
  This produced a false "auth is null" product bug that was actually my test
  reading the wrong database.
- `db.transaction()` rolls back atomically — but an uncaught throw inside kills
  the process, and the browser sees only "Request failed". Always wrap in
  try/catch returning JSON.

**Temporal dead zone — this class of bug bit four times**
- `const` declared below its use site, same function → `Cannot access 'X'
  before initialization`. Happened with `overwriteFor`, `rawBlocks`,
  `monthlyDos`, and `monthly`. **Check declaration order whenever adding code
  that reads a `const` earlier in a function.**

**Missing fields in payload/response objects — three times**
- `source_file`, `claim_status`, and `paid` were each dropped from a client→
  server map and silently became `undefined`, then defaulted server-side. The
  reversal misclassification (`REVERSAL` stored as `denied`) was this, not a
  parser bug. **Grep for what you send, not just what the server expects.**

**React / JSDOM**
- React 17+ binds `onBlur` to the bubbling **`focusout`** event — dispatching
  a `blur` event does nothing.
- `saveAll()` has an `unmatched > 0` guard that silently returns. Fixtures must
  set `suggested_client` or nothing saves.
- `.every()` on an empty array is vacuously `true` — assert length first.
- Mount `ClientProfile` inside `<Route path="/clients/:id">` or `useParams()`
  is empty and the page renders "That client id is not valid".
- Set globals **before** importing bundles; stub `scrollIntoView`,
  `ResizeObserver`, `matchMedia`; React must be `external` in esbuild.

**Editing code**
- `s.replace()` **without asserting the anchor** silently no-ops while printing
  success. This caused multiple "fixes" that never landed. Always assert the
  anchor is present, and verify with `grep -c` afterwards.

**Export**
- LEFT JOIN + `NOT LIKE` needs an `IS NULL` guard:
  `(a.service_code IS NULL OR a.service_code NOT LIKE 'S5116%')` — otherwise
  NULL comparison drops every unlinked visit.
- The export resolves agreements **by date of service**. Any code that trusts
  `day_entries.agreement_id` will produce stale/wrong codes.

---

## 7. Standing rules the user enforces

- **Live DB is READ-ONLY unless explicitly authorized.** Reads are `SELECT`
  only. Writes need per-operation approval.
- **Back up before any write**: `VACUUM INTO data/backups/<name>.db`, report
  the filename and confirm non-zero before proceeding.
- **Never delete rows.** Retire with `superseded_at`, or set an `end_date`.
- **Test against an isolated copy**, never live:
  `VACUUM INTO '/tmp/hha24/verify4100.db'` + `BILLING_DB=... PORT=4100`
- **No schema changes without approval.** Show the SQL, back up, then stop.
- **Do not touch the RA parser, `classifyStatus`, the payload map, the deny
  gate, `existingForPeriod()`, the Reports DOS-windowing, or the
  `hhaExport.js:526` overlap fix** without being asked.
- **Evidence over assurance.** Report what is verified vs unverified. Never
  claim a UI feature works from API tests alone — several bugs shipped that way.
- **One-line "is it done, yes/no"** at the end of reports is expected and
  valued.
- Report exactly what is found, not what it "should" be.

---

## 8. Environment constraints in this session

- File sandbox is **workspace-write**: cannot write outside
  `/Users/james/Documents/Billing-app` (e.g. `~/Desktop`, `~/expose-app.sh`).
  Export files go to `exports/` inside the repo.
- `/bin/ps` is blocked; use `lsof -nP -iTCP:<port>` to check processes.
- Use the `read` tool, not `cat`, for inspection.

---

## 9. Backups

18 files in `data/backups/`. Meaningful ones for the agreements/export work:

```
billing_pre_parent_agreements_*.db   before service_agreements table
billing_pre_backfill_*.db            before backfill
billing_pre_mod_20261010_033817.db   before day_entries.service_code migration
billing_pre_portal_*.db / billing_pre_final_*.db   before export generation
testdb_*.db                          isolated-copy snapshots (scratch)
```

Restore by copying the chosen file over `data/billing.db` (stop the server
first, and remove `billing.db-wal` / `billing.db-shm`).

---

## 10. Suggested next steps, in order

1. Upload NNADIKWE's DHS PDF at `/billing/clients/6` — closes 228 of the 307
   empty AQ cells and tests the upload flow end to end.
2. Enter SIMS's auth on parent `50109003072` at `/billing/clients/101`.
3. Run the JSDOM 4-case import suite — the missing verification.
4. Regenerate the export and confirm AQ coverage. Only then submit to
   `edi.hhaexchange.com`.

### HHAeXchange spec notes
- 43 columns A–AQ; A–AP is the verified 42-column block, AQ is additive
- Column C = `clients.ma_number` (the "Medicaid Number" / Patient ID)
- Column J = **base** procedure code, no `:XX` modifier
- Column I = Schedule ID, max 11 chars, derived as `MMDD` + 7-char base36
- Column AA = `INV-` + zero-padded `claims.id`
- Units are **15-minute units**, not hours
- Filename `EDI_<taxid digits>_<YYYYMMDDHHMMSS>.CSV`
