// Patient directory: names come from the clinic CRM, looked up once per inbound call and cached locally.
// The CRM logs every lookup as a call, so it is asked exactly once per inbound call and never in bulk.
import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, Param, Post, Put, Query } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { CurrentUser, Me, Roles, Perm } from './auth';
import { readSetting, writeSetting, scopeKey } from './tenant-settings';
import { Bus } from './bus';
import { PrismaService } from './prisma.service';
import { DID_POOL_PREFIX, isPoolDid, normalizeInboundDid } from './tenant-scope';

export interface CrmSettings {
  enabled: boolean; url: string; param: string; user: string; pass: string;
  phoneFormat: '0' | '98' | '+98' | '9'; nameField: string; timeoutMs: number;
  phoneName: 'fa' | 'latin' | 'off'; showSurgery: boolean;
  // «دستغیب» / «کامیلو»: own address + token, kept apart so switching back keeps each provider's settings
  provider: 'crm' | 'dastgheib' | 'kamilo'; dgUrl: string; dgToken: string; dgHost: string;
  kmUrl: string; kmToken: string;
}
const DEFAULTS: CrmSettings = {
  enabled: false, url: 'https://crm.drpouriaaflaki.com/api/v1/voip/surgery-status', param: 'mobile', user: '', pass: '',
  phoneFormat: '0', nameField: 'name', timeoutMs: 4000, phoneName: 'fa', showSurgery: true,
  provider: 'crm', dgUrl: '', dgToken: '', dgHost: '', kmUrl: '', kmToken: '',
};

/** Dead Mac LAN URL (callcenter cannot reach :8010 / .88.254). استعلام آزمایشی persists the form first — rewrite so a stale browser field cannot keep writing it back. */
/** Reachable from callcenter via SSH reverse tunnel Mac:8080 → 127.0.0.1:18080 (LAN :8010/.88.254 and flaky Wi‑Fi :8080 fail). */
export const KAMILO_LIVE_KM_URL = 'http://127.0.0.1:18080/api';
/** Public production Kamilo — bare host `kamilo` fails DNS (`getaddrinfo EAI_AGAIN kamilo`) on سرور لوکال. */
export const KAMILO_PROD_KM_URL = 'https://kamilo.ir/api';
export function migrateKamiloKmUrl(url: string): string {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return u;
  // Hostname literally `kamilo` (no TLD) — not in callcenter DNS
  if (/^https?:\/\/kamilo(?::\d+)?(?:\/|$)/i.test(u)) return KAMILO_PROD_KM_URL;
  // Unreachable from سرور لوکال: old Mac alias :8010, or direct Wi‑Fi :8080 (drops under load)
  if (/192\.168\.88\.254/.test(u)) return KAMILO_LIVE_KM_URL;
  if (/192\.168\.100\.230:8080/.test(u)) return KAMILO_LIVE_KM_URL;
  if (/:8010(\/|$)/.test(u) && /192\.168\./.test(u)) return KAMILO_LIVE_KM_URL;
  return u;
}

/** Inbound DIDs that must use دستغیب (platform dg credentials). Never apply to 31985*. */
export const DASTGHEIB_INBOUND_DIDS = new Set(['21008244', '21009062', '21009448']);

export function isDastgheibInboundDid(raw: any): boolean {
  const d = normalizeInboundDid(raw);
  return !!d && DASTGHEIB_INBOUND_DIDS.has(d);
}

/** Trunk / pool DID prefix 31985 — must never call dastgheib. */
export function isTenantPoolDid(raw: any): boolean {
  const d = normalizeInboundDid(raw);
  return !!d && (d.startsWith(DID_POOL_PREFIX) || isPoolDid(d));
}

/**
 * Pick effective CRM settings from the called DID (and optional tenant).
 * - 21008244 / 21009062 / 21009448 → always dastgheib (platform tokens)
 * - 31985* → never dastgheib; tenant/kamilo settings only
 * - otherwise → tenant settings (or platform when tenantId is null)
 */
export function applyDidCrmRouting(base: CrmSettings, platform: CrmSettings, did?: string | null): CrmSettings {
  if (isDastgheibInboundDid(did)) {
    return {
      ...platform,
      enabled: !!(platform.dgUrl && platform.dgToken),
      provider: 'dastgheib',
      dgUrl: platform.dgUrl, dgToken: platform.dgToken, dgHost: platform.dgHost,
    };
  }
  if (isTenantPoolDid(did)) {
    if (base.provider !== 'dastgheib') return base;
    // Tenant inherited platform dastgheib via fallback — do not call demo.s8n.ir on 31985.
    if (base.kmUrl && base.kmToken) return { ...base, provider: 'kamilo' };
    return { ...base, enabled: false, provider: 'kamilo' };
  }
  return base;
}

const DG_PATH = '/external-api/voip/v1/patients/by-phone/';
const KM_PATIENT_PATH = '/external-api/voip/v1/patients/by-phone/';
const KM_APPT_PATH = '/external-api/voip/v1/appointments';

/** GET with a chosen Host header (fetch() ignores it): the clinic app picks the clinic by its domain.
 *  Clinic boxes often use self-signed LAN certs — TLS verify is off on purpose. */
function httpGet(url: URL, headers: Record<string, string>, host: string, timeoutMs: number) {
  return new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const opts: https.RequestOptions = {
      headers: { ...headers, Host: host }, timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { servername: host.replace(/:\d+$/, ''), rejectUnauthorized: false } : {}),
    };
    const req = lib.get(url, opts, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 5e6) { req.destroy(new Error('پاسخ سامانه بیماران بیش از حد بزرگ است')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode || 0, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.name = 'TimeoutError'; req.destroy(e); });
    req.on('error', reject);
  });
}

/** 0912… in the panel; the CRM may want 98912…, +98912… or 912…. */
function formatPhone(p: string, f: CrmSettings['phoneFormat']) {
  const local = p.replace(/^0/, '');
  return f === '98' ? '98' + local : f === '+98' ? '+98' + local : f === '9' ? local : p;
}

const pick = (o: any, field: string) => field.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

const isoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Last completed surgery as YYYY-MM-DD, or null when the CRM has none on record (which is not proof of no surgery). */
export function surgeryDate(d: any): string | null {
  if (!d || typeof d !== 'object') return null;
  const done = d.has_completed_surgery;
  if (!(done === true || done === 1 || done === 'true' || done === '1')) return null;
  const date = typeof d.last_surgery_date === 'string' ? d.last_surgery_date.trim().slice(0, 10) : '';
  if (ISO.test(date) && !Number.isNaN(Date.parse(date)) && Date.parse(date) <= Date.parse(isoToday())) return date;
  // no usable date: fall back to the day count (null, '' and non-numbers mean "unknown", never "today")
  const raw = d.days_since_surgery;
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 36500) return null;
  return new Date(Date.parse(isoToday()) - days * 864e5).toISOString().slice(0, 10);
}

/** Whole days since a YYYY-MM-DD date in Tehran time (0 = today); counted at ring time, so the cache never goes stale. */
export function daysSince(date: string | null | undefined) {
  if (!date || !ISO.test(date)) return null;
  const n = Math.round((Date.parse(isoToday()) - Date.parse(date)) / 864e5);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const faNum = (n: number) => n.toLocaleString('fa-IR');
/** Short surgery note for the phone screen. */
export function surgeryNote(days: number | null, latin: boolean) {
  if (days == null) return '';
  if (latin) return days === 0 ? 'Op today' : `Op ${days}d ago`;
  return days === 0 ? 'عمل شده امروز' : `عمل شده ${faNum(days)} روز پیش`;
}

const FA_LATIN: Record<string, string> = {
  'ا': 'a', 'آ': 'a', 'أ': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'ژ': 'zh',
  'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': '', 'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'و': 'v', 'ه': 'h', 'ة': 'h', 'ی': 'i', 'ي': 'i', 'ئ': 'i', 'ء': '', '‌': ' ',
};
/** Rough Persian → Latin for desk phones that cannot draw Persian letters. */
export function toLatin(s: string) {
  const t = [...s].map(ch => (ch in FA_LATIN ? FA_LATIN[ch] : ch)).join('').replace(/\s+/g, ' ').trim();
  return t.replace(/\b\w/g, c => c.toUpperCase());
}

@Injectable()
export class PatientsService {
  private log = new Logger('Patients');
  private caches = new Map<string, CrmSettings>();
  private recent = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private fails = 0;
  private pausedUntil = 0;
  lastError = '';
  constructor(private db: PrismaService, private bus: Bus) {}

  async settings(tenantId?: string | null): Promise<CrmSettings> {
    const k = scopeKey(tenantId);
    if (!this.caches.has(k)) {
      const r = await readSetting(this.db, 'crm', tenantId, { fallbackPlatform: !!tenantId });
      const merged = { ...DEFAULTS, ...((r as any) || {}) } as CrmSettings;
      const fixed = migrateKamiloKmUrl(merged.kmUrl);
      if (fixed !== merged.kmUrl) {
        merged.kmUrl = fixed;
        // Persist rewrite so the next panel load / استعلام آزمایشی save does not resurrect the dead URL
        if (tenantId) await writeSetting(this.db, 'crm', merged as any, { id: 'system', name: 'system', tenantId } as Me).catch(() => {});
        else await writeSetting(this.db, 'crm', merged as any, { id: 'system', name: 'system', tenantId: null } as Me).catch(() => {});
      }
      this.caches.set(k, merged);
    } else {
      const cur = this.caches.get(k)!;
      const fixed = migrateKamiloKmUrl(cur.kmUrl);
      if (fixed !== cur.kmUrl) { cur.kmUrl = fixed; this.caches.set(k, cur); }
    }
    return this.caches.get(k)!;
  }

  publicView(s: CrmSettings) {
    const { pass, dgToken, kmToken, ...rest } = s;
    return { ...rest, hasPass: !!pass, hasDgToken: !!dgToken, hasKmToken: !!kmToken };
  }

  async save(b: any, me: Me) {
    const cur = await this.settings(me.tenantId);
    const url = String(b.url ?? cur.url).trim();
    const dgUrl = String(b.dgUrl ?? cur.dgUrl).trim().replace(/\/+$/, '');
    const kmUrl = migrateKamiloKmUrl(String(b.kmUrl ?? cur.kmUrl).trim().replace(/\/+$/, ''));
    for (const u of [url, dgUrl, kmUrl]) if (u && !/^https?:\/\/\S+$/i.test(u)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود');
    const provider = b.provider === 'dastgheib' || b.provider === 'crm' || b.provider === 'kamilo' ? b.provider : cur.provider;
    const next: CrmSettings = {
      enabled: !!(b.enabled ?? cur.enabled), url,
      param: String(b.param ?? cur.param).trim() || 'mobile',
      user: String(b.user ?? cur.user).trim(),
      pass: typeof b.pass === 'string' && b.pass ? b.pass : cur.pass,
      phoneFormat: ['0', '98', '+98', '9'].includes(b.phoneFormat) ? b.phoneFormat : cur.phoneFormat,
      nameField: String(b.nameField ?? cur.nameField).trim() || 'name',
      timeoutMs: Math.min(15000, Math.max(1000, +(b.timeoutMs ?? cur.timeoutMs) || 4000)),
      phoneName: ['fa', 'latin', 'off'].includes(b.phoneName) ? b.phoneName : cur.phoneName,
      showSurgery: !!(b.showSurgery ?? cur.showSurgery),
      provider,
      dgUrl, dgToken: typeof b.dgToken === 'string' && b.dgToken.trim() ? b.dgToken.trim() : cur.dgToken,
      dgHost: String(b.dgHost ?? cur.dgHost).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''),
      kmUrl, kmToken: typeof b.kmToken === 'string' && b.kmToken.trim() ? b.kmToken.trim() : cur.kmToken,
    };
    if (b.clearPass) next.pass = '';
    if (next.enabled && next.provider === 'crm' && !next.url) throw new BadRequestException('آدرس API را وارد کنید');
    if (next.enabled && next.provider === 'dastgheib' && (!next.dgUrl || !next.dgToken)) throw new BadRequestException('آدرس و توکن API دستغیب را وارد کنید');
    if (next.enabled && next.provider === 'kamilo' && (!next.kmUrl || !next.kmToken)) throw new BadRequestException('آدرس و توکن API کامیلو را وارد کنید');
    await writeSetting(this.db, 'crm', next as any, me);
    this.caches.set(scopeKey(me.tenantId), next);
    this.fails = 0; this.pausedUntil = 0; this.lastError = '';
    this.bus.emit('crm-saved');
    const { pass, dgToken, kmToken, ...safe } = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'crm.save', target: 'crm', detail: { ...safe, passChanged: !!b.pass, dgTokenChanged: !!b.dgToken, kmTokenChanged: !!b.kmToken } as any } });
    return this.publicView(next);
  }

  /** True when the settings point at a usable patient system. */
  ready(s: CrmSettings) {
    if (!s.enabled) return false;
    if (s.provider === 'dastgheib') return !!(s.dgUrl && s.dgToken);
    if (s.provider === 'kamilo') return !!(s.kmUrl && s.kmToken);
    return !!s.url;
  }

  /** CRM settings for an inbound call: DID wins over a global provider toggle. */
  async settingsForInbound(did?: string | null, tenantId?: string | null): Promise<CrmSettings> {
    const base = await this.settings(tenantId);
    if (!isDastgheibInboundDid(did) && !isTenantPoolDid(did)) return base;
    const platform = await this.settings(null);
    const routed = applyDidCrmRouting(base, platform, did);
    if (isTenantPoolDid(did) && base.provider === 'dastgheib' && routed.provider !== 'dastgheib') {
      this.log.warn(`CRM: DID ${normalizeInboundDid(did)} is 31985 — blocked dastgheib (using ${routed.enabled ? routed.provider : 'off'})`);
    }
    if (isDastgheibInboundDid(did)) {
      this.log.log(`CRM: DID ${normalizeInboundDid(did)} → dastgheib`);
    }
    return routed;
  }

  /** One request to the CRM; returns the raw answer and the extracted name. */
  async fetchCrm(phone: string, s: CrmSettings) {
    if (s.provider === 'dastgheib') return this.fetchDastgheib(phone, s);
    if (s.provider === 'kamilo') return this.fetchKamilo(phone, s);
    const u = new URL(s.url);
    u.searchParams.set(s.param, formatPhone(phone, s.phoneFormat));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (s.user || s.pass) headers.Authorization = 'Basic ' + Buffer.from(`${s.user}:${s.pass}`).toString('base64');
    const t0 = Date.now();
    const r = await fetch(u, { headers, signal: AbortSignal.timeout(s.timeoutMs) });
    const text = await r.text();
    if (!r.ok) throw new Error(`پاسخ ${r.status} از سامانه بیماران${r.status === 401 ? ' (نام کاربری یا رمز اشتباه است)' : ''}`);
    let d: any;
    try { d = JSON.parse(text); } catch { throw new Error('پاسخ سامانه بیماران JSON نیست'); }
    const v = pick(d, s.nameField);
    const name = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '';
    return { name, surgery: surgeryDate(d), raw: d, ms: Date.now() - t0 };
  }

  /** «دستغیب»: the whole patient card (profile, services, satisfaction) in one read-only request. */
  async fetchDastgheib(phone: string, s: CrmSettings) {
    const base = new URL(s.dgUrl);
    const u = s.dgUrl.includes('{phone}') ? new URL(s.dgUrl.replace('{phone}', phone))
      : new URL(s.dgUrl.includes('/external-api/') ? s.dgUrl + '/' + phone : base.origin + base.pathname.replace(/\/+$/, '') + DG_PATH + phone);
    const host = s.dgHost || u.host;
    const t0 = Date.now();
    const r = await httpGet(u, { Accept: 'application/json', Authorization: 'Bearer ' + s.dgToken }, host, s.timeoutMs);
    if (r.status !== 200) throw new Error(`پاسخ ${r.status} از دستغیب${r.status === 401 ? ' (توکن اشتباه است)' : r.status === 403 ? ' (ارتباط با VoIP در تنظیمات دستغیب غیرفعال است)' : r.status === 404 ? ' (آدرس درست نیست)' : ''}`);
    let d: any;
    try { d = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('پاسخ دستغیب JSON نیست'); }
    if (!d || typeof d !== 'object' || typeof d.found !== 'boolean') throw new Error('پاسخ دستغیب قالب مورد انتظار را ندارد');
    if (d.found && d.patient) {
      if (Array.isArray(d.services)) d.services = d.services.slice(0, 300);
      // the photo lives on the clinic's own domain, which the browser cannot reach: keep a small copy with the card
      const pic = typeof d.patient.avatar_path === 'string' && d.patient.avatar_path.startsWith('/') ? d.patient.avatar_path : '';
      delete d.patient.avatar_path;
      // dastgheib sends a ready 256px photo; the stored thumbnail (50px) is only the fallback
      if (typeof d.patient.avatar !== 'string' || !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(d.patient.avatar) || d.patient.avatar.length > 200e3) delete d.patient.avatar;
      if (pic && !d.patient.avatar) {
        try {
          const a = await httpGet(new URL(pic, u.origin), {}, host, 3000);
          if (a.status === 200 && /^image\//.test(a.type) && a.body.length < 150e3) d.patient.avatar = `data:${a.type.split(';')[0]};base64,${a.body.toString('base64')}`;
        } catch { /* no photo: the initial is shown */ }
      }
    }
    const name = d.found && d.patient ? String(d.patient.name || '').replace(/\s+/g, ' ').trim() : '';
    return { name, surgery: null as string | null, raw: d, ms: Date.now() - t0 };
  }

  /** «کامیلو»: patient card + appointment lists by phone (Bearer token). */
  async fetchKamilo(phone: string, s: CrmSettings) {
    const base = s.kmUrl.replace(/\/+$/, '');
    const u = new URL(base.includes('/external-api/')
      ? (base.includes('/patients/by-phone') ? base.replace(/\/?$/, '/') + phone : base.replace(/\/+$/, '') + '/' + phone)
      : base + KM_PATIENT_PATH + phone);
    const t0 = Date.now();
    const r = await httpGet(u, { Accept: 'application/json', Authorization: 'Bearer ' + s.kmToken }, u.host, s.timeoutMs);
    if (r.status !== 200) throw new Error(`پاسخ ${r.status} از کامیلو${r.status === 401 ? ' (توکن اشتباه است)' : r.status === 403 ? ' (ارتباط با VoIP در کامیلو غیرفعال است)' : r.status === 404 ? ' (آدرس درست نیست)' : ''}`);
    let d: any;
    try { d = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('پاسخ کامیلو JSON نیست'); }
    if (!d || typeof d !== 'object' || typeof d.found !== 'boolean') throw new Error('پاسخ کامیلو قالب مورد انتظار را ندارد');
    if (Array.isArray(d.in_person_appointments)) d.in_person_appointments = d.in_person_appointments.slice(0, 400);
    if (Array.isArray(d.online_appointments)) d.online_appointments = d.online_appointments.slice(0, 400);
    const name = d.found ? String(d.name || '').replace(/\s+/g, ' ').trim() : '';
    return { name, surgery: null as string | null, raw: d, ms: Date.now() - t0 };
  }

  /** Appointment list for the tenant's kamilo connection (scoped by token's doctor). */
  async fetchKamiloAppointments(s: CrmSettings, q: { date?: string; from?: string; to?: string; limit?: number; confirmed?: boolean } = {}) {
    if (!s.kmUrl || !s.kmToken) throw new BadRequestException('آدرس و توکن API کامیلو وارد نشده است');
    const root = s.kmUrl.replace(/\/+$/, '');
    const href = /\/appointments\/?$/.test(root) ? root
      : /\/external-api\/voip\/v1\/?$/.test(root) ? root + '/appointments'
      : /\/external-api\/voip\/?$/.test(root) ? root + '/v1/appointments'
      : root + KM_APPT_PATH;
    const final = new URL(href);
    if (q.date) final.searchParams.set('date', q.date);
    if (q.from) final.searchParams.set('from', q.from);
    if (q.to) final.searchParams.set('to', q.to);
    if (q.limit) final.searchParams.set('limit', String(q.limit));
    if (q.confirmed) final.searchParams.set('confirmed', '1');
    const r = await httpGet(final, { Accept: 'application/json', Authorization: 'Bearer ' + s.kmToken }, final.host, s.timeoutMs);
    if (r.status !== 200) throw new Error(`پاسخ ${r.status} از کامیلو${r.status === 401 ? ' (توکن اشتباه است)' : r.status === 403 ? ' (ارتباط با VoIP در کامیلو غیرفعال است)' : ''}`);
    let d: any;
    try { d = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('پاسخ کامیلو JSON نیست'); }
    if (!d || !Array.isArray(d.appointments)) throw new Error('پاسخ کامیلو لیست نوبت ندارد');
    return d;
  }

  /** Inbound call started: ask the CRM in the background (never delays the call). */
  lookup(phone: string, tenantId?: string | null, did?: string | null) {
    const job = (async () => {
      const s = await this.settingsForInbound(did, tenantId);
      if (!this.ready(s) || !/^09\d{9}$/.test(phone)) return;
      const now = Date.now();
      // the same caller again within a minute (redial, retry) is not a new CRM lookup
      if ((this.recent.get(phone) || 0) > now - 60e3 || now < this.pausedUntil) return;
      this.recent.set(phone, now);
      if (this.recent.size > 5000) for (const [k, t] of this.recent) if (t < now - 60e3) this.recent.delete(k);
      try {
        const { name, surgery, raw } = await this.fetchCrm(phone, s);
        this.fails = 0;
        await this.store(phone, name, surgery, raw);
        await this.check(phone, !!name, null);
      } catch (e) {
        this.lastError = (e as Error).name === 'TimeoutError' ? 'سامانه بیماران در زمان تعیین‌شده جواب نداد' : (e as Error).message;
        await this.check(phone, null, this.lastError);
        // repeated failures: leave the CRM alone for five minutes
        if (++this.fails >= 3) { this.pausedUntil = Date.now() + 5 * 60e3; this.fails = 0; }
        this.log.warn('CRM lookup failed: ' + this.lastError);
      }
    })().catch(() => {}).finally(() => this.inflight.delete(phone));
    this.inflight.set(phone, job);
  }

  /** Keep the CRM's answer (name, surgery and every other field it sends) for the caller card and the file. */
  async store(phone: string, name: string, surgery: string | null, raw: any) {
    const cur = await this.db.patient.findUnique({ where: { phone } });
    if (!cur && !name) return;
    // a name typed in the panel wins; the surgery date always follows the CRM
    const nextName = cur && (cur.source === 'manual' || !name) ? cur.name : name;
    const crm = raw && typeof raw === 'object' && JSON.stringify(raw).length < (raw.found !== undefined && raw.patient ? 600000 : isApptCrm(raw) ? 800000 : 20000) ? raw : null;
    await this.db.patient.upsert({
      where: { phone },
      create: { phone, name: nextName, surgery, source: 'crm', crm, crmAt: new Date() },
      update: { name: nextName, surgery, crm: crm ?? undefined, crmAt: new Date(), ...(cur && cur.source === 'manual' ? {} : { source: 'crm' }) },
    });
    this.bus.emit('patient', { phone });
    if (!cur || cur.name !== nextName || cur.surgery !== surgery) this.bus.emit('calls', {});
  }

  isLooking(phone: string) { return this.inflight.has(phone); }

  /** Remember the outcome of a lookup (found = null: the CRM could not be asked; keeps the last known answer). */
  async check(phone: string, found: boolean | null, error: string | null) {
    const prev = await this.db.crmCheck.findUnique({ where: { phone } });
    const f = found ?? prev?.found ?? false;
    await this.db.crmCheck.upsert({ where: { phone }, create: { phone, found: f, error }, update: { found: f, error } }).catch(() => {});
    this.bus.emit('patient', { phone });
  }

  /** Wait (bounded) for a lookup that is still running for this caller. */
  async waitLookup(phone: string, ms: number) {
    const job = this.inflight.get(phone);
    if (job) await Promise.race([job, new Promise(r => setTimeout(r, ms))]);
  }

  /** Name for the desk phone display, from the local cache only (instant). */
  async phoneName(phone: string, tenantId?: string | null, _did?: string | null) {
    // Display prefs follow the tenant (or platform); DID routing only gates live CRM fetch in lookup().
    const s = await this.settings(tenantId);
    if (!s.enabled || s.phoneName === 'off' || !phone) return '';
    const p = await this.db.patient.findUnique({ where: { phone } });
    if (!p) return '';
    const latin = s.phoneName === 'latin';
    const clean = (x: string) => x.replace(/[,"'|;\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    const note = s.showSurgery ? surgeryNote(daysSince(p.surgery), latin) : '';
    // the surgery note must survive the phone's width limit, so the name is shortened first
    const name = clean(latin ? toLatin(p.name) : p.name).slice(0, note ? 40 - note.length - 3 : 40);
    return note ? `${name} - ${note}` : name;
  }

  /**
   * Preferred operator for inbound «ارتباط با اپراتور»:
   * CRM زیبایار agent_id on the dossier → User.apiId → extension (+ optional announce sound id).
   * Returns null when no match; never throws into the dialplan path.
   */
  async preferredAgent(phone: string, tenantId?: string | null): Promise<{ ext: string; announceSnd: string; queueAnnounceSnd: string; name: string; apiId: string } | null> {
    if (!phone) return null;
    try {
      // CRM lookup started at call entry; give it a short window before reading the cache.
      await this.waitLookup(phone, 1200);
      const p = await this.db.patient.findUnique({ where: { phone } });
      const agentKey = pickCrmAgentId(p?.crm);
      if (!agentKey) return null;
      // Prefer tenant-scoped users for tenant DIDs; never leak another tenant's agent.
      const where: any = { apiId: agentKey, active: true, ext: { not: null } };
      if (tenantId) where.tenantId = tenantId;
      else where.tenantId = null;
      const u = await this.db.user.findFirst({ where });
      if (!u || !u.ext || !/^\d{2,6}$/.test(u.ext)) return null;
      return {
        ext: u.ext,
        announceSnd: u.announceSnd || '',
        queueAnnounceSnd: u.queueAnnounceSnd || '',
        name: u.name,
        apiId: agentKey,
      };
    } catch {
      return null;
    }
  }
}

/** Prefer summary / next appointment / newest appointment agent_id from a cached CRM payload. */
export function pickCrmAgentId(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  const norm = (v: any) => {
    if (v === null || v === undefined || v === '') return '';
    return String(v).trim();
  };
  const card = apptCard(raw);
  if (card?.summary?.agentId != null && norm(card.summary.agentId)) return norm(card.summary.agentId);
  const fromAppt = (x: any) => (x && x.agentId != null ? norm(x.agentId) : '');
  const next = fromAppt(card?.next);
  if (next) return next;
  for (const a of (card?.appointments || [])) {
    const id = fromAppt(a);
    if (id) return id;
  }
  // Raw fallback when apptCard did not recognise the payload shape
  const sum = raw.summary && typeof raw.summary === 'object' ? raw.summary : null;
  if (sum && norm(sum.agent_id)) return norm(sum.agent_id);
  if (norm(raw.agent_id)) return norm(raw.agent_id);
  return '';
}

@Perm('vcrm')
@Controller('crm')
export class CrmController {
  constructor(private patients: PatientsService, private db: PrismaService) {}

  /** What the desk phone would show for this answer. */
  private async preview(name: string, surgery: string | null, s: CrmSettings) {
    if (s.phoneName === 'off' || !name) return '';
    const latin = s.phoneName === 'latin';
    const note = s.showSurgery ? surgeryNote(daysSince(surgery), latin) : '';
    const n = (latin ? toLatin(name) : name).slice(0, note ? 40 - note.length - 3 : 40);
    return note ? `${n} - ${note}` : n;
  }

  @Get()
  async get(@CurrentUser() me: Me) {
    const s = await this.patients.settings(me.tenantId);
    const [named, total] = await Promise.all([this.db.patient.count({ where: { source: 'crm' } }), this.db.patient.count()]);
    return { settings: this.patients.publicView(s), status: { named, total, lastError: this.patients.lastError } };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.patients.save(b, me); }

  /** One real lookup (the CRM logs it like a call). */
  @Perm('vcrm', 'edit')
  @Post('test')
  async test(@Body() b: { phone?: string }, @CurrentUser() me: Me) {
    const phone = String(b.phone || '').replace(/\D/g, '').replace(/^98/, '0').replace(/^9/, '09');
    if (!/^09\d{9}$/.test(phone)) throw new BadRequestException('یک شماره موبایل معتبر وارد کنید (مثل ۰۹۱۲…)');
    const s = await this.patients.settings(me.tenantId);
    if (s.provider === 'dastgheib' ? !s.dgUrl || !s.dgToken : s.provider === 'kamilo' ? !s.kmUrl || !s.kmToken : !s.url) {
      throw new BadRequestException(s.provider === 'dastgheib' ? 'آدرس و توکن API دستغیب وارد نشده است' : s.provider === 'kamilo' ? 'آدرس و توکن API کامیلو وارد نشده است' : 'آدرس API وارد نشده است');
    }
    try {
      const r = await this.patients.fetchCrm(phone, s);
      if (s.provider === 'dastgheib') {
        const p = r.raw.patient || {};
        const raw = { ...r.raw, patient: r.raw.patient ? { ...p, avatar: p.avatar ? '(عکس پروفایل دریافت شد)' : undefined } : undefined };
        return { ok: true, name: r.name, surgery: r.raw.found ? `${(r.raw.services || []).length} سابقه خدمت · ${(r.raw.details || []).length} فیلد تکمیلی` : 'این شماره در دستغیب پرونده ندارد', phone: await this.preview(r.name, null, s), ms: r.ms, raw: JSON.stringify(raw, null, 2).slice(0, 3000), latin: r.name ? toLatin(r.name) : '' };
      }
      if (s.provider === 'kamilo') {
        const n = r.raw.found ? `${r.raw.appointments_total || 0} نوبت` : 'این شماره در کامیلو پرونده ندارد';
        return { ok: true, name: r.name, surgery: n, phone: await this.preview(r.name, null, s), ms: r.ms, raw: JSON.stringify(r.raw, null, 2).slice(0, 3000), latin: r.name ? toLatin(r.name) : '' };
      }
      const note = surgeryNote(daysSince(r.surgery), false);
      return { ok: true, name: r.name, surgery: r.surgery ? note : 'در این سامانه جراحی تکمیل‌شده‌ای ثبت نشده', phone: await this.preview(r.name, r.surgery, s), ms: r.ms, raw: JSON.stringify(r.raw, null, 2).slice(0, 3000), latin: r.name ? toLatin(r.name) : '' };
    } catch (e) {
      return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'سامانه بیماران در زمان تعیین‌شده جواب نداد' : (e as Error).message };
    }
  }

  /** نوبت‌های کامیلو برای مستأجر لاگین‌شده (تنظیمات TenantConfig). */
  @Get('appointments')
  async appointments(
    @CurrentUser() me: Me,
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('confirmed') confirmed?: string,
  ) {
    return this.listAppointments(me, { date, from, to, limit: limit ? +limit : undefined, confirmed: confirmed === '1' || confirmed === 'true' });
  }

  @Post('appointments')
  async appointmentsPost(@Body() b: { date?: string; from?: string; to?: string; limit?: number; confirmed?: boolean }, @CurrentUser() me: Me) {
    return this.listAppointments(me, b || {});
  }

  private async listAppointments(me: Me, b: { date?: string; from?: string; to?: string; limit?: number; confirmed?: boolean }) {
    const s = await this.patients.settings(me.tenantId);
    if (s.provider !== 'kamilo') throw new BadRequestException('برای دریافت لیست نوبت، نوع سامانه را روی «کامیلو» بگذارید');
    if (!this.patients.ready(s)) throw new BadRequestException('آدرس و توکن کامیلو را ذخیره کنید');
    try {
      const d = await this.patients.fetchKamiloAppointments(s, {
        date: b.date ? String(b.date) : undefined,
        from: b.from ? String(b.from) : undefined,
        to: b.to ? String(b.to) : undefined,
        limit: b.limit ? +b.limit : 100,
        confirmed: !!b.confirmed,
      });
      return { ok: true, doctorId: d.doctor_id ?? null, count: d.count ?? (d.appointments || []).length, appointments: d.appointments || [] };
    } catch (e) {
      throw new BadRequestException((e as Error).name === 'TimeoutError' ? 'کامیلو در زمان تعیین‌شده جواب نداد' : (e as Error).message);
    }
  }
}

// Persian labels for the CRM fields we know; anything else is shown with its own key
const CRM_LABELS: Record<string, string> = {
  name: 'نام', full_name: 'نام کامل', first_name: 'نام', last_name: 'نام خانوادگی', mobile: 'موبایل', phone: 'تلفن', email: 'ایمیل', city: 'شهر', age: 'سن', gender: 'جنسیت',
  national_code: 'کد ملی', national_id: 'کد ملی', has_completed_surgery: 'جراحی انجام‌شده', last_surgery_date: 'تاریخ آخرین جراحی', days_since_surgery: 'روز از جراحی',
  surgery_type: 'نوع جراحی', next_appointment: 'نوبت بعدی', last_visit: 'آخرین ویزیت', doctor: 'پزشک', status: 'وضعیت', file_number: 'شماره پرونده', patient_id: 'شناسه بیمار', notes: 'یادداشت',
  call_count: 'تعداد تماس در سامانه بیماران', has_surgery_appointment: 'نوبت جراحی دارد', has_past_surgery_appointment: 'نوبت جراحی گذشته', has_future_surgery_appointment: 'نوبت جراحی آینده',
};
Object.assign(CRM_LABELS, {
  id: 'شناسه بیمار', file_no: 'شماره پرونده', found: 'پرونده دارد', appointments_total: 'کل نوبت‌ها', appointments_in_person: 'نوبت‌های حضوری', appointments_online: 'نوبت‌های آنلاین',
  calls_total: 'تماس‌های ثبت‌شده', calls_today: 'تماس‌های امروز', date: 'تاریخ', jalali: 'تاریخ', service: 'خدمت', place: 'محل', status_label: 'وضعیت', amount_paid: 'مبلغ پرداختی',
  online_status_label: 'وضعیت گفتگو', messages_count: 'تعداد پیام', last_online_chat: 'آخرین گفتگوی آنلاین', is_open: 'گفتگو باز است',
});
const SKIP = /^(success|ok|message|code|status_code|call_id)$/i;

/** The clinic's appointment CRM (in-person / online appointments, online chats): recognised by its own fields. */
export function isApptCrm(raw: any) {
  return !!raw && typeof raw === 'object' && typeof raw.found === 'boolean' && ('appointments_total' in raw || Array.isArray(raw.in_person_appointments) || Array.isArray(raw.online_appointments) || (raw.found === false && !raw.patient));
}

/** That answer in a fixed, size-bounded shape for the caller card and the patient file. */
export function apptCard(raw: any) {
  if (!isApptCrm(raw)) return null;
  const str = (v: any) => (v === null || v === undefined ? '' : String(v).trim());
  const num = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const bool = (v: any) => v === true || v === 1 || v === '1' || v === 'true';
  const doc = (d: any) => (d && typeof d === 'object' ? { id: d.id ?? null, name: str(d.name) } : null);
  const when = (x: any) => (x && typeof x === 'object' ? { id: x.id ?? null, date: str(x.date), time: str(x.time || x.time_from) } : null);
  const appt = (x: any) => (x && typeof x === 'object' ? {
    id: x.id ?? null, date: str(x.date), jalali: str(x.jalali), time: str(x.time || x.time_from), timeTo: str(x.time_to),
    service: str(x.service || x.part), part: str(x.part || x.service), place: str(x.place),
    status: num(x.status), statusLabel: str(x.status_label), paid: num(x.amount_paid),
    kind: str(x.kind), kindLabel: str(x.kind_label || x.kind_status_label),
    confirmed: bool(x.is_confirmed), confirmedLabel: str(x.is_confirmed_label),
    category: x.appointment_category ?? null, categoryLabel: str(x.appointment_category_label),
    first: bool(x.is_first_appointment), identifier: str(x.identifier_code),
    tracking: str(x.tracking_code || x.code), secondMobile: str(x.second_mobile),
    agentId: x.agent_id ?? null, agentName: str(x.agent_name), doctor: doc(x.doctor),
    visit: num(x.visit), visitLabel: str(x.visit_label), note: str(x.confirmed_comment),
    createdAt: str(x.created_at), updatedAt: str(x.updated_at),
    onlineStatus: num(x.online_status), onlineLabel: str(x.online_status_label), messages: num(x.messages_count),
  } : null);
  const list = (v: any) => (Array.isArray(v) ? v : []).slice(0, 400).map(appt).filter(Boolean);
  const msg = (m: any) => (m && typeof m === 'object' ? { sender: m.sender === 'staff' || +m.type === 2 ? 'staff' : 'patient', body: str(m.body).slice(0, 1500), file: !!m.has_file || (!str(m.body) && m.has_file !== false), at: str(m.sent_at), jalali: str(m.jalali) } : null);
  const ch = raw.last_online_chat && typeof raw.last_online_chat === 'object' ? raw.last_online_chat : null;
  const sum = raw.summary && typeof raw.summary === 'object' ? raw.summary : null;
  const patient = raw.patient && typeof raw.patient === 'object' ? raw.patient : null;
  // Prefer the rich dossier list; fall back to legacy in-person / online arrays.
  const richList = list(raw.appointments);
  const inPersonList = list(raw.in_person_appointments);
  const onlineList = list(raw.online_appointments);
  const appointments = richList.length ? richList : [...inPersonList, ...onlineList]
    .sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.time || '').localeCompare(String(a.time || '')));
  return {
    found: raw.found === true, id: raw.id ?? patient?.id ?? null,
    name: str(raw.name || patient?.name || sum?.full_name),
    first: str(raw.first_name || patient?.first_name), last: str(raw.last_name || patient?.last_name),
    phone: str(raw.phone || patient?.mobile || sum?.mobile),
    secondMobile: str(raw.second_mobile || patient?.second_mobile || sum?.second_mobile),
    nid: str(raw.national_code || patient?.national_code).replace(/\D/g, ''), fileNo: str(raw.file_no || patient?.file_no),
    city: str(raw.city || patient?.city || sum?.city), province: str(raw.province || patient?.province || sum?.province),
    address: str(raw.address || patient?.address || sum?.address),
    total: num(raw.appointments_total), received: num(raw.appointments_received_count ?? sum?.appointments_received_count),
    active: num(raw.appointments_active_count ?? sum?.appointments_active_count),
    cancelled: num(raw.appointments_cancelled_count ?? sum?.appointments_cancelled_count),
    inPerson: num(raw.appointments_in_person), online: num(raw.appointments_online),
    calls: num(raw.calls_total), callsToday: num(raw.calls_today),
    next: appt(raw.next_appointment) || when(sum?.next_appointment_at),
    lastReceived: appt(raw.last_received_appointment) || when(sum?.last_received_appointment_at),
    lastReceivedCreatedAt: str(raw.last_received_appointment?.created_at || sum?.last_received_created_at),
    appointments, appointmentsTruncated: raw.appointments_truncated === true, appointmentsOmitted: num(raw.appointments_omitted) || 0,
    inPersonList, onlineList,
    summary: sum ? {
      fullName: str(sum.full_name), agentName: str(sum.agent_name), agentId: sum.agent_id ?? null,
      first: bool(sum.is_first_appointment), firstLabel: str(sum.is_first_appointment_label),
      received: num(sum.appointments_received_count), mobile: str(sum.mobile), secondMobile: str(sum.second_mobile),
      part: str(sum.part), doctor: doc(sum.doctor),
      nextAt: when(sum.next_appointment_at), lastAt: when(sum.last_received_appointment_at),
      lastCreatedAt: str(sum.last_received_created_at),
      kind: str(sum.appointment_kind), kindLabel: str(sum.appointment_kind_label),
      status: num(sum.status), statusLabel: str(sum.status_label),
      confirmed: bool(sum.is_confirmed), confirmedLabel: str(sum.is_confirmed_label),
      city: str(sum.city), province: str(sum.province), address: str(sum.address),
      category: sum.appointment_category ?? null, categoryLabel: str(sum.appointment_category_label),
      identifier: str(sum.identifier_code) || str((appointments.find((x: any) => x.identifier) || {}).identifier),
      tracking: str(sum.tracking_code), appointmentId: sum.appointment_id ?? null,
      active: num(sum.appointments_active_count), cancelled: num(sum.appointments_cancelled_count),
      notes: str(sum.dossier_notes || raw.dossier_notes),
    } : null,
    notes: str(sum?.dossier_notes || raw.dossier_notes),
    notesSupported: raw.dossier_notes_supported === true,
    chat: ch ? {
      apptId: ch.appointment_id ?? null, service: str(ch.service), status: num(ch.online_status), statusLabel: str(ch.online_status_label), open: ch.is_open === true,
      messages: num(ch.messages_count), last: msg(ch.last_message), recent: (Array.isArray(ch.recent_messages) ? ch.recent_messages : []).slice(0, 10).map(msg).filter(Boolean),
    } : null,
  };
}

/** The CRM answer as label / value rows (nested objects flattened one level, national codes masked). */
export function crmFields(raw: any) {
  const out: { key: string; label: string; value: string }[] = [];
  const add = (k: string, v: any, prefix = '') => {
    if (v === null || v === undefined || v === '' || SKIP.test(k)) return;
    if (Array.isArray(v)) { if (v.length && v.every(x => typeof x !== 'object')) add(k, v.join('، '), prefix); return; }
    if (typeof v === 'object') { if (!prefix) for (const [k2, v2] of Object.entries(v)) add(k2, v2, k); return; }
    let value = typeof v === 'boolean' ? (v ? 'بله' : 'خیر') : String(v).trim();
    if (/national|melli|nid/i.test(k) && /\d{6,}/.test(value)) value = '•••••' + value.slice(-4);
    if (value.length > 300) value = value.slice(0, 300) + '…';
    out.push({ key: (prefix ? prefix + '.' : '') + k, label: CRM_LABELS[k] || k.replace(/_/g, ' '), value });
  };
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw)) add(k, v);
  return out.slice(0, 40);
}

// clinical file: the field names the CRM is asked to send (a few common aliases are accepted)
const CLIN: Record<string, string[]> = {
  firstName: ['first_name', 'firstname'], lastName: ['last_name', 'lastname', 'family'], fullName: ['full_name', 'name'],
  nationalCode: ['national_code', 'national_id', 'nid', 'melli_code'],
  consultation: ['consultation_date', 'consult_date', 'first_consultation_date'],
  surgery: ['surgery_date', 'last_surgery_date'],
  tampon: ['tampon_removal_date', 'tampon_removed_at', 'tampon_date'],
  splint: ['splint_removal_date', 'splint_removed_at', 'splint_date'],
  exams: ['examinations', 'exams', 'examination_dates'],
  visits: ['visits', 'appointments', 'visit_history'],
};
const CLIN_KEYS = new Set(Object.values(CLIN).flat().filter(k => k !== 'name'));

/** The clinical part of the CRM answer, as plain strings (dates are converted to Jalali in the panel). */
export function clinicalOf(raw: any) {
  const src = raw && typeof raw === 'object' ? (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw) : {};
  const get = (k: string) => { for (const a of CLIN[k]) if (src[a] !== undefined && src[a] !== null && src[a] !== '') return src[a]; return null; };
  const str = (v: any) => (v === null || v === undefined ? '' : String(v).trim());
  const list = (v: any) => (Array.isArray(v) ? v : []).slice(0, 500);
  // status codes of the clinic system (0 pending … 8 online visit done); status_title is shown as sent
  const st = (x: any) => ({ status: x.status === null || x.status === undefined || x.status === '' ? null : Number(x.status), statusTitle: str(x.status_title) });
  // online vs in-person: an explicit flag / service id when the API sends one, otherwise the service title
  const online = (x: any) => (x.is_online === true || x.is_online === 1 ? true : x.is_online === false || x.is_online === 0 ? false : +x.service_id === 19 ? true : x.service_id != null ? false : null);
  const exams = list(get('exams')).map((x: any) => (typeof x === 'object' && x ? { id: x.id ?? null, date: str(x.date || x.at), time: str(x.time), title: str(x.title || x.type), online: online(x), ...st(x) } : { id: null, date: str(x), time: '', title: '', online: null, status: null, statusTitle: '' }));
  const visits = list(get('visits')).map((x: any) => (typeof x === 'object' && x ? {
    id: x.id ?? null, type: str(x.type || x.title), date: str(x.date || x.at), time: str(x.time), ...st(x),
    apptNote: str(x.appointment_note ?? x.note), procNotes: (Array.isArray(x.procedure_notes) ? x.procedure_notes : []).map(str).filter(Boolean),
  } : { id: null, type: '', date: str(x), time: '', status: null, statusTitle: '', apptNote: '', procNotes: [] as string[] }));
  const yes = (v: any) => v === true || v === 1 || v === '1' || v === 'true';
  return {
    completed: yes(src.has_completed_surgery), completedDate: str(src.last_surgery_date), message: str(src.message),
    nextSurgeryAppt: str(src.next_surgery_appointment_date), lastSurgeryAppt: str(src.last_surgery_appointment_date),
    firstName: str(get('firstName')), lastName: str(get('lastName')), fullName: str(get('fullName')), nationalCode: str(get('nationalCode')).replace(/\D/g, ''),
    consultation: str(get('consultation')), surgery: str(get('surgery')), tampon: str(get('tampon')), splint: str(get('splint')), exams, visits,
  };
}

/** The stored «دستغیب» answer, when the stored answer is one (an older CRM answer is not shown as a clinic file). */
function dgCard(raw: any) {
  return raw && typeof raw === 'object' && raw.found === true && raw.patient && typeof raw.patient === 'object' ? raw : null;
}

const noteView = (n: { id: number; phone: string; text: string; userId: string; userName: string; createdAt: Date; updatedAt: Date }) => ({
  id: n.id, phone: n.phone, text: n.text, by: n.userName, userId: n.userId, at: n.createdAt,
  edited: +n.updatedAt - +n.createdAt > 60e3,
});

/** Caller card / patient file: what the CRM said, plus our own history of this number. */
@Controller('patients')
export class PatientCardController {
  constructor(private db: PrismaService, private patients: PatientsService) {}

  @Perm('calls')
  @Get(':phone/card')
  async card(@Param('phone') phone: string, @CurrentUser() me: Me) {
    const p = String(phone).replace(/\D/g, '');
    const [pt, s, reports, notes, chk] = await Promise.all([
      this.db.patient.findUnique({ where: { phone: p } }), this.patients.settings(me.tenantId),
      this.db.callReport.findMany({ where: { phone: p }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.db.patientNote.findMany({ where: { phone: p }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.crmCheck.findUnique({ where: { phone: p } }),
    ]);
    const days = daysSince(pt?.surgery);
    // crm: on (connection off) · mobile (only mobiles are looked up) · found / none / never / error
    const dgOn = s.provider === 'dastgheib';
    const kmOn = s.provider === 'kamilo';
    // dastgheib/kamilo are not charged per lookup: refresh open files older than two minutes
    if ((dgOn || kmOn) && this.patients.ready(s) && /^09\d{9}$/.test(p) && !this.patients.isLooking(p) && (!chk || chk.at.getTime() < Date.now() - 120e3)) this.patients.lookup(p, me.tenantId);
    const crmState = !s.enabled ? 'off' : !/^09\d{9}$/.test(p) ? 'nomobile' : this.patients.isLooking(p) ? 'looking'
      // the newest answer wins: a later «no file» or failure is shown over an older stored file
      : chk && (!pt?.crmAt || chk.at >= pt.crmAt) ? (chk.found ? 'found' : chk.error ? (pt?.crm ? 'found' : 'error') : 'none') : pt?.crm ? 'found' : 'never';
    return {
      phone: p, known: !!pt, name: pt?.name || '', source: pt?.source || '', surgery: pt?.surgery || null, days, surgeryNote: surgeryNote(days, false),
      crmOn: s.enabled, crmState, checkedAt: chk?.at || pt?.crmAt || null, checkError: chk?.error || '', looking: this.patients.isLooking(p), crmAt: pt?.crmAt || null,
      provider: s.provider, dg: dgOn ? dgCard(pt?.crm) : null, appt: dgOn ? null : apptCard(pt?.crm),
      fields: dgOn || isApptCrm(pt?.crm) ? [] : crmFields(pt?.crm).filter(f => !CLIN_KEYS.has(f.key.split('.').pop()!)), clinical: clinicalOf(dgOn || isApptCrm(pt?.crm) ? null : pt?.crm),
      reports: reports.map(r => ({ id: r.id, callId: r.callId, cat: r.cat, outcome: r.outcome, text: r.text, followUp: r.followUp || '', by: r.userName, userId: r.userId, at: r.createdAt })),
      notes: notes.map(noteView),
    };
  }

  /** Free-form «توضیحات» on the dossier: author edits/deletes own; others view only. */
  @Perm('calls', 'edit')
  @Post(':phone/notes')
  async addNote(@Param('phone') phone: string, @Body() b: { text?: string }, @CurrentUser() me: Me) {
    const p = String(phone).replace(/\D/g, '');
    if (!/^0\d{6,}$/.test(p)) throw new BadRequestException('شماره معتبر نیست');
    const text = String(b?.text || '').trim().slice(0, 4000);
    if (text.length < 2) throw new BadRequestException('متن توضیح را بنویسید');
    const n = await this.db.patientNote.create({ data: { phone: p, text, userId: me.id, userName: me.name } });
    return noteView(n);
  }

  @Perm('calls', 'edit')
  @Put(':phone/notes/:id')
  async editNote(@Param('phone') phone: string, @Param('id') id: string, @Body() b: { text?: string }, @CurrentUser() me: Me) {
    const n = await this.db.patientNote.findUnique({ where: { id: +id || 0 } });
    if (!n || n.phone !== String(phone).replace(/\D/g, '')) throw new BadRequestException('توضیح پیدا نشد');
    if (n.userId !== me.id) throw new BadRequestException('فقط نویسنده توضیح می‌تواند آن را ویرایش کند');
    const text = String(b?.text || '').trim().slice(0, 4000);
    if (text.length < 2) throw new BadRequestException('متن توضیح را بنویسید');
    return noteView(await this.db.patientNote.update({ where: { id: n.id }, data: { text } }));
  }

  @Perm('calls', 'edit')
  @Delete(':phone/notes/:id')
  async removeNote(@Param('phone') phone: string, @Param('id') id: string, @CurrentUser() me: Me) {
    const n = await this.db.patientNote.findUnique({ where: { id: +id || 0 } });
    if (!n || n.phone !== String(phone).replace(/\D/g, '')) throw new BadRequestException('توضیح پیدا نشد');
    if (n.userId !== me.id) throw new BadRequestException('فقط نویسنده توضیح می‌تواند آن را حذف کند');
    await this.db.patientNote.delete({ where: { id: n.id } });
    return { ok: true };
  }

  /** «به‌روزرسانی از سامانه بیماران» in the file: one fresh CRM request (at most once a minute per number). */
  private last = new Map<string, number>();
  @Perm('calls', 'edit')
  @Post(':phone/refresh')
  async refresh(@Param('phone') phone: string, @CurrentUser() me: Me) {
    const p = String(phone).replace(/\D/g, '');
    if (!/^09\d{9}$/.test(p)) throw new BadRequestException('فقط شماره موبایل در سامانه بیماران جستجو می‌شود');
    const s = await this.patients.settings(me.tenantId);
    if (!this.patients.ready(s)) throw new BadRequestException('اتصال به سامانه بیماران در تنظیمات فعال نیست');
    if ((this.last.get(p) || 0) > Date.now() - 60e3) throw new BadRequestException('همین الان به‌روزرسانی شد؛ یک دقیقه دیگر دوباره امتحان کنید');
    this.last.set(p, Date.now());
    try {
      const r = await this.patients.fetchCrm(p, s);
      await this.patients.store(p, r.name, r.surgery, r.raw);
      await this.patients.check(p, !!r.name, null);
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'سامانه بیماران در زمان تعیین‌شده جواب نداد' : (e as Error).message;
      await this.patients.check(p, null, msg);
      throw new BadRequestException(msg);
    }
    return this.card(p, me);
  }
}
