import React from 'react';
import { api, auth } from './api.js';

const field = { border: '1px solid #e1e3dc', borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', width: '100%', background: '#fff' };

export default function Login({ onDone }) {
  const [u, setU] = React.useState('');
  const [p, setP] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api('/auth/login', { username: u.trim(), password: p }); auth.set(r.token); onDone(); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };
  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f4f5f1', padding: 16 }}>
      <form onSubmit={submit} style={{ width: 'min(400px,100%)', background: '#fff', border: '1px solid #e7e8e3', borderRadius: 24, overflow: 'hidden', boxShadow: '0 14px 34px rgba(46,47,49,.08)' }}>
        <div style={{ background: '#2E2F31', padding: '26px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <img src="/logo.png" alt="دکتر پوریا افلاکی" style={{ height: 46, width: 'auto', objectFit: 'contain', objectPosition: 'right' }} />
          <div style={{ fontSize: 13, color: '#b8bab5', fontWeight: 500 }}>مرکز تماس دکتر افلاکی</div>
        </div>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 20, fontWeight: 800 }}>ورود به سامانه</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#6b6e72' }}>نام کاربری
            <input value={u} onChange={e => setU(e.target.value)} autoFocus autoComplete="username" style={{ ...field, direction: 'ltr', textAlign: 'right' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#6b6e72' }}>رمز عبور
            <input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" style={{ ...field, direction: 'ltr', textAlign: 'right' }} /></label>
          {err ? <div style={{ background: '#fdeceb', color: '#b42318', borderRadius: 10, padding: '9px 12px', fontSize: 13 }}>{err}</div> : null}
          <button disabled={busy || !u || !p} style={{ border: 'none', background: '#8DC63F', color: '#1f2021', padding: '12px 18px', borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: 'pointer', opacity: busy || !u || !p ? 0.6 : 1 }}>{busy ? 'در حال ورود…' : 'ورود'}</button>
        </div>
      </form>
    </div>
  );
}
