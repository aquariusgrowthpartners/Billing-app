#!/usr/bin/env node
/**
 * Dev launcher: starts the API (127.0.0.1:4000) and the Vite dev server
 * (127.0.0.1:5173) together, with prefixed output. No extra dependencies.
 *
 *   ./run.sh          -> dev mode, open http://127.0.0.1:5173
 *   ./run.sh --build  -> build the UI, then serve everything from the API
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const API_PORT = Number(process.env.API_PORT ?? 4000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

const COLORS = { api: '\x1b[36m', web: '\x1b[35m', reset: '\x1b[0m' };
const children = [];
let shuttingDown = false;

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${COLORS[name] ?? ''}[${name}]${COLORS.reset} `;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`${prefix}exited (code ${code ?? signal})`);
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const node = process.execPath;
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

console.log('\n  Billing Calendar — starting up\n');

if (!fs.existsSync(viteBin)) {
  console.error('  Dependencies are missing. Run:  ./run.sh --install\n');
  process.exit(1);
}

run('api', node, [path.join(ROOT, 'server', 'index.js')], { PORT: String(API_PORT) });
run('web', node, [viteBin, '--config', path.join(ROOT, 'client', 'vite.config.js')], {
  API_PORT: String(API_PORT),
  WEB_PORT: String(WEB_PORT),
});

console.log(`\n  Open:  http://127.0.0.1:${WEB_PORT}\n`);
