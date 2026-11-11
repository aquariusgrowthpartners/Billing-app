/** Randomly sample N RA PDFs using the full regression runner. */
import { spawnSync } from 'node:child_process';

const limit = Number(process.argv[2] || 3);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('Usage: node test-canary.js <limit>');
  process.exit(2);
}
const result = spawnSync(process.execPath, ['test-all-ras.js'], {
  stdio: 'inherit',
  env: { ...process.env, CANARY_LIMIT: String(limit) },
});
process.exit(result.status ?? 1);
