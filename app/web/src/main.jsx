import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import Login from './Login.jsx';
import { api, auth } from './api.js';

function Root() {
  const [boot, setBoot] = React.useState(null);
  const [state, setState] = React.useState(auth.token() ? 'loading' : 'login');
  const [err, setErr] = React.useState('');
  const load = React.useCallback(async () => {
    setState('loading');
    try { setBoot(await api('/bootstrap')); setState('ready'); }
    catch (e) { setErr(e.message); setState(auth.token() ? 'error' : 'login'); }
  }, []);
  React.useEffect(() => { if (state === 'loading') load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (state === 'login') return <Login onDone={load} />;
  if (state === 'ready') return <App boot={boot} />;
  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#6b6e72', fontSize: 14 }}>
      {state === 'error' ? <div style={{ textAlign: 'center' }}>خطا در بارگذاری: {err}<br /><button onClick={load} style={{ marginTop: 12, border: 'none', background: '#2E2F31', color: '#fff', padding: '9px 18px', borderRadius: 10, cursor: 'pointer' }}>تلاش دوباره</button></div> : 'در حال بارگذاری…'}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
