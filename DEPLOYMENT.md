# Deployment

Railway is the primary target: it runs the Express API and serves the built SPA
from one origin, with the SQLite file on a persistent volume.

Netlify cannot run the backend or SQLite, so `netlify.toml` is only a static
fallback for the frontend with `/billing-api/*` proxied to a separately hosted
API.

---

## 1. Push the code to GitHub

```bash
git add .
git commit -m "Ready for deployment"
git remote add origin git@github.com:YOUR-USER/billing-app.git   # if not already set
git push -u origin main
```

`data/` is not committed (databases and uploads are local). Confirm `.gitignore`
covers `data/*.db`, `data/*.db-wal`, `data/*.db-shm`, `data/ra_uploads/`,
`data/task_uploads/`, `client/dist/` and `node_modules/`.

## 2. Create the Railway project

1. Go to <https://railway.app> → **New Project**.
2. Choose **Deploy from GitHub repo**.
3. Select the repository and branch (`main`).
4. Railway reads `railway.json`, so the build command is
   `npm install && npm run build` and the start command is `node server/index.js`.

## 3. Environment variables

In the service → **Variables** tab, add:

| Variable      | Value          | Notes |
|---------------|----------------|-------|
| `NODE_ENV`    | `production`   | enables SPA static serving |
| `DEMO_MODE`   | `true`         | synthetic data only — **required for a public demo** |
| `BILLING_DB`  | `/app/data/billing.db` | must sit inside the mounted volume |
| `ALLOWED_ORIGINS` | *(empty)*  | leave empty when frontend and API share an origin |

> **`DEMO_MODE=true` is the safety switch.** It makes the live database
> unreachable: even if `BILLING_DB` points at `data/billing.db`, the server opens
> `demo.db` instead. It also auto-seeds an empty demo database on first boot.
> Set it to `false` (or remove it) only when you are ready to serve real PHI.

### AI provider and key

**These are not environment variables.** The provider and API key live in the
`settings` table and are set from the UI at **Settings → AI Configuration**.
Setting `AI_PROVIDER` / `AI_API_KEY` in Railway has no effect — they will be
ignored.

To configure AI on a deployed instance:

1. Open the app → **Settings** → **AI Configuration**.
2. Choose DeepSeek or OpenAI, paste the key, and save.

The key is stored in the database (on the volume) and is never sent back to the
browser — the settings API redacts it and returns only `has_ai_key`.

## 4. Attach a volume

The SQLite database must survive redeploys.

1. Service → **Settings** → **Volumes** → **Add Volume**.
2. Mount path: **`/app/data`**
3. Set `BILLING_DB=/app/data/billing.db` (see step 3).

Without a volume the database is rebuilt on every deploy, and in demo mode it is
re-seeded from scratch each time.

## 5. Generate a domain

1. Service → **Settings** → **Networking** → **Generate Domain**.
2. Railway gives you `https://<name>.up.railway.app`.
3. Open it — the SPA loads at `/` and the API at `/api/*`.

Healthcheck: `GET /api/health` should return `200`. Railway uses this path for
deploy health checks (see `railway.json`).

---

## Option B — Netlify (static frontend only)

Use this only if the API is hosted elsewhere.

1. Connect the repo to Netlify. `netlify.toml` sets the build (`npm run build`)
   and publish directory (`client/dist`).
2. Edit the `/billing-api/*` redirect in `netlify.toml` to point at your
   deployed API host.
3. Set `VITE_API_BASE` if the app must call a different origin.

The app is served under `/billing/` (see `client/vite.config.js`). The redirects
in `netlify.toml` already handle the SPA fallback for that subpath.

---

## Post-deploy checklist

- [ ] `GET /api/health` returns 200
- [ ] `GET /api/mode` returns `{"demo":true}` on a demo deployment
- [ ] The yellow "DEMO MODE" banner is visible at the top of every page
- [ ] Clients list shows synthetic names (John Doe, Jane Smith), **not** real clients
- [ ] A day entry saves and survives a redeploy (proves the volume is working)
- [ ] Settings → AI Configuration accepts a key and shows "API Key Saved"

## Local demo run

```bash
npm run build
DEMO_MODE=true BILLING_DB=data/demo.db node server/index.js
```

The demo database is created and seeded automatically on first boot.
To regenerate it from scratch:

```bash
node server/scripts/seed-demo.js
```

The seeder copies its schema from the live database, so it tracks migrations
automatically. It refuses to run if `DEMO_DB` points at the live file.
