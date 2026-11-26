// Admin: mark every form's submissions as read ("Mark all read").
// Optional { site_id } limits it to one site's forms.
import { json, readJson } from '../../_lib/http.js';
import { run } from '../../_lib/db.js';
import { adminGate } from '../../_lib/admin.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const body = await readJson(request).catch(() => ({}));
  const siteId = Number(body && body.site_id);
  if (Number.isInteger(siteId) && siteId > 0) {
    await run(env, "UPDATE forms SET last_viewed_at = datetime('now') WHERE site_id = ?", siteId);
  } else {
    await run(env, "UPDATE forms SET last_viewed_at = datetime('now')");
  }
  return json({ ok: true });
};
