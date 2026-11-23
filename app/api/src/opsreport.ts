// «عملکرد داخلی‌ها»: per-extension report built from the AI's operator evaluation (ai.coach) of each answered call.
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Perm } from './auth';
import { jalaliDate, jalaliToDate } from './jalali';
import { PrismaService } from './prisma.service';

const CRIT = ['politeness', 'tone', 'clarity', 'listening', 'resolution'] as const;
const J = /^\d{4}\/\d{2}\/\d{2}$/;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

type Row = { id: string; date: string; time: string; phone: string; dir: string; dur: number; opExt: string | null; ai: any };

function summarize(rows: Row[]) {
  const ev = rows.filter(c => c.ai?.coach && Number.isFinite(+c.ai.coach.score));
  const scores = ev.map(c => +c.ai.coach.score);
  const crit: Record<string, number | null> = {};
  for (const k of CRIT) crit[k] = r1(avg(ev.flatMap(c => (c.ai.coach.criteria || []).filter((x: any) => x.key === k).map((x: any) => +x.score)).filter(Number.isFinite)));
  const band = { great: 0, good: 0, mid: 0, weak: 0 };
  for (const s of scores) band[s >= 8 ? 'great' : s >= 6.5 ? 'good' : s >= 5 ? 'mid' : 'weak']++;
  const senti = { pos: 0, neu: 0, neg: 0 };
  for (const c of ev) { const k = c.ai.sent; if (k in senti) senti[k as keyof typeof senti]++; }
  return { n: ev.length, score: r1(avg(scores)), crit, band, senti, ev };
}

@Controller('reports')
export class OpsReportController {
  constructor(private db: PrismaService) {}

  @Get('ai-ops')
  @Perm('coach')
  async aiOps(@Query('from') from: string, @Query('to') to: string, @Query('dir') dir = 'all') {
    if (!J.test(from || '') || !J.test(to || '') || from > to) throw new BadRequestException('بازه تاریخ نامعتبر است');
    // the same number of days just before, for the trend
    const days = Math.round((jalaliToDate(to).getTime() - jalaliToDate(from).getTime()) / 86400000) + 1;
    const pTo = jalaliDate(new Date(jalaliToDate(from).getTime() - 86400000));
    const pFrom = jalaliDate(new Date(jalaliToDate(from).getTime() - days * 86400000));
    const dirW = dir === 'in' || dir === 'out' ? { dir } : {};
    const sel = { id: true, date: true, time: true, phone: true, dir: true, dur: true, opExt: true, ai: true };
    const [rows, prev, handled, cfg, users] = await Promise.all([
      this.db.call.findMany({ where: { date: { gte: from, lte: to }, opExt: { not: null }, aiState: 'done', ...dirW }, select: sel, orderBy: { startedAt: 'asc' } }) as Promise<Row[]>,
      this.db.call.findMany({ where: { date: { gte: pFrom, lte: pTo }, opExt: { not: null }, aiState: 'done', ...dirW }, select: sel }) as Promise<Row[]>,
      this.db.call.groupBy({ by: ['opExt'], where: { date: { gte: from, lte: to }, opExt: { not: null }, st: { in: ['answered', 'transferred'] }, ...dirW }, _count: { _all: true }, _sum: { dur: true } }),
      this.db.configEntry.findUnique({ where: { key: 'exts' } }),
      this.db.user.findMany({ where: { ext: { not: null } }, select: { name: true, ext: true } }),
    ]);
    const extName = new Map<string, string>();
    for (const e of ((cfg?.data as any[]) || [])) if (e?.n) extName.set(String(e.n), e.name || '');
    for (const u of users) if (u.ext) extName.set(u.ext, u.name);
    const hand = new Map(handled.map(h => [h.opExt as string, { calls: h._count._all, talk: h._sum.dur || 0 }]));

    const byExt = new Map<string, Row[]>();
    for (const c of rows) { const k = c.opExt as string; if (!byExt.has(k)) byExt.set(k, []); byExt.get(k)!.push(c); }
    const prevBy = new Map<string, Row[]>();
    for (const c of prev) { const k = c.opExt as string; if (!prevBy.has(k)) prevBy.set(k, []); prevBy.get(k)!.push(c); }

    const exts = [...byExt.entries()].map(([ext, list]) => {
      const s = summarize(list);
      if (!s.n) return null;
      const p = summarize(prevBy.get(ext) || []);
      const daily = new Map<string, number[]>();
      for (const c of s.ev) { if (!daily.has(c.date)) daily.set(c.date, []); daily.get(c.date)!.push(+c.ai.coach.score); }
      const cats = new Map<string, number>();
      for (const c of s.ev) if (c.ai.cat) cats.set(c.ai.cat, (cats.get(c.ai.cat) || 0) + 1);
      const brief = (c: Row) => ({ id: c.id, date: c.date, time: c.time, phone: c.phone, dir: c.dir, dur: c.dur, score: +c.ai.coach.score, verdict: c.ai.coach.verdict || '' });
      const sorted = [...s.ev].sort((a, b) => +a.ai.coach.score - +b.ai.coach.score);
      const recent = [...s.ev].reverse();
      const h = hand.get(ext) || { calls: 0, talk: 0 };
      return {
        ext, name: extName.get(ext) || '', n: s.n, score: s.score, prevScore: p.score, prevN: p.n, crit: s.crit, band: s.band, senti: s.senti,
        handled: h.calls, talk: h.talk, coverage: h.calls ? Math.round((s.n / h.calls) * 100) : null,
        daily: [...daily.entries()].map(([date, xs]) => ({ date, score: r1(avg(xs)), n: xs.length })),
        cats: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([cat, n]) => ({ cat, n })),
        worst: sorted.slice(0, 5).map(brief),
        best: sorted.slice(-3).reverse().map(brief),
        issues: recent.flatMap(c => (c.ai.coach.improvements || []).map((x: any) => ({ issue: x.issue || '', quote: x.quote || '', suggestion: x.suggestion || '', callId: c.id, date: c.date, score: +c.ai.coach.score }))).slice(0, 6),
        strengths: [...new Set(recent.flatMap(c => (c.ai.coach.strengths || []) as string[]))].slice(0, 6),
      };
    }).filter(Boolean) as any[];
    exts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.n - a.n);

    const team = summarize(rows);
    const prevTeam = summarize(prev);
    return { from, to, prevFrom: pFrom, prevTo: pTo, team: { n: team.n, score: team.score, prevScore: prevTeam.score, crit: team.crit, band: team.band, senti: team.senti }, exts };
  }
}
