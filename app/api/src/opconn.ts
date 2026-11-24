// «ارتباط با اپراتورها»: preferred-agent + queue connect analytics, with per-operator
// dossier breakdown (new number / no appointment / prior appointment·VIP) from Kamilo CRM cache.
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, Me, Perm } from './auth';
import { jalaliDate, jalaliToDate } from './jalali';
import { PrismaService } from './prisma.service';
import { apptCard, isApptCrm } from './patients';

const J = /^\d{4}\/\d{2}\/\d{2}$/;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

type Ev = { callId: string; event: string; seq: number; occurredAt: Date; payload: any };
type CallRow = {
  id: string; phone: string; date: string; time: string; st: string; opExt: string | null;
  queue: string; wait: number; dur: number; startedAt: Date; tenantId: string | null; did: string | null;
};

/** Classify a cached CRM dossier for answered-call analytics. */
export function dossierClass(crm: any): 'priorVip' | 'noAppt' | 'unknown' {
  if (!crm || typeof crm !== 'object') return 'unknown';
  if (crm.found === false) return 'noAppt';
  if (isApptCrm(crm)) {
    const card = apptCard(crm);
    const tot = Number(crm.appointments_total ?? card?.total ?? 0) || 0;
    const appts = Array.isArray(card?.appointments) ? card!.appointments.length
      : Array.isArray(crm.appointments) ? crm.appointments.length : 0;
    if (tot > 0 || appts > 0) return 'priorVip';
    return 'noAppt';
  }
  // Dastgheib-style: services history counts as prior
  if (crm.found === true && Array.isArray(crm.services) && crm.services.length > 0) return 'priorVip';
  if (crm.found === true) return 'noAppt';
  return 'unknown';
}

function dataOf(ev: Ev): any {
  const p = ev.payload;
  if (p && typeof p === 'object' && p.data && typeof p.data === 'object') return p.data;
  return p && typeof p === 'object' ? p : {};
}

function isPreferredRing(ev: Ev) {
  if (ev.event !== 'call.ringing') return false;
  const d = dataOf(ev);
  return d.target === 'preferred' || d.preferred === true;
}

@Controller('reports')
export class OpConnController {
  constructor(private db: PrismaService) {}

  private async tenantScope(me: Me) {
    if (!me.tenantId) return null;
    const dids = (await this.db.didAssignment.findMany({ where: { tenantId: me.tenantId }, select: { did: true } })).map(d => d.did);
    return { tenantId: me.tenantId, dids };
  }

  @Get('opconn')
  @Perm('reports')
  async opconn(
    @CurrentUser() me: Me,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('op') op = 'all',
  ) {
    if (!J.test(from || '') || !J.test(to || '') || from > to) throw new BadRequestException('بازه تاریخ نامعتبر است');
    const scope = await this.tenantScope(me);
    const where: any = { date: { gte: from, lte: to }, dir: 'in' };
    if (scope) {
      where.OR = [{ tenantId: scope.tenantId }, ...(scope.dids.length ? [{ did: { in: scope.dids } }] : [])];
    }
    const calls = await this.db.call.findMany({
      where,
      select: {
        id: true, phone: true, date: true, time: true, st: true, opExt: true,
        queue: true, wait: true, dur: true, startedAt: true, tenantId: true, did: true,
      },
      orderBy: { startedAt: 'asc' },
    }) as CallRow[];

    const ids = calls.map(c => c.id);
    const events = ids.length
      ? await this.db.callEvent.findMany({
          where: { callId: { in: ids }, event: { in: ['call.queued', 'call.ringing', 'call.answered', 'preferred.missed'] } },
          orderBy: [{ callId: 'asc' }, { seq: 'asc' }],
        }) as Ev[]
      : [];

    const byCall = new Map<string, Ev[]>();
    for (const e of events) {
      if (!byCall.has(e.callId)) byCall.set(e.callId, []);
      byCall.get(e.callId)!.push(e);
    }

    const phones = [...new Set(calls.map(c => c.phone).filter(p => /^09\d{9}$/.test(p)))];
    const patients = phones.length
      ? await this.db.patient.findMany({ where: { phone: { in: phones } }, select: { phone: true, crm: true } })
      : [];
    const crmByPhone = new Map(patients.map(p => [p.phone, p.crm]));

    // Prior calls (any time before each call) → "new number" = no earlier inbound/outbound for that phone
    const priorCounts = phones.length
      ? await this.db.call.groupBy({
          by: ['phone'],
          where: { phone: { in: phones }, startedAt: { lt: jalaliToDate(from) } },
          _count: { _all: true },
        })
      : [];
    const priorBeforeRange = new Map(priorCounts.map(r => [r.phone, r._count._all]));
    // Also count calls earlier in-range when iterating chronologically
    const seenInRange = new Map<string, number>();

    const users = await this.db.user.findMany({
      where: {
        ext: { not: null },
        ...(me.tenantId ? { tenantId: me.tenantId } : {}),
      },
      select: { name: true, ext: true, apiId: true },
    });
    const extName = new Map<string, string>();
    for (const u of users) if (u.ext) extName.set(u.ext, u.name);

    type OpAgg = {
      ext: string; name: string;
      prefAttempts: number; prefAnswered: number; prefMissed: number;
      queueConnect: number; queueAbandon: number;
      answered: number; newNumbers: number; noAppt: number; priorVip: number; unknownDossier: number;
      talkSec: number;
    };
    const ops = new Map<string, OpAgg>();
    const ensure = (ext: string) => {
      if (!ops.has(ext)) ops.set(ext, {
        ext, name: extName.get(ext) || `داخلی ${ext}`,
        prefAttempts: 0, prefAnswered: 0, prefMissed: 0,
        queueConnect: 0, queueAbandon: 0,
        answered: 0, newNumbers: 0, noAppt: 0, priorVip: 0, unknownDossier: 0, talkSec: 0,
      });
      return ops.get(ext)!;
    };

    let prefAttempts = 0, prefAnswered = 0, prefMissed = 0;
    let queueConnect = 0, queueAbandon = 0;
    let answeredTotal = 0, newNumbers = 0, noAppt = 0, priorVip = 0, unknownDossier = 0;

    const opFilter = op && op !== 'all' ? String(op).replace(/\D/g, '') : '';

    for (const c of calls) {
      const evs = byCall.get(c.id) || [];
      const prefRings = evs.filter(isPreferredRing);
      const prefMissEv = evs.filter(e => e.event === 'preferred.missed');
      const answeredEv = evs.find(e => e.event === 'call.answered');
      const queued = evs.some(e => e.event === 'call.queued') || /صف|پذیرش|IVR/i.test(c.queue || '');

      const prefExt = prefRings.length
        ? String(dataOf(prefRings[0]).extension || '').replace(/\D/g, '')
        : (prefMissEv[0] ? String(dataOf(prefMissEv[0]).extension || '').replace(/\D/g, '') : '');

      let thisPrefAttempt = prefRings.length > 0 || prefMissEv.length > 0;
      let thisPrefAnswered = false;
      let thisPrefMissed = false;
      if (thisPrefAttempt) {
        if (prefMissEv.length > 0) {
          // Explicit miss marker → any later answer is queue, not preferred.
          thisPrefMissed = true;
        } else {
          const ansExt = answeredEv
            ? String(dataOf(answeredEv).extension || c.opExt || '').replace(/\D/g, '')
            : String(c.opExt || '').replace(/\D/g, '');
          const answeredOk = (c.st === 'answered' || c.st === 'transferred') && !!prefExt && ansExt === prefExt;
          if (answeredOk) thisPrefAnswered = true;
          else thisPrefMissed = true;
        }
      }

      const spokeExt = c.opExt || (answeredEv ? String(dataOf(answeredEv).extension || '').replace(/\D/g, '') : '') || null;
      const isAns = c.st === 'answered' || c.st === 'transferred';
      const isAbandon = queued && (c.st === 'missed' || c.st === 'voicemail');
      const isConnect = queued && isAns && !!spokeExt;

      if (opFilter) {
        const touches = (prefExt === opFilter) || (spokeExt === opFilter)
          || prefRings.some(e => String(dataOf(e).extension || '') === opFilter)
          || prefMissEv.some(e => String(dataOf(e).extension || '') === opFilter);
        if (!touches) continue;
      }

      if (thisPrefAttempt) {
        prefAttempts++;
        if (prefExt) ensure(prefExt).prefAttempts++;
      }
      if (thisPrefAnswered) {
        prefAnswered++;
        if (prefExt) ensure(prefExt).prefAnswered++;
      }
      if (thisPrefMissed) {
        prefMissed++;
        if (prefExt) ensure(prefExt).prefMissed++;
      }
      if (isConnect && spokeExt) {
        queueConnect++;
        ensure(spokeExt).queueConnect++;
      }
      if (isAbandon) {
        queueAbandon++;
        // Attribute abandon to preferred ext if they were attempted, else leave unscoped (team only)
        if (prefExt) ensure(prefExt).queueAbandon++;
      }

      if (isAns && spokeExt) {
        answeredTotal++;
        const row = ensure(spokeExt);
        row.answered++;
        row.talkSec += c.dur || 0;

        const earlier = (priorBeforeRange.get(c.phone) || 0) + (seenInRange.get(c.phone) || 0);
        const isNew = earlier === 0;
        if (isNew) { newNumbers++; row.newNumbers++; }

        const klass = dossierClass(crmByPhone.get(c.phone));
        if (klass === 'priorVip') { priorVip++; row.priorVip++; }
        else if (klass === 'noAppt') { noAppt++; row.noAppt++; }
        else { unknownDossier++; row.unknownDossier++; }
      }

      seenInRange.set(c.phone, (seenInRange.get(c.phone) || 0) + 1);
    }

    const operators = [...ops.values()]
      .filter(o => !opFilter || o.ext === opFilter)
      .sort((a, b) => b.answered - a.answered || b.prefAttempts - a.prefAttempts || a.ext.localeCompare(b.ext))
      .map(o => ({
        ...o,
        prefAnswerRate: pct(o.prefAnswered, o.prefAttempts),
        queueAnswerRate: pct(o.queueConnect, o.queueConnect + o.queueAbandon),
        newPct: pct(o.newNumbers, o.answered),
        noApptPct: pct(o.noAppt, o.answered),
        priorVipPct: pct(o.priorVip, o.answered),
      }));

    const dossierAnswered = newNumbers + noAppt + priorVip + unknownDossier;
    // Chart slices use exclusive-ish buckets for display: priorVip, noAppt (excl unknown), new overlay is separate bar
    return {
      from, to,
      summary: {
        prefAttempts, prefAnswered, prefMissed,
        prefAnswerRate: pct(prefAnswered, prefAttempts),
        queueConnect, queueAbandon,
        queueAnswerRate: pct(queueConnect, queueConnect + queueAbandon),
        answeredTotal, newNumbers, noAppt, priorVip, unknownDossier,
        newPct: pct(newNumbers, answeredTotal),
        noApptPct: pct(noAppt, answeredTotal),
        priorVipPct: pct(priorVip, answeredTotal),
      },
      charts: {
        preferred: [
          { key: 'answered', label: 'پاسخ زنگ ترجیحی', n: prefAnswered, pct: pct(prefAnswered, prefAttempts) },
          { key: 'missed', label: 'بی‌پاسخ زنگ ترجیحی', n: prefMissed, pct: pct(prefMissed, prefAttempts) },
        ],
        queue: [
          { key: 'connect', label: 'وصل به اپراتور از صف', n: queueConnect, pct: pct(queueConnect, queueConnect + queueAbandon) },
          { key: 'abandon', label: 'رها کردن صف', n: queueAbandon, pct: pct(queueAbandon, queueConnect + queueAbandon) },
        ],
        dossier: [
          { key: 'new', label: 'شمارهٔ جدید', n: newNumbers, pct: pct(newNumbers, answeredTotal) },
          { key: 'noAppt', label: 'بدون نوبت', n: noAppt, pct: pct(noAppt, answeredTotal) },
          { key: 'priorVip', label: 'نوبت قبلی / ویژه', n: priorVip, pct: pct(priorVip, answeredTotal) },
          ...(unknownDossier ? [{ key: 'unknown', label: 'پرونده نامشخص', n: unknownDossier, pct: pct(unknownDossier, answeredTotal) }] : []),
        ],
        dossierBase: dossierAnswered,
      },
      operators,
      ops: [...extName.entries()].map(([ext, name]) => ({ ext, name })).sort((a, b) => a.ext.localeCompare(b.ext)),
      generatedAt: new Date().toISOString(),
      today: jalaliDate(new Date()),
    };
  }
}
