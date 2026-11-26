// POST /api/forms/:slug/otp/verify — public: exchange a 6-digit code for a
// short-lived signed token that the submit endpoint accepts.
import { handleOptions, publicJson, readJson, optionsHandler } from '../../../../_lib/http.js';
import { first, run } from '../../../../_lib/db.js';
import { parseConfig } from '../../../../_lib/config.js';
import {
  MAX_ATTEMPTS,
  TOKEN_TTL_MS,
  hashCode,
  normalizeEmail,
  otpFields,
  signToken,
  validEmail,
} from '../../../../_lib/otp.js';

export const onRequestPost = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }

  const config = parseConfig(form.config);
  if (!otpFields(config).some((f) => f.type === 'email')) {
    return publicJson({ error: 'otp_not_enabled' }, 404);
  }

  if (!env.OTP_SECRET) {
    console.error('otp/verify: OTP_SECRET is not configured');
    return publicJson({ error: 'server_misconfigured' }, 500);
  }

  const body = (await readJson(request)) || {};
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';

  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return publicJson({ error: 'invalid_code' }, 400);
  }

  const row = await first(
    env,
    `SELECT * FROM email_otps
     WHERE form_id = ? AND email = ? AND used = 0
     ORDER BY id DESC LIMIT 1`,
    form.id, email,
  );

  // One answer for missing / expired / exhausted / wrong-code rows: a caller
  // must not be able to tell which it hit.
  if (!row) return publicJson({ error: 'invalid_code' }, 400);
  if (Number(row.expires_at) <= Date.now()) return publicJson({ error: 'invalid_code' }, 400);
  if (Number(row.attempts) >= MAX_ATTEMPTS) return publicJson({ error: 'invalid_code' }, 400);

  const hash = await hashCode(form.id, email, code);
  if (hash !== row.code_hash) {
    await run(env, 'UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', row.id);
    return publicJson({ error: 'invalid_code' }, 400);
  }

  await run(env, 'UPDATE email_otps SET used = 1 WHERE id = ?', row.id);

  const expiryMs = Date.now() + TOKEN_TTL_MS;
  const token = await signToken({ formId: form.id, email, expiryMs }, env.OTP_SECRET);
  return publicJson({ ok: true, token, email, expires_in: Math.floor(TOKEN_TTL_MS / 1000) });
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
