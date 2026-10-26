// «پیامک»: one-click template SMS from a call (reminder, app link, missed call, address, payment, after-surgery care)
// through SHSMS: GET https://shsms.ir/api/v1/sendms?receptor=…&template=…&param[0]=… with «Authorization: Bearer <token>».
// Sends are never retried automatically (a timeout may still have sent the message).
import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, Me, Perm } from './auth';
import { Bus } from './bus';
import { hhmm, jalaliDate } from './jalali';
import { clinicalOf } from './patients';
import { PrismaService } from './prisma.service';

const BASE = 'https://shsms.ir/api/v1';

/** Values a template parameter can take; the panel shows this list as the guide under each template. */
export const SMS_VARS: Record<string, string> = {
  name: 'نام کامل بیمار', first_name: 'نام کوچک بیمار', phone: 'شماره موبایل بیمار',
  today: 'تاریخ امروز (شمسی)', now: 'ساعت فعلی', operator: 'نام کاربر ارسال‌کننده', ext: 'داخلی کاربر ارسال‌کننده',
  next_date: 'تاریخ نزدیک‌ترین نوبت آینده', next_time: 'ساعت نزدیک‌ترین نوبت آینده', next_type: 'نوع نزدیک‌ترین نوبت آینده',
  surgery_date: 'تاریخ جراحی (شمسی)', surgery_days: 'روز از جراحی',
};

export interface SmsParam { kind: 'var' | 'text'; v: string }
export interface SmsTemplate { id: string; title: string; icon: string; template: string; on: boolean; params: SmsParam[] }
export interface SmsSettings { enabled: boolean; token: string; dryRun: boolean; timeoutSec: number; templates: SmsTemplate[] }

const P = (...a: (string | [string])[]) => a.map(x => (Array.isArray(x) ? { kind: 'text' as const, v: x[0] } : { kind: 'var' as const, v: x }));
const DEFAULTS: SmsSettings = {
  enabled: false, token: '', dryRun: true, timeoutSec: 15,
  templates: [
    { id: 'reminder', title: 'یادآوری نوبت', icon: 'calendar', template: '', on: true, params: P('name', 'next_date', 'next_time') },
    { id: 'app', title: 'لینک نصب اپلیکیشن', icon: 'app', template: '', on: true, params: P('name') },
    { id: 'missed', title: 'تماس گرفتیم، جواب ندادید', icon: 'missed', template: '', on: true, params: P('name') },
    { id: 'address', title: 'آدرس مطب', icon: 'pin', template: '', on: true, params: P('name') },
    { id: 'payment', title: 'یادآوری پرداخت', icon: 'card', template: '', on: true, params: P('name') },
    { id: 'postop', title: 'شرایط بعد از عمل', icon: 'heart', template: '', on: true, params: P('name', 'surgery_date') },
  ],
};
const ICONS = ['calendar', 'app', 'missed', 'pin', 'card', 'heart', 'chat', 'star'];

@Injectable()
export class SmsService {
  private log = new Logger('Sms');
  private cache: SmsSettings | null = null;
  constructor(private db: PrismaService, private bus: Bus) {}

  async settings(): Promise<SmsSettings> {
    if (!this.cache) {
      const r = await this.db.configEntry.findUnique({ where: { key: 'sms' } });
      this.cache = { ...DEFAULTS, ...((r?.data as any) || {}) };
    }
    return this.cache!;
  }

  publicView(s: SmsSettings) {
    const { token, ...rest } = s;
    return { ...rest, hasToken: !!token, tokenHint: token ? '…' + token.slice(-4) : '', vars: SMS_VARS };
  }

  async save(b: any, me: Me) {
    const cur = await this.settings();
    const tpls: SmsTemplate[] = (Array.isArray(b.templates) ? b.templates : cur.templates).slice(0, 20).map((t: any, i: number) => ({
      id: /^[a-z0-9_-]{2,30}$/i.test(t.id || '') ? t.id : 't' + Date.now().toString(36) + i,
      title: String(t.title || '').trim().slice(0, 40) || 'پیامک',
      icon: ICONS.includes(t.icon) ? t.icon : 'chat',
      template: String(t.template || '').trim().slice(0, 100),
      on: t.on !== false,
      params: (Array.isArray(t.params) ? t.params : []).slice(0, 10).map((p: any) => (p && p.kind === 'text' ? { kind: 'text', v: String(p.v || '').slice(0, 200) } : { kind: 'var', v: SMS_VARS[p?.v] ? p.v : 'name' })),
    }));
    const next: SmsSettings = {
      enabled: !!(b.enabled ?? cur.enabled), dryRun: !!(b.dryRun ?? cur.dryRun),
      timeoutSec: Math.min(30, Math.max(5, +(b.timeoutSec ?? cur.timeoutSec) || 15)),
      token: typeof b.token === 'string' && b.token.trim() ? b.token.trim() : b.clearToken ? '' : cur.token,
      templates: tpls,
    };
    if (next.enabled && !next.dryRun && !next.token) throw new BadRequestException('برای ارسال واقعی، توکن API پنل پیامک را وارد کنید (یا حالت آزمایشی را روشن بگذارید)');
    await this.db.configEntry.upsert({ where: { key: 'sms' }, create: { key: 'sms', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    this.cache = next;
    const { token, ...safe } = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'sms.save', target: 'sms', detail: { ...safe, tokenChanged: !!b.token } as any } });
    this.bus.emit('sms', {});
    return this.publicView(next);
  }

  /** Account credit (`data.ballance`, spelled with two l's by the service); null = unknown, 0 is a real value. */
  async budget() {
    const s = await this.settings();
    if (!s.token) throw new BadRequestException('توکن API پنل پیامک وارد نشده است');
    const r = await fetch(BASE + '/budget', { headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) throw new BadRequestException('توکن پنل پیامک پذیرفته نشد');
    const d: any = await r.json().catch(() => null);
    if (r.status !== 200 || !d || d.status !== true || !d.data || !('ballance' in d.data)) throw new BadRequestException('پاسخ نامعتبر از پنل پیامک (' + r.status + ')');
    // the service sends the credit already formatted («5,116,271»), plus the package and its end date
    const x = d.data;
    return { balance: String(x.ballance ?? ''), package: String(x.package || ''), endAt: String(x.end_at || ''), packageOk: x.package_status !== false };
  }

  /** Values for one caller: CRM data (name, next appointment, surgery) and the sending user. */
  private async context(phone: string, me: Me) {
    const pt = await this.db.patient.findUnique({ where: { phone } });
    const cl = clinicalOf(pt?.crm);
    const iso = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v.slice(0, 10) + 'T12:00:00Z') : null);
    const today = new Date().toISOString().slice(0, 10);
    const next = cl.visits.filter(v => v.date >= today && ![3, 5, 6].includes(v.status as number)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    const sd = iso(cl.completedDate || cl.surgery);
    const users = await this.db.user.findUnique({ where: { id: me.id }, select: { title: true } });
    return {
      name: pt?.name || [cl.firstName, cl.lastName].filter(Boolean).join(' ') || 'بیمار گرامی', first_name: cl.firstName || (pt?.name || '').split(' ')[0] || 'بیمار گرامی', phone,
      today: jalaliDate(new Date()), now: hhmm(new Date()), operator: users?.title ? me.name + ' (' + users.title + ')' : me.name, ext: me.ext || '',
      next_date: next && iso(next.date) ? jalaliDate(iso(next.date)!) : '', next_time: next?.time || '', next_type: next?.type || '',
      surgery_date: sd ? jalaliDate(sd) : '', surgery_days: sd ? String(Math.max(0, Math.round((Date.now() - sd.getTime()) / 864e5))) : '',
    } as Record<string, string>;
  }

  async send(callKey: string, phone: string, templateId: string, me: Me) {
    const s = await this.settings();
    if (!s.enabled) throw new BadRequestException('ارسال پیامک در تنظیمات فعال نیست');
    const t = s.templates.find(x => x.id === templateId && x.on);
    if (!t) throw new BadRequestException('این قالب پیامک تعریف نشده یا غیرفعال است');
    if (!t.template) throw new BadRequestException('نام الگوی «' + t.title + '» در تنظیمات پیامک وارد نشده است');
    const key = String(callKey || '').replace(/^C/, '').slice(0, 64);
    const to = String(phone || '').replace(/\D/g, '').replace(/^98/, '0');
    if (!key) throw new BadRequestException('تماس مشخص نیست');
    if (!/^09\d{9}$/.test(to)) throw new BadRequestException('پیامک فقط به شماره موبایل فرستاده می‌شود');
    const done = await this.db.smsLog.findFirst({ where: { callKey: key, templateId, ok: true } });
    if (done) throw new BadRequestException('«' + t.title + '» برای این تماس قبلاً ارسال شده است');
    const ctx = await this.context(to, me);
    const params = t.params.map(p => (p.kind === 'text' ? p.v : ctx[p.v] ?? ''));
    const missing = t.params.map((p, i) => (p.kind === 'var' && !params[i] ? SMS_VARS[p.v] : '')).filter(Boolean);
    if (missing.length) throw new BadRequestException('برای این بیمار مقدار «' + missing.join('، ') + '» موجود نیست؛ پیامک ارسال نشد');
    let ok = false, httpCode: number | null = null, error: string | null = null;
    if (s.dryRun) ok = true;
    else {
      const u = new URL(BASE + '/sendms');
      u.searchParams.append('receptor', to);
      u.searchParams.append('template', t.template);
      params.forEach((v, i) => u.searchParams.append(`param[${i}]`, v));
      try {
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/json' }, signal: AbortSignal.timeout(s.timeoutSec * 1000) });
        httpCode = r.status;
        const d: any = await r.json().catch(() => null);
        ok = r.ok && !(d && d.status === false);
        if (!ok) error = (r.status === 401 || r.status === 403 ? 'توکن پنل پیامک پذیرفته نشد' : r.status === 404 ? 'آدرس یا الگوی پیامک پیدا نشد' : r.status === 429 ? 'محدودیت تعداد ارسال پنل پیامک' : 'پنل پیامک خطا داد') + ' (' + r.status + ')' + (d && d.message ? ': ' + String(d.message).slice(0, 120) : '');
      } catch (e) {
        error = (e as Error).name === 'TimeoutError' ? 'پنل پیامک در زمان تعیین‌شده جواب نداد (ممکن است ارسال شده باشد)' : 'اتصال به پنل پیامک برقرار نشد';
      }
    }
    const row = await this.db.smsLog.create({ data: { callKey: key, phone: to, templateId, title: t.title, ok, dryRun: s.dryRun, httpCode, error, userId: me.id, userName: me.name } });
    this.bus.emit('sms', { callKey: key });
    if (!ok) throw new BadRequestException(error || 'ارسال ناموفق بود');
    return { id: row.id, at: row.at, dryRun: s.dryRun };
  }

  async forCalls(keys: string[]) {
    const rows = await this.db.smsLog.findMany({ where: { callKey: { in: keys }, ok: true }, orderBy: { at: 'asc' } });
    const out: Record<string, any[]> = {};
    for (const r of rows) (out[r.callKey] = out[r.callKey] || []).push({ t: r.templateId, title: r.title, at: r.at, by: r.userName, dry: r.dryRun });
    return out;
  }
}

@Controller('sms')
export class SmsController {
  constructor(private sms: SmsService) {}

  /** Buttons for the panel: titles and icons only (never the token). */
  @Perm('calls')
  @Get('buttons')
  async buttons() {
    const s = await this.sms.settings();
    return { enabled: s.enabled, dryRun: s.dryRun, buttons: s.templates.filter(t => t.on).map(t => ({ id: t.id, title: t.title, icon: t.icon, ready: !!t.template })) };
  }

  @Perm('vsms')
  @Get('settings')
  async get() { return this.sms.publicView(await this.sms.settings()); }

  @Perm('vsms', 'edit')
  @Put('settings')
  save(@Body() b: any, @CurrentUser() me: Me) { return this.sms.save(b, me); }

  @Perm('vsms')
  @Get('budget')
  budget() { return this.sms.budget(); }

  @Perm('calls', 'edit')
  @Post('send')
  send(@Body() b: { callKey: string; phone: string; template: string }, @CurrentUser() me: Me) { return this.sms.send(b.callKey, b.phone, b.template, me); }

  @Perm('calls')
  @Post('sent')
  async sent(@Body() b: { keys: string[] }) { return this.sms.forCalls((Array.isArray(b?.keys) ? b.keys : []).map(k => String(k).replace(/^C/, '')).slice(0, 500)); }
}
