// Admin: mark one submission as spam and add its email + IP to the blocklist.
// POST /api/admin/forms/:id/submissions/:sid/spam
//
// Blocked senders are silently accepted by the public submit endpoint (ok:true, id:0):
// nothing is stored and no webhook fires, so a spammer sees no signal.
import { json } from '../../../../../../_lib/http.js';
import { first, run } from '../../../../../../_lib/db.js';
import { adminGate } from '../../../../../../_lib/admin.js';

function emailFrom(dataJson) {
  try {
    const d = JSON.parse(dataJson || '{}');
    for (const v of Object.values(d)) {
      if (typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) {
        return v.trim().toLowerCase();
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

export const onRequestPost = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const sub = await first(
    env,
    'SELECT id, form_id, data, ip FROM submissions WHERE id = ?',
    params.sid,
  );
  if (!sub || String(sub.form_id) !== String(params.id)) {
    return json({ error: 'not_found' }, 404);
  }

  await run(env, 'UPDATE submissions SET spam = 1 WHERE id = ?', params.sid);

  const now = new Date().toISOString();
  const entries = [];
  const email = emailFrom(sub.data);
  if (email) entries.push(['email', email]);
  if (sub.ip) entries.push(['ip', String(sub.ip).trim()]);

  for (const [kind, value] of entries) {
    await run(
      env,
      'INSERT OR IGNORE INTO spam_blocklist (kind, value, created_at) VALUES (?, ?, ?)',
      kind,
      value,
      now,
    );
  }

  return json({
    ok: true,
    id: Number(params.sid),
    blocked: entries.map(([k, v]) => `${k}:${v}`),
  });
};

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405);
