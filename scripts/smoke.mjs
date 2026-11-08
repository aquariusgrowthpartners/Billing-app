#!/usr/bin/env node
/**
 * Browser-less end-to-end smoke test.
 *
 * Renders the real React app in jsdom against a running API and drives actual
 * navigation, so route regressions (a profile page that never renders, a rate
 * that shows as $0) fail here instead of in the browser.
 *
 *   ./run.sh --build      # or leave `./run.sh` running
 *   node scripts/smoke.mjs
 *
 * Exits non-zero on the first failing assertion set.
 */
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const API = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const BUNDLE = path.join(ROOT, '.cache', 'smoke-app.mjs');

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* --------------------------------------------------------- preconditions */

async function requireApi() {
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`\nCannot reach the API at ${API} (${e.message}).`);
    console.error('Start it first:  ./run.sh   (or ./run.sh --build)\n');
    process.exit(2);
  }
}

/* ------------------------------------------------------------ 1. routing */

section('Route parsing (pure)');
{
  const { parseRoute } = await import('../client/src/route.js');

  const list = parseRoute('#/clients');
  check('#/clients -> list', list.name === 'clients' && list.clientId === null, JSON.stringify(list));

  const profile = parseRoute('#/clients/3');
  check(
    '#/clients/3 -> client profile (THE BUG: this used to stay on the list)',
    profile.name === 'client' && profile.clientId === 3,
    JSON.stringify(profile)
  );

  const cal = parseRoute('#/calendar/3?week=2026-10-05');
  check(
    '#/calendar/3?week= -> calendar with week',
    cal.name === 'calendar' && cal.clientId === 3 && cal.week === '2026-10-05',
    JSON.stringify(cal)
  );

  const bad = parseRoute('#/nonsense/xyz');
  check('#/nonsense -> falls back to list', bad.name === 'clients' && bad.clientId === null);

  const empty = parseRoute('');
  check('empty hash -> list', empty.name === 'clients');
}

/* --------------------------------------------------------- 2. jsdom boot */

section('Booting the app in jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:5173/#/clients',
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
// Node 24 exposes globalThis.navigator as a getter-only property.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.HashChangeEvent = window.HashChangeEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The app fetches relative paths; give Node's fetch an absolute origin.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  nodeFetch(typeof url === 'string' && url.startsWith('/') ? `${API}${url}` : url, opts);

await build({
  entryPoints: [path.join(__dirname, 'smoke-app.jsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  packages: 'external',
  outfile: BUNDLE,
  logLevel: 'error',
});

const { React, createRoot, act, App } = await import(BUNDLE);

const container = document.getElementById('root');
const root = createRoot(container);

/** Let effects, promises and re-renders settle inside act(). */
async function settle(ms = 80) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * Poll until the DOM satisfies `predicate`. More reliable than a fixed sleep,
 * which is exactly how the debounced search silently fooled an earlier run.
 */
async function waitFor(predicate, { timeout = 4000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(step);
  }
  return predicate();
}

/** Mirror what a real browser does when location.hash changes. */
async function goTo(hash) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  });
  await settle();
}

const text = () => container.textContent ?? '';
const rows = () => [...container.querySelectorAll('tbody tr')];

await act(async () => {
  root.render(React.createElement(App));
});
await waitFor(() => text().includes('Smith'));

/* ------------------------------------------------------- 3. client list */

section('Client list');
check('renders the client list heading', text().includes('Clients'));
check('loaded clients from the API', rows().length > 0, `${rows().length} rows`);
check('shows a known seeded client (Smith)', text().includes('Smith'));

/* ------------------------------------------- 4. clicking opens the profile */

section('Clicking a client opens their profile (BLOCKER 1)');
{
  const row = rows().find((r) => /Smith/.test(r.textContent));
  check('found the Smith row', Boolean(row));
  if (row) {
    await act(async () => {
      row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => text().includes('MA number'));

    check(
      'clicking the row changed the URL to #/clients/:id',
      /^#\/clients\/\d+$/.test(window.location.hash),
      window.location.hash
    );

    const id = Number(window.location.hash.split('/').pop());
    const body = text();

    check('profile page replaced the list', !body.includes('Include inactive'));
    check('shows the client name', body.includes('Alice') && body.includes('Smith'));
    check('shows the DOB label and value', body.includes('DOB') && body.includes('Mar 14, 1985'));
    check('shows the MA number', body.includes('MA number') && body.includes('123456789'));
    check('has a Back to Client List button', body.includes('Back to Client List'));
    check('has an Agreements section', body.includes('Agreements'));
    check('has an Add Agreement button', body.includes('Add Agreement'));
    check('has the embedded week calendar', body.includes('Week calendar'));
    check('has a Claims section', body.includes('Claims'));

    check('profile URL is unique per client', id > 0, `id=${id}`);
  }
}

/* ------------------------------------- 5. agreement terms reach the calendar */

section('Agreement terms drive the calendar (BLOCKER 2)');
{
  const body = text();
  check('rate from the agreement is shown, not $0', body.includes('$18.50'), 'expected $18.50');
  check('minutes-per-unit from the agreement is shown', body.includes('15') && body.includes('min/unit'));
  check('max units/day from the agreement is shown', /max\s*16/.test(body.replace(/\s+/g, ' ')));
  check('no "no agreement" warning for a client that has one', !body.includes('has no agreement yet'));
}

/* ------------------------------------------- 6. a client with no agreement */

section('Client with no agreement still offers a way to set the rate');
{
  const res = await fetch(`${API}/api/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: 'Smoke',
      last_name: `zzSmoke-${Date.now()}`,
      ma_number: '000000001',
    }),
  });
  const created = await res.json();

  await goTo(`#/clients/${created.id}`);
  await waitFor(() => text().includes('Smoke'));
  const body = text();

  check('new client profile renders', body.includes('Smoke'));
  check('warns that there is no agreement', body.includes('has no agreement yet'));
  check(
    'auto-opens the Add agreement form so the rate is reachable',
    body.includes('Add agreement') && body.includes('Rate per unit')
  );
  check(
    'rate input is present (not defaulted to $0)',
    Boolean(container.querySelector('input[placeholder="18.50"]'))
  );
  check(
    'calendar shows — instead of a misleading $0.00',
    body.includes('—'),
    'dash placeholder missing'
  );

  // Clean up the throwaway client.
  const del = await fetch(`${API}/api/clients/${created.id}`, { method: 'DELETE' });
  check('temp client cleaned up', del.ok, `HTTP ${del.status}`);
}

/* --------------------------- 6b. fill in and submit the agreement form */

/** Set a React-controlled input the way a real keystroke would. */
async function type(selector, value) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  await act(async () => {
    const proto =
      el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

section('Submitting the agreement form teaches the calendar the rate (BLOCKER 2)');
{
  const unique = `zzSmoke-${Date.now()}`;
  const res = await fetch(`${API}/api/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Rate', last_name: unique, ma_number: '000000002' }),
  });
  const client = await res.json();

  await goTo(`#/clients/${client.id}`);
  await waitFor(() => Boolean(container.querySelector('form.agreement-form')));

  check('agreement form auto-opened for the new client', Boolean(container.querySelector('form.agreement-form')));

  // The payer dropdown must be fed from the payers table (async fetch).
  await waitFor(
    () =>
      [...container.querySelectorAll('select[name="payer_id"] option')].some((o) =>
        /State Medicaid/.test(o.textContent)
      ),
    { timeout: 4000 }
  );
  const payerOptions = [...container.querySelectorAll('select[name="payer_id"] option')].map((o) => ({
    value: o.value,
    label: o.textContent,
  }));
  check(
    'payer dropdown is populated from the payers table',
    payerOptions.some((o) => /State Medicaid/.test(o.label)),
    payerOptions.map((o) => o.label).join(' | ')
  );
  check(
    'payer options show their typical days to pay',
    payerOptions.some((o) => /net 30d/.test(o.label)),
    payerOptions.map((o) => o.label).join(' | ')
  );

  const medicaid = payerOptions.find((o) => /State Medicaid/.test(o.label));

  // 20-minute units, $42.00/unit, max 6 units/day, 50 units/week.
  await type('input[name="agreement_number"]', unique);
  if (medicaid) await type('select[name="payer_id"]', medicaid.value);
  await type('input[name="minutes_per_unit"]', '20');
  await type('input[name="rate_per_unit"]', '42');
  await type('input[name="max_units_per_day"]', '6');

  check(
    'live preview reflects the typed terms (80 min = 4 units = $168.00)',
    text().includes('$168.00'),
    text().match(/Preview:[^|]{0,120}/)?.[0] ?? 'no preview found'
  );

  await act(async () => {
    container
      .querySelector('form.agreement-form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await waitFor(() => text().includes('20') && text().includes('$42.00'), { timeout: 5000 });

  const body = text();
  check('agreement saved and listed', body.includes(unique));
  check('the payer selected in the form was attached', body.includes('State Medicaid'));
  check('calendar now shows the $42.00 rate', body.includes('$42.00'), 'rate not reflected');
  check('calendar now shows 20 min/unit', /20\s*min\/unit/.test(body.replace(/\s+/g, ' ')));
  check('the "no agreement" warning is gone', !body.includes('has no agreement yet'));

  // --- adjustment 1: authorized units per week fully retired ---
  check(
    'agreement form no longer has an Authorized Units field',
    container.querySelector('input[name="authorized_units_per_week"]') === null
  );
  check('no "units/wk" appears on the calendar', !/units\/wk/i.test(text()));
  check('no "Units/wk" column in the agreements table', !/Units\/wk/i.test(text()));
  check(
    'no authorization wording anywhere on the page',
    !/authoriz/i.test(text()),
    text().match(/.{0,60}authoriz.{0,60}/i)?.[0] ?? ''
  );

  /* --- log a day with separate hours + minutes fields --- */

  const hoursInput = container.querySelector('input[name^="hours-"]');
  const day = hoursInput.getAttribute('name').replace('hours-', '');

  check('the row has a separate Hours field', Boolean(container.querySelector(`input[name="hours-${day}"]`)));
  check('the row has a separate Minutes field', Boolean(container.querySelector(`input[name="minutes-${day}"]`)));

  // 1h 25m must combine to 85 minutes -> 4 units at 20min/unit -> $168.00
  await type(`input[name="hours-${day}"]`, '1');
  await type(`input[name="minutes-${day}"]`, '25');
  check(
    'the server-side total appears as 1h 25m',
    text().includes('1h 25m'),
    'combined total not shown'
  );
  check(
    'live units/dollars for 1h 25m at 20min/unit and $42 = 4 units / $168.00',
    text().includes('$168.00'),
    'per-day math did not appear'
  );

  // Save the day via its row button.
  const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
  check('a per-day Save button appeared for the dirty row', Boolean(saveBtn));
  if (saveBtn) {
    await act(async () => {
      saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => text().includes('saved'), { timeout: 5000 });
  }

  // Confirm the server stored the denormalized snapshot.
  const week = await (
    await fetch(`${API}/api/day-entries?client_id=${client.id}&start=${day}&end=${nextDay(day)}`)
  ).json();
  const entry = week.entries[0];
  check('day entry persisted to SQLite', Boolean(entry), 'no entry returned');
  if (entry) {
    check(
      'server combined 1h 25m into minutes_worked = 85',
      entry.minutes_worked === 85,
      `got ${entry.minutes_worked}`
    );
    check('stored units = 4 (floor(85/20))', entry.units === 4, `got ${entry.units}`);
    check('stored rate_per_unit = 42', Number(entry.rate_per_unit) === 42, `got ${entry.rate_per_unit}`);
    check('stored dollars = 168', Number(entry.dollars) === 168, `got ${entry.dollars}`);
  }

  // Reload the page from scratch to prove it came from the database.
  // Assert against the CALENDAR inputs specifically: "$168.00" also appears in
  // the profile's "Total billed" stat card, which is not evidence the week
  // loaded (an earlier version of this check passed for exactly that reason).
  await goTo('#/clients');
  await waitFor(() => text().includes('Clients'));
  await goTo(`#/clients/${client.id}`);
  await waitFor(
    () => container.querySelector(`input[name="hours-${day}"]`)?.value === '1',
    { timeout: 6000 }
  );
  check(
    'entry survives a full reload (hours read back from SQLite)',
    container.querySelector(`input[name="hours-${day}"]`)?.value === '1'
  );
  check(
    'entry minutes read back from SQLite',
    container.querySelector(`input[name="minutes-${day}"]`)?.value === '25'
  );

  /* ------------------------------------------------ copy & paste schedules */

  section('Copy / paste a schedule across days (BLOCKER 3)');
  {
    const btn = (label) =>
      [...container.querySelectorAll('button')].filter((b) => b.textContent.trim() === label);

    const copyButtons = btn('Copy');
    check('filled days offer a Copy button', copyButtons.length >= 1, `${copyButtons.length} found`);

    await act(async () => {
      copyButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => /Copied/.test(text()));
    check('clipboard shows what was copied (1h 25m)', text().includes('1h 25m'));

    const pasteButtons = btn('Paste');
    check(
      'empty days now offer a Paste button',
      pasteButtons.length >= 2,
      `${pasteButtons.length} paste buttons`
    );

    // Single-day paste: must apply AND persist without a separate save.
    const target = pasteButtons[0].closest('tr');
    const targetDate = target
      .querySelector('input[name^="hours-"]')
      .getAttribute('name')
      .replace('hours-', '');

    await act(async () => {
      pasteButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => text().includes('saved'), { timeout: 5000 });

    let saved = await (
      await fetch(`${API}/api/day-entries?client_id=${client.id}&start=${targetDate}&end=${nextDay(targetDate)}`)
    ).json();
    check('paste persisted without an extra save step', saved.entries.length === 1, 'nothing stored');
    if (saved.entries[0]) {
      check(
        'pasted day has the same 85 minutes',
        saved.entries[0].minutes_worked === 85,
        `got ${saved.entries[0].minutes_worked}`
      );
      check('pasted day recalculated to 4 units / $168', saved.entries[0].units === 4 && Number(saved.entries[0].dollars) === 168);
    }

    // Multi-day paste via checkboxes.
    await act(async () => {
      [...container.querySelectorAll('button')]
        .filter((b) => b.textContent.trim() === 'Copy')[0]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => [...container.querySelectorAll('.day-check')].length >= 2);

    const boxes = [...container.querySelectorAll('.day-check')];
    check('empty days expose a multi-select checkbox', boxes.length >= 2, `${boxes.length} boxes`);

    const picked = boxes.slice(0, 2);
    await act(async () => {
      for (const b of picked) b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => /Paste to 2 days/.test(text()));
    check('toolbar offers a bulk paste once days are ticked', /Paste to 2 days/.test(text()));

    const bulkBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Paste to 2 days'
    );
    await act(async () => {
      bulkBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => /saved/.test(text()), { timeout: 5000 });

    const weekAll = await (
      await fetch(`${API}/api/day-entries?client_id=${client.id}&start=${weekStartOf(day)}&end=${nextDay(addDaysISO(weekStartOf(day), 6))}`)
    ).json();
    // 1 originally typed + 1 single paste + 2 bulk pasted = 4 filled days.
    check(
      'bulk paste stored every filled day (1 typed + 1 single + 2 bulk = 4)',
      weekAll.entries.length === 4,
      `got ${weekAll.entries.length} entries`
    );
    check(
      'every pasted day carries 85 minutes',
      weekAll.entries.every((e) => e.minutes_worked === 85),
      JSON.stringify(weekAll.entries.map((e) => e.minutes_worked))
    );
  }

  /* ------------------------------------------------------------ cleanup */

  const all = await (await fetch(`${API}/api/day-entries?client_id=${client.id}`)).json();
  for (const e of all.entries) {
    await fetch(`${API}/api/day-entries/${e.id}`, { method: 'DELETE' });
  }
  const del = await fetch(`${API}/api/clients/${client.id}`, { method: 'DELETE' });
  check('temp client + agreement + entries cleaned up', del.ok, `HTTP ${del.status}`);
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekStartOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ------------------- 6d. every client-picking route lands on the profile */

section('Every route that picks a client opens their profile');
{
  const PICKER = 'Pick a client to open their schedule';
  const PROFILE = 'Back to Client List';
  const CALENDAR = 'Week total'; // only rendered by the embedded week calendar

  // (a) The "Week Calendar" tab shows a picker that looks like a client list.
  //     Clicking a client there must open the profile, not a bare calendar.
  await goTo('#/calendar');
  await waitFor(() => text().includes(PICKER), { timeout: 5000 });
  check('Week Calendar tab shows the client picker', text().includes(PICKER));
  check('picker is not a bare calendar', !text().includes(CALENDAR));

  // The picker's rows arrive from a debounced fetch — wait for a row, not the
  // heading (waiting on the heading was how this check first came up empty).
  await waitFor(() => rows().some((r) => /Smith/.test(r.textContent)), { timeout: 5000 });

  const pickerRow = rows().find((r) => /Smith/.test(r.textContent));
  check('picker lists clients', Boolean(pickerRow));
  if (pickerRow) {
    await act(async () => {
      pickerRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    // Wait for LOADED content: "Back to Client List" also renders in the
    // profile's loading state, so it is not evidence the data arrived.
    await waitFor(() => text().includes('Alice') && text().includes(CALENDAR), { timeout: 6000 });

    check(
      'picking a client from the Week Calendar tab lands on their profile URL',
      /^#\/clients\/\d+$/.test(window.location.hash),
      window.location.hash
    );
    check('...and renders the profile, not a bare calendar', text().includes(PROFILE));
    check('...with the client name', text().includes('Alice') && text().includes('Smith'));
    check('...and the calendar embedded in it', text().includes(CALENDAR));
  }

  // (b) A legacy/bookmarked #/calendar/:id must normalise to the profile URL.
  await goTo('#/calendar/1');
  await waitFor(() => text().includes('Alice') && window.location.hash === '#/clients/1', {
    timeout: 6000,
  });
  check('legacy #/calendar/:id renders the profile', text().includes(PROFILE));
  check(
    'legacy #/calendar/:id rewrites the URL to #/clients/:id',
    window.location.hash === '#/clients/1',
    window.location.hash
  );
  check('legacy link still shows the client name', text().includes('Alice'));
  check('legacy link never shows a calendar-only view', text().includes(PROFILE));

  // (c) The top-nav Week Calendar button must not strand you on a bare calendar.
  const navBtn = [...container.querySelectorAll('.topnav button')].find(
    (b) => b.textContent.trim() === 'Week Calendar'
  );
  check('top nav has a Week Calendar button', Boolean(navBtn));
  if (navBtn) {
    await act(async () => {
      navBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => window.location.hash === '#/calendar');
    check('Week Calendar nav goes to the picker', window.location.hash === '#/calendar');
    check('Week Calendar nav does not render a bare calendar', !text().includes(CALENDAR));
  }
}

/* ------------------------------------------------- 6c. defensive cleanup */

section('Cleanup');
await sweepTestClients();

async function sweepTestClients() {
  try {
    const list = await (await fetch(`${API}/api/clients?q=zzSmoke&active=0`)).json();
    let removed = 0;
    for (const c of list.clients) {
      // Remove any day entries first so the client delete is not blocked.
      const entries = await (
        await fetch(`${API}/api/day-entries?client_id=${c.id}`)
      ).json();
      for (const e of entries.entries) {
        await fetch(`${API}/api/day-entries/${e.id}`, { method: 'DELETE' });
      }
      const res = await fetch(`${API}/api/clients/${c.id}`, { method: 'DELETE' });
      if (res.ok) removed++;
    }
    check(`no zzSmoke test clients left behind (removed ${removed})`, true);
  } catch (e) {
    check('cleanup sweep ran', false, e.message);
  }
}

/* ------------------------------------------------------------ 7. wrap up */

section('Result');
console.log(`  ${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`  \x1b[31m${failures} failed\x1b[0m\n`);
}
await act(async () => {
  root.unmount();
});
process.exit(failures ? 1 : 0);
