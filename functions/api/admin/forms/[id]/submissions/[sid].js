// Admin: delete one submission.
// DELETE /api/admin/forms/:id/submissions/:sid
import { json } from '../../../../../_lib/http.js';
import { first, run } from '../../../../../_lib/db.js';
import { adminGate } from '../../../../../_lib/admin.js';

export const onRequestDelete = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const sub = await first(env, 'SELECT id, form_id FROM submissions WHERE id = ?', params.sid);
  // A submission that belongs to another form is reported as not found, never deleted.
  if (!sub || String(sub.form_id) !== String(params.id)) {
    return json({ error: 'not_found' }, 404);
  }

  await run(env, 'DELETE FROM submissions WHERE id = ?', params.sid);
  return json({ ok: true, id: Number(params.sid) });
};

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405);
