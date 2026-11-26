// Admin: forms list + create.
import { json, readJson } from '../../_lib/http.js';
import { all, first, run } from '../../_lib/db.js';
import { adminGate } from '../../_lib/admin.js';
import { validSlug, sanitizeConfig, sanitizeSettings, sanitizeNotifications, sanitizePages } from '../../_lib/validate.js';
import { stringifyConfig } from '../../_lib/config.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const rows = await all(env, `
    SELECT f.id, f.site_id, s.name AS site_name, f.slug, f.title, f.status, f.updated_at, f.last_viewed_at,
           (SELECT COUNT(*) FROM submissions sub WHERE sub.form_id = f.id) AS submission_count,
           (SELECT COUNT(*) FROM submissions sub2 WHERE sub2.form_id = f.id
              AND sub2.created_at > datetime('now', '-30 days')) AS submissions_30d,
           (SELECT COUNT(*) FROM submissions sub4 WHERE sub4.form_id = f.id
              AND sub4.created_at > datetime('now', '-7 days')) AS submissions_7d,
           (SELECT COUNT(*) FROM submissions sub6 WHERE sub6.form_id = f.id
              AND sub6.created_at > COALESCE(NULLIF(f.last_viewed_at, ''), datetime('now', '-7 days'))) AS new_count,
           (SELECT MAX(sub5.created_at) FROM submissions sub5 WHERE sub5.form_id = f.id) AS last_submission_at,
           (SELECT COUNT(DISTINCT e.session_id) FROM form_events e
              WHERE e.form_id = f.id AND e.event = 'view'
                AND e.created_at > datetime('now', '-30 days')) AS views_30d
    FROM forms f JOIN sites s ON s.id = f.site_id
    ORDER BY f.updated_at DESC
  `);
  return json({ forms: rows });
};

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const body = await readJson(request);
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '';
  let slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const siteId = Number(body?.site_id);

  if (!title) return json({ error: 'Title is required.' }, 400);
  if (!Number.isInteger(siteId) || siteId < 1) return json({ error: 'A site is required.' }, 400);

  if (!slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  if (!validSlug(slug)) {
    return json({ error: 'Slug must start with a letter or number and use only lowercase letters, numbers and dashes.' }, 400);
  }
  const site = await first(env, 'SELECT id FROM sites WHERE id = ?', siteId);
  if (!site) return json({ error: 'Site not found.' }, 404);
  const exists = await first(env, 'SELECT id FROM forms WHERE slug = ?', slug);
  if (exists) return json({ error: 'A form with that slug already exists.' }, 409);

  const pagesRaw = Array.isArray(body.config?.pages) ? body.config.pages : [];
  const fields = sanitizeConfig(body.config?.fields, pagesRaw.length);
  const pages = sanitizePages(pagesRaw, fields);
  const config = stringifyConfig(
    fields,
    sanitizeSettings(body.config?.settings),
    sanitizeNotifications(body.config?.notifications),
    pages
  );
  const status = body.status === 'published' ? 'published' : 'draft';

  const res = await run(
    env,
    'INSERT INTO forms (site_id, slug, title, config, status) VALUES (?, ?, ?, ?, ?)',
    siteId, slug, title, config, status
  );
  const form = await first(env, 'SELECT * FROM forms WHERE id = ?', res.meta.last_row_id);
  return json({ form }, 201);
};
