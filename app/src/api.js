// Thin API client for the Peak Forms admin API.

const KEY_STORE = 'pf_admin_key';

export function getKey() {
  return sessionStorage.getItem(KEY_STORE) || '';
}
export function setKey(k) {
  sessionStorage.setItem(KEY_STORE, k);
}
export function clearKey() {
  sessionStorage.removeItem(KEY_STORE);
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const key = getKey();
  if (key) headers['x-admin-key'] = key;

  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    const err = new Error('Cannot reach the API. If developing locally, is `npm run dev:api` running?');
    err.status = 0;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('json');
  const body = isJson
    ? await res.json().catch(() => ({}))
    : await res.blob().catch(() => null);

  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  listSites: () => request('/api/admin/sites'),
  createSite: (payload) => request('/api/admin/sites', { method: 'POST', body: JSON.stringify(payload) }),
  listForms: () => request('/api/admin/forms'),
  markFormSeen: (id) => request(`/api/admin/forms/${id}/seen`, { method: 'POST', body: '{}' }),
  markAllSeen: (siteId) => request('/api/admin/mark-read', { method: 'POST', body: JSON.stringify(siteId ? { site_id: Number(siteId) } : {}) }),
  createForm: (payload) => request('/api/admin/forms', { method: 'POST', body: JSON.stringify(payload) }),
  getForm: (id) => request(`/api/admin/forms/${id}`),
  updateForm: (id, payload) => request(`/api/admin/forms/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  duplicateForm: (id) => request(`/api/admin/forms/${id}/duplicate`, { method: 'POST', body: '{}' }),
  deleteForm: (id) => request(`/api/admin/forms/${id}`, { method: 'DELETE' }),
  getSubmissions: (id, limit = 200) => request(`/api/admin/forms/${id}/submissions?limit=${limit}`),
  getAnalytics: (id, days = 30) => request(`/api/admin/forms/${id}/analytics?days=${days}`),
  deleteSubmission: (id, sid) => request(`/api/admin/forms/${id}/submissions/${sid}`, { method: 'DELETE' }),
  markSpam: (id, sid) => request(`/api/admin/forms/${id}/submissions/${sid}/spam`, { method: 'POST', body: '{}' }),
  listBlocklist: () => request('/api/admin/blocklist'),
  removeBlocklist: (bid) => request(`/api/admin/blocklist?id=${bid}`, { method: 'DELETE' }),
  getSettings: () => request('/api/admin/settings'),
  saveSettings: (payload) => request('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  testWebhook: (payload) => request('/api/admin/webhook-test', { method: 'POST', body: JSON.stringify(payload) }),
  exportCsv: async (id) => {
    const blob = await request(`/api/admin/forms/${id}/submissions?export=csv`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `form-${id}-submissions.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};

export function fmtDate(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return sqlDate;
  return d.toLocaleString();
}

export function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function slugify(s) {
  // Entity slugs (forms/sites): lowercase, dashes only — matches the server rule.
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
