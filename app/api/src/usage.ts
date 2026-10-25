// «مصرف توکن»: every request to an AI service is recorded with its tokens / audio length; the cost is
// computed at report time from an editable price list, so correcting a price fixes the whole history.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Put, Query } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { CurrentUser, Me, Roles, Perm } from './auth';
import { jalaliDate, jalaliToDate } from './jalali';
import { PrismaService } from './prisma.service';

/** Which part of the system the current AI work belongs to (set around each job). */
export const usageCtx = new AsyncLocalStorage<{ feature: string; callId?: string }>();

export const FEATURES: Record<string, string> = {
  call: 'تحلیل مکالمه اپراتور', voicemail: 'پیام صوتی', agent_voice: 'دستیار هوشمند · مکالمه زنده',
  agent_summary: 'دستیار هوشمند · خلاصه گفتگو', survey: 'نظرسنجی · پیام صوتی', test: 'تست تنظیمات', other: 'سایر',
};
export const KINDS: Record<string, string> = { stt: 'تبدیل گفتار به متن', llm: 'تحلیل متن', realtime: 'مکالمه صوتی زنده' };

/** USD per 1M tokens (in, cachedIn, out, audioIn, audioOut) or per minute of audio (perMin). Editable on the page. */
export interface Price { in?: number; cached?: number; out?: number; audioIn?: number; audioOut?: number; perMin?: number }
export const DEFAULT_PRICES: Record<string, Price> = {
  'gpt-6-luna': { in: 0.2, cached: 0.02, out: 1.2 },
  'gpt-5-nano': { in: 0.05, cached: 0.005, out: 0.4 },
  'gpt-5-mini': { in: 0.25, cached: 0.025, out: 2 },
  'gpt-6.1-sol': { in: 2, cached: 0.2, out: 10 },
  'gpt-6-sol': { in: 2, cached: 0.2, out: 10 },
  'gpt-6-astra': { in: 10, cached: 1, out: 50 },
  'gpt-transcribe': { perMin: 0.0045 },
  'gpt-4o-mini-transcribe': { perMin: 0.003 },
  'gpt-4o-transcribe': { perMin: 0.006 },
  'whisper-1': { perMin: 0.006 },
  'gpt-realtime-2.1-mini': { in: 0.6, cached: 0.06, out: 2.4, audioIn: 10, audioOut: 20 },
  'gpt-realtime-2.1': { in: 4, cached: 0.4, out: 16, audioIn: 32, audioOut: 64 },
};

export function costOf(r: { model: string; inTok: number; cached: number; outTok: number; audioIn: number; audioOut: number; seconds: number }, prices: Record<string, Price>) {
  const p = prices[r.model];
  if (!p) return 0;
  if (p.perMin && r.seconds) return (r.seconds / 60) * p.perMin;
  const M = 1e6;
  return ((r.inTok - r.cached) * (p.in || 0) + r.cached * (p.cached ?? p.in ?? 0) + r.outTok * (p.out || 0) + r.audioIn * (p.audioIn || 0) + r.audioOut * (p.audioOut || 0)) / M;
}

/** Length of a PCM WAV file in seconds (Asterisk recordings), from its header. */
export function wavSeconds(buf: Buffer) {
  try {
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return buf.length / 16000;
    const byteRate = buf.readUInt32LE(28);
    return byteRate ? Math.max(0, buf.length - 44) / byteRate : 0;
  } catch { return 0; }
}

@Injectable()
export class UsageService {
  private log = new Logger('Usage');
  constructor(private db: PrismaService) {}

  /** Record one request; never throws (usage logging must not break the AI work). */
  record(u: { kind: string; model: string; inTok?: number; cached?: number; outTok?: number; audioIn?: number; audioOut?: number; seconds?: number; feature?: string; callId?: string | null; at?: Date }) {
    const ctx = usageCtx.getStore();
    const int = (v: any) => Math.max(0, Math.round(+v || 0));
    this.db.aiUsage.create({ data: {
      feature: u.feature || ctx?.feature || 'other', callId: u.callId ?? ctx?.callId ?? null, kind: u.kind, model: String(u.model || '?').slice(0, 60),
      inTok: int(u.inTok), cached: int(u.cached), outTok: int(u.outTok), audioIn: int(u.audioIn), audioOut: int(u.audioOut), seconds: Math.max(0, +(u.seconds || 0)),
      ...(u.at ? { at: u.at } : {}),
    } }).catch(e => this.log.warn('usage not recorded: ' + e.message));
  }

  async prices(): Promise<Record<string, Price>> {
    const r = await this.db.configEntry.findUnique({ where: { key: 'aiPrices' } });
    return { ...DEFAULT_PRICES, ...((r?.data as any) || {}) };
  }

  async savePrices(b: Record<string, Price>, me: Me) {
    if (!b || typeof b !== 'object') throw new BadRequestException('قیمت‌ها نامعتبر است');
    const clean: Record<string, Price> = {};
    for (const [m, p] of Object.entries(b)) {
      if (!/^[\w.\-]{2,60}$/.test(m) || !p || typeof p !== 'object') continue;
      const x: Price = {};
      for (const k of ['in', 'cached', 'out', 'audioIn', 'audioOut', 'perMin'] as const) if (p[k] !== undefined && p[k] !== null && (p[k] as any) !== '' && isFinite(+p[k]!)) x[k] = Math.max(0, +p[k]!);
      clean[m] = x;
    }
    await this.db.configEntry.upsert({ where: { key: 'aiPrices' }, create: { key: 'aiPrices', data: clean as any, updatedBy: me.id }, update: { data: clean as any, updatedBy: me.id } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'usage.prices', target: 'aiPrices', detail: clean as any } });
    return this.prices();
  }

  /** Everything the page shows for a Jalali date range (Tehran days). */
  async report(from: string, to: string) {
    const tehran = 3.5 * 3600e3;
    const start = new Date(jalaliToDate(from).getTime() - tehran), end = new Date(jalaliToDate(to).getTime() + 864e5 - tehran);
    const [rows, prices] = await Promise.all([this.db.aiUsage.findMany({ where: { at: { gte: start, lt: end } }, orderBy: { at: 'asc' } }), this.prices()]);
    const zero = () => ({ requests: 0, inTok: 0, cached: 0, outTok: 0, audioIn: 0, audioOut: 0, seconds: 0, cost: 0 });
    const add = (a: any, r: any, c: number) => { a.requests += r.requests; a.inTok += r.inTok; a.cached += r.cached; a.outTok += r.outTok; a.audioIn += r.audioIn; a.audioOut += r.audioOut; a.seconds += r.seconds; a.cost += c; };
    const total = zero(), byDay: Record<string, any> = {}, byFeature: Record<string, any> = {}, byModel: Record<string, any> = {}, byKind: Record<string, any> = {};
    const calls: Record<string, Set<string>> = {};
    const unpriced = new Set<string>();
    for (const r of rows) {
      const c = costOf(r, prices);
      if (!prices[r.model]) unpriced.add(r.model);
      const d = jalaliDate(r.at);
      add(total, r, c);
      const day = byDay[d] = byDay[d] || { ...zero(), date: d, features: {} as Record<string, number> };
      add(day, r, c); day.features[r.feature] = (day.features[r.feature] || 0) + c;
      add(byFeature[r.feature] = byFeature[r.feature] || { ...zero(), key: r.feature, label: FEATURES[r.feature] || r.feature }, r, c);
      add(byModel[r.model] = byModel[r.model] || { ...zero(), model: r.model, kind: r.kind }, r, c);
      add(byKind[r.kind] = byKind[r.kind] || { ...zero(), key: r.kind, label: KINDS[r.kind] || r.kind }, r, c);
      if (r.callId) (calls[r.feature] = calls[r.feature] || new Set()).add(r.callId);
    }
    for (const f of Object.values(byFeature)) f.calls = calls[f.key] ? calls[f.key].size : 0;
    return {
      from, to, total, prices, unpriced: [...unpriced], features: FEATURES,
      byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
      byFeature: Object.values(byFeature).sort((a, b) => b.cost - a.cost),
      byModel: Object.values(byModel).sort((a, b) => b.cost - a.cost),
      byKind: Object.values(byKind).sort((a, b) => b.cost - a.cost),
      today: jalaliDate(new Date()),
    };
  }
}

@Perm('usage')
@Controller('usage')
export class UsageController {
  constructor(private usage: UsageService) {}

  @Get()
  report(@Query('from') from: string, @Query('to') to: string) {
    const ok = (s: string) => /^\d{4}\/\d{2}\/\d{2}$/.test(s || '');
    const today = jalaliDate(new Date());
    return this.usage.report(ok(from) ? from : today, ok(to) ? to : today);
  }

  @Put('prices')
  savePrices(@Body() b: Record<string, Price>, @CurrentUser() me: Me) { return this.usage.savePrices(b, me); }
}
