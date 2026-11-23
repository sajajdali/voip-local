import React from 'react';
import { api, auth } from './api.js';

const REASON = {
  expired: 'اشتراک شما به پایان رسیده است',
  locked: 'دسترسی حساب قفل شده است',
  disabled: 'حساب مستأجر غیرفعال است',
};

function faNum(n) {
  return String(n ?? 0).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

export default function Paywall({ boot, onUnlocked }) {
  const t = (boot && boot.tenant) || {};
  const access = (boot && boot.access) || {};
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const reason = REASON[access.reason] || REASON.locked;
  const price = t.priceToman || 0;
  const exp = t.expiresAt ? new Date(t.expiresAt).toLocaleString('fa-IR') : '—';

  const pay = async (success) => {
    setBusy(true); setMsg('');
    try {
      const r = await api('/tenants/me/pay/simulate', { success });
      if (r.ok) {
        setMsg(r.message || 'پرداخت موفق؛ در حال باز کردن پنل…');
        setTimeout(() => onUnlocked && onUnlocked(), 600);
      } else {
        setMsg(r.message || 'پرداخت ناموفق بود');
      }
    } catch (e) {
      setMsg(e.message || 'خطا در شبیه‌ساز پرداخت');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(160deg,#F7F9FC 0%,#EEF8F7 45%,#E2ECFA 100%)', fontFamily: 'IRANSansX, Tahoma, sans-serif', color: '#0B2545' }}>
      <div style={{ width: '100%', maxWidth: 440, background: '#fff', border: '1px solid #E3E8EF', borderRadius: 20, padding: '28px 24px', boxShadow: '0 12px 40px rgba(11,37,69,.08)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: '#5B6B82', fontWeight: 600 }}>voip.s8n.ir · پنل مستأجر</div>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "'Noto Kufi Arabic',sans-serif" }}>{t.name || 'اشتراک'}</h1>
        <div style={{ background: '#fdeceb', border: '1px solid #f5c2c0', borderRadius: 12, padding: '12px 14px', color: '#b42318', fontSize: 14, fontWeight: 600 }}>{reason}</div>
        <div style={{ fontSize: 13, color: '#3A4A63', lineHeight: 1.7 }}>
          <div>مدت طرح: <b>{t.planLabel || t.planPeriod || '—'}</b></div>
          <div>انقضا: <b>{exp}</b></div>
          <div>مبلغ دوره: <b>{price ? faNum(price.toLocaleString('en-US')) + ' تومان' : 'رایگان / توافقی'}</b></div>
        </div>
        <div style={{ fontSize: 12, color: '#7A889C', lineHeight: 1.6 }}>
          درگاه واقعی هنوز وصل نیست. با شبیه‌ساز پرداخت می‌توانید تمدید موفق یا ناموفق را تست کنید.
        </div>
        {msg && <div style={{ fontSize: 13, color: msg.includes('ناموفق') ? '#b42318' : '#0A5C5B', background: '#F7F9FC', borderRadius: 10, padding: '10px 12px' }}>{msg}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <button type="button" disabled={busy} onClick={() => pay(true)} style={{ border: 'none', background: 'linear-gradient(135deg,#0A5C5B,#1D4E89)', color: '#fff', padding: '12px 16px', borderRadius: 12, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 14 }}>
            {busy ? '…' : 'پرداخت موفق (شبیه‌ساز) — باز کردن دسترسی'}
          </button>
          <button type="button" disabled={busy} onClick={() => pay(false)} style={{ border: '1px solid #E3E8EF', background: '#fff', color: '#5B6B82', padding: '10px 16px', borderRadius: 12, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
            پرداخت ناموفق (شبیه‌ساز)
          </button>
          <button type="button" onClick={() => auth.logout()} style={{ border: 'none', background: 'transparent', color: '#7A889C', padding: '8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
            خروج از حساب
          </button>
        </div>
      </div>
    </div>
  );
}
