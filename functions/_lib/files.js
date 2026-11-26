// File uploads: R2 holds the bytes, D1 holds metadata and the single-use link
// to a submission. Keep the bucket private; downloads go through an admin route.

import { first, run } from './db.js';

export const FILE_PRESETS = {
  images: {
    label: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  pdf: {
    label: 'PDF',
    extensions: ['pdf'],
    mimes: ['application/pdf'],
  },
  documents: {
    label: 'Documents',
    extensions: ['pdf', 'doc', 'docx'],
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  spreadsheets: {
    label: 'Spreadsheets',
    extensions: ['xls', 'xlsx', 'csv'],
    mimes: [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ],
  },
};

FILE_PRESETS.all = {
  label: 'All safe documents',
  extensions: [...new Set([
    ...FILE_PRESETS.images.extensions,
    ...FILE_PRESETS.documents.extensions,
    ...FILE_PRESETS.spreadsheets.extensions,
  ])],
  mimes: [...new Set([
    ...FILE_PRESETS.images.mimes,
    ...FILE_PRESETS.documents.mimes,
    ...FILE_PRESETS.spreadsheets.mimes,
  ])],
};

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

export function filePreset(name) {
  return FILE_PRESETS[name] || FILE_PRESETS.all;
}

export function fileAccept(field) {
  const p = filePreset(field && field.accept);
  return p.extensions.map((e) => '.' + e).concat(p.mimes).join(',');
}

export function fileMaxBytes(field) {
  const mb = Math.min(25, Math.max(1, Number(field && field.maxSizeMb) || 10));
  return Math.round(mb * 1024 * 1024);
}

export function getUploadBucket(env) {
  return env.UPLOADS || env.FORM_UPLOADS || env.form_uploads || env.FORM_UPLOADS_BUCKET || null;
}

function extensionOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function validateFileUpload(file, field) {
  const preset = filePreset(field && field.accept);
  const ext = extensionOf(file.name);
  const mime = String(file.type || '').toLowerCase();
  if (!ext || !preset.extensions.includes(ext)) {
    return `Please upload a ${preset.label.toLowerCase()} file.`;
  }
  if (mime && !preset.mimes.includes(mime)) {
    return 'That file type is not allowed.';
  }
  if (!file.size || file.size > fileMaxBytes(field)) {
    return `File is too large (max ${Math.min(25, Math.max(1, Number(field && field.maxSizeMb) || 10))} MB).`;
  }
  return null;
}

function safeFilename(name) {
  return String(name || 'upload')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .slice(0, 180) || 'upload';
}

function safeContentType(file, ext) {
  const mime = String(file.type || '').toLowerCase();
  return MIME_BY_EXT[ext] || (mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) ? mime : 'application/octet-stream');
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function storeUpload(env, { formId, field, file, ip }) {
  const bucket = getUploadBucket(env);
  if (!bucket) return { error: 'storage_not_configured' };

  const ext = extensionOf(file.name);
  const now = new Date();
  const key = [
    'uploads',
    String(formId),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${crypto.randomUUID()}.${ext}`,
  ].join('/');
  const contentType = safeContentType(file, ext);
  const originalName = safeFilename(file.name);

  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType },
    customMetadata: { formId: String(formId), field: field.name, originalName },
  });

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const res = await run(
    env,
    `INSERT INTO form_files
       (form_id, field_name, object_key, original_name, content_type, size, ip, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    formId, field.name, key, originalName, contentType, file.size, ip || '',
    await tokenHash(token), Date.now() + 60 * 60 * 1000,
  );

  return {
    file: {
      id: res.meta.last_row_id,
      token,
      name: originalName,
      size: Number(file.size) || 0,
      type: contentType,
    },
  };
}

export async function resolveUpload(env, { formId, fieldName, ref }) {
  if (!ref || typeof ref !== 'object' || !Number.isInteger(Number(ref.id)) || typeof ref.token !== 'string') return null;
  const row = await first(
    env,
    `SELECT * FROM form_files
     WHERE id = ? AND form_id = ? AND field_name = ? AND used = 0 AND expires_at > ?`,
    Number(ref.id), formId, fieldName, Date.now(),
  );
  if (!row) return null;
  if (await tokenHash(ref.token) !== row.token_hash) return null;
  return row;
}

export async function markUploadUsed(env, id, submissionId) {
  await run(env, 'UPDATE form_files SET used = 1, submission_id = ? WHERE id = ?', submissionId, id);
}
