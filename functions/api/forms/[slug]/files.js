// POST /api/forms/:slug/files — public upload endpoint.
// Multipart form: field=<field name>, file=<File>. Returns a single-use file
// token that the submit endpoint exchanges for a submission link.
import { handleOptions, publicJson, optionsHandler } from '../../../_lib/http.js';
import { first } from '../../../_lib/db.js';
import { parseConfig } from '../../../_lib/config.js';
import {
  getUploadBucket,
  storeUpload,
  validateFileUpload,
} from '../../../_lib/files.js';

const MAX_UPLOADS_PER_IP_HOUR = 20;

export const onRequestPost = async ({ request, env, params }) => {
  const opts = handleOptions(request);
  if (opts) return opts;

  const form = await first(env, 'SELECT * FROM forms WHERE slug = ?', params.slug);
  if (!form || form.status !== 'published') {
    return publicJson({ error: 'not_found' }, 404);
  }

  const config = parseConfig(form.config);
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return publicJson({ error: 'bad_request' }, 400);
  }

  const fieldName = String(formData.get('field') || '');
  const field = (config.fields || []).find((f) => f.name === fieldName && f.type === 'file');
  if (!field) return publicJson({ error: 'invalid_field' }, 400);

  if (!getUploadBucket(env)) {
    console.error('files/upload: no R2 binding (expected UPLOADS)');
    return publicJson({ error: 'storage_not_configured' }, 503);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string' || !file.size) {
    return publicJson({ error: 'no_file' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const recent = await first(
    env,
    `SELECT COUNT(*) AS c FROM form_files
     WHERE ip = ? AND created_at > datetime('now', '-1 hour')`,
    ip,
  );
  if (recent && recent.c >= MAX_UPLOADS_PER_IP_HOUR) {
    return publicJson({ error: 'rate_limited' }, 429);
  }

  const invalid = validateFileUpload(file, field);
  if (invalid) {
    return publicJson({ error: 'invalid_file', message: invalid }, 400);
  }

  try {
    const result = await storeUpload(env, { formId: form.id, field, file, ip });
    if (result.error) return publicJson({ error: result.error }, 503);
    return publicJson({ ok: true, file: result.file }, 201);
  } catch (err) {
    console.error('files/upload: R2/D1 write failed', { message: err && err.message });
    return publicJson({ error: 'upload_failed' }, 500);
  }
};

export const onRequestGet = async () => publicJson({ error: 'method_not_allowed' }, 405);

export const onRequestOptions = optionsHandler;
