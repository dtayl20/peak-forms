// Admin: single form get / update / delete.
import { json, readJson } from '../../../_lib/http.js';
import { first, run } from '../../../_lib/db.js';
import { adminGate } from '../../../_lib/admin.js';
import { validSlug, sanitizeConfig, sanitizeSettings, sanitizeNotifications, sanitizePages } from '../../../_lib/validate.js';
import { parseConfig, stringifyConfig } from '../../../_lib/config.js';

export const onRequestGet = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const form = await first(env, 'SELECT * FROM forms WHERE id = ?', params.id);
  if (!form) return json({ error: 'not_found' }, 404);
  const config = parseConfig(form.config);
  return json({ form: { ...form, config } });
};

export const onRequestPut = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const form = await first(env, 'SELECT * FROM forms WHERE id = ?', params.id);
  if (!form) return json({ error: 'not_found' }, 404);

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400);

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : form.title;
  let slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : form.slug;
  if (!validSlug(slug)) return json({ error: 'Invalid slug.' }, 400);
  if (slug !== form.slug) {
    const clash = await first(env, 'SELECT id FROM forms WHERE slug = ? AND id != ?', slug, form.id);
    if (clash) return json({ error: 'A form with that slug already exists.' }, 409);
  }

  const rawConfig = body.config && typeof body.config === 'object' ? body.config : parseConfig(form.config);
  // When a client omits .pages, keep the stored pages (don't silently flatten).
  const existingPages = parseConfig(form.config).pages;
  const pagesRaw = Array.isArray(rawConfig.pages) ? rawConfig.pages : existingPages;
  const fields = sanitizeConfig(rawConfig.fields, pagesRaw.length);
  const pages = sanitizePages(pagesRaw, fields);
  const config = stringifyConfig(
    fields,
    sanitizeSettings(rawConfig.settings),
    sanitizeNotifications(rawConfig.notifications),
    pages
  );
  const status = body.status === 'published' || body.status === 'draft' ? body.status : form.status;

  await run(
    env,
    "UPDATE forms SET title = ?, slug = ?, config = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
    title, slug, config, status, form.id
  );
  const updated = await first(env, 'SELECT * FROM forms WHERE id = ?', form.id);
  return json({ form: { ...updated, config: parseConfig(updated.config) } });
};

export const onRequestDelete = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const form = await first(env, 'SELECT id FROM forms WHERE id = ?', params.id);
  if (!form) return json({ error: 'not_found' }, 404);
  await run(env, 'DELETE FROM submissions WHERE form_id = ?', params.id);
  await run(env, 'DELETE FROM forms WHERE id = ?', params.id);
  return json({ ok: true });
};
