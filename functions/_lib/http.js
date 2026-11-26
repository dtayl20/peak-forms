// Shared HTTP helpers for Pages Functions.
// Public endpoints (form config GET, submission POST) are CORS-open by design:
// no cookies, no sessions — spam protection happens via Turnstile/honeypot/rate limits.

const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // Public API replies are per-request (published config, submission outcome). A
  // cached copy at an edge/CDN could pair a stale config with a newer widget, so
  // never store them. Belt-and-braces with the widget's ?cb= cache-buster.
  'Cache-Control': 'no-store',
};

export function publicHeaders(extra = {}) {
  return { ...PUBLIC_CORS, ...extra };
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function publicJson(data, status = 200) {
  return json(data, status, PUBLIC_CORS);
}

/**
 * Handles CORS preflights for public endpoints. Pages Functions only routes
 * OPTIONS to an exported onRequestOptions — without one, cross-origin browser
 * POSTs (the widget on a host page) fail preflight. GETs are simple requests
 * and never preflight, which is why this bug hid behind curl tests.
 */
export function optionsHandler() {
  return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

/** Returns a 204 Response for preflight, or null when the request is not OPTIONS. */
export function handleOptions(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }
  return null;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
