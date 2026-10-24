// Patient directory: names come from the clinic CRM, looked up once per inbound call and cached locally.
// The CRM logs every lookup as a call, so it is asked exactly once per inbound call and never in bulk.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post, Put } from '@nestjs/common';
import { CurrentUser, Me, Roles } from './auth';
import { Bus } from './bus';
import { PrismaService } from './prisma.service';

export interface CrmSettings {
  enabled: boolean; url: string; param: string; user: string; pass: string;
  phoneFormat: '0' | '98' | '+98' | '9'; nameField: string; timeoutMs: number;
  phoneName: 'fa' | 'latin' | 'off';
}
const DEFAULTS: CrmSettings = {
  enabled: false, url: 'https://crm.drpouriaaflaki.com/api/v1/voip/surgery-status', param: 'mobile', user: '', pass: '',
  phoneFormat: '0', nameField: 'name', timeoutMs: 4000, phoneName: 'fa',
};

/** 0912… in the panel; the CRM may want 98912…, +98912… or 912…. */
function formatPhone(p: string, f: CrmSettings['phoneFormat']) {
  const local = p.replace(/^0/, '');
  return f === '98' ? '98' + local : f === '+98' ? '+98' + local : f === '9' ? local : p;
}

const pick = (o: any, field: string) => field.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

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
  private cache: CrmSettings | null = null;
  private recent = new Map<string, number>();
  private fails = 0;
  private pausedUntil = 0;
  lastError = '';
  constructor(private db: PrismaService, private bus: Bus) {}

  async settings(): Promise<CrmSettings> {
    if (!this.cache) {
      const r = await this.db.configEntry.findUnique({ where: { key: 'crm' } });
      this.cache = { ...DEFAULTS, ...((r?.data as any) || {}) };
    }
    return this.cache!;
  }

  publicView(s: CrmSettings) {
    const { pass, ...rest } = s;
    return { ...rest, hasPass: !!pass };
  }

  async save(b: any, me: Me) {
    const cur = await this.settings();
    const url = String(b.url ?? cur.url).trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود');
    const next: CrmSettings = {
      enabled: !!(b.enabled ?? cur.enabled), url,
      param: String(b.param ?? cur.param).trim() || 'mobile',
      user: String(b.user ?? cur.user).trim(),
      pass: typeof b.pass === 'string' && b.pass ? b.pass : cur.pass,
      phoneFormat: ['0', '98', '+98', '9'].includes(b.phoneFormat) ? b.phoneFormat : cur.phoneFormat,
      nameField: String(b.nameField ?? cur.nameField).trim() || 'name',
      timeoutMs: Math.min(15000, Math.max(1000, +(b.timeoutMs ?? cur.timeoutMs) || 4000)),
      phoneName: ['fa', 'latin', 'off'].includes(b.phoneName) ? b.phoneName : cur.phoneName,
    };
    if (b.clearPass) next.pass = '';
    if (next.enabled && !next.url) throw new BadRequestException('آدرس API را وارد کنید');
    await this.db.configEntry.upsert({ where: { key: 'crm' }, create: { key: 'crm', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    this.cache = next;
    this.fails = 0; this.pausedUntil = 0; this.lastError = '';
    const { pass, ...safe } = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'crm.save', target: 'crm', detail: { ...safe, passChanged: !!b.pass } as any } });
    return this.publicView(next);
  }

  /** One request to the CRM; returns the raw answer and the extracted name. */
  async fetchCrm(phone: string, s: CrmSettings) {
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
    const name = String(pick(d, s.nameField) ?? '').replace(/\s+/g, ' ').trim();
    return { name, raw: d, ms: Date.now() - t0 };
  }

  /** Inbound call started: ask the CRM in the background (never delays the call). */
  lookup(phone: string) {
    (async () => {
      const s = await this.settings();
      if (!s.enabled || !s.url || !/^09\d{9}$/.test(phone)) return;
      const now = Date.now();
      // the same caller again within a minute (redial, retry) is not a new CRM lookup
      if ((this.recent.get(phone) || 0) > now - 60e3 || now < this.pausedUntil) return;
      this.recent.set(phone, now);
      if (this.recent.size > 5000) for (const [k, t] of this.recent) if (t < now - 60e3) this.recent.delete(k);
      try {
        const { name } = await this.fetchCrm(phone, s);
        this.fails = 0;
        if (!name) return;
        const cur = await this.db.patient.findUnique({ where: { phone } });
        if (cur && (cur.source === 'manual' || cur.name === name)) return;
        await this.db.patient.upsert({ where: { phone }, create: { phone, name, source: 'crm' }, update: { name, source: 'crm' } });
        this.bus.emit('calls', {});
      } catch (e) {
        this.lastError = (e as Error).name === 'TimeoutError' ? 'سامانه بیماران در زمان تعیین‌شده جواب نداد' : (e as Error).message;
        // repeated failures: leave the CRM alone for five minutes
        if (++this.fails >= 3) { this.pausedUntil = Date.now() + 5 * 60e3; this.fails = 0; }
        this.log.warn('CRM lookup failed: ' + this.lastError);
      }
    })().catch(() => {});
  }

  /** Name for the desk phone display, from the local cache only (instant). */
  async phoneName(phone: string) {
    const s = await this.settings();
    if (!s.enabled || s.phoneName === 'off' || !phone) return '';
    const p = await this.db.patient.findUnique({ where: { phone } });
    if (!p) return '';
    const n = s.phoneName === 'latin' ? toLatin(p.name) : p.name;
    return n.replace(/[,"'|;\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
}

@Roles('admin')
@Controller('crm')
export class CrmController {
  constructor(private patients: PatientsService, private db: PrismaService) {}

  @Get()
  async get() {
    const s = await this.patients.settings();
    const [named, total] = await Promise.all([this.db.patient.count({ where: { source: 'crm' } }), this.db.patient.count()]);
    return { settings: this.patients.publicView(s), status: { named, total, lastError: this.patients.lastError } };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.patients.save(b, me); }

  /** One real lookup (the CRM logs it like a call). */
  @Post('test')
  async test(@Body() b: { phone?: string }) {
    const phone = String(b.phone || '').replace(/\D/g, '').replace(/^98/, '0').replace(/^9/, '09');
    if (!/^09\d{9}$/.test(phone)) throw new BadRequestException('یک شماره موبایل معتبر وارد کنید (مثل ۰۹۱۲…)');
    const s = await this.patients.settings();
    if (!s.url) throw new BadRequestException('آدرس API وارد نشده است');
    try {
      const r = await this.patients.fetchCrm(phone, s);
      return { ok: true, name: r.name, ms: r.ms, raw: JSON.stringify(r.raw, null, 2).slice(0, 3000), latin: r.name ? toLatin(r.name) : '' };
    } catch (e) {
      return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'سامانه بیماران در زمان تعیین‌شده جواب نداد' : (e as Error).message };
    }
  }
}
