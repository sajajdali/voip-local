// Builds the Asterisk configuration from the panel's VoIP collections.
// Pure functions only: input = the ConfigEntry rows, output = file contents + AstDB entries.
// The panel replaces Issabel/FreePBX, so everything a call needs is generated here.
import { jalaliToGregorianCompact } from '../jalali';
import { tenantPrefix } from '../tenant-scope';

export interface VoipConfig {
  exts: any[]; trunks: any[]; vqs: any[]; ivrs: any[]; snds: any[]; routes: any[];
  tgroups: any[]; tconds: any[]; holidays: any[]; rgroups: any[]; fmes: Record<string, any>;
  blist: any[]; bset: any; oroutes?: any[]; survey?: any; vmbox?: any; aiagent?: any; booking?: any;
  /** Preferred agent before queue: { ringSec } — default 40. */
  prefagent?: { ringSec?: number };
  didRoutes?: { did: string; tenantId: string; dest: string; name?: string }[];
}

export interface Generated {
  files: Record<string, string>;
  astdb: Record<string, Record<string, string>>; // family -> key -> value (families are replaced wholesale)
  moh: Record<string, string>; // moh class -> sound id
  warnings: string[];
}

const DOW = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']; // design index 0 = Saturday
const QSTRAT: Record<string, string> = { ringall: 'ringall', leastrecent: 'leastrecent', roundrobin: 'rrmemory', random: 'random' };
const digits = (s: any) => String(s ?? '').replace(/\D/g, '');
// Dialplan values must not break the line / argument syntax.
const safe = (s: any) => String(s ?? '').replace(/[\r\n;,()|\\$\[\]{}"]/g, ' ').trim();
const sid = (s: any) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');

/** Unique PJSIP endpoint name: tenant exts use e.sip (tn…_102); platform exts use dial digits. */
export function sipOf(e: { n?: any; sip?: any } | null | undefined) {
  if (!e) return '';
  if (e.sip) return sid(e.sip);
  return digits(e.n);
}

/** Resolve a queue/ring-group member (dial digits or sip id) within an optional tenant. */
export function findExt(cfg: VoipConfig, member: string, tenantId?: string | null) {
  const m = String(member ?? '');
  if (!m) return undefined;
  if (tenantId) {
    const hit = cfg.exts.find(e => e.tenantId === tenantId && (e.n === m || digits(e.n) === digits(m) || e.sip === m));
    if (hit) return hit;
  }
  return cfg.exts.find(e => e.sip === m)
    || cfg.exts.find(e => !e.tenantId && (e.n === m || digits(e.n) === digits(m)))
    || cfg.exts.find(e => e.n === m || digits(e.n) === digits(m));
}

export function isExternal(n: string, cfg: VoipConfig, tenantId?: string | null) {
  return !findExt(cfg, n, tenantId);
}

export function codecs(text: string) {
  const out: string[] = [];
  const add = (c: string) => { if (!out.includes(c)) out.push(c); };
  for (const tok of String(text || '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) {
    if (/^(ulaw|pcmu)$/.test(tok)) add('ulaw');
    else if (/^(alaw|pcma)$/.test(tok)) add('alaw');
    else if (/711/.test(tok)) { add('alaw'); add('ulaw'); }
    else if (/722/.test(tok)) add('g722');
    else if (tok === 'gsm') add('gsm');
  }
  return out.length ? out : ['alaw', 'ulaw'];
}

/** Routing order: most specific first (DID+CID, DID, CID, default), then priority. */
export function routeScore(r: any) { return (r.did ? 2 : 0) + (r.cid ? 1 : 0); }
export function sortRoutes(routes: any[]) {
  return [...routes].sort((a, b) => routeScore(b) - routeScore(a) || (a.prio || 0) - (b.prio || 0));
}

/** Issabel-style CallerID pattern (X, N, Z, .) -> POSIX regex used by the dialplan REGEX() function. */
export function cidRegex(p: string) {
  return '^' + String(p).toUpperCase().replace(/[^0-9XNZ.]/g, '').replace(/\./g, '[0-9]*').replace(/X/g, '[0-9]').replace(/N/g, '[2-9]').replace(/Z/g, '[1-9]') + '$';
}

export function destTarget(dest: string, cfg: VoipConfig): string {
  if (!dest) return 'cc-hang,s,1';
  const [kind, id] = dest.includes(':') ? dest.split(':') : [dest, ''];
  switch (kind) {
    case 'q': return cfg.vqs.some(q => q.id === id) ? `cc-queue-${sid(id)},s,1` : 'cc-hang,s,1';
    case 'rg': return cfg.rgroups.some(g => g.id === id) ? `cc-rg-${sid(id)},s,1` : 'cc-hang,s,1';
    case 'ivr': return cfg.ivrs.some(i => i.id === id) ? `cc-ivr-${sid(id)},s,1` : 'cc-hang,s,1';
    case 'tc': return cfg.tconds.some(t => t.id === id) ? `cc-tc-${sid(id)},s,1` : 'cc-hang,s,1';
    case 'e': {
      const hit = findExt(cfg, id) || cfg.exts.find(e => sipOf(e) === sid(id));
      return hit ? `cc-ext,${sipOf(hit)},1` : 'cc-hang,s,1';
    }
    case 'vm': return 'cc-vm,s,1';
    case 'busy': return 'cc-busy,s,1';
    case 'ann': return cfg.snds.some(x => x.id === id) ? `cc-ann,${sid(id)},1` : 'cc-hang,s,1';
    // AI receptionist; while it is switched off, calls take its fallback destination
    case 'ai': return cfg.aiagent?.enabled ? 'cc-ai,s,1' : cfg.aiagent?.fallback && cfg.aiagent.fallback !== 'ai' ? destTarget(cfg.aiagent.fallback, cfg) : 'cc-vm,s,1';
    // phone booking line (key 2 / key 3 of the old menu); while it is off, calls take its fallback destination
    case 'book': return cfg.booking?.enabled ? 'cc-book,s,1' : bookingFallback(cfg);
    case 'booktrack': return cfg.booking?.enabled ? 'cc-book,track,1' : bookingFallback(cfg);
    default: return 'cc-hang,s,1';
  }
}

const bookingDest = (cfg: VoipConfig, key: 'fallback' | 'backDest') => {
  const f = String(cfg.booking?.[key] || '');
  return f && f !== 'book' && f !== 'booktrack' ? destTarget(f, cfg) : 'cc-hang,s,1';
};
const bookingFallback = (cfg: VoipConfig) => bookingDest(cfg, 'fallback');

const sound = (id: string, cfg: VoipConfig) => (cfg.snds.some(s => s.id === id) ? `custom/${sid(id)}` : '');

function firstTrunk(cfg: VoipConfig) {
  return cfg.trunks.find(t => t.on && t.type !== 'PRI / E1' && t.host && t.host !== '—');
}

function dialString(n: string, cfg: VoipConfig, tenantId?: string | null) {
  const e = findExt(cfg, n, tenantId);
  if (!e) return `Local/${digits(n)}@cc-outext/n`;
  return `PJSIP/${sipOf(e)}`;
}

function minusMinute(hm: string) {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.max(0, h * 60 + m - 1);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// ---------------------------------------------------------------- pjsip
function pjsip(cfg: VoipConfig, warnings: string[]) {
  const L: string[] = ['; Generated by the call-center panel. Do not edit: changes are overwritten on every save.', ''];
  // once any extension may register from the internet, all the others accept requests from private networks only
  const remoteSite = cfg.exts.some(e => e.remote);
  for (const e of cfg.exts) {
    const n = digits(e.n);
    const sip = sipOf(e);
    if (!n || !sip) continue;
    const webrtc = e.type === 'WebRTC';
    L.push(`[${sip}]`, 'type=endpoint', 'context=cc-internal', 'disallow=all', `allow=${webrtc ? 'opus,alaw,ulaw' : 'alaw,ulaw,gsm,g722'}`,
      `auth=${sip}`, `aors=${sip}`, `callerid="${safe(e.name)}" <${n}>`, 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes',
      'rewrite_contact=yes', 'device_state_busy_at=1', `transport=${webrtc ? 'transport-wss' : 'transport-udp'}`);
    // Dial number + tenant scope for answer hooks / short-dial (phones register as sip, dial peers as n)
    L.push(`set_var=CC_EXTNUM=${n}`);
    if (e.tenantId) {
      L.push(`set_var=CC_TENANT=${sid(e.tenantId)}`, `set_var=CC_TNPREFIX=${sid(tenantPrefix(e.tenantId))}`);
    }
    if (webrtc) L.push('webrtc=yes', 'dtls_auto_generate_cert=yes');
    if (remoteSite && !e.remote) L.push('deny=0.0.0.0/0.0.0.0', 'permit=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    L.push('', `[${sip}]`, 'type=auth', 'auth_type=userpass', `username=${sip}`, `password=${e.secret || ''}`, '',
      `[${sip}]`, 'type=aor', 'max_contacts=3', 'remove_existing=yes', 'qualify_frequency=30', '');
    if (e.type === 'IAX2') warnings.push(`داخلی ${n} از نوع IAX2 به‌صورت SIP (PJSIP) ساخته شد.`);
  }
  for (const t of cfg.trunks) {
    if (!t.on) continue;
    if (t.type === 'PRI / E1' || !t.host || t.host === '—') { warnings.push(`ترانک «${t.name}» به سخت‌افزار E1/آدرس نیاز دارد و ساخته نشد.`); continue; }
    const id = `trunk-${sid(t.id)}`, host = String(t.host).replace(/[^A-Za-z0-9.:-]/g, '');
    const hasAuth = !!(t.user && t.pass);
    if (hasAuth) {
      L.push(`[${id}-auth]`, 'type=auth', 'auth_type=userpass', `username=${safe(t.user)}`, `password=${t.pass}`, '');
      L.push(`[${id}-reg]`, 'type=registration', `outbound_auth=${id}-auth`, `server_uri=sip:${host}`, `client_uri=sip:${safe(t.user)}@${host}`,
        `contact_user=${digits(t.did) || safe(t.user)}`, 'expiration=300', `endpoint=${id}`, 'line=yes',
        // never give up: after a cable/network outage or a refusal from the provider, keep trying every minute
        'retry_interval=60', 'forbidden_retry_interval=60', 'fatal_retry_interval=60', 'auth_rejection_permanent=no', 'max_retries=1000000', '');
    }
    L.push(`[${id}]`, 'type=aor', `contact=sip:${host}`, 'qualify_frequency=60', '');
    L.push(`[${id}]`, 'type=endpoint', 'transport=transport-udp', 'context=from-trunk', 'disallow=all', `allow=${codecs(t.codec).join(',')}`,
      `aors=${id}`, 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'send_rpid=yes', 'trust_id_inbound=yes', `dtmf_mode=${['inband', 'info', 'auto', 'rfc4733'].includes(t.dtmf) ? t.dtmf : 'rfc4733'}`);
    if (hasAuth) L.push(`outbound_auth=${id}-auth`, `from_user=${safe(t.user)}`, `from_domain=${host}`);
    // trunk reached over a second NIC: send RTP from (and advertise) that NIC's address
    const media = String(t.media || '').replace(/[^0-9.]/g, '');
    if (media) L.push(`media_address=${media}`, 'bind_rtp_to_media_address=yes');
    L.push('', `[${id}-identify]`, 'type=identify', `endpoint=${id}`, `match=${host.split(':')[0]}`, '');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- queues / moh
/** The «صندوق پیام» key, when it is on in this IVR (default: the old «all menus» switch) or queue (default: off). */
export function vmboxKey(cfg: VoipConfig, kind: 'ivr' | 'queue', x: any): string {
  const vb = cfg.vmbox || {};
  if (!vb.on || !/^[0-9*#]$/.test(vb.key || '')) return '';
  const on = kind === 'ivr' ? (typeof x.vbKey === 'boolean' ? x.vbKey : vb.inIvr !== false) : x.vbKey === true;
  return on ? vb.key : '';
}

function queues(cfg: VoipConfig) {
  const L: string[] = ['; Generated by the call-center panel.', ''];
  for (const q of cfg.vqs) {
    L.push(`[cc-${sid(q.id)}]`, `strategy=${QSTRAT[q.strat] || 'ringall'}`, `timeout=${Math.max(5, +q.ring || 20)}`, 'retry=5', 'wrapuptime=0', 'servicelevel=60',
      'joinempty=yes', 'leavewhenempty=no', `ringinuse=${q.riu ? 'yes' : 'no'}`, 'autofill=yes', 'reportholdtime=no', 'setinterfacevar=yes', 'setqueuevar=yes',
      `musicclass=${q.moh && cfg.snds.some(s => s.id === q.moh) ? 'snd-' + sid(q.moh) : 'default'}`,
      // a caller waiting in the queue leaves it with the voicemail key (one digit, looked up in this context)
      ...(vmboxKey(cfg, 'queue', q) ? [`context=cc-qkey-${sid(q.id)}`] : []));
    for (const m of q.members || []) {
      const e = findExt(cfg, String(m), q.tenantId);
      if (e) L.push(`member => PJSIP/${sipOf(e)},0,${safe(e.name) || digits(e.n) || m},PJSIP/${sipOf(e)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

function moh(cfg: VoipConfig, dir: string) {
  const L: string[] = ['; Generated by the call-center panel. One class per uploaded sound.', ''];
  const map: Record<string, string> = {};
  for (const s of cfg.snds) {
    const cls = 'snd-' + sid(s.id);
    map[cls] = s.id;
    L.push(`[${cls}]`, 'mode=files', `directory=${dir}/${sid(s.id)}`, 'sort=alpha', '');
  }
  return { text: L.join('\n'), map };
}

// ---------------------------------------------------------------- dialplan
export const SURVEY_MAX_Q = 5;
/** Greeting, beep, recording and closing prompt of the voice mailbox («صندوق پیام» settings). */
function vmboxLines(cfg: VoipConfig): string[] {
  const vb = cfg.vmbox || {};
  const has = (id: string) => !!id && cfg.snds.some(s => s.id === id);
  if (!vb.on) return [' same => n,Playback(beep)', ' same => n,Record(${ASTSPOOLDIR}/monitor/${CC_REC},4,180,k)', ' same => n,Hangup()'];
  const silence = Math.min(30, Math.max(0, +vb.silence || 0)), max = Math.min(600, Math.max(15, +vb.maxSec || 120));
  // Record() ends on # by default; t = * instead; x = no key at all (silence, time limit or hang-up)
  const opt = 'k' + (vb.term === '*' ? 't' : vb.term === 'none' ? 'x' : '');
  return [
    ...(has(vb.greet) ? [` same => n,Playback(custom/${sid(vb.greet)})`] : []),
    ...(vb.beep !== false ? [' same => n,Playback(beep)'] : []),
    ` same => n,Record(\${ASTSPOOLDIR}/monitor/\${CC_REC},${silence},${max},${opt})`,
    ...(has(vb.end) ? [` same => n,Playback(custom/${sid(vb.end)})`] : []),
    ' same => n,Hangup()',
  ];
}

function surveyLines(cfg: VoipConfig): string[] {
  const sv = cfg.survey || {};
  const has = (id: string) => !!id && cfg.snds.some(s => s.id === id);
  const qs = (sv.qs || []).filter((q: any) => has(q.snd)).slice(0, SURVEY_MAX_Q);
  if (!sv.on || !qs.length) return ['exten => s,1,Hangup()'];
  const to = Math.min(15, Math.max(2, +sv.timeout || 5)), retry = Math.min(3, Math.max(0, +sv.retry || 0));
  const cm = sv.comment || {}, low = Math.min(4, Math.max(1, +cm.max || 2));
  const L = [
    'exten => s,1,GotoIf($["${CC_DIR}"!="in" | "${CC_ANSTS}"=""]?end)',
    ` same => n,GotoIf($[\${EPOCH} - \${CC_ANSTS} < ${Math.max(0, +sv.minTalk || 0)}]?end)`,
    ' same => n,' + ccEvent('survey.started', 'Ansext: ${CC_ANSEXT}'),
    ...(has(sv.intro) ? [` same => n,Playback(custom/${sid(sv.intro)})`] : []),
  ];
  qs.forEach((q: any, i: number) => {
    const v = `CC_SV${i + 1}`;
    L.push(
      ` same => n(q${i + 1}),Set(CC_T=0)`,
      ` same => n(q${i + 1}r),Read(${v},custom/${sid(q.snd)},1,,1,${to})`,
      ` same => n,GotoIf(\${REGEX("^[1-5]$" \${${v}})}?a${i + 1})`,
      ` same => n,Set(${v}=)`,
      ' same => n,Set(CC_T=$[${CC_T}+1])',
      ` same => n,GotoIf($[\${CC_T} > ${retry}]?fin)`,
      ...(has(sv.invalid) ? [` same => n,Playback(custom/${sid(sv.invalid)})`] : []),
      ` same => n,Goto(q${i + 1}r)`,
      ` same => n(a${i + 1}),ExecIf($[\${${v}} <= ${low}]?Set(CC_SVLOW=1))`,
    );
  });
  L.push(` same => n(q${qs.length + 1}),NoOp(survey done)`,
    ' same => n(fin),GotoIf($["${CC_SV1}"=""]?end)');
  // a low score: ask why and record the caller's answer (ended by # or silence)
  if (cm.on && has(cm.snd)) L.push(
    ' same => n,GotoIf($["${CC_SVLOW}"!="1"]?thx)',
    ` same => n,Playback(custom/${sid(cm.snd)})`,
    ' same => n,Set(CC_SVREC=cc-svc/${STRFTIME(${EPOCH},,%Y%m%d)}-${FILTER(0-9.,${UNIQUEID})}.wav)',
    ` same => n,Record(\${ASTSPOOLDIR}/monitor/\${CC_SVREC},6,${Math.min(180, Math.max(10, +cm.maxSec || 60))},k)`);
  L.push(...(has(sv.thanks) ? [` same => n(thx),Playback(custom/${sid(sv.thanks)})`] : [' same => n(thx),Playback(beep)']),
    ' same => n(end),Hangup()');
  return L;
}

/** Text for a UserEvent header: percent-encoded so commas, brackets and Persian letters pass through the dialplan. */
export function evText(v: string) {
  return encodeURIComponent(String(v || '')).replace(/[()!*']/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** A call step for «ارسال تماس‌ها (API)» (read by CallEventsService from AMI). */
const ccEvent = (type: string, fields = '') => `UserEvent(CCEvent,Type: ${type}${fields ? ',' + fields : ''})`;

function dialplan(cfg: VoipConfig, opts: { hookUrl: string; hookSecret: string }) {
  const L: string[] = ['; Generated by the call-center panel. Do not edit: changes are overwritten on every save.', ''];
  const X = (ctx: string, lines: string[]) => { L.push(`[${ctx}]`, ...lines, ''); };
  const trunk = firstTrunk(cfg);
  const hook = (path: string, data: string) => `Set(CC_CURL=\${CURL(${opts.hookUrl}/${path}?s=${opts.hookSecret},${data})})`;
  // caller name from the local patient cache (the CRM lookup started when the call came in); set right before phones ring
  // Pass DID so CRM routing can pick dastgheib vs kamilo by called number (not platform-global).
  const cname = [
    ` same => n,Set(CC_CNAME=\${CURL(${opts.hookUrl}/cname?s=${opts.hookSecret},num=\${CC_NUM}&did=\${CC_DID})})`,
    ' same => n,ExecIf($["${CC_DIR}"="in" & "${CC_CNAME}"!=""]?Set(CALLERID(name)=${CC_CNAME}))',
  ];

  X('globals-cc', []);

  // --- entry from trunks (normalize DID: strip 98/0, keep last-8 for 31985xxxx pool)
  X('from-trunk', [
    'exten => _[+0-9].,1,Set(__CC_DID=${FILTER(0-9,${EXTEN})})',
    ' same => n,GotoIf($["${CC_DID:0:2}"="98"]?strip98:chk0)',
    ' same => n(strip98),Set(__CC_DID=${CC_DID:2})',
    ' same => n(chk0),GotoIf($["${CC_DID:0:1}"="0"]?strip0:norm8)',
    ' same => n(strip0),Set(__CC_DID=${CC_DID:1})',
    ' same => n(norm8),GotoIf($[${LEN(${CC_DID})}>8]?last8:goin)',
    ' same => n(last8),Set(__CC_DID=${CC_DID:-8})',
    ' same => n(goin),Goto(cc-inbound,s,1)',
    'exten => s,1,Set(__CC_DID=)',
    ' same => n,Goto(cc-inbound,s,1)',
  ]);

  // --- inbound: blacklist -> tenant DID routes -> panel routes
  const routeLines: string[] = [];
  for (const d of cfg.didRoutes || []) {
    const did = digits(d.did);
    if (!did) continue;
    // Match exact DID and common provider variants (0+did / 98+did)
    routeLines.push(` same => n,GotoIf($["\${CC_DID}"="${did}" | "\${CC_DID}"="0${did}" | "\${CC_DID}"="98${did}"]?cc-tenant-${sid(d.tenantId)}-${did},s,1)`);
  }
  for (const r of sortRoutes(cfg.routes).filter(r => r.on)) {
    const conds: string[] = [];
    if (r.did) conds.push(`"\${CC_DID}"="${digits(r.did)}"`);
    if (r.cid) conds.push(`\${REGEX("${cidRegex(r.cid)}" \${CC_CID})}`);
    const cond = conds.length ? conds.join(' & ') : '1';
    routeLines.push(` same => n,GotoIf($[${cond}]?cc-route-${sid(r.id)},s,1)`);
  }
  X('cc-inbound', [
    'exten => s,1,Set(__CC_DIR=in)',
    ' same => n,Set(__CC_START=${EPOCH})',
    ' same => n,Set(CHANNEL(hangup_handler_push)=cc-hangup,s,1)',
    ' same => n,Set(CC_CID=${FILTER(0-9,${CALLERID(num)})})',
    ' same => n,Set(__CC_NUM=${CC_CID})',
    // Accountcode survives Gotos (Exten becomes s) so live callpop can recover the DID
    ' same => n,Set(CHANNEL(accountcode)=${CC_DID})',
    ' same => n,GotoIf($["${CC_CID}"=""]?anon)',
    ' same => n,GotoIf(${DB_EXISTS(ccbl/${CC_CID})}?blocked:route)',
    ' same => n(anon),GotoIf($["${DB(ccset/anon)}"="1"]?blocked:route)',
    ' same => n(blocked),Set(CC_BLOCKED=1)',
    ' same => n,' + hook('blhit', 'num=${CC_CID}'),
    ' same => n,Goto(cc-blocked,s,1)',
    ' same => n(route),NoOp(route matching)',
    ' same => n,' + ccEvent('call.started', 'Uid: ${UNIQUEID},Dir: in,Num: ${URIENCODE(${CC_NUM})},Did: ${CC_DID}'),
    // CRM lookup in the background — include DID so 31985 never hits dastgheib and 2100… maps to it
    ' same => n,GotoIf($["${CC_CID}"=""]?nolookup)',
    ' same => n,' + hook('lookup', 'num=${CC_CID}&did=${CC_DID}'),
    ' same => n(nolookup),NoOp()',
    ...routeLines,
    ' same => n,Hangup(21)',
  ]);

  // --- internal test entry: *88<DID> simulates an inbound call on that DID from this extension
  for (const d of cfg.didRoutes || []) {
    const did = digits(d.did);
    if (!did) continue;
    X(`cc-tenant-${sid(d.tenantId)}-${did}`, [
      `exten => s,1,NoOp(Tenant ${safe(d.name || d.tenantId)} DID ${did})`,
      ` same => n,Set(__CC_TENANT=${sid(d.tenantId)})`,
      ` same => n,Set(__CC_DID=${did})`,
      ` same => n,Set(CHANNEL(accountcode)=${did})`,
      ` same => n,Goto(${destTarget(d.dest, cfg)})`,
    ]);
  }

  for (const r of cfg.routes) {
    X(`cc-route-${sid(r.id)}`, [
      `exten => s,1,NoOp(Inbound route ${safe(r.name)})`,
      ...(r.prefix ? [` same => n,Set(CALLERID(name)=${safe(r.prefix)}\${CALLERID(name)})`] : []),
      ` same => n,Set(CHANNEL(language)=${sid(r.lang) || 'fa'})`,
      ...(r.moh && cfg.snds.some(s => s.id === r.moh) ? [` same => n,Set(CHANNEL(musicclass)=snd-${sid(r.moh)})`] : []),
      ` same => n,Set(__CC_RECMODE=${sid(r.rec) || 'dontcare'})`,
      ...(r.alert ? [` same => n,Set(__CC_ALERT=${safe(r.alert)})`] : []),
      ...(r.fax ? [' same => n,Set(FAXOPT(faxdetect)=yes)'] : []),
      ` same => n,Goto(${destTarget(r.dest, cfg)})`,
    ]);
  }

  // --- blocked callers
  const act = (cfg.bset && cfg.bset.action) || 'hang';
  X('cc-blocked', [
    'exten => s,1,NoOp(Blacklisted caller)',
    ...(act === 'busy' ? [' same => n,Busy(10)'] : act === 'vm' ? [' same => n,Goto(cc-vm,s,1)'] :
      act === 'msg' ? [' same => n,Answer()', ...(sound(cfg.bset.sound, cfg) ? [` same => n,Playback(${sound(cfg.bset.sound, cfg)})`] : []), ' same => n,Hangup()'] :
        [' same => n,Hangup(21)']),
  ]);

  // --- time conditions (the server clock is UTC: hours and holidays are Tehran time)
  for (const t of cfg.tconds) {
    const g = cfg.tgroups.find(x => x.id === t.group);
    const ranges = (g ? g.ranges : []).filter((r: any) => r.days && r.days.length);
    X(`cc-tc-${sid(t.id)}`, [
      `exten => s,1,NoOp(Time condition ${safe(t.name)})`,
      ` same => n,Set(CC_OVR=\${DB(cctc/${sid(t.id)})})`,
      ' same => n,GotoIf($["${CC_OVR}"="open"]?open)',
      ' same => n,GotoIf($["${CC_OVR}"="closed"]?closed)',
      ...(t.useHol ? [' same => n,GotoIf(${DB_EXISTS(ccholiday/${STRFTIME(${EPOCH},Asia/Tehran,%Y%m%d)})}?closed)'] : []),
      ...ranges.map((r: any) => ` same => n,GotoIfTime(${r.from}-${minusMinute(r.to)},${[...r.days].sort().map((d: number) => DOW[d]).join('&')},*,*,Asia/Tehran?open)`),
      ' same => n(closed),Set(__CC_TCOUT=1)',
      ` same => n,Goto(${destTarget(t.closed, cfg)})`,
      ` same => n(open),Goto(${destTarget(t.open, cfg)})`,
    ]);
  }

  // --- IVRs
  for (const iv of cfg.ivrs) {
    const greet = sound(iv.greet, cfg), after = sound(iv.after, cfg);
    const to = Math.max(1, +iv.timeout || 6);
    const rep = iv.rep === undefined ? 1 : Math.max(0, +iv.rep || 0);
    const lines = [
      'exten => s,1,Answer()',
      ' same => n,Set(CC_IVRTRY=0)',
      ` same => n,Set(__CC_QUEUE=IVR ${safe(iv.name)})`,
      ' same => n,Set(TIMEOUT(digit)=3)',
      ...(after ? [` same => n,ExecIf($["\${CC_TCOUT}"="1"]?Playback(${after}))`] : []),
      ' same => n(start),Set(CC_IVRTRY=$[${CC_IVRTRY}+1])',
      greet ? ` same => n,Background(${greet})` : ' same => n,Background(beep)',
      ` same => n,WaitExten(${to})`,
    ];
    for (const o of iv.opts || []) {
      if (!/^[0-9*#]$/.test(o.k)) continue;
      lines.push(`exten => ${o.k},1,NoOp(${safe(o.label)})`, ` same => n,${ccEvent('call.ivr', `Menu: ${evText(iv.name)},Key: ${o.k},Label: ${evText(o.label)}`)}`, ` same => n,Goto(${destTarget(o.dest, cfg)})`);
    }
    lines.push(`exten => t,1,GotoIf($[\${CC_IVRTRY}<=${rep}]?s,start)`, ` same => n,Goto(${destTarget(iv.tdest || 'vm', cfg)})`,
      `exten => i,1,GotoIf($[\${CC_IVRTRY}<=${rep}]?s,start)`, ` same => n,Goto(${destTarget(iv.idest || 'vm', cfg)})`);
    // callers can also dial the AI receptionist's code while the menu plays (unless it clashes with a menu key)
    const aiCode = cfg.aiagent?.enabled && cfg.aiagent.codeInIvr !== false ? String(cfg.aiagent.code || '') : '';
    if (aiCode && !(iv.opts || []).some((o: any) => o.k === aiCode)) lines.push(`exten => ${aiCode},1,Goto(cc-ai,s,1)`);
    // «صندوق پیام» key in every menu (a menu's own option on the same key wins)
    const vbk = vmboxKey(cfg, 'ivr', iv);
    if (vbk && vbk !== aiCode && !(iv.opts || []).some((o: any) => o.k === vbk))
      lines.push(`exten => ${vbk},1,Set(__CC_QUEUE=صندوق پیام · IVR ${safe(iv.name)})`, ' same => n,Goto(cc-vm,s,1)');
    if (iv.ddial) lines.push('include => cc-ivr-direct');
    X(`cc-ivr-${sid(iv.id)}`, lines);
  }

  // --- queues
  // Preferred agent (Kamilo زیبایار agent_id → User.apiId): announce + ring that ext first;
  // unavailable / no-answer → optional queue-fallback announce, then Queue as today.
  // Ring timeout is per-queue (tenant stamp prefRingSec) with platform prefagent.ringSec fallback (default 40).
  const prefBlock = (ringSec: number) => {
    const sec = Math.max(5, Math.min(120, Math.round(+ringSec || 40)));
    return [
      ` same => n,Set(CC_PREF=\${CURL(${opts.hookUrl}/prefagent?s=${opts.hookSecret},num=\${CC_NUM}&did=\${CC_DID})})`,
      ' same => n,GotoIf($["${CC_PREF}"=""]?prefskip)',
      ' same => n,Set(CC_PREFEXT=${CUT(CC_PREF,|,1)})',
      ' same => n,Set(CC_PREFSND=${CUT(CC_PREF,|,2)})',
      ' same => n,Set(CC_PREFQSND=${CUT(CC_PREF,|,3)})',
      ' same => n,GotoIf($["${CC_PREFEXT}"=""]?prefskip)',
      // Busy / offline: skip Dial, still play queue-fallback announce before Queue.
      ' same => n,GotoIf($["${DEVICE_STATE(PJSIP/${CC_PREFEXT})}"!="NOT_INUSE"]?preffall)',
      ' same => n,ExecIf($["${CC_PREFSND}"!=""]?Playback(${CC_PREFSND}))',
      ` same => n,${ccEvent('call.ringing', 'Target: preferred,Ext: ${CC_PREFEXT}')}`,
      ` same => n,Dial(PJSIP/\${CC_PREFEXT},${sec},trgU(cc-agent-answer^0))`,
      ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)',
      ' same => n(preffall),ExecIf($["${CC_PREFQSND}"!=""]?Playback(${CC_PREFQSND}))',
      ' same => n(prefskip),NoOp(preferred agent done)',
    ];
  };
  const defaultPrefRing = Math.max(5, Math.min(120, Math.round(+(cfg.prefagent?.ringSec ?? 40) || 40)));
  for (const q of cfg.vqs) {
    const ring = q.prefRingSec != null ? +q.prefRingSec : defaultPrefRing;
    X(`cc-queue-${sid(q.id)}`, [
      'exten => s,1,Answer()',
      ` same => n,Set(__CC_QUEUE=${safe(q.name)})`,
      ` same => n,${ccEvent('call.queued', `Queue: ${evText(q.name)}`)}`,
      ...cname,
      ...prefBlock(ring),
      ...(q.moh && cfg.snds.some(s => s.id === q.moh) ? [` same => n,Set(CHANNEL(musicclass)=snd-${sid(q.moh)})`] : []),
      ` same => n,Queue(cc-${sid(q.id)},tc,,,${+q.maxWait > 0 ? Math.max(10, +q.maxWait) : ''},,cc-agent-answer)`,
      ' same => n,GotoIf($["${CC_ANSEXT}"!=""]?cc-survey,s,1)',
      ` same => n,Goto(${destTarget(q.fail || 'vm', cfg)})`,
    ]);
    const qk = vmboxKey(cfg, 'queue', q);
    if (qk) X(`cc-qkey-${sid(q.id)}`, [`exten => ${qk},1,Set(__CC_QUEUE=صندوق پیام · صف ${safe(q.name)})`, ' same => n,Goto(cc-vm,s,1)']);
  }

  // --- ring groups
  for (const g of cfg.rgroups) {
    const ring = Math.max(5, +g.ring || 20);
    const tid = g.tenantId || null;
    const members = [...(g.members || []).filter((m: string) => !isExternal(m, cfg, tid)), ...(g.ext || [])];
    const mopt = g.moh && g.moh !== 'ring' && cfg.snds.some(s => s.id === g.moh) ? `m(snd-${sid(g.moh)})` : 'r';
    const U = `U(cc-agent-answer^${g.confirm ? 1 : 0})`;
    const lines = [
      `exten => s,1,Set(__CC_QUEUE=گروه زنگ ${safe(g.name)})`,
      ...cname,
      ...(g.prefix ? [` same => n,Set(CALLERID(name)=${safe(g.prefix)}\${CALLERID(name)})`] : []),
      ...(g.rec && g.rec !== 'dontcare' ? [` same => n,Set(__CC_RECMODE=${sid(g.rec)})`] : []),
    ];
    const avail = (m: string) => {
      const e = findExt(cfg, m, tid);
      return `$["\${DEVICE_STATE(PJSIP/${e ? sipOf(e) : digits(m)})}"="NOT_INUSE"]`;
    };
    if (!members.length) lines.push(' same => n,Goto(na)');
    else if (g.strat === 'ringall') {
      lines.push(' same => n,Set(CC_DS=)');
      for (const m of members) {
        const ds = dialString(m, cfg, tid);
        if (g.skipBusy && !isExternal(m, cfg, tid)) lines.push(` same => n,ExecIf(${avail(m)}?Set(CC_DS=\${CC_DS}&${ds}))`);
        else lines.push(` same => n,Set(CC_DS=\${CC_DS}&${ds})`);
      }
      lines.push(' same => n,GotoIf($["${CC_DS}"=""]?na)', ` same => n,Dial(\${CC_DS:1},${ring},${mopt}tg${U})`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)');
    } else {
      // hunt / memoryhunt / firstavailable / random: one member at a time (memoryhunt keeps earlier members ringing)
      let order = [...members];
      if (g.strat === 'random') lines.push(' same => n,NoOp(random order is applied per call by rotation)');
      const acc: string[] = [];
      order.forEach((m, i) => {
        const ds = dialString(m, cfg, tid);
        acc.push(ds);
        const target = g.strat === 'memoryhunt' ? acc.join('&') : ds;
        const e = findExt(cfg, m, tid);
        if ((g.skipBusy || g.strat === 'firstavailable') && !isExternal(m, cfg, tid)) {
          lines.push(` same => n,GotoIf($["\${DEVICE_STATE(PJSIP/${e ? sipOf(e) : digits(m)})}"!="NOT_INUSE"]?m${i + 1})`);
        }
        lines.push(` same => n,Dial(${target},${ring},${mopt}tg${U})`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)', ` same => n(m${i + 1}),NoOp()`);
      });
      if (g.strat === 'random') {
        // rotate the start member randomly: jump to a random member label
        const n = order.length;
        lines.splice(lines.findIndex(l => l.includes('random order')), 1, ` same => n,Goto(m$[\${RAND(0,${n - 1})}])`, ' same => n(m0),NoOp()');
      }
    }
    lines.push(' same => n(na),NoOp(no answer)', ` same => n,Goto(${destTarget(g.na, cfg)})`);
    X(`cc-rg-${sid(g.id)}`, lines);
  }

  // --- extensions (direct), follow-me, voicemail fallback — dialplan exten = sip id (unique across tenants)
  const extLines: string[] = [];
  for (const e of cfg.exts) {
    const n = digits(e.n);
    const sip = sipOf(e);
    if (!sip) continue;
    const fm = cfg.fmes[sip] || cfg.fmes[e.n] || cfg.fmes[n];
    extLines.push(`exten => ${sip},1,ExecIf($["\${CC_QUEUE}"=""]?Set(__CC_QUEUE=داخلی ${n}))`, ...cname);
    if (fm && fm.on) extLines.push(` same => n,Goto(cc-fm-${sip},s,1)`);
    else {
      extLines.push(` same => n,Dial(PJSIP/${sip},15,trgU(cc-agent-answer^0))`,
        ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)',
        e.vm ? ` same => n,Goto(cc-vm,${n},1)` : ' same => n,Hangup()');
    }
  }
  X('cc-ext', extLines.length ? extLines : ['exten => _X.,1,Hangup()']);

  for (const e of cfg.exts) {
    const sip = sipOf(e);
    const n = digits(e.n);
    const fm = cfg.fmes[sip] || cfg.fmes[e.n] || cfg.fmes[n];
    if (!fm || !fm.on || !sip) continue;
    const U = `U(cc-agent-answer^${fm.confirm ? 1 : 0})`;
    const lines = [`exten => s,1,Dial(PJSIP/${sip},${Math.max(1, +fm.init || 8)},trg${U})`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)'];
    const list = (fm.list || []).map((x: string) => String(x)).filter(Boolean);
    if (fm.strat === 'ringall' && list.length) {
      lines.push(` same => n,Dial(${list.map((x: string) => dialString(x, cfg, e.tenantId)).join('&')},${Math.max(5, +fm.ring || 20)},trg${U})`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)');
    } else {
      for (const x of list) lines.push(` same => n,Dial(${dialString(x, cfg, e.tenantId)},${Math.max(5, +fm.ring || 20)},trg${U})`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?cc-survey,s,1)');
    }
    lines.push(` same => n,Goto(${destTarget(fm.na, cfg)})`);
    X(`cc-fm-${sip}`, lines);
  }

  // --- external legs (ring groups / follow-me to mobiles)
  // Tenant phones must use the 31985 pool trunk + their own CLI (AstDB ccoutcli/<tenantId>).
  X('cc-outext', [
    'exten => _X.,1,GotoIf($["${CC_TENANT}"=""]?plat)',
    ' same => n,Set(CC_OUTCLI=${DB(ccoutcli/${CC_TENANT})})',
    ' same => n,GotoIf($["${CC_OUTCLI}"=""]?deny)',
    ' same => n,Dial(PJSIP/${EXTEN}@trunk-t31985,60,b(cc-trunk-cid^s^1(${CC_OUTCLI})))',
    ' same => n,Hangup()',
    ' same => n(deny),Congestion(5)',
    ' same => n,Hangup()',
    ...(trunk ? [
      ` same => n(plat),Dial(PJSIP/\${EXTEN}@trunk-${sid(trunk.id)},60)`, ' same => n,Hangup()',
    ] : [
      ' same => n(plat),NoOp(no active trunk)', ' same => n,Congestion(5)',
    ]),
  ]);

  // --- answer hooks (run on the answering channel)
  X('cc-agent-answer', [
    // ARG1 = 1 -> external member must press 1 to accept (avoids landing in a mobile voicemail)
    // CC_EXTNUM (endpoint set_var) is the dialled number; CHANNEL endpoint may be tn…_102 (SIP id).
    'exten => s,1,Set(CC_ASIP=${CUT(CUT(CHANNEL,/,2),-,1)})',
    ' same => n,Set(CC_AEXT=${IF($["${CC_EXTNUM}"!=""]?${CC_EXTNUM}:${FILTER(0-9,${CC_ASIP})})})',
    ' same => n,GotoIf($["${ARG1}"!="1"|"${CUT(CHANNEL,/,1)}"!="Local"]?ok)',
    ' same => n,Read(CC_CONF,beep,1,,1,10)',
    ' same => n,GotoIf($["${CC_CONF}"="1"]?ok)',
    ' same => n,Set(GOSUB_RESULT=ABORT)',
    ' same => n,Return()',
    ' same => n(ok),ExecIf($["${MASTER_CHANNEL(CC_ANSEXT)}"!=""]?Set(MASTER_CHANNEL(CC_XFER)=1))',
    ' same => n,Set(MASTER_CHANNEL(CC_ANSEXT)=${CC_AEXT})',
    ' same => n,Set(MASTER_CHANNEL(CC_ANSTS)=${EPOCH})',
    ' same => n,' + hook('answer', 'orig=${CC_ORIG}&ext=${CC_AEXT}'),
    ' same => n,GotoIf($["${CC_RECMODE}"="never"]?done)',
    ' same => n,GotoIf($["${CC_RECMODE}"="always"]?rec)',
    ' same => n,GotoIf($["${DB(ccrec/${CC_ASIP})}"="1"]?rec:done)',
    ' same => n(rec),Set(CC_RECF=cc/${STRFTIME(${EPOCH},,%Y%m%d)}-${FILTER(0-9.,${CHANNEL(linkedid)})}.wav)',
    // besides the mixed file, one track per side so the transcript knows who spoke
    ' same => n,MixMonitor(${CC_RECF},br(${ASTSPOOLDIR}/monitor/${CC_RECF:0:-4}-op.wav)t(${ASTSPOOLDIR}/monitor/${CC_RECF:0:-4}-pt.wav))',
    ' same => n,Set(MASTER_CHANNEL(CC_REC)=${CC_RECF})',
    ' same => n(done),Return()',
  ]);
  X('cc-callee-answer', [
    'exten => s,1,Set(MASTER_CHANNEL(CC_ANSEXT)=${CC_OPEXT})',
    ' same => n,Set(MASTER_CHANNEL(CC_ANSTS)=${EPOCH})',
    ' same => n,' + hook('answer', 'orig=${CC_ORIG}&ext=${CC_OPEXT}'),
    ' same => n,GotoIf($["${CC_ORIG}"=""&"${DB(ccrec/${CC_OPEXT})}"!="1"]?done)',
    ' same => n,Set(CC_RECF=cc/${STRFTIME(${EPOCH},,%Y%m%d)}-${FILTER(0-9.,${CHANNEL(linkedid)})}.wav)',
    ' same => n,MixMonitor(${CC_RECF},br(${ASTSPOOLDIR}/monitor/${CC_RECF:0:-4}-pt.wav)t(${ASTSPOOLDIR}/monitor/${CC_RECF:0:-4}-op.wav))',
    ' same => n,Set(MASTER_CHANNEL(CC_REC)=${CC_RECF})',
    ' same => n(done),Return()',
  ]);

  // --- voicemail: recorded straight into the monitor spool so the panel can stream it
  X('cc-vm', [
    'exten => s,1,Set(CC_VMBOX=general)',
    ' same => n,Goto(vm,1)',
    'exten => _X.,1,Set(CC_VMBOX=${EXTEN})',
    ' same => n,Goto(vm,1)',
    'exten => vm,1,Answer()',
    ' same => n,ExecIf($["${CC_QUEUE}"=""]?Set(CC_QUEUE=صندوق صوتی))',
    ' same => n,Set(CC_VM=1)',
    ' same => n,Set(CC_REC=cc-vm/${STRFTIME(${EPOCH},,%Y%m%d)}-${FILTER(0-9.,${UNIQUEID})}.wav)',
    ...vmboxLines(cfg),
  ]);
  X('cc-busy', ['exten => s,1,Busy(10)']);
  // announcements: play a recording, then hang up
  X('cc-ann', cfg.snds.length ? cfg.snds.flatMap(x => [`exten => ${sid(x.id)},1,Answer()`, ` same => n,Playback(custom/${sid(x.id)})`, ' same => n,Hangup()']) : ['exten => _X.,1,Hangup()']);
  // IVR direct-dial: same short-number rules as internal (tenant prefix when CC_TNPREFIX is set)
  X('cc-ivr-direct', [
    'exten => _X.,1,GotoIf($["${CC_TNPREFIX}"=""]?plat)',
    ' same => n,GotoIf(${DIALPLAN_EXISTS(cc-ext,${CC_TNPREFIX}_${EXTEN},1)}?tn)',
    ' same => n(plat),Goto(cc-ext,${EXTEN},1)',
    ' same => n(tn),Goto(cc-ext,${CC_TNPREFIX}_${EXTEN},1)',
  ]);
  X('cc-hang', ['exten => s,1,Hangup()']);

  // --- AI receptionist: audio goes to the local bridge over AudioSocket; it may ask for a transfer by
  // leaving a marker file named after the call UUID
  const ai = cfg.aiagent || {};
  const aiTransfer = '/var/lib/callcenter-ai/transfers/${AI_CALL_UUID}';
  const aiLines = [
    'exten => s,1,Set(__CC_QUEUE=دستیار هوشمند)',
    ' same => n,Answer()',
    ' same => n,Set(__AI_CALL_UUID=${UUID()})',
    // one recording for the whole call: patient, AI and, after a transfer, the doctor
    ...(ai.record !== false ? [
      ' same => n,Set(CC_REC=cc/${STRFTIME(${EPOCH},,%Y%m%d)}-${FILTER(0-9.,${CHANNEL(linkedid)})}.wav)',
      ' same => n,MixMonitor(${CC_REC})',
    ] : []),
    ` same => n,Set(CC_CURL=\${CURL(${opts.hookUrl}/aimeta?s=${opts.hookSecret},uuid=\${AI_CALL_UUID}&num=\${CC_NUM})})`,
    ' same => n,Dial(Local/ai@cc-ai-session/n,,g)',
    // a conversation of 3 s or more counts as answered (by the AI, not an operator)
    ' same => n,ExecIf($[0${ANSWEREDTIME} >= 3]?Set(CC_ANSTS=$[${EPOCH} - ${ANSWEREDTIME}]))',
    ` same => n,GotoIf(\${STAT(e,${aiTransfer})}?transfer)`,
    ' same => n,GotoIf($[0${ANSWEREDTIME} >= 3]?end)',
    // the bridge was not reachable at all
    ' same => n,Playback(custom/ai-unavailable-fa)',
    ' same => n(end),Hangup()',
    ` same => n(transfer),TrySystem(/usr/bin/unlink ${aiTransfer})`,
    // the AI call is already being recorded; the doctor's answer must not start a second file
    ...(ai.record !== false ? [' same => n,Set(__CC_RECMODE=never)'] : []),
  ];
  const tExt = digits(ai.transferExt || ''), tMob = digits(ai.transferMobile || '');
  const tHit = tExt ? findExt(cfg, tExt, ai.tenantId) : undefined;
  if (tHit) aiLines.push(` same => n,Dial(PJSIP/${sipOf(tHit)},${Math.max(5, +ai.transferRing || 10)},tU(cc-agent-answer^0))`, ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER"]?end)');
  if (tMob) aiLines.push(` same => n,Dial(${dialString(tMob, cfg, ai.tenantId)},45,t)`);
  aiLines.push(' same => n,Hangup()');
  X('cc-ai', aiLines);
  X('cc-ai-session', ['exten => ai,1,Answer()', ` same => n,AudioSocket(\${AI_CALL_UUID},127.0.0.1:9019)`, ' same => n,Hangup()']);

  // --- phone booking line (booking.ts, over FastAGI): s = booking menu, track = follow-up / cancel.
  // The script sets BOOK_RESULT: «back» (caller pressed *) goes to the back destination; an API failure, or the
  // panel's service not answering at all, goes to the fallback destination.
  const bookEntry = (ex: string, script: string, queue: string) => [
    `exten => ${ex},1,Set(__CC_QUEUE=${queue})`,
    ' same => n,Answer()',
    ' same => n,Set(CC_BOOKTS=${EPOCH})',
    ` same => n,AGI(agi://127.0.0.1:4573/${script})`,
    // served by the booking line itself: not a missed call
    ' same => n,ExecIf($["${BOOK_RESULT}"!="" & "${BOOK_RESULT}"!="error" & "${BOOK_RESULT}"!="disabled"]?Set(CC_ANSTS=${CC_BOOKTS}))',
    ` same => n,GotoIf($["\${BOOK_RESULT}"="back"]?${bookingDest(cfg, 'backDest')})`,
    ' same => n,GotoIf($["${AGISTATUS}"!="SUCCESS" | "${BOOK_RESULT}"="" | "${BOOK_RESULT}"="error" | "${BOOK_RESULT}"="disabled"]?fail)',
    ' same => n,Hangup()',
    ` same => n(fail),Goto(${bookingFallback(cfg)})`,
  ];
  X('cc-book', [...bookEntry('s', 'booking', 'نوبت‌دهی تلفنی'), ...bookEntry('track', 'track', 'پیگیری نوبت')]);
  // reminder / cancellation calls queued as call files by the booking system (POST /api/booking/remind)
  X('cc-book-call', [
    'exten => remind,1,Answer()', ' same => n,Wait(1)', ' same => n,AGI(agi://127.0.0.1:4573/remind)', ' same => n,Hangup()',
    'exten => cancel,1,Answer()', ' same => n,Wait(1)', ' same => n,AGI(agi://127.0.0.1:4573/cancelnotice)', ' same => n,Hangup()',
  ]);

  // --- post-call survey: the operator hung up, the caller stays on the line and rates 1..5 per question
  X('cc-survey', surveyLines(cfg));
  // *77 from a desk phone: hear the survey exactly as callers do (nothing is recorded)
  X('cc-survey-test', ['exten => s,1,Answer()', ' same => n,Set(CC_DIR=in)', ' same => n,Set(CC_ANSTS=1)', ' same => n,Goto(cc-survey,s,1)']);

  // --- hangup handler on the caller (master) channel: reports the finished call to the panel
  X('cc-hangup', [
    'exten => s,1,GotoIf($["${CC_DIR}"=""]?done)',
    ' same => n,' + hook('call', 'uid=${URIENCODE(${UNIQUEID})}&start=${CC_START}&end=${EPOCH}&cid=${URIENCODE(${CALLERID(num)})}&num=${URIENCODE(${CC_NUM})}&did=${CC_DID}&tenant=${CC_TENANT}&dir=${CC_DIR}&queue=${URIENCODE(${CC_QUEUE})}&ansext=${CC_ANSEXT}&ansts=${CC_ANSTS}&xfer=${CC_XFER}&vm=${CC_VM}&vmbox=${CC_VMBOX}&rec=${URIENCODE(${CC_REC})}&orig=${CC_ORIG}&opext=${CC_OPEXT}&sv=${CC_SV1}${CC_SV2}${CC_SV3}${CC_SV4}${CC_SV5}&svrec=${URIENCODE(${CC_SVREC})}&aiuuid=${AI_CALL_UUID}&blocked=${CC_BLOCKED}'),
    ' same => n(done),Return()',
  ]);

  // --- click-to-call: AMI Originate rings the operator (Channel=PJSIP/<sip>), then this dials the patient
  const dialout: string[] = [];
  const seenDialOut = new Set<string>();
  for (const e of cfg.exts) {
    const sip = sipOf(e), n = digits(e.n);
    if (!sip) continue;
    if (!seenDialOut.has(sip)) {
      seenDialOut.add(sip);
      dialout.push(`exten => ${sip},1,Dial(PJSIP/${sip},45,U(cc-callee-answer))`);
    }
    // Keep dial-number alias once (platform first) for legacy Exten values
    if (n && !seenDialOut.has(n)) {
      seenDialOut.add(n);
      dialout.push(`exten => ${n},1,Dial(PJSIP/${sip},45,U(cc-callee-answer))`);
    }
  }
  X('cc-callback', [
    'exten => _X.,1,Set(__CC_DIR=out)',
    ' same => n,Set(__CC_START=${EPOCH})',
    ' same => n,Set(CHANNEL(hangup_handler_push)=cc-hangup,s,1)',
    ' same => n,Set(__CC_QUEUE=پیگیری پیام صوتی)',
    ' same => n,Goto(cc-dialout,${EXTEN},1)',
  ]);
  X('cc-dialout', [
    ...dialout,
    'include => cc-dialout-routes',
    'exten => h,1,NoOp()',
  ]);

  // --- what extensions can dial (short numbers resolve via CC_TNPREFIX for tenant phones)
  const internal: string[] = ['include => cc-internal-ext'];
  // Per-dial-number GotoIf chain when several tenants share the same n (plus platform)
  const byDial = new Map<string, { tenantId?: string; sip: string }[]>();
  for (const e of cfg.exts) {
    const n = digits(e.n), sip = sipOf(e);
    if (!n || !sip) continue;
    const list = byDial.get(n) || [];
    list.push({ tenantId: e.tenantId, sip });
    byDial.set(n, list);
  }
  const shortDial: string[] = [];
  for (const [n, list] of [...byDial.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (list.length === 1 && !list[0].tenantId) {
      shortDial.push(`exten => ${n},1,Goto(cc-ext,${list[0].sip},1)`);
      continue;
    }
    // Prefer same-tenant peer; fall back to platform (no tenantId) then first match
    const lines = [`exten => ${n},1,NoOp(short dial ${n})`];
    for (const x of list.filter(x => x.tenantId)) {
      lines.push(` same => n,GotoIf($["\${CC_TENANT}"="${sid(x.tenantId)}"]?cc-ext,${x.sip},1)`);
    }
    const plat = list.find(x => !x.tenantId);
    if (plat) lines.push(` same => n,Goto(cc-ext,${plat.sip},1)`);
    else lines.push(' same => n,Hangup()');
    shortDial.push(...lines);
  }
  // Queue/ring access codes: tenant-scoped when CC_TENANT matches, else first unique num
  const qByNum = new Map<string, { id: string; tenantId?: string }[]>();
  for (const q of cfg.vqs) {
    const num = digits(q.num);
    if (!num) continue;
    const list = qByNum.get(num) || [];
    list.push({ id: q.id, tenantId: q.tenantId });
    qByNum.set(num, list);
  }
  const qDial: string[] = [];
  for (const [num, list] of qByNum) {
    if (list.length === 1) qDial.push(`exten => ${num},1,Goto(cc-queue-${sid(list[0].id)},s,1)`);
    else {
      const lines = [`exten => ${num},1,NoOp(queue ${num})`];
      for (const x of list.filter(x => x.tenantId)) lines.push(` same => n,GotoIf($["\${CC_TENANT}"="${sid(x.tenantId)}"]?cc-queue-${sid(x.id)},s,1)`);
      const plat = list.find(x => !x.tenantId);
      lines.push(plat ? ` same => n,Goto(cc-queue-${sid(plat.id)},s,1)` : ' same => n,Hangup()');
      qDial.push(...lines);
    }
  }
  const rgByNum = new Map<string, { id: string; tenantId?: string }[]>();
  for (const g of cfg.rgroups) {
    const num = digits(g.num);
    if (!num) continue;
    const list = rgByNum.get(num) || [];
    list.push({ id: g.id, tenantId: g.tenantId });
    rgByNum.set(num, list);
  }
  const rgDial: string[] = [];
  for (const [num, list] of rgByNum) {
    if (list.length === 1) rgDial.push(`exten => ${num},1,Goto(cc-rg-${sid(list[0].id)},s,1)`);
    else {
      const lines = [`exten => ${num},1,NoOp(rg ${num})`];
      for (const x of list.filter(x => x.tenantId)) lines.push(` same => n,GotoIf($["\${CC_TENANT}"="${sid(x.tenantId)}"]?cc-rg-${sid(x.id)},s,1)`);
      const plat = list.find(x => !x.tenantId);
      lines.push(plat ? ` same => n,Goto(cc-rg-${sid(plat.id)},s,1)` : ' same => n,Hangup()');
      rgDial.push(...lines);
    }
  }
  X('cc-internal-ext', [
    ...shortDial,
    ...qDial,
    ...rgDial,
    'exten => *77,1,Goto(cc-survey-test,s,1)',
    ...(cfg.aiagent?.enabled && cfg.aiagent.code ? [`exten => ${cfg.aiagent.code},1,Goto(cc-ai,s,1)`] : []),
    // the booking line's own codes, for desk-phone tests (booking menu / follow-up)
    ...(cfg.booking?.enabled && /^[0-9*#]+$/.test(cfg.booking.code || '') ? [`exten => ${cfg.booking.code},1,Goto(cc-book,s,1)`] : []),
    ...(cfg.booking?.enabled && /^[0-9*#]+$/.test(cfg.booking.trackCode || '') ? [`exten => ${cfg.booking.trackCode},1,Goto(cc-book,track,1)`] : []),
    // *88<DID>: test an inbound route from a desk phone (caller ID = this extension)
    'exten => _*88.,1,Set(CALLERID(num)=${CALLERID(num)})',
    ' same => n,Set(__CC_DID=${EXTEN:3})',
    ' same => n,Goto(cc-inbound,s,1)',
    'exten => *43,1,Answer()',
    ' same => n,Playback(beep)',
    ' same => n,Echo()',
  ]);
  const outs = (cfg.oroutes || []).filter(r => r.on && r.trunk && cfg.trunks.some(t => t.id === r.trunk && t.on && t.type !== 'PRI / E1'));
  if (!(cfg.oroutes || []).length && trunk) outs.push({ id: 'default', pats: '0X.', trunk: trunk.id, prepend: '' });
  // the provider shows whatever number we send (an extension came out as +9821102): send the line's own number.
  // PJSIP builds Remote-Party-ID from the outgoing channel's connected line, which Dial copies from the extension,
  // so that is set too ('i': only on this channel, no update sent to the extension)
  X('cc-trunk-cid', ['exten => s,1,Set(CALLERID(num)=${ARG1})', ' same => n,Set(CALLERID(name)=${ARG1})',
    ' same => n,Set(CONNECTEDLINE(num,i)=${ARG1})', ' same => n,Set(CONNECTEDLINE(name,i)=${ARG1})', ' same => n,Return()']);

  const pushOutPattern = (L2: string[], r: any, opts: {
    tenantId?: string; cliExpr: string; denyOtherTenants?: boolean;
  }) => {
    const cidOpt = opts.cliExpr ? `b(cc-trunk-cid^s^1(${opts.cliExpr}))` : '';
    for (const raw of String(r.pats || '').split(/[,،\s]+/).filter(Boolean)) {
      const [pre, pat] = raw.includes('|') ? raw.split('|') : ['', raw];
      const p = (pre + pat).toUpperCase().replace(/[^0-9XNZ.*#+\[\]-]/g, '');
      if (!p) continue;
      const ext = p === '.' ? '_X.' : '_' + p;
      const strip = pre.replace(/[^0-9*#+]/g, '').length;
      const num = `${String(r.prepend || '').replace(/[^0-9*#+]/g, '')}\${EXTEN${strip ? ':' + strip : ''}}`;
      L2.push(
        `exten => ${ext},1,GotoIf($["\${CC_DIR}"!=""]?dial)`,
        ' same => n,Set(__CC_DIR=out)', ' same => n,Set(__CC_START=${EPOCH})',
        ' same => n,Set(__CC_OPEXT=${FILTER(0-9,${CALLERID(num)})})', ' same => n,Set(__CC_QUEUE=تماس خروجی)',
        ' same => n,Set(CHANNEL(hangup_handler_push)=cc-hangup,s,1)',
        ' same => n(dial),NoOp()',
      );
      // Tenant phones must never place calls on platform/shared trunks or other tenants' CLIs.
      if (opts.denyOtherTenants) {
        L2.push(' same => n,GotoIf($["${CC_TENANT}"!=""]?skiptenant)');
      }
      if (opts.tenantId) {
        const tid = sid(opts.tenantId);
        const fallback = digits(opts.cliExpr) || '';
        L2.push(` same => n,GotoIf($["\${CC_TENANT}"!="${tid}"]?skip)`);
        // CLI: channel override CC_OUTCLI → AstDB primary → compile-time fallback. Must be an assigned DID.
        L2.push(
          ' same => n,Set(CC_USECLI=${CC_OUTCLI})',
          ` same => n,ExecIf($["\${CC_USECLI}"=""]?Set(CC_USECLI=\${DB(ccoutcli/${tid})}))`,
          ...(fallback ? [` same => n,ExecIf($["\${CC_USECLI}"=""]?Set(CC_USECLI=${fallback}))`] : []),
          ' same => n,GotoIf($["${CC_USECLI}"=""]?deny)',
          ` same => n,GotoIf($[\${DB_EXISTS(ccoutdid/${tid}_\${CC_USECLI})}]?clidok:deny)`,
          ' same => n(clidok),NoOp()',
        );
      }
      const cliForDial = opts.tenantId ? '${CC_USECLI}' : opts.cliExpr;
      const cid = cliForDial ? `b(cc-trunk-cid^s^1(${cliForDial}))` : cidOpt;
      L2.push(
        ` same => n,Set(__CC_NUM=${num})`,
        ` same => n,${ccEvent('call.started', 'Uid: ${UNIQUEID},Dir: out,Num: ${URIENCODE(${CC_NUM})},Opext: ${CC_OPEXT},Callback: ${IF($["${CC_ORIG}"!=""]?1:0)}')}`,
        ` same => n,Dial(PJSIP/\${CC_NUM}@trunk-${sid(r.trunk)},60,TU(cc-callee-answer)${cid})`,
        ' same => n,Hangup()',
      );
      if (opts.tenantId) {
        L2.push(' same => n(deny),Congestion(5)', ' same => n,Hangup()', ' same => n(skip),Return()');
      }
      if (opts.denyOtherTenants) {
        L2.push(' same => n(skiptenant),Return()');
      }
    }
  };

  // Tenant outbound first (own DID CLI + pool trunk only), then platform (blocked when CC_TENANT set).
  const tenantOuts = outs.filter(r => r.tenantId);
  const platformOuts = outs.filter(r => !r.tenantId);
  // One dialplan context per tenant: collapse auto DIDs so the same pats do not collide.
  const byTenant = new Map<string, any[]>();
  for (const r of tenantOuts) {
    const tid = String(r.tenantId);
    const list = byTenant.get(tid) || [];
    list.push(r);
    byTenant.set(tid, list);
  }
  for (const [tid, list] of byTenant) {
    // Prefer the first auto DID as default CLI; fall back to first route's cli/trunk.did.
    const primary = list.find(r => r.auto && r.cli) || list.find(r => r.cli) || list[0];
    const cli = digits(primary?.cli || primary?.did) || '';
    // Use a representative route (pats + trunk from primary); CLI validated against AstDB list.
    const synth = {
      id: 'tout-' + tid,
      pats: primary?.pats || '8|.,0X.,9X.',
      trunk: primary?.trunk || 't31985',
      prepend: primary?.prepend || '',
    };
    if (!cfg.trunks.some(t => t.id === synth.trunk && t.on)) continue;
    const L2: string[] = [];
    // Default CLI from AstDB (kept in sync with DID assign); channel may override via CC_OUTCLI.
    pushOutPattern(L2, synth, {
      tenantId: tid,
      cliExpr: '${IF($["${DB(ccoutcli/' + sid(tid) + ')}"!=""]?${DB(ccoutcli/' + sid(tid) + ')}:' + cli + ')}',
    });
    if (L2.length) {
      X(`cc-out-${sid(synth.id)}`, L2);
      internal.push(`include => cc-out-${sid(synth.id)}`);
    }
  }
  for (const r of platformOuts) {
    const L2: string[] = [];
    const rt = cfg.trunks.find(t => t.id === r.trunk);
    const lineNum = digits(r.cli) || digits(rt?.did) || digits(rt?.user);
    pushOutPattern(L2, r, { cliExpr: lineNum || '', denyOtherTenants: true });
    if (L2.length) { X(`cc-out-${sid(r.id)}`, L2); internal.push(`include => cc-out-${sid(r.id)}`); }
  }
  X('cc-internal', internal);
  X('cc-dialout-routes', internal.length > 1 ? internal.slice(1) : ['exten => _X.,1,NoOp(no outbound route)', ' same => n,Congestion(5)']);
  return L.join('\n');
}

export function generate(cfg: VoipConfig, opts: { hookUrl: string; hookSecret: string; mohDir: string }): Generated {
  const warnings: string[] = [];
  const m = moh(cfg, opts.mohDir);
  const astdb: Generated['astdb'] = { ccbl: {}, ccset: {}, cctc: {}, ccholiday: {}, ccrec: {}, ccoutcli: {}, ccoutdid: {} };
  for (const b of cfg.blist) if (digits(b.num)) astdb.ccbl[digits(b.num)] = String(b.reason || 'other');
  astdb.ccset.anon = cfg.bset && cfg.bset.anon ? '1' : '0';
  for (const t of cfg.tconds) astdb.cctc[sid(t.id)] = t.ovr && t.ovr !== 'none' ? t.ovr : 'none';
  for (const h of cfg.holidays) { const g = jalaliToGregorianCompact(h.date); if (g) astdb.ccholiday[g] = safe(h.name) || '1'; }
  for (const e of cfg.exts) {
    const sip = sipOf(e);
    if (sip) astdb.ccrec[sip] = e.rec ? '1' : '0';
  }
  // Per-tenant outbound CLI allow-list (from DID assignments / auto oroutes).
  const didsByTenant = new Map<string, string[]>();
  for (const d of cfg.didRoutes || []) {
    const did = digits(d.did), tid = sid(d.tenantId);
    if (!did || !tid) continue;
    const list = didsByTenant.get(tid) || [];
    if (!list.includes(did)) list.push(did);
    didsByTenant.set(tid, list);
  }
  for (const r of cfg.oroutes || []) {
    if (!r?.tenantId || !r.auto) continue;
    const did = digits(r.cli || r.did), tid = sid(r.tenantId);
    if (!did || !tid) continue;
    const list = didsByTenant.get(tid) || [];
    if (!list.includes(did)) list.push(did);
    didsByTenant.set(tid, list);
  }
  for (const [tid, dids] of didsByTenant) {
    if (!dids.length) continue;
    astdb.ccoutcli[tid] = dids[0];
    for (const did of dids) astdb.ccoutdid[`${tid}_${did}`] = '1';
  }
  return {
    files: { 'pjsip.conf': pjsip(cfg, warnings), 'extensions.conf': dialplan(cfg, opts), 'queues.conf': queues(cfg), 'musiconhold.conf': m.text },
    astdb, moh: m.map, warnings,
  };
}
