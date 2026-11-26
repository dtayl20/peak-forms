// Admin: sites list + create.
import { json, readJson } from '../../_lib/http.js';
import { all, first, run } from '../../_lib/db.js';
import { adminGate } from '../../_lib/admin.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const rows = await all(env, `
    SELECT s.id, s.name, s.slug, s.created_at,
           (SELECT COUNT(*) FROM forms f WHERE f.site_id = s.id) AS form_count
    FROM sites s ORDER BY s.name
  `);
  return json({ sites: rows });
};

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const body = await readJson(request);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : '';
  let slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!name) return json({ error: 'Name is required.' }, 400);

  if (!slug) {
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return json({ error: 'Slug must be lowercase letters, numbers and dashes.' }, 400);
  }
  const exists = await first(env, 'SELECT id FROM sites WHERE slug = ?', slug);
  if (exists) return json({ error: 'A site with that slug already exists.' }, 409);

  const res = await run(env, 'INSERT INTO sites (name, slug) VALUES (?, ?)', name, slug);
  const site = await first(env, 'SELECT * FROM sites WHERE id = ?', res.meta.last_row_id);
  return json({ site }, 201);
};
