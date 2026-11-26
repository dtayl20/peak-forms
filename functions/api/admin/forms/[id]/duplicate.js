// Admin: duplicate a form as a fresh draft (no submissions copied).
import { json } from '../../../../_lib/http.js';
import { first, run } from '../../../../_lib/db.js';
import { adminGate } from '../../../../_lib/admin.js';
import { parseConfig } from '../../../../_lib/config.js';

export const onRequestPost = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const original = await first(env, 'SELECT * FROM forms WHERE id = ?', params.id);
  if (!original) return json({ error: 'not_found' }, 404);

  const title = `${original.title} copy`.slice(0, 200);
  const root = String(original.slug).replace(/-copy(-\d+)?$/, '').slice(0, 59);
  let slug = `${root}-copy`;
  let n = 1;
  while (await first(env, 'SELECT id FROM forms WHERE slug = ?', slug)) {
    n += 1;
    slug = `${root}-copy-${n}`;
  }

  const res = await run(
    env,
    "INSERT INTO forms (site_id, slug, title, config, status) VALUES (?, ?, ?, ?, 'draft')",
    original.site_id, slug, title, original.config,
  );
  const created = await first(
    env,
    'SELECT id, site_id, slug, title, config, status, created_at, updated_at FROM forms WHERE id = ?',
    res.meta.last_row_id,
  );
  return json({ form: { ...created, config: parseConfig(created.config) } }, 201);
};

export const onRequestGet = async () => json({ error: 'method_not_allowed' }, 405);
