// POST /api/forms/:slug/otp/sms/start — public: send an SMS code via Twilio Verify.
//
// The answer is intentionally constant ({ok:true}) for malformed numbers,
// throttling or send failures, so a caller cannot probe which numbers exist.
import { handleOptions, publicJson, readJson, optionsHandler } from '../../../../../_lib/http.js';
import { first, run } from '../../../../../_lib/db.js';
import { parseConfig } from '../../../../../_lib/config.js';
import {
  OTP_TTL_MS,
  PER_EMAIL_PER_HOUR,
  PER_IP_PER_HOUR,
  hourlySmsCounts,
  normalizePhone,
  otpFields,
  recentlySentSms,
  sendSmsOtp,
  verifyTurnstile,
} from '../../../../../_lib/otp.js';

export const onRequestPost = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }

  const config = parseConfig(form.config);
  const phoneFields = otpFields(config).filter((f) => f.type === 'phone');
  if (!phoneFields.length) {
    return publicJson({ error: 'otp_not_enabled' }, 404);
  }

  const body = (await readJson(request)) || {};
  if (body.field && !phoneFields.some((f) => f.name === body.field)) {
    return publicJson({ ok: true });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';

  // Turnstile, when the form enables it, is required before any send.
  const ts = config.settings.turnstile || {};
  if (ts.enabled && ts.siteKey) {
    if (!env.TURNSTILE_SECRET) return publicJson({ error: 'server_misconfigured' }, 500);
    const token = typeof body.turnstile === 'string' ? body.turnstile : '';
    if (!token) return publicJson({ error: 'captcha_required' }, 400);
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip))) {
      return publicJson({ error: 'captcha_failed' }, 400);
    }
  }

  const phone = normalizePhone(body.phone);
  if (!phone) return publicJson({ ok: true });
  if (!env.OTP_SECRET) {
    console.error('otp/sms/start: OTP_SECRET is not configured');
    return publicJson({ ok: true });
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
    console.error('otp/sms/start: Twilio Verify is not configured');
    return publicJson({ ok: true });
  }

  if (await recentlySentSms(env, form.id, phone)) return publicJson({ ok: true });

  const counts = await hourlySmsCounts(env, form.id, phone, ip);
  if (counts.phone >= PER_EMAIL_PER_HOUR || counts.ip >= PER_IP_PER_HOUR) {
    return publicJson({ ok: true });
  }

  const sent = await sendSmsOtp(env, phone);
  if (!sent.ok) {
    console.error('otp/sms/start: Twilio Verify send failed', { status: sent.status, error: sent.error });
    return publicJson({ ok: true });
  }

  await run(
    env,
    `INSERT INTO sms_otps (form_id, phone, expires_at, attempts, used, ip)
     VALUES (?, ?, ?, 0, 0, ?)`,
    form.id, phone, Date.now() + OTP_TTL_MS, ip,
  );

  return publicJson({ ok: true });
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
