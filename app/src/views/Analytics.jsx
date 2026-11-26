import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

function Metric({ label, value, hint, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-900',
    teal: 'text-teal-700',
    amber: 'text-amber-600',
    red: 'text-red-600',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{label}</div>
      <div className={`text-2xl font-bold mt-0.5 ${tones[tone] || tones.slate}`}>{value}</div>
      {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function Bar({ label, value, pct, tone = 'teal' }) {
  const colors = { teal: 'bg-teal-600', slate: 'bg-slate-400', amber: 'bg-amber-500' };
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm mb-1">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="text-slate-500 text-xs">{value} · {pct}%</span>
      </div>
      <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${colors[tone] || colors.teal}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

export default function Analytics({ formId }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api.getAnalytics(formId, days)
      .then((res) => { if (!cancelled) { setData(res); setError(''); } })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [formId, days]);

  if (busy && !data) return <div className="p-8 text-sm text-slate-500 text-center">Loading analytics…</div>;
  if (error) return <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-red-600">{error}</div>;
  if (!data) return null;

  const t = data.totals || {};
  const pages = data.pages || [];
  const daily = data.daily || [];

  if (!t.views) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <p className="text-sm font-semibold text-slate-700">No analytics events in the last {days} days.</p>
        <p className="text-sm text-slate-500">
          Events start flowing once a site embeds the current widget version. A pinned
          <span className="font-mono"> ?v=</span> snippet from before this release sends nothing —
          re-copy the embed snippet from the <b>Embed</b> tab.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">Funnel</h2>
          <p className="text-sm text-slate-500">Anonymous sessions — no cookies, no field values.</p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="Views" value={t.views} hint="widget rendered" />
        <Metric label="Started" value={t.starts} hint={`${t.startPct || 0}% of views`} tone="teal" />
        <Metric label="Submitted" value={t.submits} hint={`${t.completionPct || 0}% of views`} tone="teal" />
        <Metric label="Left after starting" value={t.abandons} hint="closed without submitting" tone={t.abandons ? 'amber' : 'slate'} />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <Bar label="Saw the form" value={t.views} pct={100} tone="slate" />
        <Bar label="Started filling it in" value={t.starts} pct={t.startPct || 0} />
        <Bar label="Submitted" value={t.submits} pct={t.completionPct || 0} />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h3 className="text-sm font-bold text-slate-700">Where they drop off</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {pages.length === 1 ? 'Single-page form.' : `${pages.length} steps.`} Reached counts distinct sessions.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2.5">Step</th>
              <th className="px-4 py-2.5">Title</th>
              <th className="px-4 py-2.5 text-right">Reached</th>
              <th className="px-4 py-2.5 text-right">Dropped here</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.index} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 text-slate-500">{p.index}</td>
                <td className="px-4 py-3 font-medium text-slate-800">{p.title}</td>
                <td className="px-4 py-3 text-right text-slate-700">{p.reached}</td>
                <td className="px-4 py-3 text-right">
                  {p.dropOff ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-700">
                      <span>{p.dropOff}</span>
                      <span className="text-xs text-amber-600">({p.dropOffPct}%)</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {daily.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-bold text-slate-700 mb-3">Daily</h3>
          <div className="flex items-end gap-1 h-28">
            {daily.map((d) => {
              const peak = Math.max(1, ...daily.map((x) => x.views || 0));
              return (
                <div key={d.day} className="flex-1 min-w-0 flex flex-col items-center justify-end gap-0.5" title={`${d.day}: ${d.views} views, ${d.submits} submits`}>
                  <div className="w-full bg-teal-200 rounded-t" style={{ height: `${((d.views || 0) / peak) * 76}px` }} />
                  <div className="w-full bg-teal-700 rounded-b" style={{ height: `${((d.submits || 0) / peak) * 76}px` }} />
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-2">Light = views · dark = submissions</p>
        </div>
      )}
    </div>
  );
}
