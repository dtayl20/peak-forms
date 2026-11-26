import React, { useEffect, useState } from 'react';
import { api, slugify } from '../api.js';

export default function Sites() {
  const [sites, setSites] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  async function load() {
    try {
      const s = await api.listSites();
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

  useEffect(() => {
    if (!slugTouched && name) setSlug(slugify(name));
  }, [name, slugTouched]);

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    setCreateErr('');
    try {
      await api.createSite({ name, slug });
      setName('');
      setSlug('');
      setSlugTouched(false);
      load();
    } catch (err) {
      setCreateErr(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-xl font-bold">Sites</h1>
        <p className="text-sm text-slate-500">A site groups the forms you build for one client or website.</p>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
        <h2 className="text-sm font-semibold mb-3">Add a site</h2>
        <form onSubmit={create} className="flex gap-3 flex-wrap">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Brisbane Spring Water"
            className="flex-1 min-w-52 border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            value={slug}
            onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
            placeholder="site-slug"
            className="w-44 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <button type="submit" disabled={creating || !name} className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold disabled:opacity-50">
            Add
          </button>
        </form>
        {createErr && <p className="mt-2 text-sm text-red-600">{createErr}</p>}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Slug</th>
              <th className="px-4 py-2.5 text-right">Forms</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-semibold">{s.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{s.slug}</td>
                <td className="px-4 py-3 text-right text-slate-600">{s.form_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <div className="p-6 text-sm text-slate-500">Loading…</div>}
        {!busy && !sites.length && <div className="p-6 text-sm text-slate-500">No sites yet.</div>}
      </div>
    </div>
  );
}
