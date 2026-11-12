import process from 'node:process';

const BASE = process.env.BASE_URL || 'https://dundas-billing-production.up.railway.app';
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9222);
const REAL_EMAIL = process.env.REAL_EMAIL || 'james@aquariusgp.com';
const REAL_PASSWORD = process.env.REAL_PASSWORD || 'NewTestPass456!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return res.json();
}

async function newPage() {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };
  return { send, evalJs, close: () => ws.close() };
}

const results = {};

async function main() {
  // 1) Fresh signup -> BAA gate must appear.
  const email = `e2e-${Date.now()}@example.com`;
  const signup = await post('/api/auth/signup', { email, password: 'Str0ngPassw0rd!', agency_name: 'E2E Test Agency' });
  if (!signup.token || signup.user?.baa_signed_at) throw new Error('signup did not return an unsigned user');
  results.baa_signed_at = signup.user.baa_signed_at;

  const page = await newPage();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('billing_token', ${JSON.stringify(signup.token)});` });
  await page.send('Page.navigate', { url: `${BASE}/` });
  await sleep(4500);
  results.baa_gate = await page.evalJs(`!!document.querySelector('#baa-gate')`);
  results.baa_submit_disabled = await page.evalJs(`document.querySelector('#baa-gate button[type=submit]')?.disabled`);
  await page.evalJs(`document.querySelector('#baa-gate input[type=checkbox]')?.click()`);
  await page.evalJs(`(()=>{const i=document.querySelector('#baa-gate input[placeholder="Full legal name"]');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'E2E Tester');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(300);
  await page.evalJs(`document.querySelector('#baa-gate button[type=submit]')?.click()`);
  await sleep(2500);
  results.baa_gate_cleared = await page.evalJs(`!document.querySelector('#baa-gate')`);
  page.close();

  // 2) Session timeout warning (seam overridden to 6s idle / 3s warning).
  const page2 = await newPage();
  await page2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page2.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('billing_token', ${JSON.stringify(signup.token)}); window.__SESSION_TIMEOUT_MS__=6000; window.__SESSION_WARN_MS__=3000;` });
  await page2.send('Page.navigate', { url: `${BASE}/` });
  await sleep(7500);
  results.session_warning = await page2.evalJs(`!![...document.querySelectorAll('.modal')].find(m=>/Session expiring/i.test(m.innerText))`);
  page2.close();

  // 3) Audit log records client profile view for a real tenant.
  const login = await post('/api/auth/login', { email: REAL_EMAIL, password: REAL_PASSWORD });
  const realToken = login.token;
  if (!realToken) throw new Error(`real login failed: ${JSON.stringify(login)}`);
  if (!login.user?.baa_signed_at) {
    await post('/api/security/baa', { accepted: true, name: 'E2E Real User' }, realToken);
  }
  const clients = await get('/api/clients?limit=1', realToken);
  const clientId = (clients.clients ?? [])[0]?.id;
  if (clientId) {
    const page3 = await newPage();
    await page3.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('billing_token', ${JSON.stringify(realToken)});` });
    await page3.send('Page.navigate', { url: `${BASE}/clients/${clientId}` });
    await sleep(4000);
    page3.close();
    const audit = await get('/api/security/audit?page=1&limit=50&action=client_viewed', realToken);
    results.client_view_audited = (audit.logs ?? []).some((row) => row.action === 'client_viewed' && String(row.resource_id) === String(clientId));
    results.audit_total = audit.total;
  }

  // 4) 2FA setup renders manual key + verify.
  const page4 = await newPage();
  await page4.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page4.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('billing_token', ${JSON.stringify(realToken)});` });
  await page4.send('Page.navigate', { url: `${BASE}/settings` });
  await sleep(5000);
  await page4.evalJs(`document.querySelector('#enable-2fa')?.click()`);
  await sleep(1500);
  results.twofa_secret = await page4.evalJs(`document.querySelector('#security-2fa .mono.small')?.innerText?.trim() || ''`);
  results.twofa_verify = await page4.evalJs(`!!document.querySelector('#verify-2fa')`);
  results.twofa_overflow = await page4.evalJs(`document.documentElement.scrollWidth > innerWidth`);
  page4.close();

  const pass = results.baa_gate && results.baa_gate_cleared && results.session_warning && results.client_view_audited && results.twofa_verify;
  console.log('[SECURITY-TEST] results', JSON.stringify(results, null, 2));
  console.log(`[SECURITY-TEST] ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('[SECURITY-TEST] fatal', e.message); process.exit(2); });
