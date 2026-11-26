// POST /api/forms/:slug/otp/start — public: email a 6-digit verification code.
//
// Answer shape is constant ({ok:true}) for every condition that could reveal
// anything about an address or the rate state. Only a form with no OTP-enabled
// email field answers 404, and a failed Turnstile answers 400 — neither depends
// on whether a particular address exists.
import { handleOptions, publicJson, readJson, optionsHandler } from '../../../../_lib/http.js';
import { first, run } from '../../../../_lib/db.js';
import { parseConfig } from '../../../../_lib/config.js';
import {
  OTP_TTL_MS,
  PER_EMAIL_PER_HOUR,
  PER_IP_PER_HOUR,
  hashCode,
  hourlyCounts,
  normalizeEmail,
  otpFields,
  recentlySent,
  sendOtpEmail,
  deriveSender,
  validEmail,
  verifyTurnstile,
} from '../../../../_lib/otp.js';

function sixDigits() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

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

  const body = (await readJson(request)) || {};
  const email = normalizeEmail(body.email);
  const pageUrl = typeof body.page_url === 'string' ? body.page_url : '';
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

  // Constant answer from here on: malformed address, throttled, or sent all
  // look identical to the caller.
  if (!validEmail(email)) return publicJson({ ok: true });
  if (!env.OTP_SECRET) {
    // Without a signing secret a token could never be accepted; fail closed and
    // report the misconfiguration to the operator, not to the visitor.
    console.error('otp/start: OTP_SECRET is not configured');
    return publicJson({ ok: true });
  }

  if (await recentlySent(env, form.id, email)) return publicJson({ ok: true });

  const counts = await hourlyCounts(env, form.id, email, ip);
  if (counts.email >= PER_EMAIL_PER_HOUR || counts.ip >= PER_IP_PER_HOUR) {
    return publicJson({ ok: true });
  }

  const code = sixDigits();
  const sender = deriveSender(pageUrl, env.SMTP2GO_SENDER_DOMAINS);
  const sent = await sendOtpEmail(env, { to: email, sender, code });
  if (!sent.ok) {
    // No row on a failed send: the visitor can retry, and no quota is burned.
    console.error('otp/start: SMTP2GO send failed', { status: sent.status, error: sent.error });
    return publicJson({ ok: true });
  }

  await run(
    env,
    `INSERT INTO email_otps (form_id, email, code_hash, expires_at, attempts, used, ip)
     VALUES (?, ?, ?, ?, 0, 0, ?)`,
    form.id, email, await hashCode(form.id, email, code), Date.now() + OTP_TTL_MS, ip,
  );

  return publicJson({ ok: true });
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
