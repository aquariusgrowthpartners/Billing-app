import express from 'express';
import {
  allSettings,
  setSetting,
  validateTemplate,
  TEMPLATE_TOKENS,
} from '../settings.js';
import { identifier } from '../hhaFields.js';
import db from '../db.js';

const router = express.Router();

/** GET /api/settings */
/**
 * Strip the stored API key before it leaves the server.
 *
 * The key is write-only from the client's point of view: `has_ai_key` says
 * whether one is saved, and the value itself is never sent back.
 */
function redactedSettings(agencyId) {
  const all = allSettings(agencyId);
  const key = String(all.ai_api_key ?? '').trim();
  return { ...all, ai_api_key: '', has_ai_key: Boolean(key) };
}

router.get('/', (req, res) => {
  const agency = db.prepare('SELECT logo_url, ai_quick_prompts FROM agencies WHERE id = ?').get(req.agencyId) ?? {};
  res.json({
    settings: { ...redactedSettings(req.agencyId), ...agency },
    template_tokens: TEMPLATE_TOKENS,
  });
});

/** PUT /api/settings  { claim_name_template } */
router.put('/', (req, res) => {
  const body = req.body ?? {};
  const updates = {};

  if ('claim_name_template' in body) {
    const check = validateTemplate(body.claim_name_template);
    if (!check.ok) return res.status(400).json({ error: check.error });
    updates.claim_name_template = check.value;
  }

  // Agency identity for the HHAeXchange exports. Stored exactly as typed —
  // letters, digits and dashes are all valid.
  if ('agency_tax_id' in body) {
    const check = identifier(body.agency_tax_id, { max: 12, label: 'Agency Tax ID' });
    if (check.error) return res.status(400).json({ error: check.error });
    updates.agency_tax_id = check.ok;
  }
  if ('office_npi' in body) {
    const check = identifier(body.office_npi, { max: 20, label: 'Office NPI' });
    if (check.error) return res.status(400).json({ error: check.error });
    updates.office_npi = check.ok;
  }

  // Agency identity for the MPSMISC reporting spreadsheet's header block.
  const AGENCY_KEYS = [
    'agency_name',
    'agency_street_address',
    'agency_city',
    'agency_state',
    'agency_zip',
  ];
  for (const key of AGENCY_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key] == null ? '' : String(body[key]).trim();
    if (key === 'agency_state' && raw && !/^[A-Za-z]{2}$/.test(raw)) {
      return res.status(400).json({ error: 'Agency state must be a 2-letter code' });
    }
    if (key === 'agency_zip' && raw && !/^\d{5}$/.test(raw)) {
      return res.status(400).json({ error: 'Agency ZIP must be 5 digits' });
    }
    // Uppercased for the state; the rest is stored exactly as typed.
    updates[key] = key === 'agency_state' ? raw.toUpperCase() : raw;
  }

  /* ------------------------------------------------------------ AI config */
  if ('ai_provider' in body) {
    const provider = String(body.ai_provider ?? 'none').trim().toLowerCase();
    if (!['none', 'deepseek', 'openai'].includes(provider)) {
      return res.status(400).json({ error: 'ai_provider must be none, deepseek or openai' });
    }
    updates.ai_provider = provider;
  }
  if ('ai_api_key' in body) {
    const key = String(body.ai_api_key ?? '').trim();
    // An empty string means "leave the saved key alone" — the UI never sends
    // the real value back, so a blank field must not wipe it.
    if (key) updates.ai_api_key = key;
  }

  /* ------------------------------------------------------- appearance */
  if ('theme_mode' in body) {
    const mode = String(body.theme_mode ?? '').trim().toLowerCase();
    if (!['light', 'dark', 'system'].includes(mode)) {
      return res.status(400).json({ error: 'theme_mode must be light, dark or system' });
    }
    updates.theme_mode = mode;
  }
  if ('theme_color' in body) {
    const color = String(body.theme_color ?? '').trim().toLowerCase();
    const named = ['blue', 'emerald', 'violet', 'rose', 'amber', 'slate'];
    const isHex = /^#[0-9a-f]{6}$/.test(color);
    if (!isHex && !named.includes(color)) {
      return res.status(400).json({ error: 'theme_color must be a hex colour or a known preset' });
    }
    updates.theme_color = color;
  }

  let logoUrl;
  let aiQuickPrompts;
  if ('logo_url' in body) {
    logoUrl = String(body.logo_url ?? '').trim() || null;
    if (logoUrl && !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(logoUrl)) {
      return res.status(400).json({ error: 'Logo must be a PNG, JPEG or WebP data URL.' });
    }
    if (logoUrl && logoUrl.length > 2_500_000) {
      return res.status(400).json({ error: 'Logo is too large (max 2.5 MB).' });
    }
  }
  if ('ai_quick_prompts' in body) {
    const raw = body.ai_quick_prompts;
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n').map((v) => v.trim()).filter(Boolean);
    aiQuickPrompts = JSON.stringify(list);
  }

  if (!Object.keys(updates).length && logoUrl === undefined && aiQuickPrompts === undefined) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }
  for (const [key, value] of Object.entries(updates)) setSetting(key, value, req.agencyId);
  if (logoUrl !== undefined) {
    db.prepare('UPDATE agencies SET logo_url = ? WHERE id = ?').run(logoUrl, req.agencyId);
  }
  if (aiQuickPrompts !== undefined) {
    db.prepare('UPDATE agencies SET ai_quick_prompts = ? WHERE id = ?').run(aiQuickPrompts, req.agencyId);
  }

  const agency = db.prepare('SELECT logo_url, ai_quick_prompts FROM agencies WHERE id = ?').get(req.agencyId) ?? {};
  res.json({
    settings: { ...redactedSettings(req.agencyId), ...agency },
    template_tokens: TEMPLATE_TOKENS,
  });
});

export default router;
