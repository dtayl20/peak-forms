// Quiz / score-band evaluation shared by the submit endpoint.
// The widget carries an identical implementation (it is a standalone IIFE), so
// the on-screen result always matches what the server stores.
import { fieldIsVisible } from './conditional.js';

const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox']);

function text(v) {
  return v === undefined || v === null ? '' : String(v);
}

function optionScore(field, value) {
  const v = text(value).trim();
  if (!v) return 0;
  const opt = (field.options || []).find((o) => o && text(o.value) === v);
  const n = opt ? Number(opt.score) : 0;
  return Number.isFinite(n) ? n : 0;
}

function fieldRange(field) {
  const scores = (field.options || []).map((o) => Number(o && o.score)).filter(Number.isFinite);
  if (!scores.length) return { min: 0, max: 0, scored: false };
  if (field.type === 'checkbox') {
    const max = scores.filter((n) => n > 0).reduce((a, b) => a + b, 0);
    const min = scores.filter((n) => n < 0).reduce((a, b) => a + b, 0);
    return { min, max, scored: true };
  }
  return { min: Math.min(0, ...scores), max: Math.max(0, ...scores), scored: true };
}

/**
 * Sum the points for every visible, non-hidden choice field.
 * `data` is the normalised submission payload (checkbox values may be a JSON
 * string, as they are stored).
 */
export function computeScore(fields, data, config) {
  const d = data || {};
  let points = 0;
  let min = 0;
  let max = 0;
  let scored = false;

  for (const field of fields || []) {
    if (field.hidden || !CHOICE_TYPES.has(field.type)) continue;
    if (config && !fieldIsVisible(field, config, d)) continue;
    const range = fieldRange(field);
    if (!range.scored) continue;
    scored = true;
    min += range.min;
    max += range.max;

    if (field.type === 'checkbox') {
      let arr = d[field.name];
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { arr = []; }
      }
      if (Array.isArray(arr)) {
        for (const v of arr) points += optionScore(field, v);
      }
    } else {
      points += optionScore(field, d[field.name]);
    }
  }

  if (!scored) {
    return { enabled: false, points: 0, percent: 0, min: 0, max: 0, band: null };
  }

  const span = max - min;
  const percent = span > 0
    ? Math.max(0, Math.min(100, Math.round(((points - min) / span) * 100)))
    : 0;

  return { enabled: true, points, percent, min, max, band: null };
}

/** Highest band whose `min` threshold the percentage reaches. */
export function resolveBand(bands, percent) {
  const list = (Array.isArray(bands) ? bands : [])
    .filter((b) => b && typeof b === 'object')
    .slice()
    .sort((a, b) => Number(a.min) - Number(b.min));
  if (!list.length) return null;
  let chosen = list[0];
  for (const b of list) {
    if (Number(b.min) <= percent) chosen = b;
    else break;
  }
  return chosen;
}

/** First selected option carrying a knockoutBand wins. Cosmetic-only answers
 *  and "no super fund" must not be outscored by a healthy balance. */
export function findKnockout(fields, data, config) {
  const d = data || {};
  for (const field of fields || []) {
    if (field.hidden || !CHOICE_TYPES.has(field.type)) continue;
    if (config && !fieldIsVisible(field, config, d)) continue;
    const selected = [];
    if (field.type === 'checkbox') {
      let arr = d[field.name];
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { arr = []; }
      }
      if (Array.isArray(arr)) selected.push(...arr);
    } else if (d[field.name] !== undefined) {
      selected.push(d[field.name]);
    }
    for (const v of selected) {
      const opt = (field.options || []).find((o) => o && text(o.value) === text(v).trim());
      const band = opt && typeof opt.knockoutBand === 'string' ? opt.knockoutBand : '';
      if (band) return band;
    }
  }
  return '';
}

/** Follow-up intent from the selected answers. "no_call" suppresses the call;
 *  everything else (including no answer) is a normal call. */
export function findFollowUp(fields, data, config) {
  const d = data || {};
  for (const field of fields || []) {
    if (field.hidden || !CHOICE_TYPES.has(field.type)) continue;
    if (config && !fieldIsVisible(field, config, d)) continue;
    const selected = [];
    if (field.type === 'checkbox') {
      let arr = d[field.name];
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { arr = []; }
      }
      if (Array.isArray(arr)) selected.push(...arr);
    } else if (d[field.name] !== undefined) {
      selected.push(d[field.name]);
    }
    for (const v of selected) {
      const opt = (field.options || []).find((o) => o && text(o.value) === text(v).trim());
      if (opt && opt.followUp === 'no_call') return 'no_call';
    }
  }
  return 'call';
}

/** Funding route from the selected answers. "plan" means the visitor prefers
 *  a payment plan over super; the band is unchanged, only the result path is. */
export function findRoute(fields, data, config) {
  const d = data || {};
  for (const field of fields || []) {
    if (field.hidden || !CHOICE_TYPES.has(field.type)) continue;
    if (config && !fieldIsVisible(field, config, d)) continue;
    const selected = [];
    if (field.type === 'checkbox') {
      let arr = d[field.name];
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr); } catch { arr = []; }
      }
      if (Array.isArray(arr)) selected.push(...arr);
    } else if (d[field.name] !== undefined) {
      selected.push(d[field.name]);
    }
    for (const v of selected) {
      const opt = (field.options || []).find((o) => o && text(o.value) === text(v).trim());
      if (opt && opt.route === 'plan') return 'plan';
    }
  }
  return '';
}

/** Score + band for a submission. Disabled scoring returns enabled:false. */
export function evaluateScoring(config, data) {
  const settings = (config && config.settings) || {};
  const scoring = settings.scoring || {};
  if (!scoring.enabled) {
    return { enabled: false, points: 0, percent: 0, min: 0, max: 0, band: null, knockout: '' };
  }
  const out = computeScore(config.fields || [], data, config);
  if (!out.enabled) {
    return { enabled: false, points: 0, percent: 0, min: 0, max: 0, band: null, knockout: '' };
  }
  const knockout = findKnockout(config.fields || [], data, config);
  if (knockout) {
    const forced = (scoring.bands || []).find((b) => b && b.key === knockout);
    if (forced) {
      out.band = forced;
      out.knockout = knockout;
      return out;
    }
  }
  out.band = resolveBand(scoring.bands, out.percent);
  out.knockout = '';
  return out;
}

/**
 * Append the result to a redirect URL without disturbing its existing query
 * string. Used for band pages that personalise their copy.
 */
export function decorateRedirect(url, band, percent) {
  const raw = text(url).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://placeholder.invalid');
    if (band && band.key) u.searchParams.set('ff_band', band.key);
    u.searchParams.set('ff_score', String(percent));
    if (raw.startsWith('/')) return u.pathname + u.search + u.hash;
    return u.toString();
  } catch {
    return raw;
  }
}
