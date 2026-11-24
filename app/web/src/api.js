import { io } from 'socket.io-client';

const KEY = 'cc.token';
/** Platform-admin token saved only while «ورود با این مستأجر» is active. */
const ADMIN_KEY = 'cc.token.admin';
const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };

export const auth = {
  token: getToken,
  set(t) { try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ } },
  /** Start tenant session: keep the current admin JWT so «بازگشت به مدیریت» can restore it. */
  beginImpersonate(tenantToken) {
    try {
      const cur = localStorage.getItem(KEY) || '';
      if (cur) localStorage.setItem(ADMIN_KEY, cur);
      localStorage.setItem(KEY, tenantToken);
    } catch (e) { /* private mode */ }
  },
  /** Restore platform-admin JWT (or fall back to a freshly issued admin token). */
  endImpersonate(adminToken) {
    try {
      const saved = localStorage.getItem(ADMIN_KEY) || '';
      localStorage.removeItem(ADMIN_KEY);
      localStorage.setItem(KEY, adminToken || saved || '');
    } catch (e) { /* private mode */ }
  },
  logout() {
    try { localStorage.removeItem(KEY); localStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ }
    location.reload();
  },
};

export async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: 'Bearer ' + getToken() } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, opts);
  if (r.status === 401 && path !== '/auth/login') { auth.logout(); throw new Error('نشست منقضی شد'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error((data && data.message) ? [].concat(data.message).join('، ') : 'خطای سرور (' + r.status + ')');
    err.status = r.status;
    err.code = data && data.code;
    err.payload = data;
    throw err;
  }
  return data;
}

// POST that returns a file (Excel export).
api.blob = async (path, body) => {
  const r = await fetch('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + getToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { auth.logout(); throw new Error('نشست منقضی شد'); }
  if (!r.ok) { let m = 'خطای سرور (' + r.status + ')'; try { m = (await r.json()).message || m; } catch (e) { /* not json */ } throw new Error(m); }
  return r.blob();
};

// Media URLs carry the token in the query string because <audio> cannot send headers.
api.url = (path, q = {}) => '/api' + path + '?' + new URLSearchParams({ ...q, token: getToken() }).toString();

export const socket = () => io({ path: '/socket.io', auth: { token: getToken() }, transports: ['websocket', 'polling'] });
