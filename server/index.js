import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import db, { DB_PATH } from './db.js';
import clientsRouter from './routes/clients.js';
import agreementsRouter from './routes/agreements.js';
import serviceAgreementsRouter from './routes/serviceAgreements.js';
import tasksRouter from './routes/tasks.js';
import askRouter from './routes/ask.js';
import dayEntriesRouter from './routes/dayEntries.js';
import claimsRouter from './routes/claims.js';
import payersRouter from './routes/payers.js';
import settingsRouter from './routes/settings.js';
import backupRouter from './routes/backup.js';
import reportsRouter from './routes/reports.js';
import caretakersRouter from './routes/caretakers.js';
import caseManagersRouter from './routes/caseManagers.js';
import exportsRouter from './routes/exports.js';
import importRaRouter from './routes/importRa.js';
import dashboardRouter from './routes/dashboard.js';
import adminRouter from './routes/admin.js';
import mpsmiscRouter from './routes/mpsmisc.js';
import denialsRouter from './routes/denials.js';
import { reconcileOnStartup, markOrphanedImports, openTaskCount, deleteRebillTask } from './denials.js';
import { computeEntry, todayISO, weekStart, addDays } from './calc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST ?? '127.0.0.1'; // loopback only — never 0.0.0.0
const PORT = Number(process.env.PORT ?? 4000);

const app = express();

/*
 * CORS.
 *
 * Same-origin in every normal case (Express serves the SPA and the API), so by
 * default nothing is allowed cross-origin. Deployments that split the frontend
 * onto another host list that origin in ALLOWED_ORIGINS, comma separated.
 */
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});


app.disable('x-powered-by');
// A batch of up to 10 RA PDFs arrives as multipart, so the JSON body limit
// stays small while the upload route sets its own.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/*
 * Local-only guard: reject anything that did not arrive over loopback.
 *
 * This is the app's original safety property — it holds patient data and was
 * built to run on one machine. A deployment is the one case where remote
 * traffic is the point, so it requires a deliberate opt-in:
 *
 *   ALLOW_REMOTE=true
 *
 * Defaulting to local-only means a misconfigured deploy is locked down rather
 * than silently public.
 */
const ALLOW_REMOTE = String(process.env.ALLOW_REMOTE ?? '').toLowerCase() === 'true';
if (ALLOW_REMOTE) {
  console.log('  network      remote connections ALLOWED (ALLOW_REMOTE=true)');
} else {
  app.use((req, res, next) => {
    const ip = req.socket.remoteAddress ?? '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback) return res.status(403).json({ error: 'This server only accepts local connections.' });
    next();
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    today: todayISO(),
    week_start: weekStart(todayISO()),
    db: DB_PATH,
    clients: db.prepare(`SELECT COUNT(*) AS n FROM clients`).get().n,
    agreements: db.prepare(`SELECT COUNT(*) AS n FROM agreements`).get().n,
    day_entries: db.prepare(`SELECT COUNT(*) AS n FROM day_entries`).get().n,
    claims: db.prepare(`SELECT COUNT(*) AS n FROM claims`).get().n,
  });
});

/**
 * Stateless calculator. The UI calls this for the live per-day preview so the
 * numbers on screen come from exactly the same code that saves them.
 */
app.post('/api/calc', (req, res) => {
  const b = req.body ?? {};
  res.json(
    computeEntry({
      minutes_worked: b.minutes_worked,
      minutes_per_unit: b.minutes_per_unit,
      rate_per_unit: b.rate_per_unit,
      max_units_per_day: b.max_units_per_day,
    })
  );
});

app.get('/api/week', (req, res) => {
  const start = weekStart(req.query.start ?? todayISO());
  res.json({
    start,
    end: addDays(start, 6),
    next_start: addDays(start, 7),
    prev_start: addDays(start, -7),
    days: Array.from({ length: 7 }, (_, i) => addDays(start, i)),
  });
});

app.use('/api/clients', clientsRouter);
app.use('/api/agreements', agreementsRouter);
app.use('/api/service-agreements', serviceAgreementsRouter);
app.use('/api/tasks', tasksRouter);

/* Tells the client whether it is looking at synthetic data. */
app.get('/api/mode', (_req, res) => {
  res.json({
    demo: String(process.env.DEMO_MODE ?? '').toLowerCase() === 'true',
  });
});
app.use('/api/ask', askRouter);
app.use('/api/day-entries', dayEntriesRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/payers', payersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/caretakers', caretakersRouter);
app.use('/api/case-managers', caseManagersRouter);
app.use('/api/exports', exportsRouter);
app.use('/api/import-ra', importRaRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/admin', adminRouter);
app.use('/api/exports', mpsmiscRouter);
app.use('/api/denials', denialsRouter);
// DELETE /api/rebill-tasks/:id — the lighter, task-only removal
app.delete('/api/rebill-tasks/:id', (req, res) => {
  const r = deleteRebillTask(req.params.id);
  if (!r) return res.status(404).json({ error: 'Rebill task not found' });
  res.json(r);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Denial reconciliation runs once per boot, after the schema is in place, so a
// rebill that landed while the server was down is still credited.
try {
  const r = reconcileOnStartup();
  markOrphanedImports();
  if (r.recovered || r.open_tasks) {
    console.log(
      `  denials      ${r.recovered} recovered on startup, ${r.open_tasks} open rebill task(s)`
    );
  }
} catch (e) {
  console.error('  denials      reconciliation failed:', e.message);
}

/*
 * Static SPA.
 *
 * Served whenever a build exists — this is what lets Railway run the API and
 * the frontend from one origin and one process. In dev there is no dist and the
 * Vite server proxies /api instead.
 */
const distDir = path.join(__dirname, '..', 'client', 'dist');
const hasBuild = fs.existsSync(path.join(distDir, 'index.html'));
if (hasBuild) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  // SPA fallback — but never for /api, which has already 404'd above
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else if (process.env.NODE_ENV === 'production') {
  console.warn('  [web] no client/dist build found — run `npm run build` before starting in production');
}

app.use((err, _req, res, _next) => {
  console.error('[api error]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`  billing-api  http://${HOST}:${PORT}`);
  console.log(`  database     ${DB_PATH}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

export default app;
