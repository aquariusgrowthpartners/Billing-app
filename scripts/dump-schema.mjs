/**
 * Regenerate server/scripts/demo-schema.sql from the live database.
 *
 * The demo seeder needs the schema but must not ship the live database (it
 * contains PHI). This dumps DDL only, so the seeder works in a container where
 * data/ is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.join(new URL('.', import.meta.url).pathname, '..');
const live = path.join(root, 'data', 'billing.db');
if (!fs.existsSync(live)) {
  console.error(`  no live database at ${live}`);
  process.exit(1);
}
const db = new Database(live, { readonly: true });
const rows = db
  .prepare(
    `SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND type IN ('table','index') AND name NOT LIKE 'sqlite_%'
      ORDER BY type DESC, name`
  )
  .all();
db.close();
const header =
  '-- Schema snapshot for the demo seeder.\n' +
  '-- Generated from the live database. DDL only, no patient data.\n' +
  '-- Regenerate with: node scripts/dump-schema.mjs\n\n';
fs.writeFileSync(
  path.join(root, 'server', 'scripts', 'demo-schema.sql'),
  header + rows.map((r) => r.sql.trim() + ';').join('\n\n') + '\n'
);
console.log(`  wrote demo-schema.sql (${rows.length} objects)`);
