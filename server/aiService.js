/**
 * Document summarisation.
 *
 * The provider and key live in the `settings` key/value table so they can be
 * changed from the UI without touching the environment. Every failure path
 * returns a human-readable string rather than throwing: a summary is a nicety,
 * and it must never prevent a document from being uploaded or a task created.
 */
import db from './db.js';
import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer';

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

    /*
     * Azure AI Foundry (the newer "OpenAI v1" surface) exposes the Responses
     * API at .../openai/v1/responses. A bare /openai/v1 base gets /responses
     * appended. Older Azure OpenAI resources still use the deployments path.
     */
    if (/\/responses(?:\?|$)/i.test(base)) {
      return { url: base, model: azureDeployment, azure: true, responses: true };
    }
    if (/\/openai\/v1$/i.test(base)) {
      return { url: `${base}/responses`, model: azureDeployment, azure: true, responses: true };
    }
    return {
      url: `${base}/openai/deployments/${encodeURIComponent(
        azureDeployment
      )}/chat/completions?api-version=2024-02-15-preview`,
      model: azureDeployment,
      azure: true,
      responses: false,
    };
  }
  return PROVIDERS[provider] ?? null;
}

/** Extract text from either the Responses API or classic chat-completions JSON. */
function completionText(json, cfg) {
  if (!cfg.responses) return json?.choices?.[0]?.message?.content?.trim() ?? '';
  if (typeof json?.output_text === 'string') return json.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
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
export async function complete(
  userPrompt,
  { system, timeoutMs = 20000, agencyId = 1, maxOutputTokens = 700 } = {}
) {
  const config = aiConfig(agencyId);
  if (config.disabled) return { text: AI_DISABLED_MESSAGE, source: 'disabled' };
  if (!config.enabled) return { text: NO_KEY, source: 'none' };

  const cfg = providerConfig(config.provider, config.azureEndpoint, config.azureDeployment);
  if (!cfg) return { text: NO_KEY, source: 'none' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const systemPrompt =
      system ?? 'You are a home-care billing expert for the state of Minnesota.';
    const prompt = String(userPrompt).slice(0, 14000);
    const payload = cfg.responses
      ? {
          model: cfg.model,
          input: `${systemPrompt}\n\n${prompt}`,
          max_output_tokens: maxOutputTokens,
        }
      : {
          model: cfg.model,
          temperature: 0.3,
          max_tokens: maxOutputTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        };
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${config.provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const text = completionText(json, cfg);
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
    const instruction = 'You summarise documents for a home-care billing office.';
    const sourceText = `${PROMPT}\n\n${String(text).slice(0, 12000)}`;
    const payload = cfg.responses
      ? {
          model: cfg.model,
          input: `${instruction}\n\n${sourceText}`,
          max_output_tokens: 200,
        }
      : {
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 200,
          messages: [
            { role: 'system', content: instruction },
            { role: 'user', content: sourceText },
          ],
        };
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${config.provider} ${res.status}: ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const summary = completionText(json, cfg);
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

/* ------------------------------------------------------------------ vision */

const VISION_SYSTEM_PROMPT =
  'You are an expert medical billing auditor. The attached image is an RA (Remittance Advice) letter. It may be physically rotated sideways or upside down. Read the text regardless of orientation. Extract the Member ID, PATIENT/CLIENT name, Date of Service, and Amount Paid. Do NOT extract the Provider or Agency name from the top of the letter. You are looking for the PATIENT/CLIENT name and MEMBER ID. If the extracted name matches the Agency name, ignore it and look further down the document. Return ONLY a JSON array of extracted records, or [] if none. Do not include markdown formatting.';

export const RA_TEXT_SYSTEM_PROMPT =
  'You are an expert medical billing auditor. The following text was extracted using OCR from an RA letter. It contains a cover page followed by claims tables. IGNORE the cover page. Look for the claims table (usually starting with \'PATIENT\', \'DATES OF SERVICE\', \'AMOUNT\'). Extract every patient claim record.\n' +
  'The columns from left to right are typically: Client, Member ID, Date, Code, Charge, Paid. Extract the CHARGE amount and the PAYMENT amount separately. CHARGE maps to charge_amount; PAYMENT or TOTAL PAYMENT maps to paid_amount. The PAYMENT amount is the actual amount paid by the state; never use CHARGE as the paid amount.\n' +
  'If the OCR text has dates mashed together without spaces (e.g., \'03-20-2603-21-26\'), split them into separate records for each date. If there is a daily breakdown, use each day\'s own amount; never duplicate a single period total across days.\n' +
  'Return ONLY a valid JSON array.';

export const CLAIM_DISCREPANCY_INSTRUCTIONS =
  'You are a medical billing assistant. When asked about a claim discrepancy for a specific client, you must look at the claims table. Explain discrepancies clearly by distinguishing between the \'Billed Amount\' (charge_amount) and the \'Paid Amount\' (paid_amount). For example, if the agency billed $1,234 but the state only paid $123, state exactly that. If you need to calculate the difference, show the math (e.g., \'The state short-paid this claim by $1,111\'). Never substitute one amount for the other.';

function parseVisionJson(text) {
  const cleaned = String(text ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
  } catch {
    // Some models wrap the array in prose; try the bracketed slice.
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/**
 * Read a rotated/scanned RA image with Azure's vision-capable Responses model.
 *
 * Returns { records: [...] } on success or { error: "..." } on failure. The
 * existing complete()/summarise() text functions are deliberately untouched.
 */
export async function verifyRaDocument(
  imageBase64,
  mimeType,
  agencyId = 1,
  timeoutMs = 60000,
  instruction = null
) {
  const config = aiConfig(agencyId);
  if (config.disabled) return { error: AI_DISABLED_MESSAGE };
  if (!config.enabled) return { error: NO_KEY };
  if (config.provider !== 'azure') {
    return { error: 'Azure Vision is not configured for this account.' };
  }

  const cfg = providerConfig(config.provider, config.azureEndpoint, config.azureDeployment);
  if (!cfg) return { error: 'Azure Vision endpoint or deployment is missing.' };

  const imageUrl = `data:${mimeType || 'image/png'};base64,${imageBase64}`;
  const isPdf = /application\/pdf/i.test(String(mimeType ?? ''));
  const extractInstruction =
    instruction ||
    'Extract every RA record you can read. Use these keys: member_id, client_name, date_of_service, amount_paid. Return only the JSON array.';
  const payload = cfg.responses
    ? {
        model: cfg.model,
        input: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: extractInstruction },
              isPdf
                ? {
                    type: 'input_file',
                    filename: 'ra-letter.pdf',
                    file_data: imageUrl,
                  }
                : { type: 'input_image', image_url: imageUrl, detail: 'high' },
            ],
          },
        ],
        max_output_tokens: 2000,
      }
    : {
        model: cfg.model,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: extractInstruction },
              isPdf
                ? {
                    type: 'file',
                    file: { filename: 'ra-letter.pdf', file_data: imageUrl },
                  }
                : { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
            ],
          },
        ],
      };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify(payload),
    });

    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      if (/quota|provision|initializ/i.test(body)) {
        return { error: 'Azure quota provisioning in progress' };
      }
      console.warn(`[ai] Azure Vision 403: ${body.slice(0, 200)}`);
      return { error: 'Azure Vision is unavailable for this account.' };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ai] Azure Vision ${res.status}: ${body.slice(0, 200)}`);
      return { error: `Azure Vision request failed (${res.status}).` };
    }

    const json = await res.json();
    const text = completionText(json, cfg);
    const records = parseVisionJson(text);
    if (!records) {
      console.warn('[ai] Azure Vision returned non-JSON output');
      return { error: 'Azure Vision returned an unreadable response.' };
    }
    return { records };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'Azure Vision timed out.' : err.message;
    console.warn(`[ai] Azure Vision failed: ${message}`);
    return { error: 'Azure Vision request failed.' };
  } finally {
    clearTimeout(timer);
  }
}


/* ------------------------------------------------------ native PDF vision */

const VISION_PDF_SYSTEM_PROMPT =
  'You are an expert medical billing auditor. This is an upright RA letter. Read the claims table. Extract Patient Name, Member ID, Date, CHARGE, and PAYMENT amounts separately. The PAYMENT amount is the actual amount paid by the state; never use CHARGE as the paid amount. Do not do any math. Return ONLY a JSON array.';

/**
 * Send the original PDF to Azure OpenAI's native file input. This avoids
 * per-page OCR limits and keeps all pages available to the model.
 */
export async function extractRaWithAzureVision(
  imageOrPdfBase64,
  agencyId = 1,
  mimeType = 'application/pdf'
) {
  const config = aiConfig(agencyId);
  if (config.disabled) return { error: AI_DISABLED_MESSAGE };
  if (!config.enabled) return { error: NO_KEY };
  if (config.provider !== 'azure') {
    return { error: 'Azure Vision is not configured for this account.' };
  }

  const cfg = providerConfig(config.provider, config.azureEndpoint, config.azureDeployment);
  if (!cfg) return { error: 'Azure Vision endpoint or deployment is missing.' };

  const base64 = String(imageOrPdfBase64 ?? '').replace(/^data:[^;]+;base64,/, '');
  if (!base64) return { error: 'The file is empty.' };
  if (base64.length > 28 * 1024 * 1024) {
    return { error: 'The file is too large for Vision processing (max 20 MB).' };
  }

  const isPdf = /application\/pdf/i.test(String(mimeType));
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const payload = cfg.responses
    ? {
        model: cfg.model,
        input: [
          { role: 'system', content: VISION_PDF_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: isPdf
                  ? 'Read all pages of this RA PDF and extract every patient claim record.'
                  : 'Read this RA page image and extract every patient claim record.',
              },
              isPdf
                ? {
                    type: 'input_file',
                    filename: 'document.pdf',
                    file_data: dataUrl,
                  }
                : {
                    type: 'input_image',
                    image_url: dataUrl,
                    detail: 'high',
                  },
            ],
          },
        ],
        max_output_tokens: 4000,
      }
    : {
        model: cfg.model,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: VISION_PDF_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: isPdf
                  ? 'Read all pages of this RA PDF and extract every patient claim record.'
                  : 'Read this RA page image and extract every patient claim record.',
              },
              isPdf
                ? {
                    type: 'file',
                    file: { filename: 'document.pdf', file_data: dataUrl },
                  }
                : {
                    type: 'image_url',
                    image_url: { url: dataUrl, detail: 'high' },
                  },
            ],
          },
        ],
      };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: requestHeaders(cfg, config.key),
      body: JSON.stringify(payload),
    });

    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      if (/quota|provision|initializ/i.test(body)) {
        return { error: 'Azure Vision quota provisioning in progress.' };
      }
      console.warn(`[ai] Azure native PDF Vision 403: ${body.slice(0, 200)}`);
      return { error: 'Azure Vision is unavailable for this account.' };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ai] Azure native PDF Vision ${res.status}: ${body.slice(0, 200)}`);
      if (res.status === 413) {
        return { error: 'The PDF is too large for native Vision processing.' };
      }
      return { error: `Azure Vision request failed (${res.status}).` };
    }

    const json = await res.json();
    const text = completionText(json, cfg);
    console.log(`[VISION-RAW] ${text}`);
    let records;
    try {
      const cleaned = String(text ?? '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      records = JSON.parse(cleaned);
      if (!Array.isArray(records)) throw new Error('Vision response is not an array.');
    } catch {
      console.warn('[ai] Azure native PDF Vision returned invalid JSON');
      return {
        error:
          'The AI failed to return valid JSON. It may have been confused by the document layout.',
      };
    }
    return { records };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'Azure Vision timed out.' : err.message;
    console.warn(`[ai] Azure native PDF Vision failed: ${message}`);
    return { error: 'Azure Vision request failed.' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------ document intelligence */

/**
 * Turn prebuilt-layout table cells into readable rows. The page `content`
 * often contains only a header on table-heavy RA letters, so the table cells
 * are the authoritative source for member names, IDs, and amounts.
 */
function formatDocIntelTables(tables) {
  const blocks = [];
  tables.forEach((table, tableIndex) => {
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    if (!cells.length) return;

    const rows = new Map();
    for (const cell of cells) {
      const rowIndex = Number(cell?.rowIndex) || 0;
      const columnIndex = Number(cell?.columnIndex) || 0;
      if (!rows.has(rowIndex)) rows.set(rowIndex, new Map());
      rows.get(rowIndex).set(columnIndex, String(cell?.content ?? '').trim());
    }

    const lines = [];
    for (const rowIndex of [...rows.keys()].sort((a, b) => a - b)) {
      const columns = rows.get(rowIndex);
      const maxColumn = Math.max(...columns.keys());
      const values = Array.from({ length: maxColumn + 1 }, (_, i) => columns.get(i) ?? '');
      if (values.some(Boolean)) lines.push(values.join(' | '));
    }

    if (lines.length) blocks.push(`TABLE ${tableIndex + 1}\n${lines.join('\n')}`);
  });
  return blocks.join('\n\n');
}

/**
 * Read an RA PDF/image with Azure Document Intelligence (prebuilt-layout).
 * Raw bytes go straight to Azure; no local rendering or OCR dependencies.
 */
export async function extractRaWithAzureDocIntel(fileBuffer, mimeType) {
  const endpoint = String(process.env.AZURE_DOC_INTEL_ENDPOINT ?? '').trim();
  const key = String(process.env.AZURE_DOC_INTEL_KEY ?? '').trim();

  if (!endpoint || !key) {
    const err = new Error(
      'Azure Document Intelligence is not configured. Add AZURE_DOC_INTEL_ENDPOINT and AZURE_DOC_INTEL_KEY.'
    );
    err.status = 503;
    err.code = 'DOC_INTEL_NOT_CONFIGURED';
    throw err;
  }

  const client = new DocumentAnalysisClient(
    endpoint,
    new AzureKeyCredential(key),
    endpoint.startsWith('http://') ? { allowInsecureConnection: true } : undefined
  );
  try {
    const poller = await client.beginAnalyzeDocument(
      'prebuilt-layout',
      new Uint8Array(fileBuffer),
      { pages: '1-' }
    );
    const result = await poller.pollUntilDone();
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    const tables = Array.isArray(result?.tables) ? result.tables : [];
    console.log(`[DOC-INTEL] Pages requested: all (1-); result pages: ${pages.length}`);
    console.log(`[DOC-INTEL] Total pages processed: ${pages.length}`);
    pages.forEach((page, index) => {
      const pageText = (Array.isArray(page?.lines) ? page.lines : [])
        .map((line) => String(line?.content ?? '').trim())
        .filter(Boolean)
        .join(' ');
      console.log(
        `[DOC-INTEL] Page ${page?.pageNumber ?? index + 1} text (first 300 chars): ${pageText.substring(0, 300)}`
      );
    });
    console.log(`[DOC-INTEL] Total tables detected: ${tables.length}`);
    tables.forEach((table, index) => {
      console.log(
        `[DOC-INTEL] Table ${index + 1}: ${table?.rowCount ?? 0} rows, ${
          table?.columnCount ?? 0
        } columns`
      );
    });

    const tableText = formatDocIntelTables(tables);
    const pageLines = pages
      .map((page) =>
        (Array.isArray(page?.lines) ? page.lines : [])
          .map((line) => String(line?.content ?? '').trim())
          .filter(Boolean)
          .join('\n')
      )
      .filter(Boolean)
      .join('\n\n');
    const pageText = pageLines || String(result?.content ?? '').trim();
    const text = [tableText, pageText].filter(Boolean).join('\n\n');
    console.log(`[DOC-INTEL] Extracted text length: ${text.length} characters`);
    console.log(`[DOC-INTEL] Sample: ${text.slice(0, 1000)}`);
    return {
      text,
      tables,
    };
  } catch (err) {
    const message = err?.message || String(err);
    if (err?.statusCode === 403 || /quota|forbidden|unauthorized/i.test(message)) {
      const e = new Error(`Azure Document Intelligence quota exceeded or access denied: ${message}`);
      e.status = 503;
      e.code = 'DOC_INTEL_QUOTA';
      throw e;
    }
    const e = new Error(`Azure Document Intelligence failed to read this file: ${message}`);
    e.status = 502;
    e.code = 'DOC_INTEL_FAILED';
    throw e;
  }
}
