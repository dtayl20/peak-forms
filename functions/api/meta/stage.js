// GHL -> Meta CRM events.
// Receives a stage change from a GoHighLevel workflow and forwards it to the
// Conversions API as a standard downstream event. Server-side only: the shared
// secret keeps the endpoint from being used by anyone who finds the URL.

const GRAPH_VERSION = 'v21.0';

const STAGES = {
  new_lead: 'Lead',
  new: 'Lead',
  lead: 'Lead',
  qualified: 'CompleteRegistration',
  qualified_lead: 'CompleteRegistration',
  appointment: 'Schedule',
  booked: 'Schedule',
  consult_booked: 'Schedule',
  purchase: 'Purchase',
  won: 'Purchase',
  accepted: 'Purchase',
};

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

function normPhone(v) {
  if (!v) return '';
  let d = String(v).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0') && d.length === 10) d = '61' + d.slice(1);
  return d.length >= 8 ? d : '';
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const onRequestOptions = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-webhook-secret',
    },
  });

export const onRequestPost = async ({ request, env }) => {
  const secret = env.META_CRM_SECRET;
  if (secret) {
    const given = request.headers.get('x-webhook-secret') || '';
    if (given !== secret) return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const token = env.META_CAPI_TOKEN;
  const dataset = env.META_CRM_DATASET_ID || env.META_DATASET_ID;
  if (!token || !dataset) return json({ ok: false, error: 'not_configured' }, 500);

  const url = new URL(request.url);
  const stage = String(body.stage || url.searchParams.get('stage') || '')
    .toLowerCase()
    .trim()
    .replace(/[\s\-]+/g, '_');
  const eventName = STAGES[stage] || (body.event_name ? String(body.event_name) : '');
  if (!eventName) return json({ ok: false, error: 'unknown_stage', stage }, 400);

  const email = normEmail(body.email);
  const phone = normPhone(body.phone);
  if (!email && !phone) return json({ ok: false, error: 'no_identifiers' }, 400);

  const userData = { country: [await sha256('au')] };
  if (email) userData.em = [await sha256(email)];
  if (phone) userData.ph = [await sha256(phone)];
  if (body.first_name) userData.fn = [await sha256(String(body.first_name).trim().toLowerCase())];
  if (body.last_name) userData.ln = [await sha256(String(body.last_name).trim().toLowerCase())];
  if (body.fbp) userData.fbp = String(body.fbp);
  if (body.fbc) userData.fbc = String(body.fbc);
  else if (body.fbclid) userData.fbc = 'fb.1.' + Date.now() + '.' + String(body.fbclid);

  const customData = {};
  if (body.value) {
    customData.value = Number(body.value) || 0;
    customData.currency = String(body.currency || 'AUD');
  }

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: 'ghl-' + (body.contact_id || email || phone) + '-' + stage,
    action_source: 'website',
    event_source_url: body.event_source_url || 'https://dentalscout.com.au/',
    user_data: userData,
    custom_data: customData,
  };

  try {
    const res = await fetch(
      'https://graph.facebook.com/' + GRAPH_VERSION + '/' + dataset + '/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [event], access_token: token }),
      }
    );
    const out = await res.json().catch(() => ({}));
    return json({ ok: res.ok, event: eventName, events_received: out.events_received, error: out.error && out.error.message }, res.ok ? 200 : 502);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
};

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405);
