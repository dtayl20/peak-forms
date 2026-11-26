// POST /api/forms/:slug/otp/sms/verify — exchange a Twilio Verify code for a
// short-lived signed token that the submit endpoint accepts.
import { handleOptions, publicJson, readJson, optionsHandler } from '../../../../../_lib/http.js';
import { first, run } from '../../../../../_lib/db.js';
import { parseConfig } from '../../../../../_lib/config.js';
import {
  MAX_ATTEMPTS,
  TOKEN_TTL_MS,
  checkSmsOtp,
  normalizePhone,
  otpFields,
  signSmsToken,
} from '../../../../../_lib/otp.js';

export const onRequestPost = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }

  const config = parseConfig(form.config);
  if (!otpFields(config).some((f) => f.type === 'phone')) {
    return publicJson({ error: 'otp_not_enabled' }, 404);
  }

  if (!env.OTP_SECRET) {
    console.error('otp/sms/verify: OTP_SECRET is not configured');
    return publicJson({ error: 'server_misconfigured' }, 500);
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
    console.error('otp/sms/verify: Twilio Verify is not configured');
    return publicJson({ error: 'server_misconfigured' }, 500);
  }

  const body = (await readJson(request)) || {};
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '').trim() : '';

  if (!phone || !/^\d{4,10}$/.test(code)) {
    return publicJson({ error: 'invalid_code' }, 400);
  }

  const row = await first(
    env,
    `SELECT * FROM sms_otps
     WHERE form_id = ? AND phone = ? AND used = 0
     ORDER BY id DESC LIMIT 1`,
    form.id, phone,
  );

  // One answer for missing / expired / exhausted / wrong-code rows.
  if (!row) return publicJson({ error: 'invalid_code' }, 400);
  if (Number(row.expires_at) <= Date.now()) return publicJson({ error: 'invalid_code' }, 400);
  if (Number(row.attempts) >= MAX_ATTEMPTS) return publicJson({ error: 'invalid_code' }, 400);

  const checked = await checkSmsOtp(env, phone, code);
  if (!checked.ok) {
    await run(env, 'UPDATE sms_otps SET attempts = attempts + 1 WHERE id = ?', row.id);
    return publicJson({ error: 'invalid_code' }, 400);
  }

  await run(env, 'UPDATE sms_otps SET used = 1 WHERE id = ?', row.id);

  const expiryMs = Date.now() + TOKEN_TTL_MS;
  const token = await signSmsToken({ formId: form.id, phone, expiryMs }, env.OTP_SECRET);
  return publicJson({ ok: true, token, phone, expires_in: Math.floor(TOKEN_TTL_MS / 1000) });
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
