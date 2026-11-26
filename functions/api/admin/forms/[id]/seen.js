// Admin: mark a form's submissions as read (clears its "new" chip).
import { json } from '../../../../_lib/http.js';
import { first, run } from '../../../../_lib/db.js';
import { adminGate } from '../../../../_lib/admin.js';

export const onRequestPost = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const form = await first(env, 'SELECT id FROM forms WHERE id = ?', params.id);
  if (!form) return json({ error: 'not_found' }, 404);

  await run(env, "UPDATE forms SET last_viewed_at = datetime('now') WHERE id = ?", form.id);
  return json({ ok: true });
};

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405);
