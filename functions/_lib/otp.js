// Email + SMS OTP helpers: hashing, signed verification tokens, sender
// selection, rate limits, SMTP2GO and Twilio Verify. Shared by the public otp
// endpoints and the submit endpoint, so the rules can never drift apart.

export const OTP_TTL_MS = 10 * 60 * 1000;       // code lifetime
export const TOKEN_TTL_MS = 15 * 60 * 1000;     // verified-email token lifetime
export const MAX_ATTEMPTS = 5;

// Rate limits (mandatory — the start endpoint is an email cannon without them).
export const RESEND_WINDOW_S = 60;              // >= 60s between sends, same form+email
export const PER_EMAIL_PER_HOUR = 5;
export const PER_IP_PER_HOUR = 10;

// Fallback sender local-part/domain. `example.com` is the verified
// SMTP2GO domain (the .com.au is not on the verified list), so a site whose host
// is not allowlisted still sends from a domain SMTP2GO accepts.
export const FALLBACK_SENDER_DOMAIN = 'example.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function validEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

/** The form's OTP-enabled email and phone fields (published config). */
export function otpFields(config) {
  const fields = (config && Array.isArray(config.fields)) ? config.fields : [];
  return fields.filter((f) => f && (f.type === 'email' || f.type === 'phone') && f.otp);
}

/* ---------- phone ---------- */

/** Normalise AU/local and international numbers to E.164. Returns '' if the
 *  number cannot be made into a plausible E.164 value. */
export function normalizePhone(v) {
  let s = String(v || '').trim().replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) {
    s = '+' + s.slice(1).replace(/\D/g, '');
  } else {
    s = s.replace(/\D/g, '');
    if (s.startsWith('00')) s = '+' + s.slice(2);
    else if (s.startsWith('0') && s.length === 10) s = '+61' + s.slice(1);
    else if (s.startsWith('61') && s.length === 11) s = '+' + s;
    else if (s.length === 9 && s.startsWith('4')) s = '+61' + s;
    else s = '+' + s;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : '';
}

export function validPhone(v) {
  return !!normalizePhone(v);
}

/* ---------- hashing / tokens ---------- */

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** SHA-256 hex. The form id and email are part of the input, so a hash is only
 *  meaningful for one form + address (and two forms never share a code space). */
export async function hashCode(formId, email, code) {
  const input = `peak-forms-otp:${formId}:${email}:${code}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(digest);
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

/** Short-lived proof that this form + email were verified. */
export async function signToken({ formId, email, expiryMs }, secret) {
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ f: formId, e: email, x: expiryMs })));
  const sig = await hmacHex(payload, secret);
  return payload + '.' + sig;
}

/** Short-lived proof that this form + phone number were verified. */
export async function signSmsToken({ formId, phone, expiryMs }, secret) {
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({ f: formId, p: phone, x: expiryMs })));
  const sig = await hmacHex(payload, secret);
  return payload + '.' + sig;
}

/** Accepts one token or an array of tokens and returns every valid payload. */
export async function verifyTokens(raw, secret) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
  const out = [];
  for (const t of list) {
    const p = await verifyToken(t, secret);
    if (p) out.push(p);
  }
  return out;
}

/** Returns the payload object, or null when malformed / tampered / unsigned. */
export async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = await hmacHex(parts[0], secret);
  if (expected !== parts[1]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------- sender ---------- */

/**
 * Sender for a form hosted on `pageUrl`: forms@<allowlisted registrable domain>
 * when the page host (or a subdomain) matches an SMTP2GO-verified domain,
 * otherwise forms@<verified fallback>. Never trusts the raw host as a sender.
 */
export function deriveSender(pageUrl, allowlistRaw) {
  const allow = String(allowlistRaw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);

  let host = '';
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch { /* no usable page_url -> fallback */ }

  const hit = allow.find((d) => host === d || host.endsWith('.' + d));
  return 'forms@' + (hit || FALLBACK_SENDER_DOMAIN);
}

/* ---------- SMTP2GO ---------- */

/**
 * Send the code. Returns { ok, status }. The code is never logged and never
 * written anywhere except the hash in D1.
 */
export async function sendOtpEmail(env, { to, sender, code }) {
  const key = env.SMTP2GO_API_KEY;
  if (!key) return { ok: false, status: 0, error: 'missing_api_key' };

  const text = [
    'Your verification code is ' + code,
    '',
    'It expires in 10 minutes. If you did not request it, you can ignore this email.',
  ].join('\n');
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.5">',
    '<p>Your verification code is:</p>',
    '<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0">' + code + '</p>',
    '<p style="color:#64748b">It expires in 10 minutes. If you did not request it, you can ignore this email.</p>',
    '</div>',
  ].join('');

  try {
    const res = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        to: [to],
        sender,
        subject: 'Your verification code',
        text_body: text,
        html_body: html,
      }),
    });
    const out = await res.json().catch(() => ({}));
    const succeeded = out && out.data && Number(out.data.succeeded);
    return { ok: res.ok && succeeded > 0, status: res.status, error: res.ok ? '' : 'send_failed' };
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }
}

/* ---------- Twilio Verify (SMS) ---------- */

function twilioAuth(env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return '';
  return 'Basic ' + btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN);
}

async function twilioPost(env, action, params) {
  const auth = twilioAuth(env);
  if (!auth || !env.TWILIO_VERIFY_SERVICE_SID) {
    return { ok: false, status: 0, error: 'not_configured', body: {} };
  }
  try {
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${encodeURIComponent(env.TWILIO_VERIFY_SERVICE_SID)}${action}`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
      },
    );
    const out = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      body: out,
      error: res.ok ? '' : [out.code, out.message].filter(Boolean).join(' ') || 'twilio_error',
    };
  } catch {
    return { ok: false, status: 0, error: 'network', body: {} };
  }
}

/** Ask Twilio Verify to send an SMS code. The sender number is configured on
 *  the Verify Service; Verify does not accept a per-request From. */
export async function sendSmsOtp(env, phone) {
  const r = await twilioPost(env, '/Verifications', {
    To: phone,
    Channel: 'sms',
  });
  const status = r.body && r.body.status;
  return {
    ok: r.ok && (status === 'pending' || status === 'approved'),
    status: r.status,
    error: r.error,
  };
}

/** Check a code with Twilio Verify. Only `approved` counts as success. */
export async function checkSmsOtp(env, phone, code) {
  const r = await twilioPost(env, '/VerificationCheck', { To: phone, Code: code });
  const status = r.body && r.body.status;
  return {
    ok: r.ok && status === 'approved',
    status: r.status,
    twilioStatus: status || '',
    error: r.error,
  };
}

/* ---------- Turnstile ---------- */

export async function verifyTurnstile(secret, token, ip) {
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

/* ---------- rate limits ---------- */

export async function recentlySent(env, formId, email) {
  const row = await firstRow(
    env,
    `SELECT COUNT(*) AS c FROM email_otps
     WHERE form_id = ? AND email = ? AND created_at > datetime('now', ?)`,
    formId, email, `-${RESEND_WINDOW_S} seconds`,
  );
  return (row && row.c) > 0;
}

export async function hourlyCounts(env, formId, email, ip) {
  const byEmail = await firstRow(
    env,
    `SELECT COUNT(*) AS c FROM email_otps
     WHERE form_id = ? AND email = ? AND created_at > datetime('now', '-1 hour')`,
    formId, email,
  );
  const byIp = ip
    ? await firstRow(
      env,
      `SELECT COUNT(*) AS c FROM email_otps
       WHERE ip = ? AND created_at > datetime('now', '-1 hour')`,
      ip,
    )
    : { c: 0 };
  return { email: (byEmail && byEmail.c) || 0, ip: (byIp && byIp.c) || 0 };
}

export async function recentlySentSms(env, formId, phone) {
  const row = await firstRow(
    env,
    `SELECT COUNT(*) AS c FROM sms_otps
     WHERE form_id = ? AND phone = ? AND created_at > datetime('now', ?)`,
    formId, phone, `-${RESEND_WINDOW_S} seconds`,
  );
  return (row && row.c) > 0;
}

export async function hourlySmsCounts(env, formId, phone, ip) {
  const byPhone = await firstRow(
    env,
    `SELECT COUNT(*) AS c FROM sms_otps
     WHERE form_id = ? AND phone = ? AND created_at > datetime('now', '-1 hour')`,
    formId, phone,
  );
  const byIp = ip
    ? await firstRow(
      env,
      `SELECT COUNT(*) AS c FROM sms_otps
       WHERE ip = ? AND created_at > datetime('now', '-1 hour')`,
      ip,
    )
    : { c: 0 };
  return { phone: (byPhone && byPhone.c) || 0, ip: (byIp && byIp.c) || 0 };
}

// Local import avoids a cycle: db.js has no imports, but keep this file usable
// from both endpoints without duplicating the D1 access.
async function firstRow(env, sql, ...args) {
  const stmt = env.DB.prepare(sql);
  return args.length ? stmt.bind(...args).first() : stmt.first();
}
