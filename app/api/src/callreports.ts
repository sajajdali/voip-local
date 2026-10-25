// «گزارش تماس»: operators write what was discussed and done on a call; managers browse them as a list.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Me, Perm } from './auth';
import { Bus } from './bus';
import { fmtPhone } from './calls';
import { jalaliDate, hhmm, jalaliToDate } from './jalali';
import { can } from './perms';
import { PrismaService } from './prisma.service';

export const REPORT_CATS: Record<string, string> = {
  appt: 'نوبت و پذیرش', consult: 'مشاوره و سؤال', postop: 'پیگیری بعد از عمل', finance: 'پرداخت و مالی', complaint: 'شکایت و نارضایتی', other: 'سایر',
};
export const REPORT_OUTCOMES: Record<string, string> = { done: 'انجام شد', follow: 'نیاز به پیگیری', ref: 'ارجاع شد', noans: 'پاسخ نداد' };

const TEHRAN = 3.5 * 3600e3;
const view = (r: any) => ({
  id: r.id, callId: r.callId, phone: fmtPhone(r.phone), phoneRaw: r.phone, cat: r.cat, outcome: r.outcome, text: r.text, followUp: r.followUp || '',
  by: r.userName, userId: r.userId, date: jalaliDate(r.createdAt), time: hhmm(r.createdAt), edited: +r.updatedAt - +r.createdAt > 60e3,
});

@Controller('call-reports')
export class CallReportsController {
  constructor(private db: PrismaService, private bus: Bus) {}

  private clean(b: any) {
    const text = String(b?.text || '').trim().slice(0, 4000);
    if (!REPORT_CATS[b?.cat]) throw new BadRequestException('موضوع گزارش را انتخاب کنید');
    if (!REPORT_OUTCOMES[b?.outcome]) throw new BadRequestException('نتیجه تماس را انتخاب کنید');
    if (text.length < 3) throw new BadRequestException('متن گزارش را بنویسید');
    const followUp = b.followUp && /^\d{4}\/\d{2}\/\d{2}$/.test(b.followUp) ? b.followUp : null;
    return { cat: b.cat, outcome: b.outcome, text, followUp: b.outcome === 'follow' ? followUp : null };
  }

  /** Reports of one call, and earlier reports for the same number. */
  @Perm('calls')
  @Get('call/:id')
  async forCall(@Param('id') id: string) {
    const c = await this.db.call.findUnique({ where: { id }, select: { phone: true } });
    if (!c) throw new NotFoundException('تماس پیدا نشد');
    const [mine, other] = await Promise.all([
      this.db.callReport.findMany({ where: { callId: id }, orderBy: { createdAt: 'desc' } }),
      this.db.callReport.findMany({ where: { phone: c.phone, callId: { not: id } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    return { items: mine.map(view), history: other.map(view) };
  }

  /** The «گزارش‌های ثبت‌شده» page: a Jalali date range, joined with each call's details. */
  @Perm('calls')
  @Get()
  async list(@Query('from') from: string, @Query('to') to: string) {
    const ok = (s: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(s || '');
    const today = jalaliDate(new Date());
    const f = ok(from) ? from : today, t = ok(to) ? to : today;
    const rows = await this.db.callReport.findMany({
      where: { createdAt: { gte: new Date(jalaliToDate(f).getTime() - TEHRAN), lt: new Date(jalaliToDate(t).getTime() + 864e5 - TEHRAN) } },
      orderBy: { createdAt: 'desc' }, take: 5000,
    });
    // follow-ups due by today are shown whatever the range, so none is forgotten
    const due = await this.db.callReport.findMany({ where: { outcome: 'follow', followUp: { lte: today, not: null } }, orderBy: { followUp: 'asc' }, take: 200 });
    const ids = [...new Set([...rows, ...due].map(r => r.callId))];
    const [calls, pats] = await Promise.all([
      this.db.call.findMany({ where: { id: { in: ids } }, select: { id: true, date: true, time: true, dir: true, st: true, opExt: true, queue: true } }),
      this.db.patient.findMany({ where: { phone: { in: [...new Set([...rows, ...due].map(r => r.phone))] } }, select: { phone: true, name: true } }),
    ]);
    const C = new Map(calls.map(c => [c.id, c])), P = new Map(pats.map(p => [p.phone, p.name]));
    const full = (r: any) => ({ ...view(r), name: P.get(r.phone) || '', call: C.get(r.callId) || null });
    // a newer report on the same number closes an older «نیاز به پیگیری»
    const latest = new Map<string, number>();
    for (const r of await this.db.callReport.findMany({ where: { phone: { in: due.map(d => d.phone) } }, select: { phone: true, createdAt: true } }))
      latest.set(r.phone, Math.max(latest.get(r.phone) || 0, +r.createdAt));
    return {
      from: f, to: t, today, cats: REPORT_CATS, outcomes: REPORT_OUTCOMES,
      items: rows.map(full), due: due.filter(d => (latest.get(d.phone) || 0) <= +d.createdAt).map(full),
    };
  }

  @Perm('calls', 'edit')
  @Post()
  async add(@Body() b: any, @CurrentUser() me: Me) {
    const c = await this.db.call.findUnique({ where: { id: String(b?.callId || '') }, select: { id: true, phone: true } });
    if (!c) throw new NotFoundException('تماس پیدا نشد');
    const r = await this.db.callReport.create({ data: { ...this.clean(b), callId: c.id, phone: c.phone, userId: me.id, userName: me.name } });
    this.bus.emit('calls', { id: c.id });
    return view(r);
  }

  private async own(id: string, me: Me) {
    const r = await this.db.callReport.findUnique({ where: { id: +id || 0 } });
    if (!r) throw new NotFoundException('گزارش پیدا نشد');
    if (r.userId !== me.id && !can(me, 'calls', 'delete')) throw new ForbiddenException('فقط نویسنده گزارش یا مدیر می‌تواند آن را تغییر دهد');
    return r;
  }

  @Perm('calls', 'edit')
  @Put(':id')
  async edit(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    const r = await this.own(id, me);
    const x = await this.db.callReport.update({ where: { id: r.id }, data: this.clean(b) });
    this.bus.emit('calls', { id: r.callId });
    return view(x);
  }

  @Perm('calls', 'edit')
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: Me) {
    const r = await this.own(id, me);
    await this.db.callReport.delete({ where: { id: r.id } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'callreport.delete', target: r.callId, detail: { id: r.id } } });
    this.bus.emit('calls', { id: r.callId });
    return { ok: true };
  }
}
