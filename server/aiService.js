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
export const GIBBERISH = 'Text extraction failed (scanned or corrupted PDF). Please view the file directly.';

const PROMPT =
  'Summarize the following document in exactly two sentences. Focus on action items and dates:';

/** Read the current AI configuration from the settings table. */
export function aiConfig() {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key IN ('ai_provider','ai_api_key')")
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const provider = String(map.ai_provider ?? 'none').toLowerCase();
  const key = String(map.ai_api_key ?? '').trim();
  return { provider, key, enabled: provider !== 'none' && Boolean(key) };
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
export async function complete(userPrompt, { system, timeoutMs = 20000 } = {}) {
  const { provider, key, enabled } = aiConfig();
  if (!enabled) return { text: NO_KEY, source: 'none' };

  const cfg = PROVIDERS[provider];
  if (!cfg) return { text: NO_KEY, source: 'none' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
      throw new Error(`${provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty completion');
    return { text, source: provider };
  } catch (err) {
    console.warn(`[ai] ${provider} completion failed: ${err.message}`);
    return { text: `AI Summary unavailable (${provider} request failed).`, source: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarise extracted document text.
 * Returns { summary, source } — source is 'deepseek' | 'openai' | 'none' | 'gibberish'.
 */
export async function summarise(text, { timeoutMs = 15000 } = {}) {
  if (!text || !String(text).trim()) return { summary: GIBBERISH, source: 'gibberish' };
  if (isGibberish(text)) return { summary: GIBBERISH, source: 'gibberish' };

  const { provider, key, enabled } = aiConfig();
  if (!enabled) return { summary: NO_KEY, source: 'none' };

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    console.warn(`[ai] unknown provider "${provider}"`);
    return { summary: NO_KEY, source: 'none' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
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
      throw new Error(`${provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const summary = json?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('empty completion');
    return { summary, source: provider };
  } catch (err) {
    console.warn(`[ai] ${provider} summary failed: ${err.message}`);
    // Never block the upload on a provider problem.
    return { summary: `AI Summary unavailable (${provider} request failed).`, source: 'none' };
  } finally {
    clearTimeout(timer);
  }
}
