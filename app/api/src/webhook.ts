// «ارسال تماس‌ها (API)»: every step of a call (started, IVR key, queue, ringing, answered, transferred, ended,
// survey, voicemail) is POSTed as JSON to one address of the customer's choice, as it happens.
// Events are saved first (CallEvent, an outbox), then delivered in order per call with retries, so nothing is lost
// when the destination or this server is down for a moment. Settings live in ConfigEntry('webhook').
import { BadRequestException, Body, Controller, Get, Injectable, Logger, NotFoundException, OnModuleInit, Param, Post, Put } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import { CurrentUser, Me, Perm } from './auth';
import { readSetting, writeSetting, scopeKey } from './tenant-settings';
import { env } from './env';
import { PrismaService } from './prisma.service';

/** The survey without the server path of its voice comment. */
export function publicSurvey(sv: any) {
  if (!sv) return null;
  const { rec, ...rest } = sv;
  return { ...rest, hasRec: !!rec };
}

/** Every event a customer can subscribe to, in the order they happen in a call. */
export const EVENTS: { key: string; label: string; hint: string }[] = [
  { key: 'call.started', label: 'شروع تماس', hint: 'تماس ورودی وارد مرکز شد یا تماس خروجی شروع شد' },
  { key: 'call.ivr', label: 'انتخاب در منوی تلفنی', hint: 'تماس‌گیرنده در منوی IVR کلیدی زد' },
  { key: 'booking.entered', label: 'ورود به نوبت‌دهی', hint: 'تماس‌گیرنده وارد نوبت‌دهی تلفنی شد (نوبت جدید یا پیگیری)، یا تماس یادآوری / اطلاع لغو برقرار شد' },
  { key: 'booking.step', label: 'هر مرحله نوبت‌دهی', hint: 'هر قدم همان لحظه: سؤال‌ها، کلید زده‌شده، زمان پیشنهادی، پاسخ سامانه نوبت‌دهی' },
  { key: 'booking.booked', label: 'نوبت ثبت شد', hint: 'کد پیگیری، تاریخ و ساعت نوبت، پزشک، موبایل' },
  { key: 'booking.cancelled', label: 'نوبت لغو شد', hint: 'لغو از پیگیری تلفنی یا از تماس یادآوری' },
  { key: 'booking.ended', label: 'پایان نوبت‌دهی', hint: 'نتیجه نهایی (ثبت، تکراری، بدون زمان خالی، لغو، نیمه‌کاره، خطا …) با همه مراحل' },
  { key: 'call.queued', label: 'ورود به صف', hint: 'تماس وارد صف انتظار شد' },
  { key: 'call.ringing', label: 'زنگ خوردن داخلی', hint: 'گوشی داخلی (یا موبایل یا شماره مقصد) زنگ می‌خورد؛ target=preferred یعنی زنگ ترجیحی عامل' },
  { key: 'preferred.missed', label: 'بی‌پاسخ زنگ ترجیحی', hint: 'عامل ترجیحی (agent_id) در مهلت جواب نداد یا در دسترس نبود؛ تماس به صف می‌رود' },
  { key: 'call.answered', label: 'وصل شدن', hint: 'داخلی جواب داد و مکالمه شروع شد' },
  { key: 'call.transferred', label: 'انتقال تماس', hint: 'اپراتور تماس را به داخلی یا شماره دیگری منتقل کرد' },
  { key: 'survey.started', label: 'شروع نظرسنجی', hint: 'بعد از قطع اپراتور، نظرسنجی برای تماس‌گیرنده پخش شد' },
  { key: 'survey.completed', label: 'پایان نظرسنجی', hint: 'امتیازها (و اینکه پیام صوتی گذاشت یا نه)' },
  { key: 'voicemail.left', label: 'پیام صوتی', hint: 'تماس‌گیرنده پیام صوتی گذاشت' },
  { key: 'call.ended', label: 'پایان تماس', hint: 'خلاصه کامل تماس: وضعیت، مدت انتظار و مکالمه، اپراتور، نظرسنجی' },
];
const EVENT_KEYS = EVENTS.map(e => e.key);

export interface WebhookSettings { enabled: boolean; url: string; headerName: string; token: string; secret: string; timeoutSec: number; events: string[] }
const DEFAULTS: WebhookSettings = { enabled: false, url: '', headerName: 'Authorization', token: '', secret: '', timeoutSec: 10, events: [...EVENT_KEYS] };
const RETRY_DELAYS = [10e3, 60e3, 300e3]; // after the first failure: 10 s, 1 min, 5 min; then the event is marked failed
const PARALLEL = 4;                       // calls delivered at the same time (events of one call always go one by one)
const KEEP_DAYS = 30;
const ST_FA: Record<string, string> = { answered: 'پاسخ‌داده', missed: 'بی‌پاسخ', voicemail: 'پیام صوتی', transferred: 'انتقال‌یافته' };

/** The JSON body of one event. */
export function envelope(e: { event: string; eventId: string; callId: string; seq: number; occurredAt: Date; data: any; test?: boolean }) {
  return { event: e.event, eventId: e.eventId, callId: e.callId, seq: e.seq, occurredAt: e.occurredAt.toISOString(), ...(e.test ? { test: true } : {}), data: e.data };
}

/** «sha256=<hex>» over «<timestamp>.<body>», so the receiver can check the sender and reject replays. */
export function signature(secret: string, ts: string, body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
}

@Injectable()
export class WebhookService implements OnModuleInit {
  private log = new Logger('Webhook');
  private caches = new Map<string, WebhookSettings>();
  private seqs = new Map<string, number>();
  private chain: Promise<any> = Promise.resolve();
  private busy = new Set<string>();   // calls with a delivery in flight
  private timer: NodeJS.Timeout | null = null;
  retryDelays = RETRY_DELAYS;

  constructor(private db: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => this.pump().catch(e => this.log.warn('pump: ' + e.message)), 1000);
    setInterval(() => this.cleanup().catch(() => {}), 6 * 3600e3);
  }

  async settings(tenantId?: string | null): Promise<WebhookSettings> {
    const k = scopeKey(tenantId);
    if (!this.caches.has(k)) {
      const row = await readSetting(this.db, 'webhook', tenantId);
      const d: any = row || {};
      const had = row != null;
      this.caches.set(k, { ...DEFAULTS, ...d, events: Array.isArray(d.events) ? d.events.filter((x: string) => EVENT_KEYS.includes(x)) : had ? ['call.ended'] : [...EVENT_KEYS] });
    }
    return this.caches.get(k)!;
  }

  async save(b: Partial<WebhookSettings> & { clearToken?: boolean; clearSecret?: boolean }, me: Me) {
    const cur = await this.settings(me.tenantId);
    const url = String(b.url ?? cur.url).trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود');
    if (b.enabled && !url) throw new BadRequestException('برای فعال کردن، آدرس مقصد را وارد کنید');
    const headerName = String(b.headerName ?? cur.headerName).trim() || 'Authorization';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw new BadRequestException('نام هدر فقط می‌تواند حروف انگلیسی، عدد و خط تیره باشد');
    const events = Array.isArray(b.events) ? EVENT_KEYS.filter(k => b.events!.includes(k)) : cur.events;
    if (b.enabled && !events.length) throw new BadRequestException('حداقل یک رویداد را برای ارسال انتخاب کنید');
    const next: WebhookSettings = {
      enabled: !!(b.enabled ?? cur.enabled), url, headerName, events,
      token: typeof b.token === 'string' && b.token.length ? b.token.trim() : cur.token, // empty = keep the saved value
      secret: typeof b.secret === 'string' && b.secret.length ? b.secret.trim() : cur.secret,
      timeoutSec: Math.min(60, Math.max(2, +(b.timeoutSec ?? cur.timeoutSec) || 10)),
    };
    if (b.clearToken) next.token = '';
    if (b.clearSecret) next.secret = '';
    await writeSetting(this.db, 'webhook', next as any, me);
    this.caches.set(scopeKey(me.tenantId), next);
    // switched off: what is still waiting would arrive late and out of context
    if (!next.enabled) {
      if (me.tenantId) {
        const ids = (await this.db.call.findMany({ where: { tenantId: me.tenantId }, select: { id: true } })).map(c => c.id);
        if (ids.length) await this.db.callEvent.updateMany({ where: { state: 'pending', callId: { in: ids } }, data: { state: 'cancelled' } });
      } else {
        await this.db.callEvent.updateMany({ where: { state: 'pending' }, data: { state: 'cancelled' } });
      }
    }
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'webhook.save', target: 'webhook', detail: { enabled: next.enabled, url: next.url, headerName: next.headerName, events: next.events, tokenChanged: !!b.token, secretChanged: !!b.secret } } });
    return this.publicView(next);
  }


  private async tenantOfCall(callId: string | null | undefined): Promise<string | null> {
    if (!callId || callId === 'test') return null;
    try {
      const c = await this.db.call.findUnique({ where: { id: callId }, select: { tenantId: true } });
      return c?.tenantId || null;
    } catch {
      return null;
    }
  }

  publicView(s: WebhookSettings) {
    return {
      enabled: s.enabled, url: s.url, headerName: s.headerName, timeoutSec: s.timeoutSec, events: s.events,
      hasToken: !!s.token, tokenHint: s.token ? '••••' + s.token.slice(-4) : '', hasSecret: !!s.secret,
    };
  }

  /** The «call.ended» data for one call (same rules as the panel: < SHORT_CALL_SEC of talk = missed). */
  async endedData(callId: string): Promise<Record<string, any> | null> {
    const c = await this.db.call.findUnique({ where: { id: callId } });
    if (!c) return null;
    const [p, u] = await Promise.all([
      this.db.patient.findUnique({ where: { phone: c.phone } }),
      c.opExt ? this.db.user.findFirst({ where: { ext: c.opExt } }) : null,
    ]);
    const short = (c.st === 'answered' || c.st === 'transferred') && c.dur < env.shortCallSec;
    const st = short ? 'missed' : c.st;
    const ended = new Date(c.startedAt.getTime() + (c.wait + c.dur) * 1000);
    return {
      direction: c.dir === 'in' ? 'inbound' : 'outbound',
      status: st,
      statusLabel: ST_FA[st] || st,
      shortCall: short,
      callerNumber: c.dir === 'in' ? c.phone : null,
      calledNumber: c.dir === 'out' ? c.phone : c.did || null,
      phone: c.phone,
      patientName: p ? p.name : null,
      queue: c.queue,
      operator: c.opExt ? { extension: c.opExt, name: u ? u.name : null } : null,
      isCallback: c.callback,
      startedAt: c.startedAt.toISOString(),
      endedAt: ended.toISOString(),
      date: c.date,
      time: c.time,
      waitSeconds: c.wait,
      talkSeconds: short ? 0 : c.dur,
      connectedSeconds: c.dur,
      hasRecording: !!c.recPath,
      survey: publicSurvey(c.survey),
      summary: c.summary || null,
    };
  }

  /**
   * Save one event for delivery (never throws). Ignored when sending is off or the event is not chosen.
   * Calls are serialised so the per-call sequence numbers never repeat.
   */
  record(event: string, callId: string, data: Record<string, any>, occurredAt = new Date()) {
    this.chain = this.chain.then(async () => {
      const tenantId = await this.tenantOfCall(callId);
      const s = await this.settings(tenantId);
      if (!s.enabled || !s.url || !s.events.includes(event)) return;
      let seq = this.seqs.get(callId);
      if (seq === undefined) seq = (await this.db.callEvent.aggregate({ where: { callId }, _max: { seq: true } }))._max.seq || 0;
      seq++;
      this.seqs.set(callId, seq);
      if (this.seqs.size > 5000) for (const k of [...this.seqs.keys()].slice(0, 1000)) this.seqs.delete(k);
      const eventId = randomUUID();
      await this.db.callEvent.create({ data: { eventId, callId, seq, event, occurredAt, payload: envelope({ event, eventId, callId, seq, occurredAt, data }) as any } });
      setImmediate(() => this.pump().catch(() => {}));
    }).catch(e => this.log.warn(`record ${event} ${callId}: ${e.message}`));
    return this.chain;
  }

  /** The end of a call: survey and voicemail events first, then «call.ended» with the whole summary. */
  async finished(callId: string) {
    const d = await this.endedData(callId).catch(() => null);
    if (!d) return;
    const at = new Date(d.endedAt || Date.now());
    if (d.survey) this.record('survey.completed', callId, { phone: d.phone, answers: d.survey.answers, score: d.survey.score, hasVoiceComment: !!d.survey.hasRec, operator: d.operator }, at);
    if (d.status === 'voicemail') this.record('voicemail.left', callId, { phone: d.phone, patientName: d.patientName, queue: d.queue, seconds: d.connectedSeconds, hasRecording: d.hasRecording }, at);
    return this.record('call.ended', callId, d, at);
  }

  /** Deliver what is due: the oldest waiting event of each call, a few calls at a time. */
  async pump() {
    if (this.busy.size >= PARALLEL) return;
    const due = await this.db.callEvent.findMany({ where: { state: 'pending' }, orderBy: { id: 'asc' }, take: 200, select: { id: true, callId: true, nextAt: true } });
    const firstOfCall = new Map<string, { id: number; nextAt: Date }>();
    for (const e of due) if (!firstOfCall.has(e.callId)) firstOfCall.set(e.callId, e);
    const now = Date.now();
    for (const [callId, e] of firstOfCall) {
      if (this.busy.size >= PARALLEL) break;
      if (this.busy.has(callId) || e.nextAt.getTime() > now) continue;
      const tenantId = await this.tenantOfCall(callId);
      const s = await this.settings(tenantId);
      if (!s.enabled || !s.url) continue;
      this.busy.add(callId);
      this.deliver(e.id).catch(err => this.log.warn('deliver: ' + err.message)).finally(() => { this.busy.delete(callId); setImmediate(() => this.pump().catch(() => {})); });
    }
  }

  private async deliver(id: number) {
    const ev = await this.db.callEvent.findUnique({ where: { id } });
    if (!ev || ev.state !== 'pending') return;
    const attempt = ev.attempts + 1;
    const r = await this.post(ev.payload as any, attempt, ev.id);
    if (r.ok) {
      await this.db.callEvent.update({ where: { id }, data: { state: 'sent', attempts: attempt, httpCode: r.code, error: null, sentAt: new Date() } });
    } else {
      const last = attempt > this.retryDelays.length;
      await this.db.callEvent.update({ where: { id }, data: { state: last ? 'failed' : 'pending', attempts: attempt, httpCode: r.code, error: r.error, nextAt: new Date(Date.now() + (last ? 0 : this.retryDelays[attempt - 1])) } });
    }
  }

  /** One HTTP attempt; logged in WebhookLog. */
  async post(body: any, attempt = 1, eventRef: number | null = null, tenantId?: string | null) {
    const tid = tenantId !== undefined ? tenantId : await this.tenantOfCall(body?.callId);
    const s = await this.settings(tid);
    if (!s.url) return { ok: false, code: null as number | null, ms: 0, error: 'آدرس مقصد تنظیم نشده است' };
    const json = JSON.stringify(body);
    const t0 = Date.now();
    let code: number | null = null, error: string | null = null, ok = false;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'NeuronCallCenter/2.0',
        'X-Event': body.event, 'X-Event-Id': body.eventId || '', 'X-Call-Id': body.callId || '',
      };
      if (s.token) headers[s.headerName] = s.token;
      if (s.secret) { const ts = String(Math.floor(Date.now() / 1000)); headers['X-Timestamp'] = ts; headers['X-Signature'] = signature(s.secret, ts, json); }
      const r = await fetch(s.url, { method: 'POST', headers, body: json, signal: AbortSignal.timeout(s.timeoutSec * 1000) });
      code = r.status;
      ok = r.ok;
      if (!ok) error = `پاسخ سرور مقصد: ${r.status}` + (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').replace(/^(.)/, ' — $1');
    } catch (e: any) {
      error = e?.name === 'TimeoutError' ? `بدون پاسخ بعد از ${s.timeoutSec} ثانیه` : `ارسال ناموفق: ${e?.cause?.code || e?.message || e}`;
    }
    const ms = Date.now() - t0;
    await this.db.webhookLog.create({ data: { callId: body.callId || 'test', event: body.event, attempt, ok, httpCode: code, error, ms, eventRef } }).catch(() => {});
    if (!ok) this.log.warn(`${body.event} ${body.callId || 'test'} attempt ${attempt}: ${error}`);
    return { ok, code, ms, error };
  }

  /** Send a stored event again (from the log), whatever its state. */
  async resend(id: number) {
    const ev = await this.db.callEvent.findUnique({ where: { id } });
    if (!ev) throw new NotFoundException('رویداد پیدا نشد');
    const r = await this.post(ev.payload as any, ev.attempts + 1, ev.id);
    await this.db.callEvent.update({ where: { id }, data: { attempts: ev.attempts + 1, httpCode: r.code, error: r.ok ? null : r.error, ...(r.ok ? { state: 'sent', sentAt: new Date() } : {}) } });
    return r;
  }

  /** A realistic example of each event (from the latest call when there is one). */
  async samples(tenantId?: string | null): Promise<Record<string, any>> {
    const latest = await this.db.call.findFirst({ where: { dir: 'in', ...(tenantId ? { tenantId } : {}) }, orderBy: { startedAt: 'desc' } });
    const ended = latest ? await this.endedData(latest.id) : null;
    const callId = latest?.id || 'C1730371234.552';
    const t0 = latest ? latest.startedAt.getTime() : Date.now() - 120e3;
    const phone = ended?.phone || '09121234567', name = ended?.patientName || 'علی رضایی';
    const op = ended?.operator || { extension: '101', name: 'خانم احمدی' };
    const queue = latest?.queue && latest.queue !== '—' ? latest.queue : 'پذیرش';
    const data: Record<string, any> = {
      'call.started': { direction: 'inbound', phone, callerNumber: phone, calledNumber: ended?.calledNumber || '02112345678', patientName: name, calls: { total: 7, today: 2, inboundTotal: 5, inboundToday: 2, lastCallAt: new Date(t0 - 3 * 3600e3).toISOString(), firstCall: false }, isCallback: false },
      'call.ivr': { menu: 'منوی اصلی', key: '2', label: 'نوبت جدید' },
      'booking.entered': { flow: 'book', flowLabel: 'ثبت نوبت', phone },
      'booking.step': { flow: 'book', flowLabel: 'ثبت نوبت', step: 'chooseTime', stepLabel: 'پیشنهاد زمان نوبت', key: '1', value: String(Math.floor(t0 / 1000) + 86400 * 3), elapsedMs: 21400,
        offeredAt: new Date(t0 + 86400e3 * 3).toISOString(), offeredDate: '1405/08/18', offeredTime: '10:30', accepted: true },
      'booking.booked': { phone, mobile: phone, code: '85504499', slotAt: new Date(t0 + 86400e3 * 3).toISOString(), date: '1405/08/18', time: '10:30', doctor: 'دکتر امیری', nationalCodeMasked: '******4661' },
      'booking.cancelled': { via: 'follow', phone, mobile: phone, code: '85504499', slotAt: new Date(t0 + 86400e3 * 3).toISOString(), date: '1405/08/18', time: '10:30' },
      'booking.ended': { flow: 'book', flowLabel: 'ثبت نوبت', result: 'booked', resultLabel: 'نوبت گرفت', phone, mobile: phone, code: '85504499', appointmentId: null, doctor: 'دکتر امیری',
        slotAt: new Date(t0 + 86400e3 * 3).toISOString(), date: '1405/08/18', time: '10:30', offeredTimes: 2, nationalCodeMasked: '******4661', surveyScore: 5, hasVoiceComment: false, error: null, durationSeconds: 96,
        steps: [
          { step: 'treated', stepLabel: 'سؤال «قبلاً توسط دکتر درمان شده‌اید؟»', key: '2', value: null, elapsedMs: 6100 },
          { step: 'apiTimes', stepLabel: 'دریافت زمان‌های خالی (سامانه نوبت‌دهی)', key: null, value: '14 times · doctor دکتر امیری', elapsedMs: 7300 },
          { step: 'chooseTime', stepLabel: 'پیشنهاد زمان نوبت', key: '2', value: '1794130200', elapsedMs: 15200, offeredAt: '2026-11-08T05:30:00.000Z', offeredDate: '1405/08/17', offeredTime: '09:00', accepted: false },
          { step: 'chooseTime', stepLabel: 'پیشنهاد زمان نوبت', key: '1', value: '1794216600', elapsedMs: 21400, offeredAt: '2026-11-09T07:00:00.000Z', offeredDate: '1405/08/18', offeredTime: '10:30', accepted: true },
          { step: 'codeMeli', stepLabel: 'ورود کد ملی', key: '******4661', value: null, elapsedMs: 38800 },
          { step: 'mobileConfirm', stepLabel: 'تأیید شماره موبایل', key: '1', value: null, elapsedMs: 52100 },
          { step: 'mobile', stepLabel: 'موبایل نهایی', key: null, value: phone, elapsedMs: 52150 },
          { step: 'apiStore', stepLabel: 'ثبت نوبت (سامانه نوبت‌دهی)', key: null, value: 'ok 85504499', elapsedMs: 54900 },
          { step: 'survey', stepLabel: 'نظرسنجی بعد از ثبت', key: '5', value: null, elapsedMs: 79000 },
        ] },
      'call.queued': { queue, phone },
      'call.ringing': { target: 'extension', extension: op.extension, operator: op.name, queue },
      'call.answered': { target: 'extension', extension: op.extension, operator: op.name, queue, waitSeconds: ended?.waitSeconds ?? 18 },
      'call.transferred': { kind: 'blind', from: { extension: op.extension, name: op.name }, to: { extension: '102', name: null } },
      'survey.started': { phone, operator: op },
      'survey.completed': { phone, answers: [5, 4, 5], score: 4.7, hasVoiceComment: false, operator: op },
      'voicemail.left': { phone, patientName: name, queue: 'صندوق صوتی', seconds: 24, hasRecording: true },
      'call.ended': ended || { direction: 'inbound', status: 'answered', statusLabel: 'پاسخ‌داده', phone, waitSeconds: 18, talkSeconds: 95 },
    };
    const out: Record<string, any> = {};
    EVENTS.forEach((e, i) => { out[e.key] = envelope({ event: e.key, eventId: randomUUID(), callId, seq: i + 1, occurredAt: new Date(t0 + i * 8000), data: data[e.key], test: true }); });
    return out;
  }

  async test(event: string, tenantId?: string | null) {
    if (!EVENT_KEYS.includes(event)) throw new BadRequestException('رویداد نامعتبر است');
    const sample = (await this.samples(tenantId))[event];
    return this.post({ ...sample, callId: 'test', eventId: randomUUID(), occurredAt: new Date().toISOString() }, 1, null, tenantId);
  }

  async logs(tenantId?: string | null) {
    const since = new Date(Date.now() - 24 * 3600e3);
    // WebhookLog has callId; for tenants filter via their calls when possible
    let callIds: string[] | null = null;
    if (tenantId) {
      const calls = await this.db.call.findMany({ where: { tenantId }, select: { id: true }, take: 5000, orderBy: { startedAt: 'desc' } });
      callIds = calls.map(c => c.id).concat(['test']);
    }
    const logWhere = callIds ? { callId: { in: callIds } } : {};
    const [rows, sent, failed, pending, dead] = await Promise.all([
      this.db.webhookLog.findMany({ where: logWhere, orderBy: { id: 'desc' }, take: 80 }),
      this.db.webhookLog.count({ where: { ...logWhere, at: { gte: since }, ok: true } }),
      this.db.webhookLog.count({ where: { ...logWhere, at: { gte: since }, ok: false } }),
      this.db.callEvent.count({ where: { state: 'pending', ...(callIds ? { callId: { in: callIds } } : {}) } }),
      this.db.callEvent.count({ where: { state: 'failed', createdAt: { gte: since }, ...(callIds ? { callId: { in: callIds } } : {}) } }),
    ]);
    return { rows, sent24: sent, failed24: failed, pending, dead24: dead };
  }

  private async cleanup() {
    const old = new Date(Date.now() - KEEP_DAYS * 86400e3);
    await this.db.callEvent.deleteMany({ where: { createdAt: { lt: old }, state: { not: 'pending' } } });
    await this.db.webhookLog.deleteMany({ where: { at: { lt: old } } });
  }
}

@Perm('vapi')
@Controller('webhook')
export class WebhookController {
  constructor(private hooks: WebhookService) {}

  @Get()
  async get(@CurrentUser() me: Me) {
    return { settings: this.hooks.publicView(await this.hooks.settings(me.tenantId)), events: EVENTS, ...(await this.hooks.logs(me.tenantId)), samples: await this.hooks.samples(me.tenantId) };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.hooks.save(b, me); }

  @Perm('vapi', 'edit')
  @Post('test')
  test(@Body() b: any, @CurrentUser() me: Me) { return this.hooks.test(String(b?.event || 'call.ended'), me.tenantId); }

  @Perm('vapi', 'edit')
  @Post('resend/:id')
  resend(@Param('id') id: string) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('شناسه نامعتبر است');
    return this.hooks.resend(+id);
  }
}
