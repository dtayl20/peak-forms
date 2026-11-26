// GET https://<host>/api/forms/:slug — public form config (published forms only).
import { handleOptions, publicJson, optionsHandler } from '../../_lib/http.js';
import { first } from '../../_lib/db.js';
import { publicForm } from '../../_lib/config.js';
import { getAppSettings } from '../../_lib/settings.js';

export const onRequestGet = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }
  // Consent wording is resolved here (per-form override -> global default -> built-in)
  // so the widget always receives a non-empty notice to show.
  const globalDefaults = await getAppSettings(env);
  return publicJson(publicForm(form, globalDefaults));
};

export const onRequestPost = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
