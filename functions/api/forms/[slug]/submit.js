// POST https://<host>/api/forms/:slug  — public submission endpoint.
import { handleOptions, publicJson, readJson, optionsHandler } from '../../../_lib/http.js';
import { first, run } from '../../../_lib/db.js';
import { parseConfig, effectiveConsentText, resolveWebhook, buildSubmitWebhookPayload, buildSubmitWebhookExtras } from '../../../_lib/config.js';
import { getAppSettings } from '../../../_lib/settings.js';
import { validateValue, normalizeValue, sanitizeUtm } from '../../../_lib/validate.js';
import { normalizeEmail, normalizePhone, otpFields, verifyTokens } from '../../../_lib/otp.js';
import { markUploadUsed, resolveUpload } from '../../../_lib/files.js';
import { fieldIsVisible } from '../../../_lib/conditional.js';
import { evaluateScoring, decorateRedirect, findFollowUp, findRoute } from '../../../_lib/scoring.js';
import { sendMetaLead } from '../../../_lib/meta.js';

const MAX_PER_HOUR_PER_IP = 15;
const WEBHOOK_TIMEOUT_MS = 8000;

async function verifyTurnstile(secret, token, ip) {
  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const out = await res.json();
    return !!out.success;
  } catch {
    return false;
  }
}

function safeMetaValue(v, cap) {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

/**
 * Fire the submit webhook. This is fire-and-forget: it runs in waitUntil, has its own
 * timeout, swallows every error, and only ever writes the outcome back to the row.
 * A webhook failure can NEVER fail, slow down, or change the visitor's submission.
 */
function fireSubmitWebhook({ env, waitUntil, submissionId, url, token, payload }) {
  waitUntil((async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let status;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        // The body contract is fixed and carries no token, so the token travels as a header.
        headers.Authorization = 'Bearer ' + token;
        headers['X-Webhook-Token'] = token;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = 'ok:' + res.status;
    } catch (e) {
      status = e && e.name === 'AbortError' ? 'timeout' : 'error';
    } finally {
      clearTimeout(timer);
    }
    try {
      await run(env, 'UPDATE submissions SET webhook_status = ?, webhook_at = ? WHERE id = ?',
        status, new Date().toISOString(), submissionId);
    } catch { /* outcome logging must never throw */ }
  })());
}

export const onRequestPost = async ({ request, env, params, waitUntil }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }

  const config = parseConfig(form.config);
  const fields = config.fields;

  const body = await readJson(request);
  if (!body || typeof body.data !== 'object' || body.data === null) {
    return publicJson({ error: 'bad_request', message: 'Invalid submission payload.' }, 400);
  }

  // Honeypot: bots fill this invisible field. Silently accept so bots think they won.
  // Crucially this returns BEFORE anything is stored or any webhook fires.
  if (body.hp) {
    return publicJson({ ok: true, id: 0 });
  }

  // Blocklist: submissions from an address or IP marked as spam are silently
  // accepted - ok:true with id 0, nothing stored, no webhook - so a spammer
  // gets no signal that they were blocked.
  {
    const clientIp = request.headers.get('cf-connecting-ip') || '';
    const emailField = fields.find((f) => f.type === 'email');
    const emailNow = emailField
      ? String(body.data[emailField.name] || '').trim().toLowerCase()
      : '';
    if (emailNow || clientIp) {
      const blocked = await first(
        env,
        `SELECT 1 AS hit FROM spam_blocklist
         WHERE (kind = 'email' AND value = ?) OR (kind = 'ip' AND value = ?) LIMIT 1`,
        emailNow,
        clientIp,
      );
      if (blocked) return publicJson({ ok: true, id: 0 });
    }
  }

  // Turnstile
  const ts = config.settings.turnstile || {};
  if (ts.enabled && ts.siteKey) {
    const secret = env.TURNSTILE_SECRET;
    if (!secret) return publicJson({ error: 'server_misconfigured' }, 500);
    const token = typeof body.turnstile === 'string' ? body.turnstile : '';
    if (!token) return publicJson({ error: 'captcha_required' }, 400);
    const ok = await verifyTurnstile(secret, token, request.headers.get('cf-connecting-ip') || '');
    if (!ok) return publicJson({ error: 'captcha_failed' }, 400);
  }

  // OTP: every active email/phone field that carries a value needs a valid,
  // unexpired token for THIS form and that exact address/number. This runs
  // before validation, storage or any webhook. Conditionally hidden or blank
  // fields do not demand a token.
  const otpFieldList = otpFields(config).filter((f) => {
    if (!fieldIsVisible(f, config, body.data)) return false;
    return f.type === 'email'
      ? normalizeEmail(body.data[f.name]) !== ''
      : normalizePhone(body.data[f.name]) !== '';
  });
  let emailVerified = 0;
  let phoneVerified = 0;
  if (otpFieldList.length) {
    const payloads = env.OTP_SECRET ? await verifyTokens(body.otp, env.OTP_SECRET) : [];
    const now = Date.now();
    const hasEmailToken = (f) => {
      const value = normalizeEmail(body.data[f.name]);
      return payloads.some((p) => p
        && Number(p.f) === Number(form.id)
        && Number(p.x) > now
        && typeof p.e === 'string'
        && normalizeEmail(p.e) === value);
    };
    const hasPhoneToken = (f) => {
      const value = normalizePhone(body.data[f.name]);
      return payloads.some((p) => p
        && Number(p.f) === Number(form.id)
        && Number(p.x) > now
        && typeof p.p === 'string'
        && normalizePhone(p.p) === value);
    };
    for (const f of otpFieldList) {
      if (f.type === 'email') {
        if (!hasEmailToken(f)) return publicJson({ error: 'email_unverified' }, 422);
        emailVerified = 1;
      } else if (f.type === 'phone') {
        if (!hasPhoneToken(f)) return publicJson({ error: 'phone_unverified' }, 422);
        phoneVerified = 1;
      }
    }
  }

  // File uploads are pre-uploaded to R2; exchange each single-use token for the
  // stored metadata before validation/storage. A missing or reused token fails
  // closed rather than accepting an arbitrary object from the client.
  const fileRows = {};
  for (const f of fields) {
    if (f.type !== 'file' || !fieldIsVisible(f, config, body.data)) continue;
    const ref = body.data[f.name];
    if (ref === undefined || ref === null || ref === '') continue;
    const row = await resolveUpload(env, { formId: form.id, fieldName: f.name, ref });
    if (!row) return publicJson({ error: 'file_invalid' }, 422);
    fileRows[f.name] = row;
  }

  // Rate limit: per form + IP, rolling hour
  const ip = request.headers.get('cf-connecting-ip') || '';
  const recent = await first(
    env,
    `SELECT COUNT(*) AS c FROM submissions
     WHERE form_id = ? AND ip = ? AND created_at > datetime('now', '-1 hour')`,
    form.id, ip
  );
  if (recent && recent.c >= MAX_PER_HOUR_PER_IP) {
    return publicJson({ error: 'rate_limited' }, 429);
  }

  // Validate against the published config — unknown fields are dropped entirely.
  const data = {};
  const errors = {};
  for (const field of fields) {
    // Conditional logic: skip fields the visitor cannot currently see. This
    // mirrors the widget so a hidden required field never blocks submission.
    if (!fieldIsVisible(field, config, body.data)) continue;
    const err = validateValue(field, body.data[field.name]);
    if (err) {
      errors[field.name] = err;
    } else if (field.type === 'file') {
      const row = fileRows[field.name];
      if (row) {
        data[field.name] = {
          file_id: row.id,
          name: row.original_name,
          size: row.size,
          type: row.content_type,
        };
      }
    } else if (body.data[field.name] !== undefined) {
      data[field.name] = normalizeValue(field, body.data[field.name]);
    } else if (field.type === 'checkbox') {
      data[field.name] = '[]';
    }
  }
  if (Object.keys(errors).length) {
    return publicJson({ errors, error: 'validation_failed' }, 422);
  }

  const ua = request.headers.get('user-agent') || '';
  const pageUrl = safeMetaValue(body.page_url, 500);

  // Quiz score is computed from the validated, normalised payload. The server is
  // authoritative; the widget's own copy is only for the instant result screen.
  const scoreInfo = evaluateScoring(config, data);
  // Contact preference is separate from eligibility: "no_call" means the lead
  // asked not to be rung, and the band must not be marked down for it.
  const followUp = findFollowUp(fields, data, config);
  // Funding route is also separate from eligibility: a plan-preferrer still has
  // an eligibility band, but the result sends them down the payment-plan path.
  const route = findRoute(fields, data, config);

  // The widget reads utm params at load; pages that rewrite the query string drop fbclid
  // before submit. Recover it from the URL we were handed - Meta also supplies fbclid_attr,
  // which carries the full value when the plain fbclid param is truncated.
  const utm = sanitizeUtm(body.utm);
  try {
    const q = new URL(pageUrl).searchParams;
    const fromUrl = q.get('fbclid_attr') || q.get('fbclid');
    if (fromUrl && (!utm.fbclid || fromUrl.length > utm.fbclid.length)) {
      utm.fbclid = fromUrl.slice(0, 500);
    }
    // Referrer fallback: the /check/ handoff URL carries the fbclid even when
    // the quiz page's own URL does not (the redirect may omit it).
    if (!utm.fbclid && body.referrer) {
      const rq = new URL(body.referrer).searchParams;
      const fromRef = rq.get('fbclid_attr') || rq.get('fbclid');
      if (fromRef) utm.fbclid = fromRef.slice(0, 500);
    }
    // Same recovery for clinic: a funnel can carry it in the page URL (the ad's
    // url_tags append clinic=floss) even when the widget's storage capture is gone.
    if (!utm.clinic) {
      const clinic = q.get('clinic') || q.get('clinic_id') || q.get('brand') || q.get('utm_clinic');
      if (clinic) utm.clinic = clinic.slice(0, 500);
    }
  } catch (e) { /* relative or malformed URL - ignore */ }

  const meta = {
    page_url: pageUrl,
    referrer: safeMetaValue(body.referrer, 500),
    utm: JSON.stringify(utm),
    ip,
    ua: ua.slice(0, 300),
  };

  // Consent: resolve the exact wording the widget was told to show, and stamp acceptance.
  const globalDefaults = await getAppSettings(env);
  const consentText = effectiveConsentText(config, globalDefaults);
  const consentAt = new Date().toISOString();

  const res = await run(
    env,
    `INSERT INTO submissions (form_id, form_slug, data, page_url, referrer, utm, ip, ua, consent_text, consent_at, email_verified, phone_verified, score, score_percent, score_band)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    form.id, form.slug, JSON.stringify(data),
    meta.page_url, meta.referrer, meta.utm, meta.ip, meta.ua,
    consentText, consentAt, emailVerified, phoneVerified,
    scoreInfo.enabled ? scoreInfo.points : 0,
    scoreInfo.enabled ? scoreInfo.percent : 0,
    scoreInfo.enabled && scoreInfo.band ? scoreInfo.band.key : ''
  );
  const submissionId = res.meta.last_row_id;
  for (const row of Object.values(fileRows)) {
    await markUploadUsed(env, row.id, submissionId);
  }

  // Fire notification webhooks (Make.com etc.) after the response is sent.
  for (const n of config.notifications || []) {
    if (!n.url) continue;
    waitUntil(
      fetch(n.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'form_submission',
          form: { id: form.id, slug: form.slug, title: form.title },
          data,
          meta: { page_url: meta.page_url, referrer: meta.referrer, utm: meta.utm, created_at: new Date().toISOString() },
        }),
      }).catch(() => {})
    );
  }

  // Fire the contract submit webhook (per-form override -> global default), fire-and-forget.
  const webhook = resolveWebhook(config, globalDefaults);
  if (webhook.url) {
    const payload = buildSubmitWebhookPayload({
      slug: form.slug,
      submissionId,
      data,
      fields,
      consentText,
      consentAt,
      meta,
    });
    // Additive keys only when this form actually produces them (score bands,
    // follow-up, funding route). A plain contact form must not look like a quiz.
    Object.assign(payload, buildSubmitWebhookExtras(config, data, scoreInfo));
    fireSubmitWebhook({ env, waitUntil, submissionId, url: webhook.url, token: webhook.token, payload });
  }


  // Meta Conversions API: server-side Lead, keyed to the submission id.
  // Fire-and-forget, skipped entirely when no token is configured. Forms that
  // are only a soft capture (e.g. quick-capture) set settings.metaCapi=false so
  // the quiz submission remains the single Lead event.
  if (config.settings.metaCapi !== false) {
    waitUntil(
      sendMetaLead(env, {
        submissionId,
        slug: form.slug,
        data,
        pageUrl: meta.page_url,
        ip: meta.ip,
        ua: meta.ua,
        cookies: request.headers.get('cookie') || '',
        utm,
        verified: !!(emailVerified || phoneVerified),
      }).catch(() => {})
    );
  }

  const settings = config.settings || {};
  const band = scoreInfo.enabled ? scoreInfo.band : null;
  // Scoring off = the old behaviour exactly: the form's redirect URL is used
  // verbatim, with no ff_band/ff_score appended. Existing forms must not change.
  let redirect = settings.redirectUrl || '';
  if (scoreInfo.enabled) {
    redirect = band && band.redirectUrl
      ? decorateRedirect(band.redirectUrl, band, scoreInfo.percent)
      : decorateRedirect(settings.redirectUrl || '', band, scoreInfo.percent);
  }

  return publicJson({
    ok: true,
    id: submissionId,
    message: settings.successMessage || 'Thanks!',
    redirect,
    score: scoreInfo.enabled ? { points: scoreInfo.points, percent: scoreInfo.percent } : null,
    followUp,
    route,
    knockout: scoreInfo.knockout || '',
    band: band ? {
      key: band.key,
      label: band.label,
      color: band.color,
      headline: band.headline,
      recommendation: band.recommendation,
      ctaLabel: band.ctaLabel,
      ctaUrl: band.ctaUrl,
      redirectUrl: redirect,
    } : null,
    scoring: scoreInfo.enabled ? {
      display: (settings.scoring && settings.scoring.display) || 'gauge',
      showScore: !(settings.scoring && settings.scoring.showScore === false),
      autoRedirect: !(settings.scoring && settings.scoring.autoRedirect === false),
      redirectDelayMs: settings.scoring && Number.isFinite(Number(settings.scoring.redirectDelayMs))
        ? Number(settings.scoring.redirectDelayMs)
        : 1500,
    } : null,
  });
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
