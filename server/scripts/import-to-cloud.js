#!/usr/bin/env node
/**
 * Push a local-export.json into the live Railway app as the authenticated admin.
 *
 * The API remaps every id and stamps every row with the admin's agency_id, so
 * data can never land in the Demo Agency.
 *
 *   CLOUD_ADMIN_PASSWORD='…' node server/scripts/import-to-cloud.js --dry-run
 *   CLOUD_ADMIN_PASSWORD='…' node server/scripts/import-to-cloud.js
 *   CLOUD_ADMIN_PASSWORD='…' node server/scripts/import-to-cloud.js --replace
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const URL_BASE = String(
  arg('url', process.env.CLOUD_API_URL ?? 'https://dundas-billing-production.up.railway.app')
).replace(/\/$/, '');
const EMAIL = String(arg('email', process.env.CLOUD_ADMIN_EMAIL ?? 'james@aquariusgp.com')).trim();
const PASSWORD = String(arg('password', process.env.CLOUD_ADMIN_PASSWORD ?? ''));
const FILE = path.resolve(arg('file', path.join(ROOT, 'local-export.json')));
const REPLACE = process.argv.includes('--replace');
const DRY_RUN = process.argv.includes('--dry-run');

if (!PASSWORD) {
  console.error('  CLOUD_ADMIN_PASSWORD is required (or pass --password).');
  console.error("  Example: CLOUD_ADMIN_PASSWORD='…' node server/scripts/import-to-cloud.js --dry-run");
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error(`  Export not found: ${FILE}`);
  console.error('  Run: node server/scripts/export-local.js');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (payload?.format !== 'billing-local-export-v1' || !payload?.data) {
  console.error('  That file is not a billing-local-export-v1 payload.');
  process.exit(1);
}

async function post(pathname, body, token) {
  const res = await fetch(`${URL_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json error page */
  }
  return { status: res.status, json };
}

console.log(`  target: ${URL_BASE}`);
console.log(`  file:   ${FILE}`);
console.log(`  mode:   ${REPLACE ? 'replace (existing admin data will be deleted)' : 'merge'}`);
if (DRY_RUN) console.log('  dry run: no rows will be written');

const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
if (login.status !== 200 || !login.json?.token) {
  console.error(`  Login failed (${login.status}): ${login.json?.error ?? 'unknown error'}`);
  process.exit(1);
}
const user = login.json.user ?? {};
if (user.agency_name === 'Demo Agency') {
  console.error('  Refusing: this login belongs to the Demo Agency.');
  process.exit(1);
}
console.log(`  signed in as ${user.email} (${user.agency_name}, agency ${user.agency_id})`);

const result = await post(
  '/api/admin/import-local',
  {
    data: payload.data,
    mode: REPLACE ? 'replace' : 'merge',
    confirm: REPLACE ? 'REPLACE' : undefined,
    dryRun: DRY_RUN,
  },
  login.json.token
);

if (result.status !== 200) {
  console.error(`  Import failed (${result.status}): ${result.json?.error ?? 'unknown error'}`);
  process.exit(1);
}

console.log(JSON.stringify(result.json, null, 2));
console.log(
  DRY_RUN
    ? '  Dry run complete — nothing was written.'
    : `  Imported ${result.json.total ?? 0} rows into ${result.json.target_agency?.name ?? 'the admin agency'}.`
);
