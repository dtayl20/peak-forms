/*!
 * Peak Forms widget — renders a form from a Cloudflare-hosted config and POSTs
 * submissions back to the API. Works on any site (static, WP, whatever) because
 * it owns its own DOM + styles inside a Shadow Root.
 *
 * Usage:
 *   <div data-ff-form="delivery-deal"></div>
 *   <script src="https://forms.example.com/widget.js?v=<version>"
 *           data-ff-origin="https://forms.example.com"
 *           data-no-optimize="1" data-cfasync="false" async></script>
 *
 * The API origin is resolved explicitly (see apiOrigin()): a data-ff-origin attribute,
 * else this script's own src when it is an absolute URL on another host, else the
 * hard-coded forms host. It NEVER falls back to the embedding page's origin.
 *
 * Multi-page forms: when the published config has more than one entry in
 * config.pages, the widget renders one page at a time with Next / Back. Each
 * page is validated before advancing. Single-page (or legacy no-pages) configs
 * render exactly as before — one long form. All pages stay in the DOM, so
 * values survive Back/Next navigation.
 *
 * Events (so GTM / Facebook Pixel on the host page can track):
 *   - dataLayer.push({event: <form setting dataLayerEvent>, form: '<slug>', ...data})
 *   - CustomEvent 'ff:submit' on the host div: { detail: { slug, data } }
 *   - window.FF.onSubmit(slug, data) if defined
 */
(function () {
  'use strict';

  // Canonical API host. Used when the script's own src cannot be trusted (bundled,
  // inlined, or served from the page's own host by an optimiser). NEVER fall back
  // to window.location.origin — a relative/same-host src means the fetch would hit
  // the embedding page and 404.
  var DEFAULT_API_ORIGIN = 'https://forms.example.com';

  var API_ORIGIN = null;

  function pageHost() {
    try { return window.location.host; } catch (e) { return ''; }
  }

  function apiOrigin() {
    if (API_ORIGIN) return API_ORIGIN;

    var el = null;
    try { el = document.currentScript || null; } catch (e) { el = null; }
    // When an optimiser inlined/combined the script, currentScript is null (or points
    // at a bundle on the page's host). Look for our own explicit marker instead.
    if (!el) {
      try { el = document.querySelector('script[data-ff-origin]'); } catch (e) { el = null; }
    }

    // (a) explicit override on our script tag — wins over everything.
    if (el) {
      try {
        var explicit = el.getAttribute && el.getAttribute('data-ff-origin');
        if (explicit) {
          var eu = new URL(explicit, window.location.href);
          if (eu.protocol === 'http:' || eu.protocol === 'https:') API_ORIGIN = eu.origin;
        }
      } catch (e) { /* ignore */ }
    }

    // (b) the script's own src — only when it is an absolute http(s) URL on a
    // DIFFERENT host than the embedding page. A relative src, or one on the page's
    // own host, is exactly the optimiser case and must NOT be used.
    if (!API_ORIGIN && el) {
      try {
        if (el.src) {
          var su = new URL(el.src); // throws on a relative src -> falls through
          if ((su.protocol === 'http:' || su.protocol === 'https:') && su.host && su.host !== pageHost()) {
            API_ORIGIN = su.origin;
          }
        }
      } catch (e) { /* ignore */ }
    }

    // (c) hard-coded default — the point of the whole change.
    if (!API_ORIGIN) API_ORIGIN = DEFAULT_API_ORIGIN;
    return API_ORIGIN;
  }

  // Build version. Stamped into dist/widget.js by scripts/after-build.mjs at deploy
  // time (source keeps the sentinel so git stays clean). The embed URL carries
  // widget.js?v=<version> so a cached old copy is identifiable and can never be
  // paired with a new API by accident.
  var WIDGET_VERSION = '__FF_BUILD_VERSION__';

  // ---- small helpers ---------------------------------------------------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Unique per request: no browser, service-worker or edge cache can answer a
  // request that carries a fresh token with a stale body.
  function cacheBust() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // Record the last failure somewhere reachable without DevTools archaeology.
  function recordFailure(rec) {
    window.FF = window.FF || {};
    window.FF.lastError = rec;
    return rec;
  }

  var turnstileState = { scriptLoaded: false, queue: [] };

  function loadTurnstile(cb) {
    if (window.turnstile) return cb();
    turnstileState.queue.push(cb);
    if (turnstileState.scriptLoaded) return;
    turnstileState.scriptLoaded = true;
    var el = document.createElement('script');
    el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    el.async = true;
    el.onload = function () {
      turnstileState.queue.splice(0).forEach(function (fn) { fn(); });
    };
    document.head.appendChild(el);
  }

  function escAttr(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ----- conditional logic (mirrors functions/_lib/conditional.js) ----- */
  function condText(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  function condEmpty(v) {
    if (Object.prototype.toString.call(v) === '[object Array]') return v.length === 0;
    return condText(v).trim() === '';
  }

  function condRuleMatches(rule, data) {
    if (!rule || !rule.field) return false;
    var op = rule.operator || 'is';
    var raw = data ? data[rule.field] : undefined;
    var value = condText(rule.value).trim().toLowerCase();

    if (op === 'is_empty') return condEmpty(raw);
    if (op === 'is_not_empty') return !condEmpty(raw);

    if (Object.prototype.toString.call(raw) === '[object Array]') {
      var arr = raw.map(function (x) { return condText(x).toLowerCase(); });
      if (op === 'is' || op === 'contains') return arr.indexOf(value) !== -1;
      if (op === 'is_not' || op === 'not_contains') return arr.indexOf(value) === -1;
      var joined = arr.join(',');
      if (op === 'starts_with') return joined.indexOf(value) === 0;
      if (op === 'ends_with') return joined.slice(-value.length) === value;
      return false;
    }

    var v = condText(raw).trim().toLowerCase();
    if (op === 'is') return v === value;
    if (op === 'is_not') return v !== value;
    if (op === 'contains') return v.indexOf(value) !== -1;
    if (op === 'not_contains') return v.indexOf(value) === -1;
    if (op === 'starts_with') return v.indexOf(value) === 0;
    if (op === 'ends_with') return v.slice(-value.length) === value;
    if (op === 'greater_than' || op === 'less_than') {
      var a = Number(v), b = Number(value);
      var cmp = (isFinite(a) && isFinite(b)) ? (a - b) : (v < value ? -1 : v > value ? 1 : 0);
      return op === 'greater_than' ? cmp > 0 : cmp < 0;
    }
    return false;
  }

  function condVisible(cond, data) {
    if (!cond || !cond.enabled) return true;
    var rules = Object.prototype.toString.call(cond.rules) === '[object Array]' ? cond.rules : [];
    if (!rules.length) return true;
    var matched = cond.match === 'any'
      ? rules.some(function (r) { return condRuleMatches(r, data); })
      : rules.every(function (r) { return condRuleMatches(r, data); });
    return cond.action === 'hide' ? !matched : matched;
  }

  // ---- quiz scoring (mirror of functions/_lib/scoring.js) -------------------
  var SCORE_TYPES = { select: 1, radio: 1, checkbox: 1 };

  function scoreNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function optionPoints(field, value) {
    var v = value === undefined || value === null ? '' : String(value).trim();
    if (!v) return 0;
    var opts = field.options || [];
    for (var i = 0; i < opts.length; i += 1) {
      if (opts[i] && String(opts[i].value) === v) return scoreNum(opts[i].score);
    }
    return 0;
  }

  function fieldScoreRange(field) {
    var opts = field.options || [];
    var min = 0, max = 0, seen = false;
    if (field.type === 'checkbox') {
      for (var i = 0; i < opts.length; i += 1) {
        var n = scoreNum(opts[i] && opts[i].score);
        if (n > 0) max += n;
        else if (n < 0) min += n;
        seen = true;
      }
      return { min: min, max: max, seen: seen };
    }
    for (var j = 0; j < opts.length; j += 1) {
      var s = scoreNum(opts[j] && opts[j].score);
      if (s < min) min = s;
      if (s > max) max = s;
      seen = true;
    }
    return { min: min, max: max, seen: seen };
  }

  function computeScore(fields, data, isVisible) {
    var points = 0, min = 0, max = 0, scored = false;
    (fields || []).forEach(function (field) {
      if (!field || field.hidden || !SCORE_TYPES[field.type]) return;
      if (isVisible && !isVisible(field)) return;
      var range = fieldScoreRange(field);
      if (!range.seen) return;
      scored = true;
      min += range.min;
      max += range.max;
      if (field.type === 'checkbox') {
        var arr = data ? data[field.name] : null;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
        if (Object.prototype.toString.call(arr) === '[object Array]') {
          arr.forEach(function (v) { points += optionPoints(field, v); });
        }
      } else {
        points += optionPoints(field, data ? data[field.name] : '');
      }
    });
    var span = max - min;
    var percent = !scored ? 0 : (span > 0 ? Math.max(0, Math.min(100, Math.round(((points - min) / span) * 100))) : 0);
    return { enabled: scored, points: points, percent: percent, min: min, max: max };
  }

  function resolveBand(bands, percent) {
    var list = (Object.prototype.toString.call(bands) === '[object Array]' ? bands : [])
      .slice()
      .sort(function (a, b) { return scoreNum(a.min) - scoreNum(b.min); });
    if (!list.length) return null;
    var chosen = list[0];
    for (var i = 0; i < list.length; i += 1) {
      if (scoreNum(list[i].min) <= percent) chosen = list[i];
      else break;
    }
    return chosen;
  }

  function findKnockout(fields, data, isVisible) {
    var found = '';
    (fields || []).forEach(function (field) {
      if (found || !field || field.hidden || !SCORE_TYPES[field.type]) return;
      if (isVisible && !isVisible(field)) return;
      var selected = [];
      if (field.type === 'checkbox') {
        var arr = data ? data[field.name] : null;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
        if (Object.prototype.toString.call(arr) === '[object Array]') selected = arr;
      } else if (data && data[field.name] !== undefined) {
        selected = [data[field.name]];
      }
      for (var i = 0; i < selected.length; i += 1) {
        var opts = field.options || [];
        for (var j = 0; j < opts.length; j += 1) {
          if (opts[j] && String(opts[j].value) === String(selected[i]).trim() && opts[j].knockoutBand) {
            found = String(opts[j].knockoutBand);
            return;
          }
        }
      }
    });
    return found;
  }

  function findRoute(fields, data, isVisible) {
    var route = '';
    (fields || []).forEach(function (field) {
      if (route || !field || field.hidden || !SCORE_TYPES[field.type]) return;
      if (isVisible && !isVisible(field)) return;
      var selected = [];
      if (field.type === 'checkbox') {
        var arr = data ? data[field.name] : null;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
        if (Object.prototype.toString.call(arr) === '[object Array]') selected = arr;
      } else if (data && data[field.name] !== undefined) {
        selected = [data[field.name]];
      }
      for (var i = 0; i < selected.length; i += 1) {
        var opts = field.options || [];
        for (var j = 0; j < opts.length; j += 1) {
          if (opts[j] && String(opts[j].value) === String(selected[i]).trim() && opts[j].route === 'plan') {
            route = 'plan';
            return;
          }
        }
      }
    });
    return route;
  }

  function findFollowUp(fields, data, isVisible) {
    var noCall = false;
    (fields || []).forEach(function (field) {
      if (noCall || !field || field.hidden || !SCORE_TYPES[field.type]) return;
      if (isVisible && !isVisible(field)) return;
      var selected = [];
      if (field.type === 'checkbox') {
        var arr = data ? data[field.name] : null;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
        if (Object.prototype.toString.call(arr) === '[object Array]') selected = arr;
      } else if (data && data[field.name] !== undefined) {
        selected = [data[field.name]];
      }
      for (var i = 0; i < selected.length; i += 1) {
        var opts = field.options || [];
        for (var j = 0; j < opts.length; j += 1) {
          if (opts[j] && String(opts[j].value) === String(selected[i]).trim() && opts[j].followUp === 'no_call') {
            noCall = true;
            return;
          }
        }
      }
    });
    return noCall ? 'no_call' : 'call';
  }

  function decorateRedirect(url, band, percent) {
    var raw = url === undefined || url === null ? '' : String(url).trim();
    if (!raw) return '';
    try {
      var isPath = raw.charAt(0) === '/' && raw.charAt(1) !== '/';
      var u = new URL(raw, 'https://placeholder.invalid');
      if (band && band.key) u.searchParams.set('ff_band', band.key);
      u.searchParams.set('ff_score', String(percent));
      return isPath ? (u.pathname + u.search + u.hash) : u.toString();
    } catch (e) {
      return raw;
    }
  }

  function params() {
    try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(); }
  }

  function mergeUtm(defaults, actual) {
    var out = {};
    // Every attribution key the API stores must survive this merge. clinic/gclid used
    // to be captured by utmData() and then silently dropped here, so the webhook
    // never saw them.
    ['source', 'medium', 'campaign', 'term', 'content', 'gclid', 'fbclid', 'clinic'].forEach(function (k) {
      var v = actual && actual[k];
      var d = defaults && defaults[k];
      if (v) out[k] = v;
      else if (d) out[k] = d;
    });
    return out;
  }
  function utmData() {
    var p = params(), out = {};
    ['source', 'medium', 'campaign', 'term', 'content', 'gclid', 'fbclid', 'clinic'].forEach(function (k) {
      var v = p.get('utm_' + k) || (k === 'gclid' || k === 'fbclid' ? (p.get(k) || p.get(k + '_attr')) : p.get(k));
      if (!v && k === 'fbclid') v = p.get('fbclid_attr');
      if (!v && k === 'clinic') v = p.get('clinic_id') || p.get('brand');
      if (v) out[k] = v;
    });
    // Params the site captured on the landing page (ads often land elsewhere, and JS
    // navigation drops the query string) - stored by the site's attribution script.
    try {
      var stored = JSON.parse(sessionStorage.getItem('ds_attr') || '{}') || {};
      ['source', 'medium', 'campaign', 'term', 'content', 'gclid', 'fbclid', 'clinic'].forEach(function (k) {
        if (out[k]) return;
        var v = stored['utm_' + k] || stored[k];
        if (v) out[k] = v;
      });
    } catch (e) { /* storage unavailable - ignore */ }
    return out;
  }

  function defaultStyles(theme) {
    var primary = theme && theme.primary ? theme.primary : '#0f766e';
    var radius = theme && theme.radius ? theme.radius : '8px';
    return [
      ':host { all: initial; display: block; font-family: inherit; color: #0f172a; line-height: 1.5; }',
      '* { box-sizing: border-box; }',
      '.ff-form { display: block; }',
      '.ff-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }',
      '.ff-page-title { font-size: 18px; font-weight: 700; color: #0f172a; margin: 0 0 4px; }',
      '.ff-page-desc { font-size: 14px; color: #475569; margin: 0 0 16px; line-height: 1.5; }',
      '.ff-field { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 5px; }',
      '.ff-field.half { grid-column: span 1; }',
      '.ff-label { font-size: 14px; font-weight: 600; color: #0f172a; }',
      '.ff-label .req { color: #dc2626; margin-left: 2px; }',
      '.ff-help { font-size: 12px; color: #64748b; }',
      '.ff-desc { font-size: 13px; color: #64748b; margin-top: -2px; }',
      '.ff-input, .ff-select, .ff-textarea { width: 100%; font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: ' + radius + '; background: #fff; color: #0f172a; outline: none; transition: border-color .15s, box-shadow .15s; }',
      '.ff-input:focus, .ff-select:focus, .ff-textarea:focus { border-color: ' + primary + '; box-shadow: 0 0 0 3px ' + primary + '26; }',
      '.ff-input.err, .ff-select.err, .ff-textarea.err { border-color: #dc2626; }',
      '.ff-file-status { margin-top: 6px; font-size: 12px; line-height: 1.4; color: #64748b; }',
      '.ff-file-status.err { color: #dc2626; }',
      '.ff-file-status.ok { color: #047857; }',
      '.ff-input.ff-locked, .ff-textarea.ff-locked, .ff-select:disabled { background: #f8fafc; color: #475569; cursor: not-allowed; }',
      '.ff-textarea { min-height: 90px; resize: vertical; }',
      '.ff-options { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }',
      '.ff-options label { display: flex; align-items: center; gap: 8px; font-size: 15px; cursor: pointer; }',
      '.ff-options input { width: 16px; height: 16px; accent-color: ' + primary + '; }',
      '.ff-options.locked { opacity: .85; }',
      '.ff-options.locked label { cursor: default; }',
      '.ff-options a { color: ' + primary + '; text-decoration: underline; }',
      '.ff-err { font-size: 12px; color: #dc2626; display: none; }',
      '.ff-err.show { display: block; }',
      '.ff-otp { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }',
      '.ff-otp-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
      '.ff-otp-btn { font: inherit; font-size: 13px; font-weight: 600; color: ' + primary + '; background: #fff; border: 1px solid ' + primary + '; border-radius: ' + radius + '; padding: 8px 12px; cursor: pointer; white-space: nowrap; }',
      '.ff-otp-btn:disabled { opacity: .55; cursor: default; }',
      '.ff-otp-msg { font-size: 12px; color: #475569; }', '.ff-otp-hint { font-size: 12px; line-height: 1.45; color: #64748b; }',
      '.ff-otp-msg.err { color: #dc2626; }',
      '.ff-otp-msg.ok { color: #15803d; }',
      '.ff-otp-code { display: none; gap: 8px; align-items: center; flex-wrap: wrap; }',
      '.ff-otp-code.show { display: flex; }',
      '.ff-otp-code .ff-input { max-width: 150px; letter-spacing: 3px; }', '.ff-otp-inline { display: flex; gap: 8px; align-items: stretch; }', '.ff-otp-inline .ff-input { flex: 1 1 auto; min-width: 0; }', '.ff-otp-send { flex: 0 0 auto; font: inherit; font-size: 13px; font-weight: 600; padding: 0 14px; border: 1px solid #cbd5e1; border-radius: ' + radius + '; background: #f8fafc; color: ' + primary + '; cursor: pointer; white-space: nowrap; }', '.ff-otp-send:hover { background: #f1f5f9; }', '.ff-field.ff-field-full { grid-column: 1 / -1; }',
      '.ff-nav { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }',
      '.ff-nav-top { display: flex; align-items: center; gap: 10px; }',
      '.ff-step { font-size: 13px; font-weight: 600; color: #64748b; margin-right: auto; }',
      '.ff-back { font: inherit; font-size: 15px; font-weight: 600; color: #334155; background: #fff; border: 1px solid #cbd5e1; border-radius: ' + radius + '; padding: 12px 20px; cursor: pointer; transition: background .15s; }',
      '.ff-back:hover { background: #f8fafc; }',
      '.ff-btn { width: 100%; display: block; font: inherit; font-size: 16px; font-weight: 600; color: #fff; background: ' + primary + '; border: 0; border-radius: ' + radius + '; padding: 13px 20px; cursor: pointer; transition: filter .15s; }',
      '.ff-btn:hover { filter: brightness(1.08); }',
      '.ff-btn:disabled { opacity: .7; cursor: wait; }',
      '.ff-consent { margin-top: 2px; font-size: 12px; line-height: 1.4; color: #64748b; text-align: center; }',
      '.ff-success { padding: 18px; border: 1px solid #bbf7d0; background: #f0fdf4; color: #14532d; border-radius: ' + radius + '; font-size: 15px; }',
      '.ff-result { padding: 22px 20px 20px; border: 1px solid #e2e8f0; background: #fff; border-radius: ' + radius + '; text-align: center; }',
      '.ff-result-kicker { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 10px; }',
      '.ff-gauge { width: 100%; max-width: 280px; margin: 0 auto; display: block; }',
      '.ff-result-score { font-size: 30px; font-weight: 800; color: #0f172a; line-height: 1.1; margin-top: -6px; }',
      '.ff-result-score small { font-size: 14px; font-weight: 600; color: #94a3b8; }',
      '.ff-result-chip { display: inline-block; font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 999px; margin: 12px 0 6px; }',
    '.ff-result-note { font-size: 12px; line-height: 1.5; color: #64748b; margin: 4px auto 12px; text-align: center; max-width: 320px; }',
      '.ff-result-headline { font-size: 19px; font-weight: 700; color: #0f172a; margin: 4px 0 8px; }',
      '.ff-result-rec { font-size: 14px; line-height: 1.55; color: #475569; max-width: 46ch; margin: 0 auto 14px; }',
      '.ff-cta { display: inline-block; font: inherit; font-size: 15px; font-weight: 600; color: #fff; background: ' + primary + '; border-radius: ' + radius + '; padding: 11px 22px; text-decoration: none; }',
      '.ff-cta:hover { filter: brightness(1.08); }',
      '.ff-traffic { display: flex; flex-direction: column; gap: 7px; width: 54px; margin: 4px auto 14px; padding: 9px; background: #0f172a; border-radius: 14px; }',
      '.ff-light { height: 36px; border-radius: 50%; background: #1e293b; opacity: .35; }',
      '.ff-light.on { opacity: 1; box-shadow: 0 0 0 3px rgba(255,255,255,.28); }',
      '.ff-result-alt { font-size: 13px; color: #64748b; margin-top: 10px; }',
      '.ff-video-block { margin: 16px 0 4px; }',
      '.ff-video { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #0f172a; border-radius: ' + radius + '; overflow: hidden; }',
      '.ff-video iframe, .ff-video video { width: 100%; height: 100%; border: 0; display: block; }',
      '.ff-video-cap { font-size: 12px; color: #64748b; margin-top: 6px; line-height: 1.4; }',
      '.ff-disclaimer { font-size: 11px; line-height: 1.45; color: #94a3b8; margin-top: 16px; padding-top: 12px; border-top: 1px solid #e2e8f0; text-align: left; }',
      '.ff-form-err { font-size: 14px; color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; padding: 10px 12px; border-radius: ' + radius + '; }'
    ].join('\n');
  }

  var FILE_EXTS = {
    images: ['jpg', 'jpeg', 'png', 'webp'],
    pdf: ['pdf'],
    documents: ['pdf', 'doc', 'docx'],
    spreadsheets: ['xls', 'xlsx', 'csv'],
    all: ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv'],
  };
  function fileExts(field) {
    return FILE_EXTS[field.accept] || FILE_EXTS.all;
  }
  function fileAcceptAttr(field) {
    return fileExts(field).map(function (e) { return '.' + e; }).join(',');
  }
  function fileMaxMb(field) {
    return Math.min(25, Math.max(1, Number(field.maxSizeMb) || 10));
  }
  function clientFileProblem(file, field) {
    var m = String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    var ext = m ? m[1] : '';
    if (fileExts(field).indexOf(ext) === -1) return 'Please upload an allowed file type.';
    if (!file.size) return 'That file is empty.';
    if (file.size > fileMaxMb(field) * 1024 * 1024) return 'File is too large (max ' + fileMaxMb(field) + ' MB).';
    return '';
  }

  function buildOtpUi(parent, field, control, ctx) {
    var isSms = field.type === 'phone';
    var state = { token: '', value: '', verified: false };
    ctx.otpState[field.name] = state;

    var wrap = document.createElement('div');
    wrap.className = 'ff-otp';

    var row = document.createElement('div');
    row.className = 'ff-otp-inline';

    // Move the email input into the inline row so the button sits beside it
    // rather than leaving a dead strip under the field.
    if (parent.contains(control)) parent.insertBefore(row, control);
    else parent.appendChild(row);
    row.appendChild(control);

    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'ff-otp-send';
    sendBtn.textContent = 'Send code';
    row.appendChild(sendBtn);

    var msg = document.createElement('div');
    msg.className = 'ff-otp-msg';
    wrap.appendChild(row);

    var hint = document.createElement('div');
    hint.className = 'ff-otp-hint';
    hint.textContent = isSms
      ? "We'll text you a 6-digit code to confirm this number. Tap Send code, then enter the code below to finish sending your enquiry."
      : "We'll email you a 6-digit code to confirm this address. Tap Send code, then enter the code below to finish sending your enquiry.";
    wrap.appendChild(hint);
    wrap.appendChild(msg);

    var codeWrap = document.createElement('div');
    codeWrap.className = 'ff-otp-code';
    var codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.inputMode = 'numeric';
    codeInput.autocomplete = 'one-time-code';
    codeInput.maxLength = 6;
    codeInput.className = 'ff-input';
    codeInput.setAttribute('placeholder', '6-digit code');
    codeInput.setAttribute('aria-label', 'Verification code');
    var verifyBtn = document.createElement('button');
    verifyBtn.type = 'button';
    verifyBtn.className = 'ff-otp-btn';
    verifyBtn.textContent = 'Verify';
    codeWrap.appendChild(codeInput);
    codeWrap.appendChild(verifyBtn);
    wrap.appendChild(codeWrap);

    parent.appendChild(wrap);

    var countdown = null;
    var cooldownUntil = 0;

    function setMsg(text, kind) {
      msg.textContent = text || '';
      msg.className = 'ff-otp-msg' + (kind ? ' ' + kind : '');
    }

    function valueNow() {
      return String(control.value || '').trim();
    }

    function sameValue(a, b) {
      if (isSms) return String(a || '').replace(/\D/g, '') === String(b || '').replace(/\D/g, '');
      return String(a || '').toLowerCase() === String(b || '').toLowerCase();
    }

    function stopCountdown() {
      if (countdown) { clearInterval(countdown); countdown = null; }
    }

    function startCountdown(seconds) {
      stopCountdown();
      cooldownUntil = Date.now() + seconds * 1000;
      sendBtn.disabled = true;
      function tick() {
        var left = Math.ceil((cooldownUntil - Date.now()) / 1000);
        if (left <= 0) {
          stopCountdown();
          sendBtn.disabled = false;
          sendBtn.textContent = state.verified ? 'Verified' : 'Resend code';
          sendBtn.disabled = state.verified;
          return;
        }
        sendBtn.textContent = 'Resend in ' + left + 's';
        sendBtn.disabled = true;
      }
      tick();
      countdown = setInterval(tick, 1000);
    }

    function clearVerification() {
      state.token = '';
      state.value = '';
      state.verified = false;
      codeWrap.classList.remove('show');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send code';
      setMsg('');
    }

    // Editing the address after verification invalidates the token.
    control.addEventListener('input', function () {
      if (state.verified && !sameValue(valueNow(), state.value)) {
        clearVerification();
        setMsg(isSms ? 'Number changed — please verify again.' : 'Email changed — please verify again.');
      }
    });

    sendBtn.addEventListener('click', function () {
      var value = valueNow();
      if (isSms) {
        if (String(value).replace(/\D/g, '').length < 7) {
          setMsg('Enter a valid phone number first.', 'err');
          return;
        }
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        setMsg('Enter a valid email address first.', 'err');
        return;
      }
      if (ctx.turnstileEnabled && !ctx.getTurnstileToken()) {
        setMsg('Please complete the security check first.', 'err');
        return;
      }

      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      setMsg('Sending…');

      var payload = isSms
        ? { phone: value, field: field.name, page_url: window.location.href }
        : { email: value, page_url: window.location.href };
      if (ctx.turnstileEnabled) payload.turnstile = ctx.getTurnstileToken();

      fetch(apiOrigin() + '/api/forms/' + encodeURIComponent(ctx.slug) + (isSms ? '/otp/sms/start' : '/otp/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (b) {
            return { status: res.status, body: b };
          });
        })
        .then(function (r) {
          if (r.status === 404) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send code';
            setMsg(isSms ? 'SMS verification is not available for this form.' : 'Email verification is not available for this form.', 'err');
            return;
          }
          if (r.status === 400) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send code';
            setMsg('Please complete the security check and try again.', 'err');
            return;
          }
          if (r.status !== 200) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send code';
            setMsg('Could not send a code. Please try again.', 'err');
            return;
          }
          codeWrap.classList.add('show');
          setMsg(isSms
            ? 'If that number can receive SMS, a code is on its way.'
            : 'If that address can receive email, a code is on its way.');
          startCountdown(60);
          // The start call consumed the Turnstile token; get a fresh one for submit.
          if (ctx.turnstileEnabled && ctx.resetTurnstile) ctx.resetTurnstile();
          try { codeInput.focus(); } catch (e) { /* ignore */ }
        })
        .catch(function () {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send code';
          setMsg('Network error — please try again.', 'err');
        });
    });

    verifyBtn.addEventListener('click', function () {
      var value = valueNow();
      var code = String(codeInput.value || '').replace(/\s+/g, '');
      if (!(isSms ? /^\d{4,10}$/.test(code) : /^\d{6}$/.test(code))) {
        setMsg(isSms ? 'Enter the code from the SMS.' : 'Enter the 6-digit code from the email.', 'err');
        return;
      }

      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying…';
      setMsg('Verifying…');

      fetch(apiOrigin() + '/api/forms/' + encodeURIComponent(ctx.slug) + (isSms ? '/otp/sms/verify' : '/otp/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isSms ? { phone: value, code: code } : { email: value, code: code }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (b) {
            return { status: res.status, body: b };
          });
        })
        .then(function (r) {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify';
          if (r.status !== 200 || !r.body.ok) {
            setMsg('That code is not valid. Check it and try again.', 'err');
            return;
          }
          state.token = r.body.token;
          state.value = isSms ? value : value.toLowerCase();
          state.verified = true;
          codeWrap.classList.remove('show');
          codeInput.value = '';
          stopCountdown();
          sendBtn.disabled = true;
          sendBtn.textContent = 'Verified';
          setMsg(isSms ? '✓ Phone verified' : '✓ Email verified', 'ok');
        })
        .catch(function () {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify';
          setMsg('Network error — please try again.', 'err');
        });
    });
  }

  function buildField(shadow, container, field, usp, ctx) {
    // Prefill from URL param when configured
    var prefill = field.prefillParam ? usp.get(field.prefillParam) : null;
    var value = prefill !== null ? prefill : (field.defaultValue || '');
    var hasPrefill = prefill !== null && String(prefill).trim() !== '';
    var hasDefault = field.defaultValue !== undefined && field.defaultValue !== null
      && String(field.defaultValue).trim() !== '';
    var locked = field.readonly === 'always' || field.readonly === true
      || (field.readonly === 'prefill' && (hasPrefill || hasDefault));

    if (field.hidden) {
      var hin = document.createElement('input');
      hin.type = 'hidden';
      hin.name = field.name;
      hin.value = escAttr(value);
      container.appendChild(hin);
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'ff-field' + (field.width === 'half' ? ' half' : '');
    wrap.setAttribute('data-ff-field', field.name);

    var label = document.createElement('label');
    label.className = 'ff-label';
    label.setAttribute('for', 'ff-' + field.id);
    label.textContent = field.label;
    if (field.required) {
      var req = document.createElement('span');
      req.className = 'req';
      req.textContent = '*';
      label.appendChild(req);
    }
    wrap.appendChild(label);

    if (field.description) {
      var desc = document.createElement('div');
      desc.className = 'ff-desc';
      desc.textContent = field.description;
      wrap.appendChild(desc);
    }

    var help = null;
    if (field.help) {
      help = document.createElement('div');
      help.className = 'ff-help';
      help.textContent = field.help;
    }

    var err = document.createElement('div');
    err.className = 'ff-err';

    var control = null;

    if (field.type === 'textarea') {
      control = document.createElement('textarea');
      control.className = 'ff-textarea';
      control.name = field.name;
      control.value = escAttr(value);
      control.setAttribute('placeholder', escAttr(field.placeholder));
      if (locked) {
        control.readOnly = true;
        control.classList.add('ff-locked');
        control.setAttribute('aria-readonly', 'true');
      }
    } else if (field.type === 'select') {
      control = document.createElement('select');
      control.className = 'ff-select';
      control.name = field.name;
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = field.placeholder || 'Select...';
      control.appendChild(ph);
      field.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (String(o.value) === String(value)) opt.selected = true;
        control.appendChild(opt);
      });
      control.value = value || '';
      if (locked) {
        control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
      }
    } else if (field.type === 'radio' || field.type === 'checkbox') {
      var optWrap = document.createElement('div');
      optWrap.className = 'ff-options' + (locked ? ' locked' : '');
      field.options.forEach(function (o) {
        var lab = document.createElement('label');
        var inp = document.createElement('input');
        inp.type = field.type === 'radio' ? 'radio' : 'checkbox';
        inp.name = field.name;
        inp.value = escAttr(o.value);
        if (locked) {
          inp.disabled = true;
          inp.setAttribute('aria-disabled', 'true');
        }
        if (field.type === 'radio' && String(o.value) === String(value)) inp.checked = true;
        if (field.type === 'checkbox' && value) {
          var want = String(value).split(',').map(function (s) { return s.trim(); });
          if (want.indexOf(String(o.value)) !== -1) inp.checked = true;
        }
        lab.appendChild(inp);
        var linkUrl = o.linkUrl && /^https:\/\//i.test(String(o.linkUrl)) ? String(o.linkUrl) : '';
        if (linkUrl) {
          var a = document.createElement('a');
          a.href = linkUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = o.linkText || o.label;
          // Do not let the link click toggle the checkbox through the label.
          a.addEventListener('click', function (e) { e.stopPropagation(); });
          if (o.linkText) {
            lab.appendChild(document.createTextNode(o.label + (/\s$/.test(o.label) ? '' : ' ')));
            lab.appendChild(a);
          } else {
            lab.appendChild(a);
          }
        } else {
          lab.appendChild(document.createTextNode(o.label));
        }
        optWrap.appendChild(lab);
      });
      wrap.appendChild(optWrap);
      wrap.appendChild(err);
      container.appendChild(wrap);
      return;
    } else if (field.type === 'file') {
      control = document.createElement('input');
      control.type = 'file';
      control.className = 'ff-input ff-file';
      control.name = field.name;
      control.accept = fileAcceptAttr(field);
      ctx.fileState = ctx.fileState || {};
      control._fileStatus = document.createElement('div');
      control._fileStatus.className = 'ff-file-status';
      control._fileStatus.textContent = 'Max ' + fileMaxMb(field) + ' MB';
      control.addEventListener('change', function () {
        delete ctx.fileState[field.name];
        var file = control.files && control.files[0];
        if (!file) {
          control._fileStatus.className = 'ff-file-status';
          control._fileStatus.textContent = 'Max ' + fileMaxMb(field) + ' MB';
          return;
        }
        var problem = clientFileProblem(file, field);
        if (problem) {
          control.value = '';
          control._fileStatus.className = 'ff-file-status err';
          control._fileStatus.textContent = problem;
          return;
        }
        ctx.fileState[field.name] = { uploading: true };
        control._fileStatus.className = 'ff-file-status';
        control._fileStatus.textContent = 'Uploading…';
        var fd = new FormData();
        fd.append('field', field.name);
        fd.append('file', file);
        fetch(apiOrigin() + '/api/forms/' + encodeURIComponent(ctx.slug) + '/files', {
          method: 'POST',
          body: fd,
        })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (b) {
              return { status: res.status, body: b };
            });
          })
          .then(function (r) {
            if (r.status !== 201 || !r.body.ok) {
              delete ctx.fileState[field.name];
              control.value = '';
              control._fileStatus.className = 'ff-file-status err';
              control._fileStatus.textContent = r.body.error === 'storage_not_configured'
                ? 'File uploads are not configured.'
                : (r.body.message || 'Upload failed. Please try again.');
              return;
            }
            ctx.fileState[field.name] = r.body.file;
            control._fileStatus.className = 'ff-file-status ok';
            control._fileStatus.textContent = '✓ ' + r.body.file.name;
          })
          .catch(function () {
            delete ctx.fileState[field.name];
            control.value = '';
            control._fileStatus.className = 'ff-file-status err';
            control._fileStatus.textContent = 'Upload failed. Please try again.';
          });
      });
    } else {
      control = document.createElement('input');
      control.type = field.type === 'email' || field.type === 'phone' || field.type === 'number' || field.type === 'date' ? field.type : 'text';
      control.className = 'ff-input';
      control.name = field.name;
      control.value = escAttr(value);
      control.setAttribute('placeholder', escAttr(field.placeholder));
      if (field.type === 'number') {
        if (field.min !== '' && field.min !== undefined && field.min !== null) control.min = String(field.min);
        if (field.max !== '' && field.max !== undefined && field.max !== null) control.max = String(field.max);
      }
      if (locked) {
        control.readOnly = true;
        control.classList.add('ff-locked');
        control.setAttribute('aria-readonly', 'true');
      }
    }

    control.id = 'ff-' + field.id;
    if (help) help.id = 'ff-help-' + field.id;
    control.setAttribute('aria-describedby', help ? 'ff-help-' + field.id : '');
    wrap.appendChild(control);
    if (control._fileStatus) wrap.appendChild(control._fileStatus);
    if (help) wrap.appendChild(help);
    wrap.appendChild(err);
    if (field.otp && (field.type === 'email' || field.type === 'phone') && !field.hidden && ctx) {
      // Full-width: the OTP controls need the room, and a half-width cell made the
      // following fields stagger into a zig-zag.
      wrap.classList.remove('half');
      wrap.classList.add('ff-field-full');
      buildOtpUi(wrap, field, control, ctx);
    }
    container.appendChild(wrap);
  }

  function collect(formEl, fields) {
    var data = {};
    fields.forEach(function (f) {
      if (f.type === 'file') return;
      var els = formEl.querySelectorAll('[name="' + f.name + '"]');
      if (!els.length) return;
      if (f.type === 'checkbox') {
        var vals = [];
        els.forEach(function (el) { if (el.checked) vals.push(el.value); });
        data[f.name] = vals;
      } else if (f.type === 'radio') {
        els.forEach(function (el) { if (el.checked) data[f.name] = el.value; });
      } else {
        data[f.name] = els[0].value;
      }
    });
    return data;
  }

  function validate(fields, data) {
    var errors = {};
    fields.forEach(function (f) {
      if (f.hidden) return;
      if (f.type === 'file') {
        var fv = data[f.name];
        if (f.required && (!fv || fv.uploading)) {
          errors[f.name] = fv && fv.uploading
            ? 'Please wait for the file upload to finish.'
            : 'Please upload a file.';
        }
        return;
      }
      var v = f.type === 'checkbox' ? (data[f.name] || []) : ((data[f.name] || '').trim());
      if (f.required) {
        if (f.type === 'checkbox') {
          if (!v.length) errors[f.name] = 'Please select at least one option.';
        } else if (!v) {
          errors[f.name] = f.type === 'radio' ? 'Please choose one.' : 'This field is required.';
        }
      }
      if (!v || errors[f.name]) return;
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) errors[f.name] = 'Please enter a valid email address.';
      if (f.type === 'phone' && (v.replace(/[^0-9]/g, '').length < 7)) errors[f.name] = 'Please enter a valid phone number.';
      if (f.type === 'number') {
        var n = Number(v);
        var minSet = f.min !== '' && f.min !== undefined && f.min !== null;
        var maxSet = f.max !== '' && f.max !== undefined && f.max !== null;
        if (!isFinite(n)) {
          errors[f.name] = 'Please enter a number.';
        } else if (minSet && maxSet && (n < Number(f.min) || n > Number(f.max))) {
          errors[f.name] = 'Please enter a number between ' + f.min + ' and ' + f.max + '.';
        } else if (minSet && n < Number(f.min)) {
          errors[f.name] = 'Please enter a number of at least ' + f.min + '.';
        } else if (maxSet && n > Number(f.max)) {
          errors[f.name] = 'Please enter a number no more than ' + f.max + '.';
        }
      }
    });
    return errors;
  }

  function renderErrors(shadow, fields, errors) {
    fields.forEach(function (f) {
      var inputs = shadow.querySelectorAll('[name="' + f.name + '"]');
      var errEl = null;
      // find the sibling error div nearest the control
      inputs.forEach(function (inp) {
        var wrap = inp.closest('.ff-field');
        if (wrap) {
          var e = wrap.querySelector('.ff-err');
          if (e) errEl = e;
          if (errors[f.name]) inp.classList.add('err'); else inp.classList.remove('err');
        }
      });
      if (errEl) {
        errEl.textContent = errors[f.name] || '';
        errEl.classList.toggle('show', !!errors[f.name]);
      }
    });
  }

  // ---- anonymous funnel telemetry ------------------------------------------
  // One session id per tab (sessionStorage), no cookies and no field values.
  // Every send is best-effort: telemetry must never break the form.
  var trackMemo = {};

  function newSessionId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
    } catch (e) { /* ignore */ }
    return 'ff' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function sessionIdFor(slug) {
    try {
      var k = 'ff_sid_' + slug;
      var v = window.sessionStorage.getItem(k);
      if (!v) { v = newSessionId(); window.sessionStorage.setItem(k, v); }
      return v;
    } catch (e) {
      var mk = 'ff_sid_mem_' + slug;
      if (!trackMemo[mk]) trackMemo[mk] = newSessionId();
      return trackMemo[mk];
    }
  }

  function eventUtm() {
    try { return utmData(); } catch (e) { return {}; }
  }

  function sendEvent(def, name, step) {
    try {
      var url = apiOrigin() + '/api/forms/' + encodeURIComponent(def.slug) + '/event';
      var body = JSON.stringify({
        session_id: sessionIdFor(def.slug),
        event: name,
        step: step || 1,
        page_url: String(window.location.href || '').slice(0, 500),
        referrer: String(document.referrer || '').slice(0, 500),
        utm: eventUtm()
      });
      // pagehide/unload needs sendBeacon: a normal fetch is cancelled mid-flight.
      if (name === 'abandon' && navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit'
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  function trackOnce(def, name, step) {
    var k = 'ff_ev_' + def.slug + '_' + name + '_' + (step || 1);
    try {
      if (window.sessionStorage.getItem(k)) return;
      window.sessionStorage.setItem(k, '1');
    } catch (e) {
      if (trackMemo[k]) return;
      trackMemo[k] = 1;
    }
    sendEvent(def, name, step);
  }

  function render(root, def) {
    var config = def.config || {};
    var fields = config.fields || [];
    var settings = config.settings || {};
    var theme = settings.theme || {};
    var meta = Array.isArray(config.pages) ? config.pages : [];

    if (!root.shadowRoot) root.attachShadow({ mode: 'open' });
    var shadow = root.shadowRoot;
    shadow.innerHTML = '';

    var style = document.createElement('style');
    style.textContent = defaultStyles(theme);
    shadow.appendChild(style);

    var formEl = document.createElement('form');
    formEl.className = 'ff-form';
    formEl.noValidate = true;

    // honeypot
    var hp = document.createElement('input');
    hp.type = 'text';
    hp.name = 'ff_extra_field';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';
    formEl.appendChild(hp);

    var usp = params();
    var tsEnabled = settings.turnstile && settings.turnstile.enabled && settings.turnstile.siteKey;
    var otpState = {};
    var fileState = {};
    var tsWidgetId = null;
    var otpCtx = {
      slug: def.slug,
      otpState: otpState,
      fileState: fileState,
      turnstileEnabled: !!tsEnabled,
      getTurnstileToken: function () { return tsToken; },
      resetTurnstile: function () {
        if (!tsEnabled) return;
        tsToken = '';
        try { if (tsWidgetId !== null && window.turnstile) window.turnstile.reset(tsWidgetId); } catch (e) { /* ignore */ }
      }
    };

    /* ----- split fields into pages ----- */
    var pageCount = meta.length || 1;
    var pages = [];
    var i;
    for (i = 0; i < pageCount; i += 1) {
      pages.push({ meta: meta[i] || null, fields: [] });
    }
    fields.forEach(function (f) {
      if (f.hidden) return; // hidden fields are global — always submitted
      var pg = parseInt(f.page, 10);
      if (!(pg >= 0)) pg = 0;
      if (pg >= pageCount) pg = pageCount - 1;
      if (pg < 0) pg = 0;
      f._page = pg;
      pages[pg].fields.push(f);
    });
    var allFields = fields;

    // Hidden fields render once, straight on the form, regardless of page.
    fields.forEach(function (f) {
      if (f.hidden) buildField(shadow, formEl, f, usp, otpCtx);
    });

    /* ----- build page DOM (all pages kept in the DOM so values survive nav) ----- */
    var tsWrap = null;
    var tsRendered = false;

    pages.forEach(function (pg, pidx) {
      var pageEl = document.createElement('div');
      pageEl.className = 'ff-page';
      pageEl.style.display = pidx === 0 ? '' : 'none';
      pg.el = pageEl;

      if (pg.meta && (pg.meta.title || pg.meta.description)) {
        if (pg.meta.title) {
          var t = document.createElement('div');
          t.className = 'ff-page-title';
          t.textContent = pg.meta.title;
          pageEl.appendChild(t);
        }
        if (pg.meta.description) {
          var d = document.createElement('div');
          d.className = 'ff-page-desc';
          d.textContent = pg.meta.description;
          pageEl.appendChild(d);
        }
      }

      var grid = document.createElement('div');
      grid.className = 'ff-grid';
      pg.fields.forEach(function (f) { buildField(shadow, grid, f, usp, otpCtx); });

      pageEl.appendChild(grid);
      formEl.appendChild(pageEl);
    });

    var multi = pageCount > 1;

    /* ----- nav ----- */
    var nav = document.createElement('div');
    nav.className = 'ff-nav';

    var stepEl = null;
    var backEl = null;

    if (multi) {
      var navTop = document.createElement('div');
      navTop.className = 'ff-nav-top';
      stepEl = document.createElement('div');
      stepEl.className = 'ff-step';
      navTop.appendChild(stepEl);
      backEl = document.createElement('button');
      backEl.type = 'button';
      backEl.className = 'ff-back';
      backEl.textContent = '← Back';
      backEl.addEventListener('click', function () {
        var vis = visiblePageIdxs(rawData());
        var pos = vis.indexOf(current);
        if (pos > 0) showPage(vis[pos - 1]);
      });
      navTop.appendChild(backEl);
      nav.appendChild(navTop);
    }

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'ff-btn';
    submitBtn.textContent = settings.submitLabel || 'Submit';
    // Turnstile lives in the nav, not on a specific page: with conditional pages
    // the last visible page is not always the last page in the config.
    if (tsEnabled) {
      tsWrap = document.createElement('div');
      tsWrap.style.cssText = 'min-height:65px;';
      tsWrap.style.display = 'none';
      nav.appendChild(tsWrap);
    }
    nav.appendChild(submitBtn);

    // Consent NOTICE beneath the submit button — shown on every form (submitting = acceptance).
    // The API resolves the wording (per-form override -> global default -> built-in fallback).
    var consentEl = document.createElement('div');
    consentEl.className = 'ff-consent';
    consentEl.textContent = (settings.consentText && String(settings.consentText).trim())
      || 'By submitting your details you consent to being contacted.';
    nav.appendChild(consentEl);

    formEl.appendChild(nav);

    var tsToken = '';
    var current = 0;

    function renderTurnstile() {
      if (!tsEnabled || tsRendered || !tsWrap) return;
      tsRendered = true;
      loadTurnstile(function () {
        tsWidgetId = window.turnstile.render(tsWrap, {
          sitekey: settings.turnstile.siteKey,
          callback: function (token) { tsToken = token; },
          'expired-callback': function () { tsToken = ''; },
          'error-callback': function () { tsToken = ''; },
        });
      });
    }

    function rawData() {
      return collect(formEl, allFields);
    }

    function pageVisible(pidx, data) {
      if (pidx <= 0) return true; // the first page is always shown
      var m = pages[pidx] && pages[pidx].meta;
      return !m || condVisible(m.conditional, data);
    }

    function fieldVisibleNow(f, data) {
      if (!condVisible(f.conditional, data)) return false;
      if (f.hidden) return true; // global hidden fields ignore page logic
      return pageVisible(f._page || 0, data);
    }

    function activeDataFrom(raw) {
      var out = {};
      allFields.forEach(function (f) {
        if (!fieldVisibleNow(f, raw)) return;
        if (raw[f.name] !== undefined) out[f.name] = raw[f.name];
        else if (f.type === 'checkbox') out[f.name] = [];
      });
      return out;
    }

    function activeFieldsFrom(raw) {
      return allFields.filter(function (f) { return fieldVisibleNow(f, raw); });
    }

    function visiblePageIdxs(raw) {
      var out = [];
      for (var p = 0; p < pages.length; p += 1) {
        if (p === 0 || pageVisible(p, raw)) out.push(p);
      }
      if (!out.length) out = [0];
      return out;
    }

    function pageIndexForField(name) {
      for (var p = 0; p < pages.length; p += 1) {
        if (pages[p].fields.some(function (f) { return f.name === name; })) return p;
      }
      return 0;
    }

    function updateNav(vis) {
      var pos = vis.indexOf(current);
      if (pos < 0) {
        pos = vis.length - 1;
        for (var q = 0; q < vis.length; q += 1) {
          if (vis[q] > current) { pos = q; break; }
        }
        current = vis[pos];
      }

      pages.forEach(function (pg, k) {
        pg.el.style.display = k === current ? '' : 'none';
      });

      if (stepEl) stepEl.textContent = 'Step ' + (pos + 1) + ' of ' + vis.length;
      if (backEl) backEl.style.visibility = pos <= 0 ? 'hidden' : 'visible';

      var last = pos === vis.length - 1;
      submitBtn.textContent = last ? (settings.submitLabel || 'Submit') : 'Next →';
      // Consent wording belongs with the actual submit action, not every step.
      if (consentEl) consentEl.style.display = last ? '' : 'none';
      if (tsWrap) {
        tsWrap.style.display = last ? '' : 'none';
        if (last) renderTurnstile();
      }
    }

    function showPage(idx, focusFirst) {
      var vis = visiblePageIdxs(rawData());
      var target = idx;
      if (vis.indexOf(target) === -1) {
        target = vis[vis.length - 1];
        for (var k = 0; k < vis.length; k += 1) {
          if (vis[k] >= idx) { target = vis[k]; break; }
        }
      }
      current = target;
      updateNav(vis);
      if (focusFirst !== false) {
        var first = pages[current].el.querySelector('input:not([type=hidden]), select, textarea');
        if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
      }
    }

    // Re-evaluate conditional logic on every change. Fields that become hidden
    // are excluded from validation and from the submitted data, and pages that
    // become hidden drop out of the Next/Back sequence.
    function applyConditions() {
      var raw = rawData();
      allFields.forEach(function (f) {
        if (f.hidden) return;
        var el = formEl.querySelector('[data-ff-field="' + f.name + '"]');
        if (!el) return;
        el.style.display = fieldVisibleNow(f, raw) ? '' : 'none';
      });
      updateNav(visiblePageIdxs(raw));
    }

    formEl.addEventListener('input', applyConditions);
    formEl.addEventListener('change', applyConditions);

    shadow.appendChild(formEl);

    function scrollErrorsIntoView(errors) {
      var names = Object.keys(errors);
      if (!names.length) return;
      showPage(pageIndexForField(names[0]), false);
      var el = formEl.querySelector('[name="' + names[0] + '"]');
      if (el) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
      }
    }

    function showFormError(msg) {
      var ter = shadow.querySelector('.ff-form-err');
      if (!ter) {
        ter = document.createElement('div');
        ter.className = 'ff-form-err';
        formEl.insertBefore(ter, formEl.firstChild);
      }
      ter.textContent = msg;
    }

    /* ----- quiz result screen --------------------------------------------- */
    function bandList() {
      var s = settings.scoring || {};
      return Array.prototype.slice.call(s.bands || [])
        .filter(function (b) { return b && b.label; })
        .sort(function (a, b) { return scoreNum(a.min) - scoreNum(b.min); });
    }

    function gaugeEl(bands, percent, highlightKey) {
      var emphasis = !!highlightKey;
      var NS = 'http://www.w3.org/2000/svg';
      var CX = 140, CY = 124, R = 104, SW = 20;
      function pt(p) {
        var a = Math.PI - (Math.max(0, Math.min(100, p)) / 100) * Math.PI;
        return [CX + R * Math.cos(a), CY - R * Math.sin(a)];
      }
      function arcPath(from, to) {
        var a = pt(from), b = pt(to);
        return 'M ' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
          ' A ' + R + ' ' + R + ' 0 0 1 ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2);
      }
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 280 152');
      svg.setAttribute('class', 'ff-gauge');
      svg.setAttribute('aria-hidden', 'true');

      var track = document.createElementNS(NS, 'path');
      track.setAttribute('d', arcPath(0, 100));
      track.setAttribute('fill', 'none');
      track.setAttribute('stroke', '#e2e8f0');
      track.setAttribute('stroke-width', SW);
      track.setAttribute('stroke-linecap', 'round');
      if (emphasis) track.setAttribute('opacity', '0.5');
      svg.appendChild(track);

      for (var i = 0; i < bands.length; i += 1) {
        var start = scoreNum(bands[i].min);
        var end = i + 1 < bands.length ? scoreNum(bands[i + 1].min) : 100;
        if (end - start <= 0.5) continue;
        var seg = document.createElementNS(NS, 'path');
        seg.setAttribute('d', arcPath(start + (start > 0 ? 0.7 : 0), end - (end < 100 ? 0.7 : 0)));
        seg.setAttribute('fill', 'none');
        seg.setAttribute('stroke', bands[i].color || '#94a3b8');
        seg.setAttribute('stroke-width', emphasis && bands[i].key === highlightKey ? String(SW + 4) : String(SW));
        if (emphasis && bands[i].key !== highlightKey) seg.setAttribute('opacity', '0.22');
        svg.appendChild(seg);
      }

      if (!emphasis) {
        var ang = Math.PI - (Math.max(0, Math.min(100, percent)) / 100) * Math.PI;
        var needle = document.createElementNS(NS, 'line');
        needle.setAttribute('x1', String(CX + 16 * Math.cos(ang)));
        needle.setAttribute('y1', String(CY - 16 * Math.sin(ang)));
        needle.setAttribute('x2', String(CX + (R - 18) * Math.cos(ang)));
        needle.setAttribute('y2', String(CY - (R - 18) * Math.sin(ang)));
        needle.setAttribute('stroke', '#0f172a');
        needle.setAttribute('stroke-width', '4');
        needle.setAttribute('stroke-linecap', 'round');
        svg.appendChild(needle);

        var hub = document.createElementNS(NS, 'circle');
        hub.setAttribute('cx', String(CX));
        hub.setAttribute('cy', String(CY));
        hub.setAttribute('r', '7');
        hub.setAttribute('fill', '#0f172a');
        svg.appendChild(hub);
      }
      return svg;
    }

    function trafficEl(bands, activeKey) {
      var wrapEl = document.createElement('div');
      wrapEl.className = 'ff-traffic';
      bands.slice(0, 4).forEach(function (b) {
        var lamp = document.createElement('div');
        lamp.className = 'ff-light' + (b.key === activeKey ? ' on' : '');
        lamp.style.background = b.color || '#64748b';
        wrapEl.appendChild(lamp);
      });
      return wrapEl;
    }

    function videoBlock(url, caption) {
      var u;
      try { u = new URL(url, window.location.href); } catch (e) { return null; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

      var host = u.hostname.replace(/^www\./, '').toLowerCase();
      var embed = '';
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        var yt = u.searchParams.get('v');
        if (yt) embed = 'https://www.youtube.com/embed/' + encodeURIComponent(yt);
      } else if (host === 'youtu.be') {
        var yt2 = u.pathname.split('/').filter(Boolean)[0];
        if (yt2) embed = 'https://www.youtube.com/embed/' + encodeURIComponent(yt2);
      } else if (host === 'vimeo.com' || host === 'player.vimeo.com') {
        var vm = (u.pathname.split('/').filter(Boolean) || []).filter(function (x) { return /^[0-9]+$/.test(x); })[0];
        if (vm) embed = 'https://player.vimeo.com/video/' + vm;
      }

      var block = document.createElement('div');
      block.className = 'ff-video-block';
      var frame = document.createElement('div');
      frame.className = 'ff-video';

      if (embed) {
        var iframe = document.createElement('iframe');
        iframe.src = embed;
        iframe.loading = 'lazy';
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen');
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('title', caption || 'Video');
        frame.appendChild(iframe);
      } else if (/\.(mp4|webm|ogg|ogv)(\?|$)/i.test(u.pathname)) {
        var video = document.createElement('video');
        video.src = u.toString();
        video.controls = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('preload', 'metadata');
        frame.appendChild(video);
      } else {
        var generic = document.createElement('iframe');
        generic.src = u.toString();
        generic.loading = 'lazy';
        generic.setAttribute('allowfullscreen', '');
        generic.setAttribute('title', caption || 'Video');
        frame.appendChild(generic);
      }
      block.appendChild(frame);

      if (caption) {
        var cap = document.createElement('div');
        cap.className = 'ff-video-cap';
        cap.textContent = caption;
        block.appendChild(cap);
      }
      return block;
    }

    function renderResult(body, data) {
      formEl.innerHTML = '';
      var band = body && body.band;
      var noCall = body && body.followUp === 'no_call';
      var isPlan = body && body.route === 'plan';
      var knockout = (body && body.knockout) || '';
      if (!band) {
        var ok = document.createElement('div');
        ok.className = 'ff-success';
        ok.textContent = (body && body.message) || settings.successMessage || 'Thanks!';
        formEl.appendChild(ok);
        return;
      }

      var bands = bandList();
      var display = (body.scoring && body.scoring.display) || 'gauge';
      var showScore = !(body.scoring && body.scoring.showScore === false);
      var percent = body.score ? Number(body.score.percent) || 0 : 0;

      var card = document.createElement('div');
      card.className = 'ff-result';

      var kicker = document.createElement('div');
      kicker.className = 'ff-result-kicker';
      kicker.textContent = knockout ? 'Your result' : 'Your readiness score';
      card.appendChild(kicker);

      if (display === 'traffic' && bands.length) {
        card.appendChild(trafficEl(bands, band.key));
      } else if (display !== 'none' && bands.length) {
        card.appendChild(gaugeEl(bands, percent, knockout));
      }

      if (showScore) {
        var scoreEl = document.createElement('div');
        scoreEl.className = 'ff-result-score';
        scoreEl.textContent = String(percent);
        var small = document.createElement('small');
        small.textContent = ' / 100';
        scoreEl.appendChild(small);
        card.appendChild(scoreEl);
      }

      var chip = document.createElement('div');
      chip.className = 'ff-result-chip';
      chip.textContent = band.label || '';
      chip.style.color = band.color || '#0f172a';
      chip.style.background = (band.color || '#0f172a') + '1f';
      card.appendChild(chip);

      if (knockout) {
        var koNote = document.createElement('div');
        koNote.className = 'ff-result-note';
        koNote.textContent = 'One of your answers rules out early release, so the score does not decide the result.';
        card.appendChild(koNote);
      }

      var planHeadline = (settings.scoring && settings.scoring.planHeadline)
        || 'Prefer not to touch your super? There is another way.';
      var planRec = (settings.scoring && settings.scoring.planRecommendation)
        || 'We will call you about payment plan options and the exact cost - no obligation.';
      // The plan copy is for people who CHOOSE a plan. If super is ineligible,
      // the band's own headline is the honest one; only the CTA changes.
      var planOverride = isPlan && band.key !== 'not_eligible';

      if (planOverride || band.headline) {
        var head = document.createElement('div');
        head.className = 'ff-result-headline';
        head.textContent = planOverride ? planHeadline : band.headline;
        card.appendChild(head);
      }
      if (band.recommendation) {
        var rec = document.createElement('div');
        rec.className = 'ff-result-rec';
        rec.textContent = planOverride
          ? planRec
          : (noCall
            ? 'No call - we will not ring you. Your result stays here; come back when you are ready to start.'
            : band.recommendation);
        card.appendChild(rec);
      }
      var videoUrl = band.videoUrl || ((settings.scoring && settings.scoring.videoUrl) || '');
      if (videoUrl) {
        var video = videoBlock(videoUrl, band.videoCaption || (settings.scoring && settings.scoring.videoCaption) || '');
        if (video) card.appendChild(video);
      }
      var ctaHref = isPlan
        ? ((settings.scoring && settings.scoring.planUrl) || band.ctaUrl || band.redirectUrl || '')
        : (band.ctaUrl || band.redirectUrl || '');
      var ctaLabel = isPlan
        ? ((settings.scoring && settings.scoring.planCtaLabel) || 'See payment plan options')
        : band.ctaLabel;
      if (!noCall && ctaLabel && ctaHref) {
        var cta = document.createElement('a');
        cta.className = 'ff-cta';
        cta.href = ctaHref;
        cta.textContent = ctaLabel;
        if (!/^tel:/i.test(ctaHref)) {
          cta.target = '_blank';
          cta.rel = 'noopener noreferrer';
        }
        card.appendChild(cta);
      }
      var disclaimer = (settings.scoring && settings.scoring.disclaimer) || '';
      if (disclaimer) {
        var disc = document.createElement('div');
        disc.className = 'ff-disclaimer';
        disc.textContent = disclaimer;
        card.appendChild(disc);
      }
      formEl.appendChild(card);
    }

    // Fallback when an older API omits the band: compute the same result locally
    // so the visitor still sees a score screen.
    function localResult(data) {
      var s = settings.scoring || {};
      if (!s.enabled) return null;
      var visible = function (f) { return fieldVisibleNow(f, data); };
      var sc = computeScore(allFields, data, visible);
      if (!sc.enabled) return null;
      var ko = findKnockout(allFields, data, visible);
      var bands = s.bands || [];
      var band = null;
      for (var i = 0; i < bands.length; i += 1) {
        if (bands[i] && bands[i].key === ko) band = bands[i];
      }
      if (!band) band = resolveBand(bands, sc.percent);
      if (!band) return null;
      return {
        message: settings.successMessage,
        score: { points: sc.points, percent: sc.percent },
        knockout: ko || '',
        band: band,
        followUp: findFollowUp(allFields, data, visible),
        route: findRoute(allFields, data, visible),
        scoring: {
          display: s.display || 'gauge',
          showScore: s.showScore !== false,
          autoRedirect: s.autoRedirect !== false,
          redirectDelayMs: typeof s.redirectDelayMs === 'number' ? s.redirectDelayMs : 1500
        },
        redirect: decorateRedirect(band.redirectUrl || settings.redirectUrl || '', band, sc.percent)
      };
    }

    formEl.addEventListener('submit', function (ev) {
      ev.preventDefault();

      var raw = rawData();
      var vis = visiblePageIdxs(raw);
      var lastVisible = vis[vis.length - 1] === current;

      // Not on the last VISIBLE page → validate this page, then advance.
      if (!lastVisible) {
        var pageFields = pages[current].fields.filter(function (f) {
          return fieldVisibleNow(f, raw);
        });
        var pageErrors = validate(pageFields, raw);
        renderErrors(shadow, pageFields, pageErrors);
        if (Object.keys(pageErrors).length) return;
        var pos = vis.indexOf(current);
        if (pos >= 0 && pos < vis.length - 1) {
          showPage(vis[pos + 1]);
          trackOnce(def, 'page', pos + 2);
        }
        return;
      }

      // Final page → full submit.
      var active = activeFieldsFrom(raw);
      var data = activeDataFrom(raw);
      active.forEach(function (f) {
        if (f.type === 'file' && !f.hidden && fileState[f.name]) {
          data[f.name] = fileState[f.name];
        }
      });
      var errors = validate(active.filter(function (f) { return !f.hidden; }), data);

      // A form with OTP-enabled email fields needs a verified token for each
      // such address before it can be submitted. A conditionally hidden OTP
      // field (or one left blank) does not demand a token.
      active.forEach(function (f) {
        if (!(f.otp && (f.type === 'email' || f.type === 'phone') && !f.hidden)) return;
        var st = otpState[f.name];
        var value = String(data[f.name] || '').trim();
        if (!value) return;
        var matches = !!(st && st.token && (f.type === 'phone'
          ? value.replace(/\D/g, '') === String(st.value || '').replace(/\D/g, '')
          : value.toLowerCase() === String(st.value || '').toLowerCase()));
        if (!matches) {
          errors[f.name] = f.type === 'phone'
            ? 'Please verify this phone number.'
            : 'Please verify this email address.';
        }
      });

      renderErrors(shadow, allFields, errors);
      if (Object.keys(errors).length) {
        scrollErrorsIntoView(errors);
        return;
      }
      if (tsEnabled && !tsToken) {
        showFormError('Please complete the security check.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      // Open the redirect tab HERE, inside the submit gesture. window.open()
      // after the async fetch would be blocked by popup blockers. With scoring,
      // the band's redirect is unknown until submit, so any possible band
      // redirect also needs the blank tab opened up front.
      var scoreBands = (settings.scoring && settings.scoring.enabled && settings.scoring.bands) || [];
      var anyBandRedirect = scoreBands.some(function (b) { return b && b.redirectUrl; });
      var newTab = null;
      if (settings.redirectNewTab && (settings.redirectUrl || anyBandRedirect) && typeof window.open === 'function') {
        try { newTab = window.open('', '_blank'); } catch (e) { newTab = null; }
      }
      function closeNewTab() {
        if (newTab) { try { newTab.close(); } catch (e) { /* ignore */ } newTab = null; }
      }

      var payload = {
        data: data,
        hp: hp.value || '',
        page_url: window.location.href,
        referrer: document.referrer || '',
        utm: mergeUtm((config.settings && config.settings.utm) || {}, utmData()),
      };
      var otpTokens = [];
      active.forEach(function (f) {
        if (f.otp && (f.type === 'email' || f.type === 'phone')
          && otpState[f.name] && otpState[f.name].token) {
          otpTokens.push(otpState[f.name].token);
        }
      });
      if (otpTokens.length === 1) payload.otp = otpTokens[0];
      else if (otpTokens.length > 1) payload.otp = otpTokens;
      if (tsEnabled) payload.turnstile = tsToken;

      // POST the submission. A transient network failure is retried once before we
      // surface it — same reasoning as the config fetch. HTTP responses are not
      // retried (a 422/429/500 is a real answer, and re-POSTing could duplicate).
      var submitAttempt = 0;
      var SUBMIT_MAX_ATTEMPTS = 2;
      var submitUrl = apiOrigin() + '/api/forms/' + encodeURIComponent(def.slug) + '/submit';
      function postSubmit() {
        submitAttempt += 1;
        return fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, body: b }; }); })
          .catch(function (err) {
            var msg = err && err.message ? err.message : String(err);
            if (submitAttempt < SUBMIT_MAX_ATTEMPTS) {
              console.warn('[PeakForms] submit "' + def.slug + '": network error on attempt ' + submitAttempt + '/' + SUBMIT_MAX_ATTEMPTS + ' (' + msg + '), retrying');
              return sleep(300).then(postSubmit);
            }
            recordFailure({ scope: 'submit', slug: def.slug, url: submitUrl, status: null, error: msg, attempt: submitAttempt, at: new Date().toISOString() });
            throw err;
          });
      }

      postSubmit()
        .then(function (r) {
          if (r.status === 422) {
            renderErrors(shadow, allFields, r.body.errors || {});
            scrollErrorsIntoView(r.body.errors || {});
            if (r.body && r.body.error === 'email_unverified') {
              showFormError('Please verify your email address before submitting.');
            } else if (r.body && r.body.error === 'phone_unverified') {
              showFormError('Please verify your phone number before submitting.');
            }
            closeNewTab();
            submitBtn.disabled = false;
            submitBtn.textContent = settings.submitLabel || 'Submit';
            return;
          }
          if (r.status !== 200 || !r.body.ok) {
            recordFailure({ scope: 'submit', slug: def.slug, url: submitUrl, status: r.status, error: (r.body && r.body.error) || 'bad_response', attempt: submitAttempt, at: new Date().toISOString() });
            closeNewTab();
            submitBtn.disabled = false;
            submitBtn.textContent = settings.submitLabel || 'Submit';
            showFormError((r.body && r.body.error === 'rate_limited')
              ? 'Too many attempts — please try again in a little while.'
              : 'Something went wrong. Please try again.');
            return;
          }
          // SUCCESS — fire tracking hooks on the host page
          try {
            if (settings.dataLayerEvent && window.dataLayer) {
              var dl = { event: settings.dataLayerEvent, form: def.slug, form_id: def.id };
              Object.keys(data).forEach(function (k) { dl['ff_' + k] = data[k]; });
              if (r.body.score) { dl.ff_score = r.body.score.percent; dl.ff_score_points = r.body.score.points; }
              if (r.body.band) dl.ff_band = r.body.band.key;
              window.dataLayer.push(dl);
            }
            try {
              if (window.__ffMetaLead !== false && typeof window.fbq === 'function') {
                var __leadId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                  : 'pf-' + Date.now() + '-' + Math.random().toString(16).slice(2);
                window.fbq('track', 'Lead', { content_name: 'website_form' }, { eventID: __leadId });
              }
            } catch (e) { /* tracking must never break the form */ }
            root.dispatchEvent(new CustomEvent('ff:submit', { detail: { slug: def.slug, id: def.id, data: data, score: r.body.score || null, band: r.body.band || null } }));
            if (window.FF && typeof window.FF.onSubmit === 'function') window.FF.onSubmit(def.slug, data, def, r.body.score || null, r.body.band || null);
          } catch (e) { /* tracking must never break the form */ }

          submitted = true;
          trackOnce(def, 'submit', stepNumber());

          // Show the result (score card when scoring is on) in the form, then act on the redirect.
          var result = r.body;
          if (!result.band && settings.scoring && settings.scoring.enabled) {
            result = localResult(data) || result;
          }
          renderResult(result, data);

          var goTo = result.redirect || '';
          var autoGo = !(result.scoring && result.scoring.autoRedirect === false);
          if (goTo && autoGo) {
            var delay = result.scoring && typeof result.scoring.redirectDelayMs === 'number'
              ? result.scoring.redirectDelayMs
              : 1500;
            if (newTab) {
              setTimeout(function () {
                try { newTab.location.href = goTo; }
                catch (e) { window.location.href = goTo; }
              }, delay);
              return;
            }
            setTimeout(function () { window.location.href = goTo; }, delay);
            return;
          }
          closeNewTab();
        })
        .catch(function () {
          closeNewTab();
          submitBtn.disabled = false;
          submitBtn.textContent = settings.submitLabel || 'Submit';
          showFormError('Network error — please check your connection and try again.');
        });
    });

    // ---- funnel telemetry -------------------------------------------------
    var started = false;
    var submitted = false;

    function stepNumber() {
      try {
        var vis = visiblePageIdxs(rawData());
        var pos = vis.indexOf(current);
        return (pos >= 0 ? pos : 0) + 1;
      } catch (e) { return 1; }
    }

    function markStarted() {
      if (started) return;
      started = true;
      trackOnce(def, 'start', stepNumber());
    }

    formEl.addEventListener('input', markStarted);
    formEl.addEventListener('change', markStarted);

    // Fires on navigation/close/bfcache, not on a tab switch. A submission has
    // already recorded the terminal step, so it never counts as an abandon.
    window.addEventListener('pagehide', function () {
      if (submitted || !started) return;
      try { sendEvent(def, 'abandon', stepNumber()); } catch (e) { /* ignore */ }
    });

    // Initial state
    showPage(0, false);
    applyConditions();
    if (backEl) backEl.style.visibility = 'hidden';
    trackOnce(def, 'view', 1);
  }

  // ---- resilient config load + graceful fallback -----------------------------

  var CONFIG_ATTEMPTS = 3;
  var CONFIG_BACKOFF_MS = [300, 900];

  // Fetch the published form config, retrying transient failures with backoff.
  // Every attempt is cache-busted (unique ?cb=) so a stale edge/browser copy can
  // never be mistaken for a live one. Rejects only after all attempts fail.
  function loadConfig(slug) {
    var attempt = 0;
    function once() {
      attempt += 1;
      var url = apiOrigin() + '/api/forms/' + encodeURIComponent(slug) + '?cb=' + cacheBust();
      return fetch(url, { cache: 'no-store', credentials: 'omit' })
        .then(function (res) {
          if (!res.ok) {
            var he = new Error('HTTP ' + res.status);
            he.httpStatus = res.status;
            throw he;
          }
          return res.json();
        })
        .catch(function (err) {
          var status = err && err.httpStatus ? err.httpStatus : null;
          var msg = err && err.message ? err.message : String(err);
          recordFailure({ scope: 'config', slug: slug, url: url, status: status, error: msg, attempt: attempt, at: new Date().toISOString() });
          if (attempt < CONFIG_ATTEMPTS) {
            var wait = CONFIG_BACKOFF_MS[attempt - 1] || 900;
            console.warn('[PeakForms] config "' + slug + '": attempt ' + attempt + '/' + CONFIG_ATTEMPTS + ' failed (' + (status ? 'HTTP ' + status : msg) + '), retrying in ' + wait + 'ms — ' + url);
            return sleep(wait).then(once);
          }
          console.warn('[PeakForms] config "' + slug + '": all ' + attempt + ' attempts failed (' + (status ? 'HTTP ' + status : msg) + '), rendering fallback — ' + url);
          throw err;
        });
    }
    return once();
  }

  // Graceful fallback once retries are exhausted. Only ever exposes the
  // business's own contact details from a cached config — never the forms app
  // host, which is not a public front door.
  function renderUnavailable(root, slug) {
    var cached = (window.FF && window.FF._config && window.FF._config[slug]) || null;
    var settings = (cached && cached.config && cached.config.settings) || {};
    var email = settings.contactEmail || settings.supportEmail || '';
    var phone = settings.contactPhone || '';

    var box = document.createElement('div');
    box.setAttribute('data-ff-fallback', '1');
    box.style.cssText = 'padding:14px 16px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#334155;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;';

    var title = document.createElement('p');
    title.style.cssText = 'margin:0 0 6px;font-weight:600;';
    title.textContent = 'This form is temporarily unavailable.';
    box.appendChild(title);

    var line = document.createElement('p');
    line.style.cssText = 'margin:0;';
    if (email || phone) {
      line.textContent = 'Please try again shortly, or ';
      var a = document.createElement('a');
      a.style.color = '#0f766e';
      if (email) {
        a.href = 'mailto:' + email;
        a.textContent = 'email us';
      } else {
        a.href = 'tel:' + String(phone).replace(/[^0-9+]/g, '');
        a.textContent = 'call ' + phone;
      }
      line.appendChild(a);
      line.appendChild(document.createTextNode('.'));
    } else {
      line.textContent = 'Please try again shortly.';
    }
    box.appendChild(line);

    root.appendChild(box);
  }

  function boot() {
    var roots = document.querySelectorAll('[data-ff-form]');
    roots.forEach(function (root) {
      var slug = root.getAttribute('data-ff-form');
      if (!slug || root.getAttribute('data-ff-state') === 'done') return;
      root.setAttribute('data-ff-state', 'done');
      loadConfig(slug)
        .then(function (def) {
          window.FF._config = window.FF._config || {};
          window.FF._config[slug] = def;
          render(root, def);
        })
        .catch(function () { renderUnavailable(root, slug); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Public namespace (optional hooks for host pages)
  window.FF = window.FF || {};
  window.FF.refresh = boot;
  window.FF.version = WIDGET_VERSION;
})();
