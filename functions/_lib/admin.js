// Admin API auth. Cloudflare Access protects /manage* and /api/admin/* at the edge
// (set up in the dashboard). The X-Admin-Key header is a second layer / deterrent
// for direct API calls, mirroring the LocalDentists pattern.

import { json } from './http.js';

export function isAdmin(request, env) {
  const key = request.headers.get('x-admin-key');
  return !!key && key === env.ADMIN_KEY;
}

export function adminGate(request, env) {
  if (isAdmin(request, env)) return null;
  return json({ error: 'unauthorized' }, 401);
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '';
}
