// Admin: view and prune the spam blocklist.
// GET    /api/admin/blocklist
// DELETE /api/admin/blocklist?id=<id>
import { json } from '../../_lib/http.js';
import { all, run } from '../../_lib/db.js';
import { adminGate } from '../../_lib/admin.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const rows = await all(
    env,
    'SELECT id, kind, value, created_at FROM spam_blocklist ORDER BY id DESC LIMIT 500',
  );
  return json({ blocked: rows, total: rows.length });
};

export const onRequestDelete = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const id = new URL(request.url).searchParams.get('id');
  if (!/^[0-9]+$/.test(String(id || ''))) return json({ error: 'bad_request' }, 400);
  await run(env, 'DELETE FROM spam_blocklist WHERE id = ?', id);
  return json({ ok: true, id: Number(id) });
};
