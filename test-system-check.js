/**
 * Full-system crawl: logs into the demo account and visits every route,
 * capturing console errors/warnings, uncaught exceptions, and 4xx/5xx
 * network requests. Exits non-zero if any hard error is found.
 *
 * Uses the Chrome DevTools Protocol over the existing remote debugger
 * (no external dependencies). Requires a Chrome debugger on DEBUG_PORT.
 */
import process from 'node:process';

const BASE = process.env.BASE_URL || 'https://dundas-billing-production.up.railway.app';
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9222);
const WAIT_MS = Number(process.env.CRAWL_WAIT_MS || 2200);

const ROUTES = [
  { label: 'Home', path: '/' },
  { label: 'Clients', path: '/clients' },
  { label: 'Client Profile', path: '/clients/{id}' },
  { label: 'Claims Dashboard', path: '/claims' },
  { label: 'Billing', path: '/billing' },
  { label: 'Caretakers', path: '/caretakers' },
  { label: 'Uploads (RA)', path: '/uploads?tab=ra' },
  { label: 'Uploads (Claim)', path: '/uploads?tab=claims' },
  { label: 'Uploads (SA)', path: '/uploads?tab=sa' },
  { label: 'Pending Claims', path: '/pending-claims' },
  { label: 'Reports', path: '/reports' },
  { label: 'Spreadsheet', path: '/spreadsheet' },
  { label: 'Denials', path: '/denials' },
  { label: 'Tasks', path: '/tasks' },
  { label: 'Ask Dundas', path: '/ask' },
  { label: 'Settings', path: '/settings' },
];

async function httpLogin() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demo: true }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`Demo login failed: ${JSON.stringify(data)}`);
  return data;
}

async function firstClientId(token) {
  const res = await fetch(`${BASE}/api/clients?limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const client = (data.clients ?? [])[0];
  return client ? client.id : null;
}

function connectCDP() {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
      .then((r) => r.json())
      .then((target) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        let nextId = 0;
        const pending = new Map();
        const listeners = [];
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const { resolve: res, reject: rej } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message));
            else res(msg.result);
          }
          for (const fn of listeners) fn(msg);
        };
        ws.onerror = (e) => reject(new Error('WebSocket error'));
        ws.onopen = () => {
          const send = (method, params = {}) =>
            new Promise((resolve, reject) => {
              const id = ++nextId;
              pending.set(id, { resolve, reject });
              ws.send(JSON.stringify({ id, method, params }));
            });
          resolve({ ws, send, on: (fn) => listeners.push(fn), close: () => ws.close() });
        };
      })
      .catch(reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { token } = await httpLogin();
  const clientId = await firstClientId(token);
  console.log(`[SYSTEM-CHECK] demo token ok; first client id = ${clientId ?? 'none'}`);

  const cdp = await connectCDP();
  const issues = [];
  let pageErrors = 0;
  let pageWarnings = 0;
  let networkBad = 0;

  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type;
      if (type === 'error' || type === 'assert') {
        pageErrors += 1;
        issues.push(`console.${type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (type === 'warning') {
        pageWarnings += 1;
        issues.push(`console.warning: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors += 1;
      const d = msg.params.exceptionDetails;
      issues.push(`exception: ${d?.exception?.description || d?.text || 'unknown'}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      pageErrors += 1;
      issues.push(`log.error: ${msg.params.entry.text}`);
    } else if (msg.method === 'Network.responseReceived') {
      const status = msg.params.response.status;
      if (status >= 400) {
        networkBad += 1;
        issues.push(`HTTP ${status}: ${msg.params.response.url}`);
      }
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const demoInitScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('billing_token', ${JSON.stringify(token)}); sessionStorage.setItem('demoTourCompleted', 'true');`,
  });

  const skipOnly = process.env.SKIP_ONLY === '1';
  if (!skipOnly) {
    for (const route of ROUTES) {
      const path = route.path.replace('{id}', String(clientId ?? ''));
      await cdp.send('Page.navigate', { url: `${BASE}${path}` });
      await sleep(WAIT_MS);
      console.log(`[SYSTEM-CHECK] visited ${route.label} (${path})`);
    }
  }

  // Real-user tutorial Skip flow: click Skip, assert Home actually renders.
  if (process.env.REAL_TOKEN) {
    // Stop the demo-token init script from overwriting the real token.
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: demoInitScript.identifier,
    });
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(1200);
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('billing_token', ${JSON.stringify(process.env.REAL_TOKEN)});`,
    });
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(WAIT_MS);
    const clicked = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const btn = [...document.querySelectorAll('.tour-welcome button')].find((b) => /skip/i.test(b.innerText));
        if (!btn) return false;
        btn.click();
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(2500);
    const after = await cdp.send('Runtime.evaluate', {
      expression: `({
        path: location.pathname,
        welcome: !!document.querySelector('.tour-welcome'),
        home: !!document.querySelector('#ytd-paid-claims'),
        text: document.body.innerText.slice(0, 80),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      })`,
      returnByValue: true,
    });
    const result = after.result?.value ?? {};
    console.log(`[SKIP-FLOW] clicked Skip: ${clicked.result?.value}`);
    console.log(`[SKIP-FLOW] path=${result.path} home=${result.home} welcome=${result.welcome} overflow=${result.overflow}`);
    if (!clicked.result?.value || !result.home || result.welcome) {
      issues.push('SKIP-FLOW: Home did not render after clicking Skip Tutorial.');
    }
  }

  cdp.close();

  console.log('\n=== SYSTEM CHECK SUMMARY ===');
  console.log(`routes visited : ${ROUTES.length}`);
  console.log(`console errors : ${pageErrors}`);
  console.log(`console warnings: ${pageWarnings}`);
  console.log(`network 4xx/5xx: ${networkBad}`);
  if (issues.length) {
    console.log('\n--- issues ---');
    for (const line of issues) console.log('  ' + line);
  } else {
    console.log('No console errors, warnings, or 4xx/5xx requests captured.');
  }

  if (pageErrors > 0 || networkBad > 0) {
    console.log('\nSYSTEM_CHECK_RESULT: FAIL');
    process.exit(1);
  }
  console.log('\nSYSTEM_CHECK_RESULT: PASS');
}

main().catch((err) => {
  console.error('[SYSTEM-CHECK] fatal:', err.message);
  process.exit(2);
});
