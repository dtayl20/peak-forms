// Admin: per-form funnel analytics (30 days by default).
// Counts are DISTINCT session_id so a visitor who revisits a step is not
// double-counted. Sessions, not people: the id lives in sessionStorage.
import { json } from '../../../../_lib/http.js';
import { all, first } from '../../../../_lib/db.js';
import { adminGate } from '../../../../_lib/admin.js';

export const onRequestGet = async ({ request, env, params }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const formId = Number(params.id);
  if (!Number.isInteger(formId) || formId < 1) return json({ error: 'Bad form id.' }, 400);

  const daysRaw = Number(new URL(request.url).searchParams.get('days') || 30);
  const days = Number.isInteger(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
  const since = `-${days} days`;

  const form = await first(env, 'SELECT id, slug, title, config FROM forms WHERE id = ?', formId);
  if (!form) return json({ error: 'Form not found.' }, 404);

  let meta = [];
  try {
    const cfg = JSON.parse(form.config || '{}');
    meta = Array.isArray(cfg.pages) ? cfg.pages : [];
  } catch { meta = []; }

  const byEvent = await all(
    env,
    `SELECT event, COUNT(DISTINCT session_id) AS n
     FROM form_events
     WHERE form_id = ? AND created_at > datetime('now', ?)
     GROUP BY event`,
    formId, since
  );
  const totals = { views: 0, starts: 0, submits: 0, abandons: 0 };
  byEvent.forEach((r) => {
    if (r.event === 'view') totals.views = r.n;
    else if (r.event === 'start') totals.starts = r.n;
    else if (r.event === 'submit') totals.submits = r.n;
    else if (r.event === 'abandon') totals.abandons = r.n;
  });

  // Sessions that left after starting but never submitted.
  const abandoned = await first(
    env,
    `SELECT COUNT(DISTINCT e.session_id) AS n
     FROM form_events e
     WHERE e.form_id = ? AND e.created_at > datetime('now', ?) AND e.event = 'abandon'
       AND NOT EXISTS (
         SELECT 1 FROM form_events s
         WHERE s.form_id = e.form_id AND s.session_id = e.session_id AND s.event = 'submit'
       )`,
    formId, since
  );

  const maxSteps = await all(
    env,
    `SELECT MAX(step) AS max_step, COUNT(*) AS n
     FROM form_events
     WHERE form_id = ? AND created_at > datetime('now', ?) AND event IN ('view', 'page', 'submit')
     GROUP BY session_id`,
    formId, since
  );
  const reachedByStep = {};
  maxSteps.forEach((r) => {
    const top = Math.max(1, Number(r.max_step) || 1);
    for (let s = 1; s <= top; s += 1) reachedByStep[s] = (reachedByStep[s] || 0) + r.n;
  });

  const pageCount = Math.max(1, meta.length);
  const pages = [];
  for (let i = 0; i < pageCount; i += 1) {
    const reached = reachedByStep[i + 1] || 0;
    const next = i + 1 < pageCount ? (reachedByStep[i + 2] || 0) : totals.submits;
    pages.push({
      index: i + 1,
      title: (meta[i] && meta[i].title) || (pageCount === 1 ? form.title : `Step ${i + 1}`),
      reached,
      dropOff: Math.max(0, reached - next),
      dropOffPct: reached ? Math.round((Math.max(0, reached - next) / reached) * 100) : 0,
    });
  }

  const daily = await all(
    env,
    `SELECT date(created_at) AS day,
            COUNT(DISTINCT CASE WHEN event = 'view' THEN session_id END) AS views,
            COUNT(DISTINCT CASE WHEN event = 'start' THEN session_id END) AS starts,
            COUNT(DISTINCT CASE WHEN event = 'submit' THEN session_id END) AS submits
     FROM form_events
     WHERE form_id = ? AND created_at > datetime('now', ?)
     GROUP BY date(created_at)
     ORDER BY day`,
    formId, since
  );

  return json({
    ok: true,
    days,
    form: { id: form.id, slug: form.slug, title: form.title },
    totals: {
      ...totals,
      abandons: abandoned ? abandoned.n : 0,
      completionPct: totals.views ? Math.round((totals.submits / totals.views) * 100) : 0,
      startPct: totals.views ? Math.round((totals.starts / totals.views) * 100) : 0,
    },
    pages,
    daily,
  });
};
