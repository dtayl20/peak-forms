// Server-side validation for form configs and submissions.
// Nothing from a submission ever reaches the DB unvalidated.
import { CONDITION_OPERATORS } from './conditional.js';

export const FIELD_TYPES = [
  'text', 'email', 'phone', 'textarea', 'number', 'select',
  'radio', 'checkbox', 'date', 'file', 'hidden',
];

const NAME_RE = /^[a-z][a-z0-9_]{0,49}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^f[0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_TEXT = 5000;
const MAX_SHORT = 300;
const CONDITION_OP_SET = new Set(CONDITION_OPERATORS);
const FILE_ACCEPT = new Set(['images', 'pdf', 'documents', 'spreadsheets', 'all']);
const SCORING_DISPLAY = new Set(['gauge', 'traffic', 'none']);
const BAND_PALETTE = ['#dc2626', '#f59e0b', '#16a34a', '#0ea5e9', '#7c3aed', '#64748b'];

function boundedInt(v, lo, hi, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Redirects may be absolute https URLs or root-relative paths on the same site.
function safeRedirect(v) {
  const s = str(v, '').trim().slice(0, 1000);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return /^https:\/\//i.test(s) ? s : '';
}

// Result CTAs may be https, root-relative, or a tel: link (no booking URL needed).
function safeCtaUrl(v) {
  const s = str(v, '').trim().slice(0, 1000);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https:\/\//i.test(s)) return s;
  if (/^tel:\+?[0-9()\s-]{3,24}$/i.test(s)) return s.replace(/\s+/g, '');
  return '';
}

// Result videos must be absolute https (YouTube/Vimeo links or a direct file).
function safeVideoUrl(v) {
  const s = str(v, '').trim().slice(0, 1000);
  return /^https:\/\//i.test(s) ? s : '';
}

export function isFieldType(t) {
  return FIELD_TYPES.includes(t);
}

export function validSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

export function validFieldName(n) {
  return typeof n === 'string' && NAME_RE.test(n);
}

function numericOrBlank(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

export function sanitizeConfig(raw, pageCount = 0) {
  // Accept either the fields array directly, or a config object with .fields.
  const fields = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.fields)
      ? raw.fields
      : [];
  const out = [];
  const rawConditions = [];
  const used = new Set();
  let idx = 0;

  for (const f of fields) {
    idx += 1;
    if (!f || typeof f !== 'object') continue;
    const type = isFieldType(f.type) ? f.type : null;
    if (!type) continue;
    const name = validFieldName(f.name) ? f.name : `field_${idx}`;
    if (used.has(name)) continue; // duplicate names silently dropped
    used.add(name);

    // 0-based page index into config.pages. Clamped to the page count so a
    // stray index can never point past the end (or orphan fields).
    const rawPage = Number.isInteger(f.page) && f.page >= 0 ? f.page : 0;
    const page = pageCount > 0 ? Math.min(rawPage, pageCount - 1) : 0;
    let min = type === 'number' ? numericOrBlank(f.min) : '';
    let max = type === 'number' ? numericOrBlank(f.max) : '';
    if (min !== '' && max !== '' && min > max) {
      const swap = min;
      min = max;
      max = swap;
    }
    const accept = type === 'file' && FILE_ACCEPT.has(f.accept) ? f.accept : 'all';
    const maxSizeMb = type === 'file'
      ? Math.min(25, Math.max(1, Number(f.maxSizeMb) || 10))
      : 10;

    const field = {
      id: ID_RE.test(f.id) ? f.id : `f${idx}`,
      type,
      name,
      label: str(f.label, '').slice(0, 200),
      required: !!f.required,
      readonly: type === 'file' ? '' : (f.readonly === 'always' || f.readonly === true
        ? 'always'
        : f.readonly === 'prefill' ? 'prefill' : ''),
      placeholder: type === 'file' ? '' : str(f.placeholder, '').slice(0, 200),
      help: str(f.help, '').slice(0, 500),
      description: str(f.description, '').slice(0, 500),
      options: [],
      defaultValue: type === 'file' ? '' : str(f.defaultValue, '').slice(0, 500),
      prefillParam: type === 'file' ? '' : str(f.prefillParam, '').slice(0, 50),
      hidden: type === 'hidden' ? true : !!f.hidden,
      width: f.width === 'half' ? 'half' : 'full',
      page,
      min,
      max,
      accept,
      maxSizeMb,
      // Per-field email OTP opt-in. Only meaningful on email fields; off by
      // default so every existing form keeps its current behaviour.
      otp: (type === 'email' || type === 'phone') ? !!f.otp : false,
    };

    if (['select', 'radio', 'checkbox'].includes(type)) {
      if (Array.isArray(f.options)) {
        const seen = new Set();
        for (const o of f.options) {
          if (!o || typeof o !== 'object') continue;
          const label = str(o.label, '').slice(0, 200);
          const value = str(o.value, '').slice(0, 200);
          if (!label || !value || seen.has(value)) continue;
          seen.add(value);
          const opt = { label, value };
          // Quiz points. Only choice options carry a score; 0 means neutral.
          opt.score = boundedInt(o.score, -100, 100);
          // Optional knockout: forces this band regardless of the total score.
          const ko = str(o.knockoutBand, '').trim();
          if (ko && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(ko)) opt.knockoutBand = ko;
          // Optional follow-up override: "no_call" means do not ring this lead.
          if (o.followUp === 'no_call') opt.followUp = 'no_call';
          // Optional funding route: "plan" switches the result to the payment-plan path.
          if (o.route === 'plan') opt.route = 'plan';
          // Optional link on radio/checkbox option labels (e.g. a privacy
          // policy inside a consent checkbox). https only; select options
          // cannot render links, so they are not stored there.
          if (type === 'radio' || type === 'checkbox') {
            const linkUrl = str(o.linkUrl, '').trim();
            if (/^https:\/\//i.test(linkUrl)) {
              opt.linkUrl = linkUrl.slice(0, 1000);
              opt.linkText = str(o.linkText, '').trim().slice(0, 200);
            }
          }
          field.options.push(opt);
        }
      }
      if (!field.options.length && type !== 'select') {
        // radio/checkbox need at least one option to be meaningful
      }
    }
    out.push(field);
    rawConditions.push(f.conditional);
  }

  // Conditional rules may reference any field in the form (but not themselves).
  // Sanitised after the loop so the valid-name set is complete.
  const names = new Set(out.map((f) => f.name));
  out.forEach((f, i) => {
    f.conditional = sanitizeConditional(rawConditions[i], names, f.name);
  });

  return out;
}

/**
 * Whitelist a conditional-logic block. `allowedNames` limits which fields a rule
 * may reference; `excludeName` blocks a field from referencing itself. A block
 * with no usable rules is stored disabled, so existing forms are unchanged.
 */
export function sanitizeConditional(raw, allowedNames, excludeName) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const rules = [];

  for (const r of (Array.isArray(c.rules) ? c.rules : []).slice(0, 10)) {
    if (!r || typeof r !== 'object') continue;
    const name = str(r.field, '');
    if (!name || name === excludeName) continue;
    if (allowedNames && !allowedNames.has(name)) continue;
    rules.push({
      field: name,
      operator: CONDITION_OP_SET.has(r.operator) ? r.operator : 'is',
      value: str(r.value, '').slice(0, 200),
    });
  }

  return {
    enabled: !!c.enabled && rules.length > 0,
    action: c.action === 'hide' ? 'hide' : 'show',
    match: c.match === 'any' ? 'any' : 'all',
    rules,
  };
}

export function sanitizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const turnstile = s.turnstile && typeof s.turnstile === 'object' ? s.turnstile : {};
  const webhook = s.submitWebhook && typeof s.submitWebhook === 'object' ? s.submitWebhook : {};
  const webhookUrl = str(webhook.url, '').trim();
  return {
    submitLabel: str(s.submitLabel, 'Submit').slice(0, 100),
    successMessage: str(s.successMessage, 'Thanks! We will be in touch.').slice(0, 500),
    redirectUrl: str(s.redirectUrl, '').slice(0, 500),
    redirectNewTab: !!s.redirectNewTab,
    dataLayerEvent: str(s.dataLayerEvent, '').slice(0, 100),
    // Per-form Meta CAPI switch. Only an explicit false is stored; absence
    // means enabled, so existing forms keep firing Lead events.
    ...(s.metaCapi === false ? { metaCapi: false } : {}),
    // Per-form consent override. Empty = fall back to the global default.
    consentText: str(s.consentText, '').trim().slice(0, 500),
    // Per-form submit webhook override. Empty URL = fall back to the global default.
    submitWebhook: {
      url: /^https:\/\//.test(webhookUrl) ? webhookUrl.slice(0, 1000) : '',
      token: str(webhook.token, '').slice(0, 500),
    },
    turnstile: {
      enabled: !!turnstile.enabled,
      siteKey: str(turnstile.siteKey, '').slice(0, 100),
    },
    // Per-form theme. This was missing from the whitelist, so every save silently
    // dropped it and the editor's colour reverted to the default green.
    theme: {
      primary: /^#[0-9a-fA-F]{6}$/.test(str(s.theme && s.theme.primary, '').trim())
        ? str(s.theme && s.theme.primary, '').trim().toLowerCase()
        : '',
    },
    // Quiz scoring. Bands are thresholded by percentage (0-100); the first
    // band is always pinned to 0 so every result resolves to a band.
    scoring: sanitizeScoring(s.scoring),
    // Per-form UTM defaults, used only when the embedding URL has no value.
    utm: {
      source: str(s.utm && s.utm.source, '').trim().slice(0, 100),
      medium: str(s.utm && s.utm.medium, '').trim().slice(0, 100),
      campaign: str(s.utm && s.utm.campaign, '').trim().slice(0, 100),
      term: str(s.utm && s.utm.term, '').trim().slice(0, 100),
      content: str(s.utm && s.utm.content, '').trim().slice(0, 100),
    },
  };
}

export function sanitizeScoring(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const bands = [];
  const used = new Set();

  for (const [i, b] of (Array.isArray(s.bands) ? s.bands : []).slice(0, 6).entries()) {
    if (!b || typeof b !== 'object') continue;
    const label = str(b.label, '').trim().slice(0, 80);
    if (!label) continue;
    let key = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(str(b.key, '')) ? str(b.key, '') : `band_${i + 1}`;
    while (used.has(key)) key = `${key.slice(0, 28)}_${i + 1}`;
    used.add(key);
    const color = /^#[0-9a-fA-F]{6}$/.test(str(b.color, '').trim())
      ? str(b.color, '').trim().toLowerCase()
      : BAND_PALETTE[i % BAND_PALETTE.length];
    bands.push({
      key,
      label,
      min: boundedInt(b.min, 0, 100),
      color,
      headline: str(b.headline, '').slice(0, 120),
      recommendation: str(b.recommendation, '').slice(0, 600),
      redirectUrl: safeRedirect(b.redirectUrl),
      ctaLabel: str(b.ctaLabel, '').slice(0, 60),
      ctaUrl: safeCtaUrl(b.ctaUrl),
      videoUrl: safeVideoUrl(b.videoUrl),
      videoCaption: str(b.videoCaption, '').slice(0, 160),
    });
  }

  bands.sort((a, b) => a.min - b.min);
  if (bands.length) bands[0].min = 0;

  return {
    enabled: !!s.enabled && bands.length > 0,
    display: SCORING_DISPLAY.has(s.display) ? s.display : 'gauge',
    showScore: s.showScore !== false,
    autoRedirect: s.autoRedirect !== false,
    redirectDelayMs: boundedInt(s.redirectDelayMs, 0, 5000, 1500),
    videoUrl: safeVideoUrl(s.videoUrl),
    videoCaption: str(s.videoCaption, '').slice(0, 160),
    disclaimer: str(s.disclaimer, '').slice(0, 600),
    planUrl: safeRedirect(s.planUrl),
    planCtaLabel: str(s.planCtaLabel, '').slice(0, 60),
    planHeadline: str(s.planHeadline, '').slice(0, 120),
    planRecommendation: str(s.planRecommendation, '').slice(0, 600),
    bands,
  };
}

export function sanitizePages(raw, fields = []) {
  // Page metadata: [{ id, title, description, conditional }]. Order = page order.
  // Absent/empty = single-page "long form" (fields all sit on page 0).
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const used = new Set();
  let n = 0;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    n += 1;
    let id = /^p[0-9]+$/.test(p.id || '') && !used.has(p.id) ? p.id : '';
    if (!id) {
      let c = n;
      while (used.has(`p${c}`)) c += 1;
      id = `p${c}`;
    }
    used.add(id);

    const index = out.length;
    // A page condition may only reference fields on earlier pages (plus global
    // hidden fields) — a page cannot depend on a value the visitor has not
    // reached yet. The first page is always shown.
    const allowed = new Set(
      (Array.isArray(fields) ? fields : [])
        .filter((f) => f.hidden || (Number.isInteger(f.page) && f.page < index))
        .map((f) => f.name),
    );
    const conditional = index === 0
      ? { enabled: false, action: 'show', match: 'all', rules: [] }
      : sanitizeConditional(p.conditional, allowed, null);

    out.push({
      id,
      title: str(p.title, '').slice(0, 200),
      description: str(p.description, '').slice(0, 1000),
      conditional,
    });
  }
  return out;
}

export function sanitizeNotifications(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const url = str(n.url, '').trim();
    if (!url || !/^https:\/\//.test(url)) continue; // webhooks must be https
    out.push({ label: str(n.label, '').slice(0, 100), url: url.slice(0, 1000) });
  }
  return out;
}

/**
 * Validate one submission value against its field definition.
 * Returns an error message string, or null when valid (value is then sanitized by caller caps).
 */
export function validateValue(field, value) {
  const raw = value === undefined || value === null ? '' : value;

  if (field.type === 'file') {
    if (!raw || typeof raw !== 'object') {
      return field.required ? 'Please upload a file.' : null;
    }
    return null;
  }

  if (field.type === 'checkbox') {
    const arr = Array.isArray(raw) ? raw : [];
    const allowed = new Set(field.options.map((o) => o.value));
    if (field.required && arr.length === 0) return 'Please select at least one option.';
    for (const v of arr) {
      if (typeof v !== 'string' || !allowed.has(v)) return 'Invalid option selected.';
    }
    return null;
  }

  if (typeof raw !== 'string') return 'Invalid value.';
  const v = raw.trim();

  if (field.required && !v) return 'This field is required.';

  if (v === '') return null; // optional + empty is fine

  switch (field.type) {
    case 'email':
      if (v.length > 254 || !EMAIL_RE.test(v)) return 'Please enter a valid email address.';
      break;
    case 'phone': {
      const digits = v.replace(/[^0-9]/g, '');
      if (digits.length < 7 || digits.length > 15) return 'Please enter a valid phone number.';
      break;
    }
    case 'number':
      {
        const n = Number(v);
        if (!Number.isFinite(n)) return 'Please enter a number.';
        const min = field.min;
        const max = field.max;
        const hasMin = min !== '' && min !== undefined && min !== null;
        const hasMax = max !== '' && max !== undefined && max !== null;
        if (hasMin && hasMax && (n < Number(min) || n > Number(max))) {
          return `Please enter a number between ${min} and ${max}.`;
        }
        if (hasMin && n < Number(min)) return `Please enter a number of at least ${min}.`;
        if (hasMax && n > Number(max)) return `Please enter a number no more than ${max}.`;
      }
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
        return 'Please enter a valid date.';
      }
      break;
    case 'select':
    case 'radio': {
      const allowed = new Set(field.options.map((o) => o.value));
      if (!allowed.has(v)) return 'Invalid option selected.';
      break;
    }
    case 'textarea':
      if (v.length > MAX_TEXT) return 'Too long.';
      break;
    case 'hidden':
      if (v.length > 300) return 'Too long.';
      break;
    default:
      if (v.length > MAX_SHORT) return 'Too long.';
  }
  return null;
}

/** Normalise a valid value for storage. */
export function normalizeValue(field, value) {
  if (field.type === 'file') return value;
  if (field.type === 'checkbox') {
    return Array.isArray(value) ? JSON.stringify(value) : '[]';
  }
  return typeof value === 'string' ? value.trim().slice(0, MAX_SHORT) : '';
}

export function sanitizeUtm(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content', 'gclid', 'fbclid', 'clinic']) {
    const v = o[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, 500);
  }
  return out;
}

function str(v, fallback) {
  return typeof v === 'string' ? v : fallback;
}
