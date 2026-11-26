import React, { useEffect, useMemo, useState } from 'react';
import { api, slugify } from '../api.js';

const STATUS_STYLE = {
  published: 'bg-emerald-100 text-emerald-800',
  draft: 'bg-amber-100 text-amber-800',
};

function timeAgo(iso) {
  if (!iso) return '';
  const raw = String(iso);
  const t = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function NewFormModal({ sites, onClose, onCreated }) {
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slugTouched && title) setSlug(slugify(title));
  }, [title, slugTouched]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.createForm({ site_id: Number(siteId), title, slug });
      onCreated(res.form.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-slate-900/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">New form</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Site</label>
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Delivery Deal Enquiry"
              autoFocus
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Slug (used in the embed)</label>
            <input
              value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
              placeholder="delivery-deal"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={busy || !title} className="px-4 py-2 text-sm rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 disabled:opacity-50">
              {busy ? 'Creating…' : 'Create form'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Forms({ openEditor }) {
  const [forms, setForms] = useState([]);
  const [sites, setSites] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [duplicating, setDuplicating] = useState(null);
  const [siteFilter, setSiteFilter] = useState('all');
  const [expanded, setExpanded] = useState({});
  const [markingSeen, setMarkingSeen] = useState(false);

  async function load() {
    try {
      const [f, s] = await Promise.all([api.listForms(), api.listSites()]);
      setForms(f.forms || []);
      setSites(s.sites || []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Site folders: ordered by the Sites list, each holding its own forms.
  const groups = useMemo(() => {
    const byId = new Map();
    sites.forEach((s) => byId.set(s.id, { site: s, forms: [] }));
    forms.forEach((f) => {
      if (!byId.has(f.site_id)) {
        byId.set(f.site_id, { site: { id: f.site_id, name: f.site_name || 'Unassigned', slug: '' }, forms: [] });
      }
      byId.get(f.site_id).forms.push(f);
    });
    const all = Array.from(byId.values());
    if (siteFilter !== 'all') return all.filter((g) => String(g.site.id) === siteFilter);
    return all.filter((g) => g.forms.length);
  }, [forms, sites, siteFilter]);

  const totalForms = forms.length;
  const totalNew = forms.reduce((n, f) => n + (f.new_count || 0), 0);

  async function markAllSeen() {
    if (markingSeen) return;
    setMarkingSeen(true);
    try {
      await api.markAllSeen(siteFilter === 'all' ? null : siteFilter);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setMarkingSeen(false);
    }
  }

  async function remove(form) {
    if (!window.confirm(`Delete "${form.title}" and all ${form.submission_count} submissions? This cannot be undone.`)) return;
    try {
      await api.deleteForm(form.id);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function duplicate(form) {
    if (duplicating) return;
    setDuplicating(form.id);
    try {
      const res = await api.duplicateForm(form.id);
      await load();
      openEditor(res.form.id, 'fields');
    } catch (err) {
      alert(err.message);
    } finally {
      setDuplicating(null);
    }
  }

  function toggle(id) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Forms</h1>
          <p className="text-sm text-slate-500">
            Grouped by site. {totalForms} form{totalForms === 1 ? '' : 's'}.
            {totalNew > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 font-semibold text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {totalNew} new
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {totalNew > 0 && (
            <button
              onClick={markAllSeen}
              disabled={markingSeen}
              title="Clear the green new badges"
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {markingSeen ? 'Clearing…' : 'Mark all read'}
            </button>
          )}
          <select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
            aria-label="Filter by site"
          >
            <option value="all">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button
            onClick={() => setShowNew(true)}
            disabled={!sites.length}
            className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold disabled:opacity-40"
          >
            + New form
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {!sites.length && !busy && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-600">
          No sites yet — add one under <b>Sites</b> first, then create your first form.
        </div>
      )}

      <div className="space-y-4">
        {groups.map(({ site, forms: siteForms }) => {
          const isCollapsed = !expanded[site.id];
          const subs30 = siteForms.reduce((n, f) => n + (f.submissions_30d || 0), 0);
          const views30 = siteForms.reduce((n, f) => n + (f.views_30d || 0), 0);
          const new7 = siteForms.reduce((n, f) => n + (f.new_count || 0), 0);
          return (
            <div key={site.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <button
                onClick={() => toggle(site.id)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200 text-left hover:bg-slate-100/70"
              >
                <span className="text-slate-400 text-xs w-3">{isCollapsed ? '▸' : '▾'}</span>
                <span className="font-bold text-slate-800">{site.name}</span>
                {new7 > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold">
                    {new7} new
                  </span>
                )}
                {site.slug && <span className="font-mono text-[11px] text-slate-400">{site.slug}</span>}
                <span className="ml-auto text-xs text-slate-500">
                  {siteForms.length} form{siteForms.length === 1 ? '' : 's'} · {subs30} subs (30d) · {views30} views (30d)
                </span>
              </button>

              {!isCollapsed && (
                <>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                        <th className="px-4 py-2.5">Form</th>
                        <th className="px-4 py-2.5">Slug</th>
                        <th className="px-4 py-2.5">Status</th>
                        <th className="px-4 py-2.5 text-right">Subs (30d / total)</th>
                        <th className="px-4 py-2.5 text-right">Views (30d)</th>
                        <th className="px-4 py-2.5 text-right">Conv.</th>
                        <th className="px-4 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {siteForms.map((f) => {
                        const views = f.views_30d || 0;
                        const conv = views ? Math.round((f.submissions_30d / views) * 100) : null;
                        return (
                          <tr
                            key={f.id}
                            onClick={(e) => { e.stopPropagation(); openEditor(f.id, 'fields'); }}
                            className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 cursor-pointer"
                          >
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold">{f.title}</span>
                                {f.new_count > 0 && (
                                  <span
                                    title="Submissions since you last viewed this form"
                                    className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold"
                                  >
                                    {f.new_count} new
                                  </span>
                                )}
                              </div>
                              {f.last_submission_at && (
                                <div className="text-[11px] text-slate-400">last {timeAgo(f.last_submission_at)}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-600">{f.slug}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[f.status] || STATUS_STYLE.draft}`}>
                                {f.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-slate-600">
                              {f.submissions_30d} / {f.submission_count}
                            </td>
                            <td className="px-4 py-3 text-right text-slate-600">{views || '—'}</td>
                            <td className="px-4 py-3 text-right text-slate-600">{conv === null ? '—' : `${conv}%`}</td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1.5">
                                <button onClick={() => openEditor(f.id, 'fields')} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200">Edit</button>
                                <button onClick={(e) => { e.stopPropagation(); openEditor(f.id, 'analytics'); }} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200">Analytics</button>
                                <button onClick={(e) => { e.stopPropagation(); openEditor(f.id, 'submissions'); }} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200">Submissions</button>
                                <button onClick={(e) => { e.stopPropagation(); openEditor(f.id, 'embed'); }} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200">Embed</button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); duplicate(f); }}
                                  disabled={!!duplicating}
                                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
                                >
                                  {duplicating === f.id ? 'Copying…' : 'Duplicate'}
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); remove(f); }} className="px-2.5 py-1 rounded-md text-xs font-medium text-red-600 hover:bg-red-50">Delete</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!siteForms.length && (
                        <tr>
                          <td colSpan={7} className="px-4 py-4 text-sm text-slate-500">No forms for this site yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          );
        })}
        {busy && <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">Loading…</div>}
        {!busy && !groups.length && (
          <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500">
            No forms yet. Create one to get started.
          </div>
        )}
      </div>

      {showNew && (
        <NewFormModal
          sites={sites}
          onClose={() => setShowNew(false)}
          onCreated={(id) => openEditor(id, 'fields')}
        />
      )}
    </div>
  );
}
