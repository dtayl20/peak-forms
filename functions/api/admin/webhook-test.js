// Admin: fire a sample submit-webhook payload at the configured (or supplied) URL.
// Owner-only test mode - awaited so the console can show the receiver's status.
//
// The sample is the REAL live payload builder fed with sample values, so the
// receiver sees exactly the keys a submission of THIS form would send. Keys the
// form does not produce (score bands, follow-up, funding route, clinic) are
// absent rather than sent as 0 / '' - sending them on every form made a plain
// contact form look like a Dental Scout quiz lead.
import { json, readJson } from '../../_lib/http.js';
import { adminGate } from '../../_lib/admin.js';
import { getAppSettings } from '../../_lib/settings.js';
import { first } from '../../_lib/db.js';
import {
  parseConfig,
  effectiveConsentText,
  buildSubmitWebhookPayload,
  buildSubmitWebhookExtras,
} from '../../_lib/config.js';
import { evaluateScoring } from '../../_lib/scoring.js';

/** A plausible value for one field, matching what the visitor would submit. */
function sampleValue(field) {
  const type = String(field && field.type ? field.type : 'text').toLowerCase();
  const options = (field && (field.options || field.choices)) || [];
  const optionValue = (o) => (o && typeof o === 'object' ? o.value : o);
  const firstOption = options.length ? optionValue(options[0]) : null;

  switch (type) {
    case 'email':
      return 'test@example.com';
    case 'phone':
      return '0400000000';
    case 'textarea':
      return 'Test message from the webhook test panel.';
    case 'number':
      return 1;
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'select':
    case 'radio':
      return firstOption ?? 'Test';
    case 'checkbox':
    case 'checkboxes':
    case 'multiselect':
      // The submit validator expects an ARRAY of chosen option values for these.
      return firstOption ? [firstOption] : [];
    default:
      return 'Test';
  }
}

/** Sample attribution so a CRM can map utm.* and fbclid from a test request. */
function sampleUtm() {
  return {
    source: 'test',
    medium: 'webhook-test',
    campaign: 'sample-campaign',
    fbclid: 'TEST123',
    gclid: 'TESTGCLID',
  };
}

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const body = (await readJson(request)) || {};
  const global = await getAppSettings(env);

  // Prefer an explicit URL/token (unsaved edits in the console), else the global default.
  const url = (typeof body.url === 'string' ? body.url.trim() : '') || global.webhookUrl;
  const token = (typeof body.token === 'string' ? body.token : '') || global.webhookToken;

  if (!url) return json({ error: 'No webhook URL configured.' }, 400);
  if (!/^https:\/\//.test(url)) return json({ error: 'Webhook URL must start with https://' }, 400);

  // Use the form's own fields so the test matches a live submission.
  let fields = [];
  let formTitle = null;
  let formConfig = null;
  const slug = typeof body.form_slug === 'string' ? body.form_slug.trim() : '';
  if (slug) {
    try {
      const row = await first(env, 'SELECT title, config FROM forms WHERE slug = ?', slug);
      if (row) {
        formTitle = row.title;
        formConfig = parseConfig(row.config);
        fields = formConfig.fields || [];
      }
    } catch (e) {
      // A lookup failure must not stop the test - fall back to the generic sample.
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
    headers['X-Webhook-Token'] = token;
  }

  const values = {};
  for (const f of fields) {
    if (f && f.name) values[f.name] = sampleValue(f);
  }
  // Fall back to a generic sample only when the form has no usable fields.
  if (!Object.keys(values).length) {
    values.first_name = 'Test';
    values.last_name = 'Submission';
    values.phone = '0400000000';
    values.email = 'test@example.com';
  }

  const config = formConfig || { fields: [], settings: {} };
  const base = buildSubmitWebhookPayload({
    slug: slug || 'test-form',
    submissionId: 0,
    data: values,
    fields,
    consentText: effectiveConsentText(config, global),
    consentAt: new Date().toISOString(),
    meta: {
      page_url: typeof body.page_url === 'string' ? body.page_url.trim().slice(0, 500) : '',
      referrer: '',
      utm: JSON.stringify(sampleUtm()),
    },
  });
  Object.assign(base, buildSubmitWebhookExtras(config, values, evaluateScoring(config, values)));

  const kind = String(body.kind || 'submit').toLowerCase();
  const payload = kind === 'notification'
    ? {
        event: 'form_submission',
        form: { id: 0, slug: slug || 'test-form', title: formTitle || 'Test form' },
        data: base.fields,
        meta: {
          page_url: base.page_url,
          referrer: base.referrer,
          utm: JSON.stringify(base.utm || {}),
          created_at: new Date().toISOString(),
        },
      }
    : base;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return json({
      ok: res.ok,
      status: res.status,
      response: text.slice(0, 1000),
      // Returned so the console can show exactly which keys were sent.
      sent_fields: kind === 'notification' ? Object.keys(payload.data || {}) : Object.keys(payload),
      form_title: formTitle,
    });
  } catch (e) {
    return json({
      ok: false,
      status: 0,
      error: e && e.name === 'AbortError' ? 'Timed out after 8s' : String((e && e.message) || e),
      sent_fields: Object.keys(payload.fields || payload.data || {}),
      form_title: formTitle,
    });
  } finally {
    clearTimeout(timer);
  }
};

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405);
