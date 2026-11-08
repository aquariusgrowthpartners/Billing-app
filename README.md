# Billing Calendar

A local-first billing calendar for a small healthcare billing business. Everything
runs on this machine — the API binds to `127.0.0.1` only and the database is a
single SQLite file. No cloud, no accounts.

## Run it

```bash
./run.sh
```

Then open **http://127.0.0.1:5173**

On first run `run.sh` installs dependencies (compiling `better-sqlite3`), creates
and seeds the database, then starts both the API and the web UI.

Other modes:

| Command | What it does |
| --- | --- |
| `./run.sh` | Dev mode — API on `:4000`, UI on `:5173` with hot reload |
| `./run.sh --build` | Builds the UI and serves everything from the API on `:4000` |
| `./run.sh --reset` | Wipes and reseeds the database, then starts |
| `./run.sh --install` | Installs dependencies only |

Ports can be overridden, which is handy if something else is already on `:4000`:

```bash
API_PORT=4100 WEB_PORT=5183 ./run.sh          # dev mode
PORT=4100 ./run.sh --build                    # single-port mode
```

`run.sh` checks the ports before starting and tells you if an instance is already
running rather than failing with a confusing Vite error.

## What's built so far (Week 1 slice)

- **Express + SQLite** — full schema from the spec, WAL mode, foreign keys on
- **Client list** — search by first name, last name, full name, or MA number; include-inactive toggle
- **Client profile** (`#/clients/:id`) — one client at a time: name, DOB, MA number, notes, lifetime totals, plus their week calendar, agreements, and claims on the same page
- **Client editing** — **Edit Client** turns name, DOB, MA number and notes into inputs; Save writes via `PUT` and the view refreshes from the database
- **Agreements** — list, **Add Agreement**, and per-row **Edit** (the same form pre-filled); payer dropdown fed from the payers table, with inline payer creation if the payer isn't there yet
- **Week calendar** — Mon–Sun view with separate **Hours** and **Minutes** inputs per day, live units/dollars, per-day over-max flags, notes, save a day or the whole week
- **Copy / paste schedules** — copy any filled day, then paste it onto one empty day or tick several empty days and paste to all of them at once
- **Day entries persist** in SQLite

- **Claim generation** — pick a period, see the claim name and totals live, and sweep every unclaimed day into a Draft claim
- **Claims dashboard** (`/claims`) — Draft → Submitted → Paid pipeline, OVERDUE flagging in red, and observed payer lag

- **Generated claim PDF** — build a claim summary PDF (pdfkit) from the claim's own data, save it locally and download it
- **PDF attachments (local)** — attach, view, replace or detach a manually uploaded PDF
- Both live under `data/claims/` and coexist; nothing is sent anywhere

- **Backup** — one zip with a consistent database snapshot plus every PDF
- **Settings** (`/settings`) — backup, the claim naming template, and payer management
- **CSV export** — download claims as a spreadsheet-ready file
- **Reports** (`/reports`) — A/R aging, payer performance, revenue snapshot with a monthly chart
- **Caretakers** (`/caretakers`) — who delivers care, recorded per day worked, with deactivate-not-delete
- **Case managers** — assigned per client, shown on the profile and on the claim PDF
- **Add client** — from the Clients page, with name, DOB, MA number, notes and an active toggle
- **Archive and delete clients** — soft-delete to hide someone, or hard-delete when they have no billing history
- **Duplicate-safe RA re-import** — detect an earlier import and skip, overwrite or archive it
- **Archive and delete claims** — hide a claim from reports and exports, or remove it when nothing is linked
- **Bulk claim actions** — select many claims and archive or delete them together
- **Client middle initial** — optional, displayed as "Sarah E. N", and used in RA matching
- **Home Dashboard** — bi-weekly caretaker ranking, period totals, recent RA imports and recently viewed clients
- **Data maintenance** — find and clean up day entries with no valid, active client
- **Caretaker profiles** — pay-period snapshot, earnings, client splits, a work calendar and a filterable history log
- **MPSMISC export** — the Minnesota DHS monthly reporting spreadsheet, built from the agency's own accepted template
- **Past-period editing + claim regeneration** — fix up old weeks and re-derive a Draft claim's totals
- **Multi-day bulk edit** — select several days and apply or delete them in one go
- **HHAeXchange exports** — caregiver and visit flat files with pre-export validation
- **Import RA** — parse MHCP remittance advice PDFs and review before saving

Google Drive / OAuth is deliberately **not** built — everything stays on this machine.

## Routes

| URL | Page |
| --- | --- |
| `/` | Client list |
| `/clients/:id` | That client's profile — tabbed |
| `/claims` | Claims dashboard |
| `/caretakers` | Caretakers — add, edit, deactivate |
| `/settings` | Settings — backup, naming template, payers |
| `/reports` | Reporting dashboard |



The profile has two tabs. **Profile & Agreements** is the default and holds the
client's details, their service agreements, and the Add Service Agreement form.
**Schedule & Time Entry** (`/clients/:id?tab=schedule`) holds the week calendar
with the Hours/Minutes inputs and Copy/Paste. The tab is in the URL so a refresh
keeps you in place, but anything without `?tab=schedule` opens on Profile &
Agreements.

Both tab panels stay mounted and the inactive one is hidden with `display:none`,
so unsaved Hours/Minutes are not discarded if you flip to the agreements tab and
back.

A client's schedule has exactly **one** address: their profile. There is no
separate calendar-only view, because two routes to the same client silently
diverged once already — the "Week Calendar" tab showed a picker that looked
like the client list, but selecting from it produced a bare calendar with no
name, MA number, or way back.

## Testing

With the app running, in a second terminal:

```bash
./run.sh --smoke
```

This renders the real React app in jsdom against the live API and drives actual
navigation — clicking a client row, opening the agreement form, typing a rate,
entering hours/minutes, saving a day, copying a day and pasting it across the
week — then reads the rows back out of SQLite to confirm the math that was
stored. 81 checks, exits non-zero on failure. It creates temporary clients
prefixed `zzSmoke-` and sweeps them up at the end.

It exists because two routing bugs got past weaker checks:

1. `#/clients/:id` rendered the list instead of the profile.
2. `#/calendar/:id` rendered a calendar-only page, so picking a client from the
   Week Calendar tab never reached their profile.

Both are now covered — every route that selects a client is asserted to land on
that client's profile — and the suite was verified to fail when either bug is
reintroduced.


## Core logic

**Units and dollars.** The calendar collects **hours and minutes separately**;
the server combines them (`minutes_worked = hours * 60 + minutes`) so the client
can never disagree with what is stored. `POST /api/day-entries` also still
accepts a plain `minutes_worked` for direct API callers.

Then `units = Math.floor(minutes_worked / minutes_per_unit)` and
`dollars = units * rate_per_unit`. `minutes_per_unit` is per-agreement (15 by
default, but Priya's agreement in the sample data uses 30). Minutes that don't
fill a whole unit are dropped and shown in the UI as `+Nm dropped`. When
`units > max_units_per_day` the day is flagged but still saved.

**Authorized units per week is retired.** The `agreements.authorized_units_per_week`
column is still in the schema, but nothing reads or displays it — it is not on
the agreement form, the calendar, or the week summary.

**Copy / paste.** `Copy` on a filled day puts its hours/minutes on a clipboard;
`Paste` on an empty day applies and saves in one click. Ticking several empty
days enables `Paste to N days`, which applies to all of them in a single request.

**Where the math lives.** `server/calc.js` is authoritative and is what gets
written to the database. `client/src/calc.js` mirrors it so the per-day preview
updates on every keystroke; after a save the row is replaced with whatever the
server returned. A parity test across 396 input combinations confirms the two
implementations agree.

**Editing never rewrites history.** Changing an agreement's rate through Edit
only affects days logged afterwards; existing `day_entries` keep the rate and
dollars they were saved with.

**Rate history is immutable.** `day_entries` stores `units`, `rate_per_unit`, and
`dollars` denormalized, snapshotted at the moment the day was saved. Changing an
agreement's rate only affects days logged afterwards — existing entries and any
claims built from them never move.

**Weeks run Monday to Sunday**, matching the `YYYYMMDD_YYYYMMDD` claim periods
in the naming template.

## Claims

**Naming.** `{last}_{ma}_{dos_start}_{dos_end}_{seq}`, e.g.
`Smith_123456789_20261005_20261011_01`. Names are slugged to alphanumerics
because they become PDF filenames in Week 3. `{seq}` is the highest suffix
already used for that client *and* that exact period, plus one — so deleting a
claim never produces a name collision.

**Generation.** Only day entries with `claim_id IS NULL` are swept in; anything
already on a claim is skipped and reported. The whole thing runs in one
transaction, so the claim and its day links land together or not at all.
Deleting a claim releases its days back to unclaimed.

**Period default — spans the data, not a calendar week.** The dialog opens on
the client's **entire unclaimed span**: oldest unclaimed day to newest unclaimed
day. Both dates stay editable, and unticking them via Quick pick offers
`All unclaimed days`, `This week (Sun–Sat)` and `Last week`.

This replaced a fixed Sunday..Saturday default, which silently dropped whatever
sat just outside the week. Real example: a client with Mon 10-05 → Sun 10-11
logged showed 6 days / 96 units / $597.12 against a profile summary of 7 days /
112 units / $696.64, because Sunday 10-11 fell outside the Sun–Sat window. Note
this is the Monday/Sunday mismatch between the calendar (Mon–Sun) and the
original Sun–Sat default.

To stop that class of bug recurring, `/api/claims/preview` always reports the
client's `overall_unclaimed` totals alongside the selected window, plus
`excluded_unclaimed_count`. If the chosen range leaves days out, the dialog says
so, shows the full total it is missing, and offers a one-click fix — it can no
longer quietly under-count.

**Lifecycle.** Moving a claim to `Submitted` stamps `submitted_date` and sets
`expected_pay_date = submitted_date + payer.typical_days_to_pay`. Recording a
`paid_date` stores `variance_days = paid_date - expected_pay_date` (negative =
early) and forces the status to `Paid` — the server decides this rather than
trusting the status the form was showing. `paid_lag_days` (submitted → paid) is
derived, not stored.

**Schema note.** `claims.variance_days` is the one column added beyond the
original spec, required by "store the variance on the claim". It is added by an
additive migration in `server/db.js` (`ALTER TABLE ... ADD COLUMN`), so existing
databases keep every row and no existing column changes.

## PDFs (Week 3, local only)

No Drive or OAuth code exists. Everything is written to `data/claims/`
(gitignored) and referenced by project-relative paths on the claim row.

There are **two independent slots**, stored under different file names so
neither can overwrite the other:

| Slot | Column | File name | Who produces it |
| --- | --- | --- | --- |
| Generated claim PDF | `claims.generated_pdf_path` | `<claim_name>_claim.pdf` | `POST /pdf/generate`, via pdfkit |
| Uploaded PDF | `claims.local_pdf_path` | `<claim_name>_uploaded.pdf` | You, via the file picker |

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/claims/:id/pdf/generate` | Build + save the claim summary PDF |
| GET | `/api/claims/:id/pdf/generated` | Stream it inline — what "View claim PDF" opens |
| GET | `/api/claims/:id/pdf/generated?download=1` | Same, as an attachment — what the download uses |
| DELETE | `/api/claims/:id/pdf/generated` | Remove just the generated file |
| POST | `/api/claims/:id/pdf` | Upload/replace the manual PDF (multipart, field `file`) |
| GET | `/api/claims/:id/pdf` | Stream the uploaded PDF inline |
| GET | `/api/claims/:id/pdf/info` | Metadata for both slots |
| DELETE | `/api/claims/:id/pdf` | Detach the upload and delete its file |

**The generated document** (`server/claimPdf.js`) carries the client's name, DOB
and MA number; the agreement number, service code and payer; the claim period
and status; total units, rate per unit and total dollars; and a day-by-day
breakdown of date, minutes, units and dollars with a totals row. It is rebuilt
from stored data every time, so it can never drift from the claim. Uses
pdfkit's built-in Helvetica, so there are no font files to ship.

`rate per unit` shows a single figure when every day shares one rate, and says
so explicitly when a claim spans more than one — the claim row itself stores no
rate, because each day snapshots its own.

**Downloading** uses the clean claim name in `Content-Disposition`
(`Smith_123456789_20261005_20261011_01.pdf`) even though the file on disk keeps
its `_claim` suffix, so the saved file is named the way you'd send it.

**Deleting a claim deletes both PDFs**, and regenerating or replacing removes a
stale file when its name changes — nothing is orphaned in the folder.

Controls appear in two places: directly on each row of the claims table
(dashboard and client profile) and inside the Edit Claim dialog.

**Validation.** Two independent checks: the declared MIME type must be
`application/pdf`, *and* the bytes must begin with `%PDF-`. The MIME type comes
from the browser and is trivially spoofed, so the magic-byte test is the one
that matters. Cap is 25 MB.

**Safety.** `resolveStored()` resolves every stored path and refuses anything
that escapes `data/claims/`, so a corrupted or hand-edited database value can
never read elsewhere on disk.

**Deleting a claim deletes its PDF**, and replacing a file whose name changed
removes the old one — so nothing is ever orphaned in the folder.

**Schema note.** Additive changes only, ever: `ALTER TABLE ... ADD COLUMN` and
`CREATE TABLE IF NOT EXISTS`. Beyond the original spec that means the `settings`,
`caretakers` and `case_managers` tables, and the `variance_days`,
`local_pdf_path`, `generated_pdf_path`, `case_manager_id` and `caretaker_id`
columns, plus the HHAeXchange fields (`payers.hhaechange_payer_id`,
`clients.diagnosis_code`, `caretakers.ssn`, `caretakers.gender`,
`caretakers.dob`, `day_entries.start_time`). An existing database keeps every row
and no existing column changes shape.

## Backup and export

**`GET /api/backup`** streams `billing_backup_<date>.zip` containing:

| Entry | What it is |
| --- | --- |
| `billing.db` | A consistent snapshot of the database |
| `claims/` | Every stored PDF, generated and uploaded |
| `backup-info.json` | Record counts, PDF list, restore notes |

The database is captured with **better-sqlite3's `backup()` API, not a file
copy**. The database runs in WAL mode, so `billing.db` on its own can be missing
commits that are still sitting in the `-wal` file — copying it would produce a
backup that silently loses recent work. Verified by creating a claim, taking a
backup immediately, and confirming the claim is present in the restored
snapshot with `PRAGMA integrity_check` returning `ok`.

Restore: stop the app, replace `data/billing.db`, unzip `claims/` back into
`data/claims/`.

**`GET /api/claims/export.csv`** downloads every claim as CSV, honouring the
same `status` / `overdue` / `client_id` filters as the dashboard so the file
matches what is on screen. Columns: Claim Name, Client Name, MA Number, Date
Range, Total Units, Total Dollars, Status, Submitted Date, Expected Pay Date,
Actual Paid Date, Paid Amount. Fields containing commas or quotes are escaped,
and the file starts with a UTF-8 BOM so Excel reads it correctly.

## Claim naming template

Stored in the `settings` table and editable at `/settings`. Default:

```
{last}_{ma}_{dos_start}_{dos_end}_{seq}
```

Tokens: `{last}`, `{first}`, `{ma}`, `{dos_start}`, `{dos_end}`, `{seq}`.
Values are slugged to alphanumerics before substitution; the template's own
separators are kept exactly as typed. The change applies to newly generated
claims — existing claims keep the names they were created with.

Validation rejects unknown tokens, empty templates, templates with no tokens,
and slashes, so a filename can never contain a stray `{...}`.

## Reports (`/reports`)

`GET /api/reports?start=&end=` powers the dashboard. Two different time
semantics are deliberately kept separate:

- **Point-in-time** (always "as of today", unaffected by the window): the A/R
  aging buckets and every Outstanding figure. An old unpaid claim must never
  disappear behind a date filter — that would defeat the point of aging.
- **Windowed** (bounded by the filter, default = year to date): Total Billed
  (by the day the claim was created), Total Paid (by the day the money landed,
  falling back to submitted/created for legacy paid claims without a date),
  payer performance, and the monthly chart.

Aging buckets: Current (0–30 days past expected), 31–60, 61–90, 90+, plus a
"No expected date" bucket for submitted claims whose agreement has no payer
terms. Drafts and denied claims are reported separately and never counted as
receivable.

Payer performance columns: claims submitted in the window, total paid in the
window, average days to pay (submitted → paid), average variance vs the
expected date (from the stored `variance_days`), and the current outstanding
balance. Claims with no payer roll up into a "No payer assigned" row.

The chart uses recharts and is lazy-loaded, so it only ships with the Reports
page, not the whole app.

## Importing Remittance Advice (RA)

Select **several** PDFs at once. They are parsed one file at a time — a file
that fails is reported against its own name and the rest still come through:

> 3 of 4 files parsed. Failed: invoice_06.pdf

Each selected file shows its own status (ready → parsing → parsed/failed). The
review table gains a **Source File** column so a combined review can be checked
against the PDFs, and rows are **never de-duplicated** — two advices may
legitimately name the same client, and both are shown. **Save All** writes every
row from every file in one request.

## MPSMISC reporting spreadsheet

**Spreadsheet** in the nav builds the Minnesota DHS **MPSMISC** reporting file.

The workbook is not built from scratch: `server/templates/MPSMISC_template.xlsx`
is the agency's own last-submitted file, and the export copies it, replacing only
the agency header values and the worker rows. That keeps the instructions, the
merged block, the column widths, the row-17 headings and the per-row `=L/30` PTO
formula byte-identical to what DHS already accepted, and renames the sheet to the
report period (`MMDDYYYY-MMDDYYYY`) so a previous name is never reused.

Two independent date ranges drive it:

- **Report Label Period** — what the header and file name say. Defaults to the
  current pay period shifted back two days.
- **Work Data Period** — which day entries supply the hours. Defaults to the
  current pay period.

Hours come from `day_entries` in this database, never from the RA. The preview
lists every caretaker with hours in the window, alphabetically, and warns about
missing required fields. `Archived caretakers and entries on archived clients are
left out`, matching every other total in the app.

Output rules that DHS is strict about: the UMPI, ZIP, phone and dates are written
as **text** with the `@` format, so `55433` never becomes `55433.0` and hire dates
never become Excel datetimes; column O is the live formula `=L{row}/30`, not a
number. The export is **read-only** — nothing in it writes to the database.

Filename:
`{AgencyUMPI}_MPSMISC_{today YYYYMMDD}_Reporting_Spreadsheet_{start}_{end}.xlsx`

### Due reminder

The Home dashboard opens with *"N days till Claim spreadsheets are due"* — the
20th of this month if today is before the 20th, otherwise the 20th of next month.
Orange at 5 days or fewer, red at 2 or fewer, and a red OVERDUE banner if the
deadline has passed.

## Caretaker profiles

Each caretaker has a profile at `/caretakers/:id`, reachable by clicking their
name on the Caretakers tab.

- **Profile** — the existing fields (name, NPI, SSN, gender, DOB, notes, active),
  editable in place.
- **Current pay period** — hours, billed value, distinct clients and rank
  (*"#2 of 8"*) for the same bi-weekly Sunday→Saturday period the Home Dashboard
  uses, with **Prev / Current / Next**.
- **Earnings** — this period, month to date, year to date, anticipated
  (`Submitted` claims) and confirmed (`Paid` claims), each with a tooltip.
- **Client splits** — hours, dollars and share per client, sorted by dollars,
  as a table *and* a bar chart, over This Pay Period / This Month / Year to Date
  / All Time.
- **Work calendar** — a month grid where only worked days are shaded, darker for
  more hours. Clicking a day opens a popover with client, start/end, hours,
  units, billed and claim status.
- **Work history** — every day entry, newest first, sortable, filterable by
  client and date range, 20 per page. Clicking a row opens that day on the
  client's calendar (`/clients/:id?week=YYYY-MM-DD`).

All the maths uses `day_entry.dollars`, and the validity rule is the one shared
with the Home Dashboard (`VALID_ENTRY_SQL` in `server/payPeriod.js`): the client
must exist, must not be archived, and the agreement reference must resolve.

## Data maintenance

`GET /api/admin/orphaned-entries` reports day entries that can no longer be
reached through a valid, active client: a `client_id` with no client row, an
archived client, or a `claim_id` pointing at a claim that no longer exists. Each
row comes back with what is wrong with it, and
`GET /api/admin/orphaned-entries/count` is the cheap version the nav badge uses.

**Settings → Data Maintenance** lists them and offers a cleanup that deletes
exactly what the report lists, behind a typed `DELETE`:

> Deleted X orphaned entries. Preserved Y valid entries.

Anything whose client exists and is not archived is preserved — including
entries with no claim and no caretaker, which are perfectly valid unclaimed days.
The nav shows a red count badge on **Settings** while anything is waiting.

The **Home Dashboard** counts only entries reachable through a valid, active
client (and a resolvable agreement), and says how many it held back.

### One-time migrations

Two guarded backfills run at startup, each behind a flag in `settings`:

- `ra_source_backfill` — tags any day entry sitting on an `ra_import` claim as
  `ra_import` itself, so deleting that claim cleans the entry up.
- `ra_import_orphan_sweep` — drops `ra_imports` log rows whose claims have all
  been deleted.

## Home Dashboard

The app opens on **Home** (`/`); the client list is at `/clients`.

The layout is a single column with a 26px gap between cards, 22px of internal
padding, a 12px radius and a soft border and shadow. Type scale: 18px semibold
section titles, 15px medium subheadings, 14px body, 28px bold metric numbers.
The due reminder sits top-right, the pay-period navigator puts an 18px range
label between its arrows, the ranking table has alternating row shading, the
totals strip uses a responsive metric grid, and Recently Viewed / Recent RA sit
side by side above 760px and stack below it.

The pay period is **bi-weekly, Sunday → Saturday**, anchored to a fixed Sunday
(`PAY_PERIOD_ANCHOR` in `server/payPeriod.js`). That one module decides the
fortnight, so the dashboard and every other view can never disagree about which
period it is. **Prev** / **Next** / **Current** move between periods.

- **Caretaker ranking** — every active caretaker with more than zero hours in the
  period, ranked by hours, showing billed value and how many distinct clients
  they worked with. Rows link to the Caretakers tab.
- **Period totals** — hours, billed value, and the number of active caretakers.
- **Recent RA submissions** — the last 5 saves from the `ra_imports` log, with
  the claims each one created.
- **Recently viewed clients** — the last 8 profiles opened, newest first, capped
  in `recent_clients`.

Hours render as `X.X hrs`; money as `$X,XXX.XX`.

### What counts

One rule, in one place (`COUNTS_PREDICATE`), used by every dashboard total:
**every day entry counts.** A day entry is a record of work actually performed,
and none of the flags around it un-works those hours.

- The entry carries a single `claim_id`, so it can only ever be counted once.
- Archiving the claim that held it, or the client it was for, is book-keeping,
  not an erasure of the shift.
- `source` is irrelevant — RA-imported hours are hours.

Filtering on any of those made real work vanish from the ranking. (Archived
claims *are* excluded from Reports, where an archived claim plus its replacement
would double-count money — a different question.)

Entries with no caretaker are counted in the totals but cannot appear in a
per-caretaker ranking; the dashboard says how many there are so the numbers
always reconcile with the rows on screen.

The endpoint prints a `[dashboard]` block to the server console each time it
runs: the period, the entry count (split assigned/unassigned), the caretaker
count, the totals, and one line per ranked caretaker.

### The RA import log

`ra_imports` powers **Recent RA submissions**. Deleting the last claim an import
created removes its log row, so a deleted import disappears from the box. An
import that still has surviving claims keeps its place with its client count
reduced to the survivors.

## Client names and the middle initial

`clients.middle_initial` is an optional (nullable) field, at most two letters.
A trailing period is stripped on save and re-added for display, so the profile
shows **"Sarah E. N"**. It appears on the Add Client form, the client profile's
edit form, and the profile header.

It is also the tie-breaker in RA matching. Advice names arrive as
`LASTNAME FIRSTNAME MI` (`SIMS SARAH E`) or the comma form (`SMITH, JOHN A`);
both parse. Last name and first name (or first initial) are required, and:

| Advice | Client on file | Result |
| --- | --- | --- |
| has a middle initial | has one, and it agrees | **Strong match** |
| has a middle initial | has one that disagrees | no match |
| has a middle initial | has none | **Possible match** |
| has none | either | **Strong match** |

Fuzzy last names and first-initial-only first names also drop to
**Possible match**. The Import RA review table shows the verdict next to the
matched client, and picking a client by hand clears it.

## Bulk claims

The claims table — on the dashboard and on the client profile — has a checkbox
column, a **Select All** header box, and row-click selection. Anything selected
raises a bar reading *"N claims selected."* with **Archive Selected**,
**Delete Selected** (red) and **Clear Selection**.

**Archive Selected** is disabled when every selected claim is already archived.
**Unarchive Selected** appears only while at least one selected claim is
archived. Neither is a toggle: a claim in the wrong state is skipped and
reported, never flipped the other way.

Bulk archive lists the four effects and reports how many were already archived. Bulk delete follows the same rule, including the per-entry `source` cleanup,
while live claims with day entries are skipped and reported — *"N archived claims deleted. M non-archived claims skipped (archive
them first)."* If **nothing** in the selection can be deleted, nothing is
touched and the modal offers **Archive Instead**. Typing `DELETE` is required
either way. Selection is per-view and clears after every bulk action.

## Archiving and deleting claims

Each row on the Claims Dashboard has an **actions menu** (⋯) with **Edit**,
**Archive** / **Unarchive**, and a red **Delete**. The same three live in a
**Danger Zone** at the bottom of the claim detail view.

**Archiving** hides a claim from the dashboard, the reports and the
HHAeXchange visit export, and is completely reversible. The claim's link to its
day entries is **kept on purpose** — nothing is deleted or re-pointed, so
unarchiving restores the exact previous state and the archived claim still shows
what it covered.

Everything downstream treats an archived claim as "no longer claiming these
days":

- the claims list, reports and the visit export exclude it;
- the calendar stops showing those days as *on claim* and stops treating the
  claim as locked, via the `claim_archived` flag the week endpoint returns.

**Deleting an archived claim always works**, and cleans up what the RA import
created. For each linked day entry, `day_entries.source` decides:

| `source` | What happens |
| --- | --- |
| `ra_import` | the entry is **deleted** — hours, caretaker assignment and calendar entry all go |
| `manual` | the entry is **preserved** and only unlinked, becoming an unclaimed day |

A hand-typed day is **never** deleted by a claim delete. The modal states both
counts, and still asks you to type `DELETE`. PDFs are left on disk, since the
paperwork is the only record left once the row is gone.

**Deleting a live claim** is refused while any day entry still points at it:

> Cannot delete this claim. It has X linked day entries. Archive it instead to
> preserve billing history.

with an **Archive Instead** button in the modal. A claim with nothing linked gets
a confirmation (*"Permanently delete claim [name]? This cannot be undone."*) and
only then is the row removed. `GET /api/claims/:id/delete-check` drives both
paths, and `DELETE` enforces the same rule server-side.

The **Show Archived (N)** toggle at the top of the dashboard is off by default
and carries the number of archived claims. Archived rows show a grey badge. The
client profile's Claims section has its own **Show Archived** toggle and the same
actions menu.

### Restoring archived claims

Bulk restore asks first, listing what it will do — make them visible on the
dashboard, show them on the client profile, re-lock their day entries as *on
claim*, and include them in reports and exports — then reports how many selected
claims were skipped because they were already live.

If a **new claim was generated over the same period while the original was
archived**, a warning names the conflict and how many days are involved. It does
not block: the days now belong to a newer claim, so restoring the old one is a
judgement call you confirm.

### Confirmation flow

**Archive** asks first, listing exactly what will happen — removed from the
dashboard, hidden from the profile, its N day entries unlocked so a new claim can
be generated, and excluded from reports and exports — and states that nothing is
deleted. **Unarchive** is immediate. Toasts read *"Claim archived."*,
*"Claim restored."* and *"Claim permanently deleted."*

**Delete** requires typing `DELETE` (case-sensitive) before the destructive
button enables, on top of the linked-entries guard.

### Archived claims unlock their days

Archiving retires a claim **without unlinking anything**: the day entries keep
their `claim_id`, and every reader treats an entry whose claim is archived as
unclaimed. That means the calendar drops the "on claim" badge, the claim stops
being "locked", and **Generate Claim** picks those days up again — creating a new
claim re-links them, leaving the archived claim's totals intact.

## Importing Remittance Advice (RA)

**Import RA** in the top nav parses an MHCP remittance advice PDF and shows what
it found for review. **Nothing is written to the database until you press Save
All** — parsing and matching are read-only.

### Parsing

`POST /api/import-ra` (multipart, field `file`) extracts the text and splits it
on `PATIENT:`. A client whose line items continue after a page break is merged
back into one entry rather than duplicated, and the review table marks it with a
page count.

Per client it pulls `client_name`, `claim_number`, `rendered_provider_name`
(from `REND PROV:`), `rendered_provider_id` (from `REND PROV ID:` — this is the
caregiver's **NPI**), `total_charge`, `total_adjust`, `total_payment`, the
`dos_start`/`dos_end` span,
and each line item: `date` (converted `MM-DD-YY` → `YYYY-MM-DD`),
`procedure_code`, `units`, `billed`, `paid`, plus `minutes_worked` (units × 15)
and `hours_worked`. Anything not found is `null`.

`POST /api/import-ra/match` finds the best **non-archived** client by fuzzy last
name plus first initial, and returns `null` rather than guessing.

### Reviewing and saving

The review table lets you correct the matched client, the DOS dates, the totals
and the action (**Mark as Paid**, **Create New Claim**, **Skip**) before saving.
A row with no client is highlighted and blocks Save All.

`POST /api/import-ra/save` then:

- **Mark as Paid** updates the most recent claim whose period overlaps the DOS
  range — preserving its name and `submitted_date` — or creates one if none
  overlaps. **Create New Claim** always creates one. Both result in a `Paid`
  claim with today's `paid_date` and the remittance's Total Payment.
- adds one `day_entries` row per line item, at `08:00`, with the remittance's
  units and the agreement's rate. **An existing entry is never overwritten** —
  those are counted as skipped.
- assigns the **caretaker by NPI**: the Rend Prov ID is looked up against
  `caretakers.npi_number`. A pick made in the review modal wins; otherwise the
  NPI match is used; otherwise the entry is left unassigned and a warning names
  the unmatched NPI so it can be fixed.
- links the new entries to the claim when they fall inside its period.

The summary reports: *"Updated X claims, created Y claims, added Z schedule
entries, skipped W existing entries. Archived A old claims, overwrote B, skipped
C."*

**Caretaker per line item.** The View Details modal has a Caretaker column.
It is pre-selected from the NPI match and can be changed per line; an inactive
caretaker is listed with an "(inactive)" suffix so a retired-but-still-billing
caregiver can still be chosen. The modal header shows the rendering provider and
NPI, and flags when no caretaker carries that NPI.

**`Skip` ignores the whole row** — no claim change *and* no schedule entries.
The original brief said "do nothing" for the claim but also "schedule entries for
every line item, regardless of claim action", which conflict for Skip; the
row-level reading was chosen so a skipped client cannot quietly appear on the
calendar. Say the word if you want Skip to still create entries.

### Troubleshooting a failed save

`POST /api/import-ra/save` logs every statement it is about to run:

```
[import-ra] INSERT day_entry 2026-09-04 (08:00-12:00)
[import-ra]   sql   : INSERT INTO day_entries (...) VALUES (@client_id, ...)
[import-ra]   bound : {"client_id":98,"agreement_id":57,...,"start_time":"08:00"}
```

Named parameters are bound through `bindNamed()`, which compares the statement's
`@name` placeholders against the object being bound before it runs. A mismatch
reports *which* parameter is missing, and mixing `?` with `@name` is rejected
outright — both would otherwise surface as SQLite's opaque *"Too few parameter
values were provided"*. `undefined` is coerced to `null` so optional columns
never fail to bind.

The whole import runs in one transaction, so a failure anywhere rolls back
completely — a failed save leaves no partial claims or entries behind.

### Re-importing an RA you have already imported

Every record gets a `source`: `manual` for anything typed or generated in the
app, `ra_import` for anything the import created. That distinction is what makes
a re-upload safe — the import only ever replaces its own work.

On parse, each row is checked against the client's claims for that DOS range and
reports what it found:

- **`existing_claim`** — an earlier `ra_import` claim overlapping the period.
  A banner appears with the claim name and status and a resolution dropdown:

  | Resolution | Effect |
  | --- | --- |
  | **Skip — keep existing claim** (default) | the row does nothing |
  | **Overwrite — replace existing claim and schedule entries** | the old RA claim is deleted and its RA day entries cleared, then fresh ones are created |
  | **Archive old — keep the old claim archived, create new one** | the old claim is flagged `archived` and its RA day entries are cleared, then a new claim is created |

- **`manual_claim`** — a claim the user made by hand. It is **never** touched,
  and the row defaults to **Skip** with a "Do you want to proceed?" warning.

`POST /api/import-ra/existing` re-runs the check, so changing the matched client
or the DOS dates refreshes the banner.

Day entries are cleared on any resolution because `day_entries` allows one row
per client per date — a surviving RA entry would block the fresh import. The old
claim keeps its totals either way; only its line items are released.

**Manual records are sacred.** The save only deletes, archives, overwrites or
links rows where `source = 'ra_import'`. A manual day entry in the period is
skipped rather than overwritten, and is never re-linked to an RA claim.

### Two things worth knowing

- **`end_time` is not stored.** `day_entries` has `start_time` but **no
  `end_time` column** — the brief said not to change that schema, so it was never
  added. The end time is derived as `start_time + minutes_worked` (`08:00` +
  240 min → `12:00`); it is logged during the save, shown in the review modal,
  and the HHAeXchange export computes it the same way. Adding a real column is a
  one-line additive migration if you would rather have it stored.
- **One entry per client per day.** `day_entries` has a `UNIQUE (client_id,
  work_date)` constraint, so when an RA carries two line items on the same date,
  the first is imported and the second is skipped (and counted). If you would
  rather they be summed into one entry, that is a small change.

## Archiving and deleting clients

`clients.archived` (additive column, `INTEGER NOT NULL DEFAULT 0`) is a **soft
delete**, separate from `active` — `active` means "not currently receiving
services", `archived` means "take them off my list".

- The Clients list hides archived clients by default. **Show Archived** brings
  them back, each with a grey badge.
- A client's profile has a **Danger Zone** with **Archive Client** /
  **Unarchive Client**. Archiving keeps every row: no day entry, claim,
  agreement or PDF is touched.
- **Delete Client** is a hard delete, so the backend checks for billing history
  first (`GET /api/clients/:id/delete-check`, backed by the same helper the
  delete itself uses):
  - **Has day entries or claims** → the delete is refused with `409` and the UI
    shows *"Cannot delete NAME. They have X claims and Y logged days. Please
    archive them instead to preserve billing history."*, with an **Archive
    instead** shortcut. `DELETE /api/clients/:id` enforces this even if the UI is
    bypassed, so billing history can never be cascaded away.
  - **No history** → a confirmation modal (*"Are you absolutely sure …? This
    cannot be undone."*) and only then is the row removed.
- Deleting a client with no history also removes their agreements, which belong
  to them; `day_entries` and `claims` are never cascade-deleted by this path.

## HHAeXchange exports

Two flat files built from the data in this app, downloadable from
**Settings → HHAeXchange exports**.

| File | Name |
| --- | --- |
| Caregivers | `CaregiverImport_{AgencyTaxID}_{YYYYMMDD}.csv` |
| Visits | `VISITS_{AgencyTaxID}_{YYYYMMDDHHMMSS}.CSV` |

The visit file text-qualifies **every** field with `"` and uses CRLF line
endings, as the layout asks, so Excel cannot mangle dates, leading zeros or
values containing commas.

### Fields that feed them

| Where | Field | Rule |
| --- | --- | --- |
| Settings → App Settings | Agency Tax ID | up to 12 characters (letters, numbers, dashes), required |
| Settings → App Settings | Office NPI | up to 20 characters (letters, numbers, dashes) |
| Settings → Payers | HHAeXchange Payer ID | 10 digits |
| Client profile | Diagnosis Code (DX) | pipe-separated ICD-10, max 208 chars |
| Caretakers | SSN | `XXX-XX-XXXX` |
| Caretakers | Gender | `M` or `F` |
| Caretakers | Date of birth | `YYYY-MM-DD` |
| Calendar → each day | Start | `HH:MM`, defaults to `08:00` when blank |

The Agency Tax ID and Office NPI are stored **exactly as typed** — no padding,
reformatting or digit filtering — because real values are not always numeric
(`92-70505`, `M417128800`). Only leading/trailing whitespace is trimmed. Both are
written verbatim into the flat files and into the download file names.

A visit's window is built from the day entry: start = the day's date + Start
time, end = start + `minutes_worked`. A visit that runs past midnight rolls the
end date forward rather than wrapping the clock.

### Pre-export validation

**Archived clients are excluded from the whole export workflow.** Both the
validation and the visit file are built from a single query that filters
`COALESCE(clients.archived, 0) = 0`, so an archived client can produce neither a
warning nor a CSV row — and none of their entries are checked for a caregiver,
a diagnosis code, a payer id or overlapping times. Nothing is deleted: the rows
stay in the database and reappear the moment the client is unarchived.

The visit export runs a pre-flight check and **refuses to produce a file** while
anything is wrong; the UI lists every issue in a modal instead of downloading.
`GET /api/exports/visits.csv` returns `422` with the same list, so the rule holds
even if the UI is bypassed. Checks:

- Agency Tax ID or Office NPI blank (archived clients are ignored entirely)
- a caregiver who worked a visit missing an SSN or NPI
- a day entry with no caregiver (blank Caregiver Code)
- a client with visits missing a Diagnosis Code
- an agreement whose payer has no HHAeXchange Payer ID
- a day entry with zero units, zero minutes or zero dollars
- visits that overlap for the same caregiver or the same client

Overlap detection compares absolute date+time, so visits on different days are
never reported as clashing.

**Caregiver Code** is the caregiver's internal id, used identically in both
files so the visit file refers to a caregiver the import already knows. The NPI
is carried separately in User Field 10 of the visit file.

## Multi-day selection and bulk edit

The week calendar has a checkbox column on the far left and a **Select All**
checkbox in the header. Clicking anywhere on a row toggles it, except on an
input, select or button (those just focus/act normally, so editing a single day
is unaffected). The count of selected days is shown in the bulk bar.
Keyboard: **Space** toggles the focused row, **Escape** clears the selection.

Selecting one or more days reveals a bulk bar pinned to the bottom of the
screen with Hours, Minutes, Caretaker, **Apply to Selected**, **Clear Selected**
and a red **Delete Selected Entries**.

**Blank means unchanged.** Leaving Hours, Minutes or Caretaker blank leaves that
field alone on every selected day, so a caretaker-only bulk edit can never wipe
someone's hours. The Caretaker dropdown has an explicit **Unassigned** entry for
when you do want to clear it, and typing `0` sets a field to zero.

**Confirmation before overwriting.** Applying to days that already hold data asks
`N of these days already have data. Overwrite them?` first. If any of them sit on
a claim, the dialog adds a warning and distinguishes the two cases: a
**submitted** claim says editing won't update it until you regenerate, while a
**draft** claim says to regenerate afterwards.

**Deleting** asks `Delete entries for N days? This cannot be undone.` Days on a
submitted claim are still deletable, with an extra warning that the claim's
totals go stale until regenerated. Deleting is `POST /api/day-entries/bulk-delete`
and does not touch the schema.

After either action the calendar refreshes, the fields reset, the selection
clears and a toast reports the outcome (`Applied to 5 days`, `Deleted 7 entries`).

Copy/Paste is unchanged: Copy a day, then use **Paste to N days** in the
clipboard bar to apply it to the current selection.

## Editing past periods and regenerating claims

**Navigating weeks.** The calendar has Previous / Next / This week, plus a date
picker that jumps straight to the week containing any date.

**Claimed days are editable.** A day that already belongs to a claim can still
have its hours, minutes, caretaker and notes changed — the day keeps its
`claim_id`, and `units`/`rate_per_unit`/`dollars` are recomputed and re-snapshotted
as always. The claim's stored totals deliberately do **not** change behind your
back; they go stale until you regenerate.

**Regenerating.** The claim detail view has a **Regenerate Claim** button, which
the server implements as:

1. clear the claim's aggregated `total_units` / `total_dollars`;
2. re-query every day entry for that client between `period_start` and `period_end`;
3. write the fresh totals (and re-link any in-period day that was not yet on the
   claim — so days added later are picked up);
4. re-render the claim PDF if one exists.

Entries in the period that belong to a *different* claim are reported and left
alone rather than being silently absorbed. The run stamps
`claims.last_regenerated_at`, which is shown on the claim detail view.

**Locked claims.** Only a **Draft** claim can be regenerated. A Submitted or Paid
claim has already gone to a payer, so the server returns 409 and the UI shows:

> This claim is locked. Revert to Draft first to edit.

with a **Revert to Draft** button. Reverting clears the submission timeline
(`submitted_date`, `expected_pay_date`, `variance_days`) because the claim is no
longer submitted. A recorded payment (`paid_date` / `paid_amount`) is deliberately
**kept** — silently deleting a payment record would be destructive — and the UI
says so.

**Calendar warning.** A week containing a Submitted/Paid claim shows a banner
naming the claim and stating that the day belongs to a locked claim that must be
reverted to Draft to edit. Editing is **not** blocked; you are only warned that
the claim totals will not update until regenerated.

## Caretakers and case managers

Two new tables, plus two columns added to existing tables:

| Change | How |
| --- | --- |
| `case_managers` table | `CREATE TABLE IF NOT EXISTS` |
| `caretakers` table | `CREATE TABLE IF NOT EXISTS` |
| `clients.case_manager_id` | `ALTER TABLE clients ADD COLUMN ... REFERENCES case_managers(id) ON DELETE SET NULL` |
| `day_entries.caretaker_id` | `ALTER TABLE day_entries ADD COLUMN ... REFERENCES caretakers(id) ON DELETE SET NULL` |

**Nothing is dropped or recreated**, so every existing row survives untouched.
SQLite does accept `ADD COLUMN ... REFERENCES` (verified), and `addReferenceColumn()`
in `server/db.js` falls back to a plain INTEGER column if a build ever refuses —
the relationship is then enforced in application code by the same validation that
produces the readable API errors.

Verified by snapshotting the database before the migration and comparing row
counts and per-table content hashes afterwards: counts preserved, content
byte-identical, `integrity_check` ok, `foreign_key_check` clean.

**One case manager per client.** Assign from a dropdown of existing managers on
the client profile, or create one inline (which assigns it straight away). The
profile shows name, organization, email and phone.

**A caretaker per day worked.** Each calendar row has a picker; the chosen name
shows under it. Copy/Paste carries the caretaker along with the hours, so pasting
a week keeps the same person on every day. Changing *only* the caretaker still
marks the day dirty — otherwise the change would never be offered for saving.

**Days recorded before caretakers existed** have `caretaker_id = NULL`. The UI
shows "Unassigned" and the PDF prints blanks for them, plus a count of how many
days in the period have nobody recorded.

**The claim PDF** now carries a CASE MANAGER block under the client details, a
caretaker name + NPI on every line of the daily breakdown, and a
CARETAKERS IN THIS PERIOD summary listing each unique caretaker with their NPI.

**Deleting** a caretaker or case manager is refused while anything references
them (days worked / assigned clients) unless forced, which clears the links
rather than silently un-attributing history. Deactivating is the normal path and
keeps the person selectable on days they already worked.

## Layout

```
run.sh                    launcher (node discovery, install, seed, start)
scripts/dev.mjs           runs the API and Vite together
server/
  index.js                Express app, loopback guard, /api/calc, /api/week
  db.js                   SQLite init + schema
  calc.js                 units/dollars math (source of truth)
  seed.js                 sample data
  routes/
    clients.js            search, profile, agreements, week lookup
    agreements.js         CRUD + live calc preview
    dayEntries.js         day/week save, summary, delete
    claims.js             generation, lifecycle, payer stats, PDF attachments
    settings.js           key/value preferences + template validation
    caretakers.js         caretaker CRUD
    caseManagers.js       case manager CRUD
    importRa.js           remittance advice parse / match / save
    backup.js             zip backup (WAL-safe snapshot + PDFs)
    pdfStorage.js         local PDF paths, validation, safe reads
    claimPdf.js           pdfkit claim-summary generator
    payers.js             payer CRUD
client/
  src/App.jsx             hash router + shell
  src/api.js              API client
  src/calc.js             client mirror of the unit math
  src/pages/              ClientSearch, ClientProfile, WeekCalendar
data/billing.db           the database (gitignored)
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Status, today, current week start, row counts |
| GET | `/api/clients?q=&active=0` | Search clients |
| GET | `/api/clients/:id` | Client + agreements + recent claims + totals |
| POST | `/api/clients` | Create a client |
| PUT/PATCH | `/api/clients/:id` | Update a client (partial; either verb) |
| GET | `/api/clients/:id/weeks?start=` | One Mon–Sun week of day entries |
| GET | `/api/agreements?client_id=` | List agreements |
| POST | `/api/agreements` | Create an agreement |
| PUT/PATCH | `/api/agreements/:id` | Update an agreement (partial; either verb) |
| POST | `/api/day-entries` | Save (upsert) one day |
| POST | `/api/day-entries/bulk` | Save a whole week in one transaction |
| GET | `/api/day-entries/summary?client_id=&start=` | Week totals |
| DELETE | `/api/day-entries/:id` | Delete a day (blocked once it's on a claim) |
| GET | `/api/claims/export.csv` | Download claims as CSV |
| GET | `/api/backup` | Download the backup zip |
| GET | `/api/reports` | Aging, payer performance, snapshot, monthly series |
| GET | `/api/clients/:id/delete-check` | Whether a client may be hard deleted |
| POST | `/api/import-ra/existing` | Existing RA/manual claim for a client + period |
| GET | `/api/claims/:id/delete-check` | Whether a claim may be deleted, or must be archived |
| POST | `/api/claims/bulk-archive` | Archive many claims (never toggles) |
| POST | `/api/claims/bulk-unarchive` | Restore many archived claims |
| POST | `/api/claims/bulk-unarchive-check` | Pre-flight: skipped count and period conflicts |
| POST | `/api/claims/bulk-delete-check` | Pre-flight for the bulk delete modal |
| POST | `/api/claims/bulk-delete` | Delete many claims, refused if any is linked |
| GET | `/api/dashboard/pay-period` | Caretaker ranking + totals for a bi-weekly period |
| GET | `/api/dashboard/recent-ra` | The last 5 saved RA imports |
| GET | `/api/dashboard/recent-clients` | The last 8 profiles opened |
| GET | `/api/caretakers/:id/summary` | Period snapshot plus period/MTD/YTD/anticipated/confirmed |
| GET | `/api/caretakers/:id/client-splits` | Hours and dollars per client over a range |
| GET | `/api/caretakers/:id/work-history` | Paginated, filterable day entries |
| GET | `/api/caretakers/:id/calendar` | Worked days for a month |
| GET | `/api/exports/mpsmisc/preview` | MPSMISC preview rows and warnings |
| GET | `/api/exports/mpsmisc.xlsx` | The MPSMISC reporting spreadsheet |
| GET | `/api/admin/orphaned-entries` | Day entries with no valid, active client |
| GET | `/api/admin/orphaned-entries/count` | Orphan count for the nav badge |
| POST | `/api/admin/orphaned-entries/cleanup` | Delete the orphans (needs `DELETE`) |
| GET/POST | `/api/caretakers` | List / create caretakers |
| PUT/PATCH/DELETE | `/api/caretakers/:id` | Update / delete (delete guarded) |
| GET/POST | `/api/case-managers` | List / create case managers |
| PUT/PATCH/DELETE | `/api/case-managers/:id` | Update / delete (delete guarded) |
| POST | `/api/claims/:id/regenerate` | Re-derive totals from the period's day entries (Draft only) |
| POST | `/api/claims/:id/revert` | Unlock a Submitted/Paid claim back to Draft |
| POST | `/api/day-entries/bulk-delete` | Delete several days' entries at once |
| GET | `/api/exports/caregivers.csv` | HHAeXchange caregiver flat file |
| GET | `/api/exports/visits.csv` | HHAeXchange visit flat file (422 while invalid) |
| GET | `/api/exports/validation` | Pre-export issues for the visit file |
| POST | `/api/import-ra` | Parse a remittance advice PDF (read-only) |
| POST | `/api/import-ra/match` | Best non-archived client for a name |
| POST | `/api/import-ra/save` | Write the approved rows |
| GET/PUT | `/api/settings` | Read / update preferences |
| POST | `/api/calc` | Stateless units/dollars preview |
| GET | `/api/week?start=` | Week boundaries |

Saving zero minutes with no notes deletes that day. A day attached to a claim
(`claim_id` set) refuses edits and deletes with HTTP 409.

## Notes on the environment

This machine has no system Node install, so `run.sh` falls back to the Node
runtime bundled at `~/.dsh/dsh-runtimes/.../node/bin/node`. That build is
Developer-ID signed with the hardened runtime, which makes macOS refuse
ad-hoc-signed native addons like our locally compiled `better-sqlite3`. When
`run.sh` detects this it keeps an ad-hoc-signed copy of Node at `.runtime/node`
and uses that instead. Nothing outside this folder is modified.

Package-manager caches are redirected to `.cache/` for the same reason.

`better-sqlite3` is pinned to **v13.0.3 or newer**. v12.11.1 aborts the process
with a native assertion (`RemoveEnvironmentCleanupHook: Assertion failed:
(env) != nullptr`) on Node 24.21.

## Database

Single file at `data/billing.db` (WAL mode). To start over:

```bash
./run.sh --reset
```

To point at a different file: `BILLING_DB=/path/to/other.db ./run.sh`
