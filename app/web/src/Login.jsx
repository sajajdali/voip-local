import React from 'react';
import { api, auth } from './api.js';

const field = { border: '1px solid #e1e3dc', borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', width: '100%', background: '#fff' };

export default function Login({ onDone }) {
  const [u, setU] = React.useState('');
  const [p, setP] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [cap, setCap] = React.useState(null);
  const [code, setCode] = React.useState('');
  // a new captcha for every attempt
  const newCaptcha = React.useCallback(async () => {
    setCode('');
    try { setCap(await api('/auth/captcha')); } catch (e2) { setCap(null); }
  }, []);
  React.useEffect(() => { newCaptcha(); }, [newCaptcha]);
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api('/auth/login', { username: u.trim(), password: p, captchaId: cap && cap.id, captcha: code }); auth.set(r.token); onDone(); }
    catch (e2) { setErr(e2.message); newCaptcha(); }
    finally { setBusy(false); }
  };
  const ready = u && p && code.length >= 5;
  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f4f5f1', padding: 16 }}>
      <form onSubmit={submit} style={{ width: 'min(430px,100%)', background: '#fff', border: '1px solid #e7e8e3', borderRadius: 24, overflow: 'hidden', boxShadow: '0 14px 34px rgba(46,47,49,.08)' }}>
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
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#6b6e72' }}>کد امنیتی
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={code} onChange={e => setCode(e.target.value.replace(/[^0-9۰-۹]/g, '').slice(0, 5))} inputMode="numeric" autoComplete="off" placeholder="عدد تصویر" style={{ ...field, direction: 'ltr', textAlign: 'center', letterSpacing: 4, flex: 1, minWidth: 0 }} />
              <div title="کد امنیتی" style={{ width: 170, height: 56, flexShrink: 0, borderRadius: 10, overflow: 'hidden', background: '#f4f5f1' }} dangerouslySetInnerHTML={{ __html: cap ? cap.svg : '' }} />
              <button type="button" onClick={newCaptcha} title="کد جدید" style={{ width: 40, height: 40, borderRadius: 10, border: '1px solid #e1e3dc', background: '#fff', cursor: 'pointer', flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#55585c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" /></svg>
              </button>
            </div></label>
          {err ? <div style={{ background: '#fdeceb', color: '#b42318', borderRadius: 10, padding: '9px 12px', fontSize: 13 }}>{err}</div> : null}
          <button disabled={busy || !ready} style={{ border: 'none', background: '#8DC63F', color: '#1f2021', padding: '12px 18px', borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: 'pointer', opacity: busy || !ready ? 0.6 : 1 }}>{busy ? 'در حال ورود…' : 'ورود'}</button>
        </div>
      </form>
    </div>
  );
}
