// POST https://<host>/api/forms/:slug/event — public funnel beacon.
//
// Fire-and-forget telemetry from the widget: view / start / page / submit / abandon.
// Deliberately accepts no field values. Written so one visitor cannot flood D1:
// a per-IP ceiling and a strict event whitelist, and every response is 2xx so a
// beacon failure never surfaces to the visitor.
import { handleOptions, optionsHandler, publicJson, readJson } from '../../../_lib/http.js';
import { first, run } from '../../../_lib/db.js';

const EVENTS = new Set(['view', 'start', 'page', 'submit', 'abandon']);
const MAX_PER_IP_PER_MIN = 240;

export const onRequestPost = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const body = await readJson(request);
  const event = typeof body?.event === 'string' ? body.event : '';
  if (!EVENTS.has(event)) return publicJson({ error: 'bad_event' }, 400);

  const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return publicJson({ error: 'bad_session' }, 400);

  const form = await first(env, 'SELECT id FROM forms WHERE slug = ? AND status = ?', params.slug, 'published');
  if (!form) return publicJson({ ok: true, ignored: 'not_published' }, 202);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 400);

  try {
    const recent = await first(
      env,
      `SELECT COUNT(*) AS n FROM form_events
       WHERE ip = ? AND created_at > datetime('now', '-1 minute')`,
      ip
    );
    if (recent && recent.n >= MAX_PER_IP_PER_MIN) {
      return publicJson({ ok: true, ignored: 'rate_limited' }, 202);
    }
  } catch {
    // A missing table must not turn telemetry into an error on the host page.
    return publicJson({ ok: true, ignored: 'unavailable' }, 202);
  }

  let step = Number(body?.step);
  if (!Number.isInteger(step) || step < 1) step = 1;
  if (step > 100) step = 100;

  const pageUrl = typeof body?.page_url === 'string' ? body.page_url.slice(0, 500) : '';
  const referrer = typeof body?.referrer === 'string' ? body.referrer.slice(0, 500) : '';
  let utm = '{}';
  try {
    utm = JSON.stringify(body?.utm && typeof body.utm === 'object' ? body.utm : {}).slice(0, 2000);
  } catch { utm = '{}'; }

  try {
    await run(
      env,
      `INSERT INTO form_events (form_id, form_slug, session_id, event, step, page_url, referrer, utm, ip, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      form.id, params.slug, sessionId, event, step, pageUrl, referrer, utm, ip, ua
    );
  } catch {
    return publicJson({ ok: true, ignored: 'unavailable' }, 202);
  }

  return publicJson({ ok: true }, 202);
};

export const onRequestOptions = optionsHandler;
