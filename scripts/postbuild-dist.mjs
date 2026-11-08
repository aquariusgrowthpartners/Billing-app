/**
 * Mirror client/dist to ./dist after the Vite build.
 *
 * Nixpacks' Node provider hard-codes `COPY /app/dist` into the final image, but
 * Vite writes to client/dist. Without this the image build fails with
 * "/app/dist: not found". Copying here runs no matter which build config
 * Railway honours (railway.json buildCommand or nixpacks.toml phases).
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(new URL('.', import.meta.url).pathname, '..');
const from = path.join(root, 'client', 'dist');
const to = path.join(root, 'dist');

if (!fs.existsSync(from)) {
  console.error(`  postbuild: ${from} does not exist — did the build run?`);
  process.exit(1);
}

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`  postbuild: mirrored client/dist -> dist`);
