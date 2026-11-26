// Config helpers shared by public + admin endpoints.
import { DEFAULT_CONSENT_TEXT } from './settings.js';
import { findFollowUp, findRoute } from './scoring.js';

/** Effective consent wording: per-form override wins, else the global default, else the built-in. */
export function effectiveConsentText(config, globalDefaults) {
  const s = (config && config.settings) || {};
  const perForm = typeof s.consentText === 'string' ? s.consentText.trim() : '';
  if (perForm) return perForm;
  const g = globalDefaults && typeof globalDefaults.consentText === 'string' ? globalDefaults.consentText.trim() : '';
  return g || DEFAULT_CONSENT_TEXT;
}

/** Effective submit webhook: per-form override wins, else the global default, else nothing. */
export function resolveWebhook(config, globalDefaults) {
  const per = ((config && config.settings) || {}).submitWebhook || {};
  const perUrl = typeof per.url === 'string' ? per.url.trim() : '';
  if (perUrl) return { url: perUrl, token: typeof per.token === 'string' ? per.token : '' };
  const gUrl = globalDefaults && typeof globalDefaults.webhookUrl === 'string' ? globalDefaults.webhookUrl.trim() : '';
  if (gUrl) return { url: gUrl, token: (globalDefaults && globalDefaults.webhookToken) || '' };
  return { url: '', token: '' };
}

/**
 * Convenience contact fields for the fixed submit-webhook contract. Resolved by field
 * TYPE first (email/phone), then by common field NAME -- the form builder lets the owner
 * name fields freely, so a name match is a fall-back, not a requirement.
 */
export function pickContact(data, fields) {
  const d = data || {};
  const byType = (type) => {
    for (const f of fields || []) {
      const v = d[f.name];
      if (f.type === type && typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const byName = (...names) => {
    for (const n of names) {
      const v = d[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    email: byType('email') || byName('email', 'email_address', 'e_mail'),
    first_name: byName('first_name', 'firstname', 'fname', 'given_name', 'first'),
    last_name: byName('last_name', 'lastname', 'lname', 'surname', 'family_name', 'last'),
    phone: byType('phone') || byName('phone', 'phone_number', 'mobile', 'telephone', 'tel'),
  };
}

/** Build the fixed outbound submit-webhook payload (the receiving contract is owned by the other team). */
export function buildSubmitWebhookPayload({ slug, submissionId, data, fields, consentText, consentAt, meta }) {
  const c = pickContact(data, fields);
  const m = meta || {};
  let utm = {};
  try { utm = typeof m.utm === 'string' ? JSON.parse(m.utm) : (m.utm || {}); } catch (e) { utm = {}; }
  const payload = {
    form_slug: slug,
    submission_id: submissionId,
    email: c.email,
    first_name: c.first_name,
    last_name: c.last_name,
    phone: c.phone,
    page_url: m.page_url || '',
    referrer: m.referrer || '',
    utm,
    fbclid: utm.fbclid || '',
    consent: { accepted: true, text: consentText, at: consentAt },
    fields: data || {},
  };
  // `clinic` is a Dental Scout routing key. Emit it only when the visit actually
  // carried one, so a plain contact form's payload does not look like a dental lead.
  if (typeof utm.clinic === 'string' && utm.clinic.trim()) {
    payload.clinic = utm.clinic.trim();
  }
  return payload;
}

/**
 * Score / follow-up keys belong only to forms that actually produce them.
 * They used to be appended to every payload as 0 / '' / 'call', which made a
 * plain contact form's webhook look like a dental quiz lead and showed fields
 * the form never collects. Add each only when this form can produce it.
 */
export function buildSubmitWebhookExtras(config, data, scoreInfo) {
  const fields = (config && config.fields) || [];
  const options = fields.flatMap((f) => (Array.isArray(f.options) ? f.options : []));
  const scored = !!(scoreInfo && scoreInfo.enabled);
  const extras = {};
  if (scored) {
    extras.score_points = scoreInfo.points;
    extras.score_percent = scoreInfo.percent;
    extras.score_band = scoreInfo.band && scoreInfo.band.key ? scoreInfo.band.key : '';
  }
  if (scored || options.some((o) => o && o.followUp === 'no_call')) {
    extras.followup = findFollowUp(fields, data, config);
  }
  if (scored || options.some((o) => o && o.route === 'plan')) {
    extras.funding_route = findRoute(fields, data, config);
  }
  return extras;
}

/**
 * Shape served by the PUBLIC endpoint -- never includes notifications or the private
 * submit webhook (URL or token). Consent wording is RESOLVED here so the widget always
 * has the exact text to show (and the submit endpoint resolves it identically to store it).
 */
export function publicForm(row, globalDefaults) {
  const config = parseConfig(row.config);
  const settings = { ...config.settings };
  delete settings.submitWebhook; // the URL/token must never reach the browser
  settings.consentText = effectiveConsentText(config, globalDefaults);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    version: row.updated_at,
    config: {
      fields: config.fields,
      settings,
      pages: config.pages,
    },
  };
}

/** Full config as stored (admin only). */
export function parseConfig(raw) {
  try {
    const c = JSON.parse(raw || '{}');
    return {
      fields: Array.isArray(c.fields) ? c.fields : [],
      settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
      notifications: Array.isArray(c.notifications) ? c.notifications : [],
      pages: Array.isArray(c.pages) ? c.pages : [],
    };
  } catch {
    return { fields: [], settings: {}, notifications: [], pages: [] };
  }
}

export function stringifyConfig(fields, settings, notifications, pages) {
  return JSON.stringify({ fields, settings, notifications, pages });
}
