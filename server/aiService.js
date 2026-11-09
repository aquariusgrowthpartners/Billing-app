/**
 * Document summarisation.
 *
 * The provider and key live in the `settings` key/value table so they can be
 * changed from the UI without touching the environment. Every failure path
 * returns a human-readable string rather than throwing: a summary is a nicety,
 * and it must never prevent a document from being uploaded or a task created.
 */
import db from './db.js';

const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
  },
};

export const NO_KEY = 'AI Summary unavailable (no API key configured in settings).';
export const AI_DISABLED_MESSAGE =
  'AI features are currently disabled for your account. Please contact support to upgrade your plan.';
export const GIBBERISH = 'Text extraction failed (scanned or corrupted PDF). Please view the file directly.';

const PROMPT =
  'Summarize the following document in exactly two sentences. Focus on action items and dates:';

const AI_SETTING_KEYS = [
  'ai_enabled',
  'ai_provider',
  'ai_api_key',
  'azure_endpoint',
  'azure_deployment',
];

function aiSettings(agencyId) {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings
        WHERE agency_id = ? AND key IN (${AI_SETTING_KEYS.map(() => '?').join(',')})`
    )
    .all(agencyId, ...AI_SETTING_KEYS);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function normalizeProvider(value) {
  const p = String(value ?? '').trim().toLowerCase();
  if (p === 'azure-openai' || p === 'azure_openai') return 'azure';
  return ['deepseek', 'openai', 'azure'].includes(p) ? p : 'none';
}

/**
 * Read the current AI configuration.
 *
 * The tenant's own ai_enabled flag is authoritative. If a tenant has no key
 * (or provider) of its own, a non-super tenant may use Agency 1's key. This
 * keeps the demo/tenant AI working without duplicating secrets into every
 * settings row.
 */
export function aiConfig(agencyId = 1) {
  const own = aiSettings(agencyId);
  if (String(own.ai_enabled ?? '1') === '0') {
    return {
      provider: 'none',
      key: '',
      azureEndpoint: '',
      azureDeployment: '',
      enabled: false,
      disabled: true,
    };
  }

  let provider = normalizeProvider(own.ai_provider);
  let key = String(own.ai_api_key ?? '').trim();
  let azureEndpoint = String(own.azure_endpoint ?? '').trim();
  let azureDeployment = String(own.azure_deployment ?? '').trim();

  if (agencyId !== 1) {
    const superSettings = aiSettings(1);
    if (provider === 'none') provider = normalizeProvider(superSettings.ai_provider);
    if (!key) key = String(superSettings.ai_api_key ?? '').trim();
    if (!azureEndpoint) azureEndpoint = String(superSettings.azure_endpoint ?? '').trim();
    if (!azureDeployment) azureDeployment = String(superSettings.azure_deployment ?? '').trim();
  }

  const azureReady = provider !== 'azure' || Boolean(azureEndpoint && azureDeployment);
  return {
    provider,
    key,
    azureEndpoint,
    azureDeployment,
    enabled: provider !== 'none' && Boolean(key) && azureReady,
    disabled: false,
  };
}

function providerConfig(provider, azureEndpoint, azureDeployment) {
  if (provider === 'azure') {
    if (!azureEndpoint || !azureDeployment) return null;
    const base = azureEndpoint.replace(/\/+$/, '');
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(
        azureDeployment
      )}/chat/completions?api-version=2024-02-15-preview`,
      model: azureDeployment,
      azure: true,
    };
  }
  return PROVIDERS[provider] ?? null;
}

function requestHeaders(cfg, key) {
  return cfg.azure
    ? { 'Content-Type': 'application/json', 'api-key': key }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

/**
 * Heuristic for text that is not really text.
 *
 * Scanned and corrupted PDFs yield runs of ligature noise like
 * "lllffiHEffiffiHf;Hflllll" — few vowels relative to consonants, and a high
 * share of symbols. Cheap and conservative: real documents almost never trip it.
 */
export function isGibberish(text) {
  /*
   * Drop page furniture first. A one-word PDF still yields "-- 1 of 1 --",
   * which adds enough letters and digits to nudge the ratios just above the
   * thresholds and let ligature soup through.
   */
  const raw = String(text ?? '')
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const compact = raw.replace(/\s+/g, '');
  if (compact.length < 24) return true;

  const letters = (compact.match(/[A-Za-z]/g) || []).length;
  const digits = (compact.match(/[0-9]/g) || []).length;
  const wordish = letters + digits;
  // mostly punctuation / box-drawing / replacement chars
  if (wordish / compact.length < 0.55) return true;

  // real prose runs ~38-42% vowels; ligature soup sits near 5%
  const vowels = (compact.match(/[aeiouAEIOU]/g) || []).length;
  if (letters >= 20 && vowels / letters < 0.25) return true;

  // a "word" here is 2+ letters; require a reasonable number of them
  const words = raw.match(/[A-Za-z]{2,}/g) || [];
  if (words.length < 3) return true;

  return false;
}

/** First two sentences, used only when no provider is configured. */
export function firstTwoSentences(text, maxChars = 320) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;

  const SHIELD = '\u0000';
  const shielded = clean.replace(/(\d)\.(\d)/g, `$1${SHIELD}$2`);
  const parts = shielded.match(/[^.!?]+[.!?]+/g);
  let out;
  if (parts && parts.length) {
    out = parts.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  } else {
    out = shielded.length > maxChars ? `${shielded.slice(0, maxChars).trim()}…` : shielded;
  }
  return out.replace(new RegExp(SHIELD, 'g'), '.').slice(0, maxChars);
}

/**
 * Free-form completion against the configured provider.
 * Returns { text, source }. Never throws — provider problems come back as text.
 */
export async function complete(userPrompt, { system, timeoutMs = 20000, agencyId = 1 } = {}) {
  const config = aiConfig(agencyId);
  if (config.disabled) return { text: AI_DISABLED_MESSAGE, source: 'disabled' };
  if (!config.enabled) return { text: NO_KEY, source: 'none' };

  const cfg = providerConfig(config.provider, config.azureEndpoint, config.azureDeployment);
  if (!cfg) return { text: NO_KEY, source: 'none' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content:
              system ??
              'You are a home-care billing expert for the state of Minnesota.',
          },
          { role: 'user', content: String(userPrompt).slice(0, 14000) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${config.provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    return { text, source: config.provider };
  } catch (err) {
    console.warn(`[ai] ${config.provider} completion failed: ${err.message}`);
    return { text: `AI Summary unavailable (${config.provider} request failed).`, source: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarise extracted document text.
 * Returns { summary, source } — source is 'deepseek' | 'openai' | 'none' | 'gibberish'.
 */
export async function summarise(text, { timeoutMs = 15000, agencyId = 1 } = {}) {
  const config = aiConfig(agencyId);
  if (config.disabled) return { summary: AI_DISABLED_MESSAGE, source: 'disabled' };
  if (!text || !String(text).trim()) return { summary: GIBBERISH, source: 'gibberish' };
  if (isGibberish(text)) return { summary: GIBBERISH, source: 'gibberish' };
  if (!config.enabled) return { summary: NO_KEY, source: 'none' };

  const cfg = providerConfig(config.provider, config.azureEndpoint, config.azureDeployment);
  if (!cfg) {
    console.warn(`[ai] unknown provider "${config.provider}"`);
    return { summary: NO_KEY, source: 'none' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'You summarise documents for a home-care billing office.' },
          { role: 'user', content: `${PROMPT}\n\n${String(text).slice(0, 12000)}` },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${config.provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const summary = json?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('empty completion');
    return { summary, source: config.provider };
  } catch (err) {
    console.warn(`[ai] ${config.provider} summary failed: ${err.message}`);
    // Never block the upload on a provider problem.
    return { summary: `AI Summary unavailable (${config.provider} request failed).`, source: 'none' };
  } finally {
    clearTimeout(timer);
  }
}
