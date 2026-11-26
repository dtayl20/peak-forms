// Admin: submissions list + CSV export for one form.
import { json } from '../../../../_lib/http.js';
import { all, first } from '../../../../_lib/db.js';
import { adminGate } from '../../../../_lib/admin.js';
import { parseConfig } from '../../../../_lib/config.js';

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const onRequestGet = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const form = await first(env, 'SELECT * FROM forms WHERE id = ?', params.id);
  if (!form) return json({ error: 'not_found' }, 404);

  const config = parseConfig(form.config);
  const fieldNames = config.fields.filter((f) => !f.hidden).map((f) => f.name);
  const fieldsMeta = config.fields.filter((f) => !f.hidden).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    type: f.type,
    options: (f.options || []).map((o) =>
      o && typeof o === 'object' ? { value: o.value, label: o.label || o.value } : { value: o, label: o },
    ),
  }));
  const url = new URL(request.url);
  const exportCsv = url.searchParams.get('export') === 'csv';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  if (exportCsv) {
    const rows = await all(env, `
      SELECT id, data, page_url, referrer, utm, ip, created_at, spam, email_verified, phone_verified
      FROM submissions WHERE form_id = ? ORDER BY id DESC
    `, form.id);

    let csv = '\uFEFFid,created_at,';
    csv += fieldNames.map(csvEscape).join(',');
    csv += ',page_url,referrer,ip,email_verified,phone_verified\n';

    for (const row of rows) {
      let data = {};
      try { data = JSON.parse(row.data); } catch { /* ignore */ }
      const cells = [row.id, row.created_at];
      for (const name of fieldNames) {
        const raw = data[name];
        cells.push(Array.isArray(raw) ? raw.join('; ') : raw ?? '');
      }
      cells.push(row.page_url || '', row.referrer || '', row.ip || '', row.email_verified ? '1' : '0', row.phone_verified ? '1' : '0');
      csv += cells.map(csvEscape).join(',') + '\n';
    }

    const filename = `${form.slug}-submissions.csv`;
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const rows = await all(env, `
    SELECT id, data, page_url, referrer, utm, ip, ua, created_at, spam, email_verified, phone_verified
    FROM submissions WHERE form_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `, form.id, limit, offset);
  const total = await first(env, 'SELECT COUNT(*) AS c FROM submissions WHERE form_id = ?', form.id);

  const out = rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data); } catch { /* ignore */ }
    let utm = {};
    try { utm = JSON.parse(r.utm); } catch { /* ignore */ }
    return { id: r.id, data, page_url: r.page_url, referrer: r.referrer, utm, ip: r.ip, ua: r.ua, created_at: r.created_at, spam: r.spam ? 1 : 0, email_verified: r.email_verified ? 1 : 0, phone_verified: r.phone_verified ? 1 : 0 };
  });

  return json({ submissions: out, total: total?.c || 0, fieldNames, fields: fieldsMeta, limit, offset });
};
