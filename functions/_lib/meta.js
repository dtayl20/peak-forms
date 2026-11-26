// Meta Conversions API — server-side Lead event for accepted submissions.
// Fire-and-forget: a Meta failure must never affect the visitor's submission.

const GRAPH_VERSION = 'v21.0';

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const data = new TextEncoder().encode(String(value));
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

function normEmail(v) {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  return /.+@.+\..+/.test(s) ? s : '';
}

// Digits only, with Australian country code when a local mobile is given.
function normPhone(v) {
  if (!v) return '';
  let d = String(v).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0') && d.length === 10) d = '61' + d.slice(1);
  if (d.length < 8) return '';
  return d;
}

function normText(v) {
  if (!v) return '';
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Send a Lead event. Returns a small status object; never throws.
 * env.META_CAPI_TOKEN is required; env.META_DATASET_ID defaults below.
 */
export async function sendMetaLead(env, { submissionId, slug, data, pageUrl, ip, ua, cookies, utm, verified }) {
  const token = env.META_CAPI_TOKEN;
  if (!token) return { skipped: 'no_token' };

  // Only verified leads count as a Lead when the form asked for OTP.
  if (env.META_REQUIRE_VERIFIED === 'true' && !verified) {
    return { skipped: 'unverified' };
  }

  const dataset = env.META_DATASET_ID || '1459315656115904';
  const email = normEmail(data.email || data.Email);
  const phone = normPhone(data.phone || data.Phone || data.mobile);

  const userData = {
    client_ip_address: ip || undefined,
    client_user_agent: ua || undefined,
    country: await sha256('au'),
  };
  if (email) userData.em = [await sha256(email)];
  if (phone) userData.ph = [await sha256(phone)];
  const fn = normText(data.first_name || data.fname || data.firstName);
  const ln = normText(data.last_name || data.lname || data.lastName);
  if (fn) userData.fn = [await sha256(fn)];
  if (ln) userData.ln = [await sha256(ln)];
  const ct = normText(data.suburb || data.city);
  const st = normText(data.state);
  const zp = normText(data.postcode || data.zip);
  if (ct) userData.ct = [await sha256(ct)];
  if (st) userData.st = [await sha256(st)];
  if (zp) userData.zp = [await sha256(zp)];

  // Browser identifiers: prefer cookies, fall back to the captured fbclid.
  const cookie = String(cookies || '');
  const fbp = (cookie.match(/(?:^|;\s*)_fbp=([^;]+)/) || [])[1];
  let fbc = (cookie.match(/(?:^|;\s*)_fbc=([^;]+)/) || [])[1];
  if (!fbc && utm && utm.fbclid) {
    fbc = 'fb.1.' + Date.now() + '.' + String(utm.fbclid);
  }
  if (fbp) userData.fbp = decodeURIComponent(fbp);
  if (fbc) userData.fbc = decodeURIComponent(fbc);

  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: 'pf-' + String(submissionId),
    action_source: 'website',
    event_source_url: pageUrl || undefined,
    user_data: userData,
    custom_data: { content_name: 'website_form', lead_type: 'website_form' },
  };

  try {
    const res = await fetch(
      'https://graph.facebook.com/' + GRAPH_VERSION + '/' + dataset + '/events?access_token=' + encodeURIComponent(token),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [event] }),
      }
    );
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, events_received: body.events_received, error: body.error && body.error.message };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
