// GET /api/admin/files/:id — authenticated download of an uploaded file.
import { json } from '../../../_lib/http.js';
import { first } from '../../../_lib/db.js';
import { adminGate } from '../../../_lib/admin.js';
import { getUploadBucket } from '../../../_lib/files.js';

function safeFilename(name) {
  return String(name || 'download').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 180) || 'download';
}

export const onRequestGet = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const row = await first(env, 'SELECT * FROM form_files WHERE id = ?', params.id);
  if (!row) return json({ error: 'not_found' }, 404);

  const bucket = getUploadBucket(env);
  if (!bucket) return json({ error: 'storage_not_configured' }, 503);

  const object = await bucket.get(row.object_key);
  if (!object) return json({ error: 'not_found' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeFilename(row.original_name)}"`,
      'Content-Length': String(row.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0',
    },
  });
};

export const onRequestGetOptions = async () => json({ error: 'method_not_allowed' }, 405);
