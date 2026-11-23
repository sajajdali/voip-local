import React from 'react';
import { api, auth } from './api.js';

const field = { border: '1px solid #DDE2EA', borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', width: '100%', background: '#F8FAFC', color: '#16213A' };
const label = { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12, color: '#3A4A63', fontWeight: 600 };
const FEATURES = [
  ['لیست تماس‌ها و ضبط مکالمه', 'پخش و پیگیری همه تماس‌های ورودی و خروجی'],
  ['پیام صوتی و تلفن گویا', 'صندوق پیام، IVR و صف‌های انتظار'],
  ['تحلیل هوش مصنوعی', 'خلاصه، دسته‌بندی و ارزیابی مکالمه‌ها'],
];
// shared with the header logo in the panel
const Mark = ({ size = 46 }) => (
  <span style={{ width: size, height: size, borderRadius: size * 0.32, background: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 10px 24px -10px rgba(0,0,0,.5)', flexShrink: 0, overflow: 'hidden' }}>
    <img src="/neuron-180.png" alt="Neuron" style={{ width: size * 0.84, height: size * 0.84, display: 'block' }} />
  </span>
);

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
    <div dir="rtl" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, fontFamily: "'IRANSansX',Tahoma,sans-serif", background: 'radial-gradient(1100px 520px at 88% -8%,#D9EEEE 0%,rgba(217,238,238,0) 60%),radial-gradient(900px 480px at 0% 0%,#E3EAF6 0%,rgba(227,234,246,0) 55%),#F1F4F8' }}>
      <style>{'.cc-login{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}@media (max-width:860px){.cc-login{grid-template-columns:1fr}.cc-login-brand{padding:26px 24px!important}.cc-login-feats{display:none!important}.cc-login form{padding:26px 20px!important}}@media (max-width:420px){.cc-cap{flex-wrap:wrap}.cc-cap > input{flex:1 1 100%!important}.cc-cap > div{flex:1 1 auto!important}}'}</style>
      <div className="cc-login" style={{ width: 'min(980px,100%)', background: '#fff', border: '1px solid #E3E8EF', borderRadius: 28, overflow: 'hidden', boxShadow: '0 30px 70px -36px rgba(11,37,69,.45)' }}>
        <div className="cc-login-brand" style={{ position: 'relative', overflow: 'hidden', background: 'linear-gradient(140deg,#0B2545 0%,#123A66 55%,#0D5C63 100%)', color: '#fff', padding: '40px 38px', display: 'flex', flexDirection: 'column', gap: 26 }}>
          <span style={{ position: 'absolute', left: -90, bottom: -110, width: 320, height: 320, borderRadius: '50%', border: '46px solid rgba(43,179,163,.12)', pointerEvents: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, position: 'relative' }}>
            <Mark />
            <div>
              <div style={{ fontFamily: "'Noto Kufi Arabic',sans-serif", fontSize: 18, fontWeight: 700, lineHeight: 1.6 }}>مرکز تماس نورون <span style={{ fontFamily: "'Readex Pro',sans-serif", fontSize: 13, fontWeight: 600, color: '#5FD0C2', letterSpacing: '.5px' }}>Neuron</span></div>
              <div style={{ fontSize: 12, color: '#9FB0C8' }}>سامانه یکپارچه تماس، پیام صوتی و تلفن گویا</div>
            </div>
          </div>
          <div className="cc-login-feats" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'auto', position: 'relative' }}>
            {FEATURES.map(([t, d]) => (
              <div key={t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 16, padding: '12px 14px' }}>
                <span style={{ width: 26, height: 26, borderRadius: 9, background: 'rgba(43,179,163,.22)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7FE0D4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                </span>
                <div><div style={{ fontSize: 13, fontWeight: 600 }}>{t}</div><div style={{ fontSize: 11.5, color: '#9FB0C8', marginTop: 2 }}>{d}</div></div>
              </div>
            ))}
          </div>
        </div>
        <form onSubmit={submit} style={{ padding: '40px 38px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ display: 'inline-flex', fontSize: 11, fontWeight: 700, color: '#0A5C5B', background: '#E3F2F1', border: '1px solid #C7E6E3', padding: '3px 11px', borderRadius: 999, marginBottom: 8 }}>ورود کاربران</div>
            <div style={{ fontFamily: "'Noto Kufi Arabic',sans-serif", fontSize: 24, fontWeight: 800, color: '#0B2545', lineHeight: 1.6 }}>ورود به سامانه</div>
            <div style={{ fontSize: 12.5, color: '#5B6B82' }}>نام کاربری و رمز عبوری را که مدیر سامانه به شما داده وارد کنید.</div>
          </div>
          <label style={label}>نام کاربری
            <input value={u} onChange={e => setU(e.target.value)} autoFocus autoComplete="username" style={{ ...field, direction: 'ltr', textAlign: 'right' }} /></label>
          <label style={label}>رمز عبور
            <input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" style={{ ...field, direction: 'ltr', textAlign: 'right' }} /></label>
          <label style={label}>کد امنیتی
            <div className="cc-cap" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={code} onChange={e => setCode(e.target.value.replace(/[^0-9۰-۹]/g, '').slice(0, 5))} inputMode="numeric" autoComplete="off" placeholder="عدد تصویر" style={{ ...field, direction: 'ltr', textAlign: 'center', letterSpacing: 4, flex: 1, minWidth: 0 }} />
              <div title="کد امنیتی" style={{ width: 152, height: 48, flexShrink: 0, borderRadius: 12, overflow: 'hidden', background: '#F7F9FC', border: '1px solid #DDE2EA', display: 'grid', placeItems: 'center' }} dangerouslySetInnerHTML={{ __html: cap ? cap.svg : '' }} />
              <button type="button" onClick={newCaptcha} title="کد جدید" style={{ width: 42, height: 42, borderRadius: 12, border: '1px solid #DDE2EA', background: '#fff', cursor: 'pointer', flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3A4A63" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" /></svg>
              </button>
            </div></label>
          {err ? <div style={{ background: '#fdeceb', color: '#b42318', border: '1px solid #f5c2bd', borderRadius: 12, padding: '10px 12px', fontSize: 13 }}>{err}</div> : null}
          <button disabled={busy || !ready} style={{ border: 'none', background: 'linear-gradient(120deg,#0B2545,#0D5C63)', color: '#fff', padding: '13px 18px', borderRadius: 14, fontSize: 14, fontWeight: 700, cursor: busy || !ready ? 'default' : 'pointer', opacity: busy || !ready ? 0.55 : 1, boxShadow: '0 12px 24px -14px rgba(11,37,69,.8)', marginTop: 4 }}>{busy ? 'در حال ورود…' : 'ورود به سامانه'}</button>
        </form>
      </div>
    </div>
  );
}
