// «ارجاع تماس»: a call is handed to an extension with a topic and a written reason. The extension's user sees it
// under «ارجاع‌شده‌ها», records progress, passes it on, returns it to the sender, or closes it («انجام شد»).
// Every step is kept as an event, so the manager sees the whole path and the report counts.
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Me, Perm } from './auth';
import { Bus } from './bus';
import { fmtPhone } from './calls';
import { ConfigStore } from './config';
import { jalaliDate, jalaliToDate, hhmm } from './jalali';
import { can } from './perms';
import { PrismaService } from './prisma.service';

export const REF_TOPICS: Record<string, string> = {
  appt: 'نوبت‌دهی / تغییر نوبت', postop: 'پیگیری بعد از عمل', medical: 'سؤال پزشکی', finance: 'امور مالی و پرداخت',
  complaint: 'شکایت / نارضایتی', doctor: 'درخواست تماس با پزشک', docs: 'مدارک و پرونده', urgent: 'موضوع فوری / اورژانسی', other: 'سایر',
};
const MIN_TEXT = 10;
const TEHRAN = 3.5 * 3600e3;

@Controller('referrals')
export class ReferralsController {
  constructor(private db: PrismaService, private bus: Bus, private store: ConfigStore) {}

  private text(v: any, what: string) {
    const t = String(v || '').trim();
    if (t.length < MIN_TEXT) throw new BadRequestException(what + ' را دقیق بنویسید (حداقل ' + MIN_TEXT.toLocaleString('fa-IR') + ' حرف)');
    return t.slice(0, 4000);
  }

  private async extName(ext: string) {
    const cfg = await this.store.all();
    const e = cfg.exts.find((x: any) => x.n === ext);
    if (!e) throw new BadRequestException('داخلی ' + ext + ' تعریف نشده است');
    const u = await this.db.user.findFirst({ where: { ext, active: true }, select: { name: true } });
    return u?.name || (e.name && !/^(داخلی\s*)?\d+$/.test(e.name.trim()) ? e.name : 'داخلی ' + ext);
  }

  private mine(r: { toExt: string }, me: Me) { return !!me.ext && r.toExt === me.ext; }
  private all(me: Me) { return can(me, 'referall'); }

  private announce(r: { id: number; toExt: string; phone: string }, text: string) {
    this.bus.emit('referrals', { id: r.id });
    this.bus.emit('notify', { ext: r.toExt, text });
  }

  /** Extensions to refer to, with the person behind each one. */
  @Perm('refer', 'add')
  @Get('targets')
  async targets(@CurrentUser() me: Me) {
    const cfg = await this.store.all();
    const users = await this.db.user.findMany({ where: { active: true, ext: { not: null } }, select: { name: true, ext: true, title: true } });
    return cfg.exts.map((e: any) => {
      const u = users.find(x => x.ext === e.n);
      return { ext: e.n, name: u?.name || (e.name && !/^(داخلی\s*)?\d+$/.test(e.name.trim()) ? e.name : ''), title: u?.title || '', me: e.n === me.ext };
    }).sort((a: any, b: any) => String(a.ext).localeCompare(String(b.ext), undefined, { numeric: true }));
  }

  @Perm('refer', 'add')
  @Post()
  async create(@Body() b: any, @CurrentUser() me: Me) {
    const call = await this.db.call.findUnique({ where: { id: String(b?.callId || '') }, select: { id: true, phone: true } });
    if (!call) throw new NotFoundException('تماس پیدا نشد');
    if (!REF_TOPICS[b.topic]) throw new BadRequestException('موضوع ارجاع را انتخاب کنید');
    const text = this.text(b.text, 'توضیح ارجاع');
    const ext = String(b.ext || '');
    const toName = await this.extName(ext);
    const open = await this.db.referral.findFirst({ where: { callId: call.id, status: 'open' } });
    if (open) throw new BadRequestException('این تماس یک ارجاع باز دارد (به داخلی ' + open.toExt + ')؛ از صفحه «ارجاع‌شده‌ها» آن را ادامه دهید');
    const r = await this.db.referral.create({ data: {
      callId: call.id, phone: call.phone, topic: b.topic, priority: b.priority === 'urgent' ? 'urgent' : 'normal', toExt: ext, toName,
      fromUserId: me.id, fromName: me.name, fromExt: me.ext || null,
      events: { create: { kind: 'create', text, topic: b.topic, toExt: ext, toName, userId: me.id, userName: me.name, userExt: me.ext || null } },
    } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'referral.create', target: call.id, detail: { id: r.id, toExt: ext, topic: b.topic } } });
    this.announce(r, (r.priority === 'urgent' ? '🔴 ارجاع فوری: ' : 'ارجاع جدید: ') + REF_TOPICS[r.topic] + ' — از ' + me.name);
    return { id: r.id };
  }

  /** One step on a referral: progress note, pass on, give back to the sender, close, or reopen. */
  @Perm('refer', 'edit')
  @Post(':id/act')
  async act(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    const r = await this.db.referral.findUnique({ where: { id: +id || 0 } });
    if (!r) throw new NotFoundException('ارجاع پیدا نشد');
    const action = String(b?.action || '');
    const isMine = this.mine(r, me), isSender = r.fromUserId === me.id, boss = this.all(me);
    const ev: any = { referralId: r.id, kind: action, userId: me.id, userName: me.name, userExt: me.ext || null };
    let data: any = {}, note = '';
    if (action === 'reopen') {
      if (r.status !== 'done') throw new BadRequestException('این ارجاع باز است');
      if (!isMine && !isSender && !boss) throw new ForbiddenException('فقط گیرنده، ارجاع‌دهنده یا مدیر می‌تواند ارجاع را دوباره باز کند');
      ev.text = this.text(b.text, 'دلیل باز کردن دوباره'); data = { status: 'open', doneAt: null, result: null };
      note = 'ارجاع دوباره باز شد';
    } else {
      if (r.status !== 'open') throw new BadRequestException('این ارجاع بسته شده است؛ برای ادامه، آن را دوباره باز کنید');
      if (!isMine && !boss) throw new ForbiddenException('این ارجاع به داخلی شما نیست');
      if (action === 'note') { ev.text = this.text(b.text, 'شرح اقدام'); data = {}; }
      else if (action === 'done') { ev.text = this.text(b.text, 'نتیجه'); data = { status: 'done', doneAt: new Date(), result: ev.text }; note = 'ارجاع شما انجام شد'; }
      else if (action === 'forward' || action === 'return') {
        const ext = action === 'return' ? r.fromExt || '' : String(b.ext || '');
        if (!ext) throw new BadRequestException(action === 'return' ? 'ارجاع‌دهنده داخلی ندارد؛ آن را به داخلی مشخصی ارجاع دهید' : 'داخلی مقصد را انتخاب کنید');
        if (ext === r.toExt) throw new BadRequestException('ارجاع همین الان در داخلی ' + ext + ' است');
        const toName = await this.extName(ext);
        const topic = b.topic && REF_TOPICS[b.topic] ? b.topic : r.topic;
        ev.text = this.text(b.text, action === 'return' ? 'دلیل برگرداندن' : 'توضیح ارجاع'); ev.toExt = ext; ev.toName = toName; ev.topic = topic;
        data = { toExt: ext, toName, topic, seenAt: null };
        note = (action === 'return' ? 'ارجاع به شما برگردانده شد: ' : 'ارجاع جدید: ') + REF_TOPICS[topic] + ' — از ' + me.name;
      } else throw new BadRequestException('عمل نامعتبر است');
    }
    await this.db.$transaction([this.db.referralEvent.create({ data: ev }), this.db.referral.update({ where: { id: r.id }, data: { ...data, updatedAt: new Date() } })]);
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'referral.' + action, target: r.callId, detail: { id: r.id, toExt: ev.toExt || r.toExt } } });
    const nr = { ...r, ...data };
    if (note) {
      if (action === 'done' || action === 'reopen') { this.bus.emit('referrals', { id: r.id }); this.bus.emit('notify', { userId: r.fromUserId, text: note + ' — ' + REF_TOPICS[r.topic] }); }
      else this.announce(nr, note);
    } else this.bus.emit('referrals', { id: r.id });
    return this.detail(String(r.id), me);
  }

  @Perm('refer')
  @Post(':id/seen')
  async seen(@Param('id') id: string, @CurrentUser() me: Me) {
    const r = await this.db.referral.findUnique({ where: { id: +id || 0 } });
    if (r && this.mine(r, me) && !r.seenAt) {
      await this.db.$transaction([this.db.referral.update({ where: { id: r.id }, data: { seenAt: new Date() } }), this.db.referralEvent.create({ data: { referralId: r.id, kind: 'seen', userId: me.id, userName: me.name, userExt: me.ext || null } })]);
      this.bus.emit('referrals', { id: r.id });
    }
    return { ok: true };
  }

  private view(r: any, me: Me, P: Map<string, string>, C: Map<string, any>) {
    const c = C.get(r.callId);
    return {
      id: r.id, callId: r.callId, phone: fmtPhone(r.phone), phoneRaw: r.phone, name: P.get(r.phone) || '', topic: r.topic, topicLabel: REF_TOPICS[r.topic] || r.topic,
      priority: r.priority, status: r.status, toExt: r.toExt, toName: r.toName, fromName: r.fromName, fromExt: r.fromExt, fromUserId: r.fromUserId,
      seen: !!r.seenAt, createdAt: r.createdAt, updatedAt: r.updatedAt, doneAt: r.doneAt, result: r.result || '',
      mine: this.mine(r, me), sentByMe: r.fromUserId === me.id,
      call: c ? { date: c.date, time: c.time, dir: c.dir, st: c.st, dur: c.dur, hasRec: !!c.recPath } : null,
    };
  }

  private async lookups(rows: any[]) {
    const [pats, calls] = await Promise.all([
      this.db.patient.findMany({ where: { phone: { in: [...new Set(rows.map(r => r.phone))] } }, select: { phone: true, name: true } }),
      this.db.call.findMany({ where: { id: { in: rows.map(r => r.callId) } }, select: { id: true, date: true, time: true, dir: true, st: true, dur: true, recPath: true } }),
    ]);
    return [new Map(pats.map(p => [p.phone, p.name])), new Map(calls.map(c => [c.id, c]))] as const;
  }

  /** box: mine (sent to my extension) · sent (by me) · all (managers) */
  @Perm('refer')
  @Get()
  async list(@Query('box') box: string, @Query('from') from: string, @Query('to') to: string, @CurrentUser() me: Me) {
    const ok = (s: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(s || '');
    const where: any = {};
    if (box === 'all' && this.all(me)) { /* every referral */ }
    else if (box === 'sent') where.fromUserId = me.id;
    else { where.OR = [{ toExt: me.ext || '__none__' }, { events: { some: { userId: me.id } } }]; }
    if (ok(from)) where.createdAt = { gte: new Date(jalaliToDate(from).getTime() - TEHRAN), ...(ok(to) ? { lt: new Date(jalaliToDate(to).getTime() + 864e5 - TEHRAN) } : {}) };
    const rows = await this.db.referral.findMany({ where, orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }], take: 1000, include: { events: { orderBy: { at: 'desc' }, take: 1 } } });
    const [P, C] = await this.lookups(rows);
    const myOpen = me.ext ? await this.db.referral.count({ where: { toExt: me.ext, status: 'open' } }) : 0;
    return {
      topics: REF_TOPICS, canAll: this.all(me), myExt: me.ext || '', myOpen,
      items: rows.map(r => ({ ...this.view(r, me, P, C), last: r.events[0] ? { kind: r.events[0].kind, text: r.events[0].text, by: r.events[0].userName, at: r.events[0].at } : null })),
    };
  }

  /** Open referrals for my extension (sidebar badge). */
  @Perm('refer')
  @Get('count')
  async count(@CurrentUser() me: Me) {
    if (!me.ext) return { open: 0, unseen: 0 };
    const [open, unseen] = await Promise.all([this.db.referral.count({ where: { toExt: me.ext, status: 'open' } }), this.db.referral.count({ where: { toExt: me.ext, status: 'open', seenAt: null } })]);
    return { open, unseen };
  }

  @Perm('refer')
  @Get(':id')
  async detail(@Param('id') id: string, @CurrentUser() me: Me) {
    const r = await this.db.referral.findUnique({ where: { id: +id || 0 }, include: { events: { orderBy: { at: 'asc' } } } });
    if (!r) throw new NotFoundException('ارجاع پیدا نشد');
    if (!this.mine(r, me) && r.fromUserId !== me.id && !this.all(me) && !r.events.some(e => e.userId === me.id)) throw new ForbiddenException('اجازه دیدن این ارجاع را ندارید');
    const [P, C] = await this.lookups([r]);
    return {
      ...this.view(r, me, P, C), topics: REF_TOPICS,
      canAct: r.status === 'open' && (this.mine(r, me) || this.all(me)), canReopen: r.status === 'done' && (this.mine(r, me) || r.fromUserId === me.id || this.all(me)),
      canReturn: r.status === 'open' && !!r.fromExt && r.fromExt !== r.toExt && (this.mine(r, me) || this.all(me)),
      events: r.events.map(e => ({ id: e.id, kind: e.kind, text: e.text, topic: e.topic ? REF_TOPICS[e.topic] || e.topic : '', toExt: e.toExt, toName: e.toName, by: e.userName, byExt: e.userExt, at: e.at })),
    };
  }

  /** Manager's report: counts, outcome, time to close, per person and topic. */
  @Perm('referall')
  @Get('stats/summary')
  async stats(@Query('from') from: string, @Query('to') to: string) {
    const ok = (s: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(s || '');
    const f = ok(from) ? from : jalaliDate(new Date(Date.now() - 29 * 864e5)), t = ok(to) ? to : jalaliDate(new Date());
    const rows = await this.db.referral.findMany({
      where: { createdAt: { gte: new Date(jalaliToDate(f).getTime() - TEHRAN), lt: new Date(jalaliToDate(t).getTime() + 864e5 - TEHRAN) } },
      include: { events: { select: { kind: true } } },
    });
    const done = rows.filter(r => r.status === 'done');
    const hours = done.map(r => (+r.doneAt! - +r.createdAt) / 36e5).sort((a, b) => a - b);
    const by = (key: (r: any) => string, label: (k: string, r: any) => string) => {
      const m = new Map<string, any>();
      for (const r of rows) { const k = key(r); const x = m.get(k) || { key: k, label: label(k, r), n: 0, open: 0, done: 0 }; x.n++; r.status === 'open' ? x.open++ : x.done++; m.set(k, x); }
      return [...m.values()].sort((a, b) => b.n - a.n);
    };
    return {
      from: f, to: t, total: rows.length, open: rows.length - done.length, done: done.length,
      urgent: rows.filter(r => r.priority === 'urgent').length, forwarded: rows.filter(r => r.events.some(e => e.kind === 'forward')).length,
      returned: rows.filter(r => r.events.some(e => e.kind === 'return')).length, unseen: rows.filter(r => r.status === 'open' && !r.seenAt).length,
      medianHours: hours.length ? hours[Math.floor(hours.length / 2)] : null,
      byAssignee: by(r => r.toExt, (k, r) => r.toName + ' · داخلی ' + k), byTopic: by(r => r.topic, k => REF_TOPICS[k] || k), bySender: by(r => r.fromUserId, (k, r) => r.fromName),
    };
  }
}

/** Referral state of each call, for the «ارجاع» column of the call list. */
export async function referralsByCall(db: PrismaService, callIds: string[]) {
  const rows = await db.referral.findMany({ where: { callId: { in: callIds } }, orderBy: { createdAt: 'desc' }, select: { callId: true, id: true, status: true, toExt: true, toName: true, topic: true } });
  const m = new Map<string, any>();
  for (const r of rows) if (!m.has(r.callId)) m.set(r.callId, { id: r.id, status: r.status, ext: r.toExt, name: r.toName, topic: REF_TOPICS[r.topic] || r.topic });
  return m;
}
