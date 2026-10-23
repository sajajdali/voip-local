import { io } from 'socket.io-client';

const KEY = 'cc.token';
const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };

export const auth = {
  token: getToken,
  set(t) { try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ } },
  logout() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } location.reload(); },
};

export async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: 'Bearer ' + getToken() } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, opts);
  if (r.status === 401 && path !== '/auth/login') { auth.logout(); throw new Error('نشست منقضی شد'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.message) ? [].concat(data.message).join('، ') : 'خطای سرور (' + r.status + ')');
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
