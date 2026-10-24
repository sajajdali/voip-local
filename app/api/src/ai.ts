// AI analysis of voicemails / recorded calls: speech-to-text, then classification of the Persian transcript.
// Settings («تنظیمات ← هوش مصنوعی») live in ConfigEntry('ai').
//   speech-to-text: OpenAI-compatible /audio/transcriptions, a custom HTTP endpoint, or off
//   analysis:       Claude (Anthropic SDK, structured JSON output), an OpenAI-compatible chat API, or built-in keywords
import Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post, Put } from '@nestjs/common';
import * as fs from 'fs';
import { CurrentUser, Me, Roles } from './auth';
import { Bus } from './bus';
import { PrismaService } from './prisma.service';

export const CATEGORIES = [
  { id: 'postop', name: 'پیگیری بعد از جراحی', hint: 'درد، ورم، کبودی، بخیه، چسب یا آتل بینی، پانسمان، سؤال درباره دوره نقاهت بعد از عمل' },
  { id: 'book', name: 'درخواست نوبت', hint: 'گرفتن نوبت ویزیت، مشاوره یا جراحی' },
  { id: 'cost', name: 'سؤال درباره هزینه', hint: 'قیمت، تعرفه، اقساط، بیمه، نحوه پرداخت' },
  { id: 'consult', name: 'مشاوره قبل از عمل', hint: 'سؤال پزشکی یا شرایط قبل از جراحی، انحراف تیغه، مشکل تنفسی، امکان‌سنجی عمل' },
  { id: 'complaint', name: 'شکایت / نارضایتی', hint: 'ناراضی بودن از خدمات، جواب ندادن تلفن، رفتار پرسنل، نتیجه عمل' },
  { id: 'cancel', name: 'تغییر یا لغو نوبت', hint: 'جابه‌جایی، لغو یا تأخیر نوبت' },
];

export interface AiSettings {
  enabled: boolean;
  sttProvider: 'openai' | 'custom' | 'none'; sttUrl: string; sttKey: string; sttModel: string; sttLanguage: string;
  llmProvider: 'claude' | 'openai' | 'keywords'; llmUrl: string; llmKey: string; llmModel: string;
  analyzeVoicemail: boolean; analyzeCalls: boolean; minSeconds: number;
}
const DEFAULTS: AiSettings = {
  enabled: false,
  sttProvider: 'openai', sttUrl: 'https://api.openai.com/v1', sttKey: '', sttModel: 'gpt-transcribe', sttLanguage: 'fa',
  llmProvider: 'openai', llmUrl: 'https://api.openai.com/v1', llmKey: '', llmModel: 'gpt-6-astra',
  analyzeVoicemail: true, analyzeCalls: false, minSeconds: 3,
};
// Claude models that support the server-side refusal fallback
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

const SYSTEM = `شما تحلیل‌گر تماس‌های مرکز تماس کلینیک جراحی زیبایی بینی دکتر پوریا افلاکی هستید.
متن پیاده‌شده یک پیام صوتی یا مکالمه تلفنی فارسی به شما داده می‌شود (ممکن است غلط تایپی یا محاوره‌ای باشد).
خروجی را فقط به شکل JSON طبق اسکیمای داده‌شده برگردانید و همه متن‌ها فارسی باشند.

دسته‌ها (فقط یکی از این شناسه‌ها):
${CATEGORIES.map(c => `- ${c.id}: ${c.name} — ${c.hint}`).join('\n')}

اولویت (urgency): high اگر نشانه خطر بعد از عمل (خونریزی، تب، درد شدید، تنگی نفس)، شکایت جدی یا درخواست تماس فوری باشد؛ mid برای پیگیری بعد از عمل و تغییر نوبت؛ در غیر این صورت low.
احساس (sentiment): pos / neu / neg.
summary: ۱ تا ۴ جمله کوتاه از نکات اصلی. keywords: حداکثر ۵ کلیدواژه. action: یک اقدام پیشنهادی کوتاه برای اپراتور.`;

const SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES.map(c => c.id) },
    summary: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    urgency: { type: 'string', enum: ['high', 'mid', 'low'] },
    sentiment: { type: 'string', enum: ['pos', 'neu', 'neg'] },
    action: { type: 'string' },
  },
  required: ['category', 'summary', 'keywords', 'urgency', 'sentiment', 'action'],
  additionalProperties: false,
};

// ---- built-in keyword analysis (no external service)
const RULES: { cat: string; kw: string[] }[] = [
  { cat: 'postop', kw: ['جراحی', 'عمل', 'بخیه', 'چسب', 'ورم', 'درد', 'کبودی', 'پانسمان', 'آتل'] },
  { cat: 'book', kw: ['نوبت', 'وقت', 'ویزیت', 'رزرو'] },
  { cat: 'cost', kw: ['هزینه', 'قیمت', 'اقساط', 'پرداخت', 'تعرفه', 'بیمه'] },
  { cat: 'consult', kw: ['مشاوره', 'انحراف', 'تنفس', 'سوال', 'سؤال'] },
  { cat: 'complaint', kw: ['شکایت', 'نارضایتی', 'جواب ندادید', 'کسی جواب', 'ناراضی'] },
  { cat: 'cancel', kw: ['لغو', 'کنسل', 'جابه‌جا', 'جابجا', 'تغییر نوبت', 'نمی‌تونم بیام'] },
];
export function keywordAnalysis(t: string) {
  const scored = RULES.map(r => ({ cat: r.cat, kw: r.kw.filter(k => t.includes(k)) })).sort((a, b) => b.kw.length - a.kw.length);
  const top = scored[0].kw.length ? scored[0] : { cat: 'consult', kw: [] as string[] };
  const neg = ['درد', 'شکایت', 'ناراضی', 'عصبانی', 'فوری', 'خونریزی', 'تب'].filter(k => t.includes(k)).length;
  const pos = ['ممنون', 'عالی', 'راضی', 'سپاس'].filter(k => t.includes(k)).length;
  const urgent = ['فوری', 'خونریزی', 'تب', 'اورژانس', 'درد شدید', 'هرچه زودتر'].some(k => t.includes(k));
  const summary = t.split(/[.!؟?\n]+/).map(s => s.trim()).filter(s => s.length > 8).slice(0, 3);
  return {
    category: top.cat, summary: summary.length ? summary : [t.slice(0, 120)], keywords: top.kw.slice(0, 5),
    urgency: urgent || top.cat === 'complaint' ? 'high' : top.cat === 'postop' || top.cat === 'cancel' ? 'mid' : 'low',
    sentiment: top.cat === 'complaint' || neg > pos + 1 ? 'neg' : pos > neg ? 'pos' : 'neu', action: '',
  };
}

@Injectable()
export class AiService {
  private log = new Logger('AI');
  private cache: AiSettings | null = null;
  private q: string[] = [];
  private busy = false;
  constructor(private db: PrismaService, private bus: Bus) {}

  async settings(): Promise<AiSettings> {
    if (!this.cache) {
      const r = await this.db.configEntry.findUnique({ where: { key: 'ai' } });
      this.cache = { ...DEFAULTS, ...((r?.data as any) || {}) };
    }
    return this.cache!;
  }

  publicView(s: AiSettings) {
    const hint = (k: string) => (k ? '••••' + k.slice(-4) : '');
    const { sttKey, llmKey, ...rest } = s;
    return { ...rest, hasSttKey: !!sttKey, sttKeyHint: hint(sttKey), hasLlmKey: !!llmKey, llmKeyHint: hint(llmKey) };
  }

  async save(b: any, me: Me) {
    const cur = await this.settings();
    const url = (v: any, d: string) => { const u = String(v ?? d).trim().replace(/\/+$/, ''); if (u && !/^https?:\/\/\S+$/i.test(u)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود'); return u; };
    const next: AiSettings = {
      enabled: !!(b.enabled ?? cur.enabled),
      sttProvider: ['openai', 'custom', 'none'].includes(b.sttProvider) ? b.sttProvider : cur.sttProvider,
      sttUrl: url(b.sttUrl, cur.sttUrl), sttModel: String(b.sttModel ?? cur.sttModel).trim() || 'whisper-1', sttLanguage: String(b.sttLanguage ?? cur.sttLanguage).trim() || 'fa',
      sttKey: typeof b.sttKey === 'string' && b.sttKey.trim() ? b.sttKey.trim() : cur.sttKey,
      llmProvider: ['claude', 'openai', 'keywords'].includes(b.llmProvider) ? b.llmProvider : cur.llmProvider,
      llmUrl: url(b.llmUrl, cur.llmUrl), llmModel: String(b.llmModel ?? cur.llmModel).trim(),
      llmKey: typeof b.llmKey === 'string' && b.llmKey.trim() ? b.llmKey.trim() : cur.llmKey,
      analyzeVoicemail: !!(b.analyzeVoicemail ?? cur.analyzeVoicemail), analyzeCalls: !!(b.analyzeCalls ?? cur.analyzeCalls),
      minSeconds: Math.min(120, Math.max(0, +(b.minSeconds ?? cur.minSeconds) || 0)),
    };
    if (b.clearSttKey) next.sttKey = '';
    if (b.clearLlmKey) next.llmKey = '';
    if (next.llmProvider !== 'keywords' && !next.llmModel) throw new BadRequestException('نام مدل تحلیل را وارد کنید');
    if (next.llmProvider === 'openai' && !next.llmUrl) throw new BadRequestException('آدرس سرویس تحلیل را وارد کنید');
    if (next.sttProvider !== 'none' && !next.sttUrl) throw new BadRequestException('آدرس سرویس تبدیل گفتار را وارد کنید');
    await this.db.configEntry.upsert({ where: { key: 'ai' }, create: { key: 'ai', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    this.cache = next;
    const { sttKey, llmKey, ...safe } = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'ai.save', target: 'ai', detail: { ...safe, sttKeyChanged: !!b.sttKey, llmKeyChanged: !!b.llmKey } as any } });
    return this.publicView(next);
  }

  // ---------------- speech-to-text
  async transcribe(file: string, s: AiSettings): Promise<{ text: string; conf: number | null }> {
    if (s.sttProvider === 'none') throw new Error('سرویس تبدیل گفتار به متن خاموش است');
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'audio.wav');
    const headers: Record<string, string> = {};
    let url = s.sttUrl;
    if (s.sttProvider === 'openai') {
      url = s.sttUrl + '/audio/transcriptions';
      fd.append('model', s.sttModel);
      fd.append('language', s.sttLanguage);
      // whisper-1 gives segment log-probs in verbose_json; the newer transcribe models only answer json
      if (/^whisper/.test(s.sttModel)) fd.append('response_format', 'verbose_json');
      else {
        fd.append('response_format', 'json');
        if (/^gpt-4o(-mini)?-transcribe(?!-diarize)/.test(s.sttModel)) fd.append('include[]', 'logprobs');
      }
      if (s.sttKey) headers.Authorization = 'Bearer ' + s.sttKey;
    } else {
      fd.append('language', s.sttLanguage);
      if (s.sttKey) headers.Authorization = s.sttKey.includes(' ') ? s.sttKey : 'Bearer ' + s.sttKey;
    }
    const r = await fetch(url, { method: 'POST', headers, body: fd, signal: AbortSignal.timeout(300e3) });
    if (!r.ok) throw new Error(`سرویس تبدیل گفتار: خطای ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const d: any = await r.json();
    const text = String(d.text || '').trim();
    // confidence: explicit value, or the mean segment log-probability returned by Whisper-style APIs
    let conf: number | null = typeof d.confidence === 'number' ? Math.round(d.confidence <= 1 ? d.confidence * 100 : d.confidence) : null;
    if (conf === null && Array.isArray(d.segments) && d.segments.length) {
      const lp = d.segments.map((x: any) => x.avg_logprob).filter((x: any) => typeof x === 'number');
      if (lp.length) conf = Math.round(Math.exp(lp.reduce((a: number, b: number) => a + b, 0) / lp.length) * 100);
    }
    if (conf === null && Array.isArray(d.logprobs) && d.logprobs.length) {
      const lp = d.logprobs.map((x: any) => x.logprob).filter((x: any) => typeof x === 'number');
      if (lp.length) conf = Math.round(Math.exp(lp.reduce((a: number, b: number) => a + b, 0) / lp.length) * 100);
    }
    return { text, conf };
  }

  // ---------------- analysis
  async analyzeText(text: string, s: AiSettings) {
    if (s.llmProvider === 'keywords' || !text.trim()) return keywordAnalysis(text);
    if (s.llmProvider === 'claude') {
      if (!s.llmKey && !s.llmUrl) throw new Error('کلید API برای Claude وارد نشده است');
      const client = new Anthropic({ apiKey: s.llmKey || undefined, baseURL: s.llmUrl || undefined, maxRetries: 2, timeout: 120e3 });
      const useFallback = FALLBACK_MODELS.includes(s.llmModel);
      const res = await client.beta.messages.create({
        model: s.llmModel,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{ role: 'user', content: 'متن تماس:\n' + text }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (res.stop_reason === 'refusal') throw new Error('مدل از تحلیل این متن خودداری کرد');
      const block = res.content.find(b => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('پاسخ مدل خالی بود');
      return JSON.parse(block.text);
    }
    // OpenAI-compatible chat completions
    if (!s.llmUrl) throw new Error('آدرس API سرویس تحلیل وارد نشده است');
    if (!s.llmKey && /api\.openai\.com/.test(s.llmUrl)) throw new Error('کلید API برای OpenAI وارد نشده است');
    const reasoning = /^(gpt-5|gpt-6|o\d)/.test(s.llmModel);
    const r = await fetch(s.llmUrl + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(120e3),
      headers: { 'Content-Type': 'application/json', ...(s.llmKey ? { Authorization: 'Bearer ' + s.llmKey } : {}) },
      body: JSON.stringify({
        model: s.llmModel,
        messages: [{ role: 'system', content: SYSTEM + '\nاسکیمای JSON:\n' + JSON.stringify(SCHEMA) }, { role: 'user', content: 'متن تماس:\n' + text }],
        response_format: { type: 'json_object' },
        ...(reasoning ? { reasoning_effort: 'low' } : {}),
      }),
    });
    if (!r.ok) throw new Error(`سرویس تحلیل: خطای ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const d: any = await r.json();
    return JSON.parse(String(d.choices?.[0]?.message?.content || '{}'));
  }

  /** Normalise any provider's answer into the shape the panel uses. */
  private toAi(a: any, text: string, conf: number | null) {
    const cat = CATEGORIES.some(c => c.id === a.category) ? a.category : 'consult';
    return {
      cat, tx: text, conf: conf ?? '—',
      sum: (Array.isArray(a.summary) ? a.summary : [String(a.summary || '')]).map(String).filter(Boolean).slice(0, 4),
      kw: (Array.isArray(a.keywords) ? a.keywords : []).map(String).slice(0, 5),
      urg: ['high', 'mid', 'low'].includes(a.urgency) ? a.urgency : 'low',
      sent: ['pos', 'neu', 'neg'].includes(a.sentiment) ? a.sentiment : 'neu',
      action: String(a.action || ''),
    };
  }

  // ---------------- queue
  async eligible(c: { st: string; recPath: string | null; dur: number }, s: AiSettings) {
    if (!s.enabled || !c.recPath || c.recPath === 'demo') return false;
    if (c.st === 'voicemail') return s.analyzeVoicemail && c.dur >= s.minSeconds;
    return s.analyzeCalls && (c.st === 'answered' || c.st === 'transferred') && c.dur >= s.minSeconds;
  }

  enqueue(id: string) {
    (async () => {
      const [s, c] = await Promise.all([this.settings(), this.db.call.findUnique({ where: { id } })]);
      if (!c || !(await this.eligible(c, s))) return;
      await this.db.call.update({ where: { id }, data: { aiState: 'queued' } });
      if (!this.q.includes(id)) this.q.push(id);
      this.next();
    })().catch(e => this.log.warn(e.message));
  }

  private async next() {
    if (this.busy || !this.q.length) return;
    this.busy = true;
    const id = this.q.shift()!;
    try { await this.process(id); }
    catch (e: any) {
      this.log.warn(`${id}: ${e.message}`);
      await this.db.call.update({ where: { id }, data: { aiState: 'failed', aiError: String(e.message).slice(0, 300) } }).catch(() => {});
    }
    this.busy = false;
    this.next();
  }

  private async process(id: string) {
    const s = await this.settings();
    const c = await this.db.call.findUnique({ where: { id } });
    if (!c || !c.recPath || !fs.existsSync(c.recPath)) throw new Error('فایل صوتی پیدا نشد');
    const { text, conf } = await this.transcribe(c.recPath, s);
    const ai = this.toAi(await this.analyzeText(text, s), text, conf);
    await this.db.call.update({ where: { id }, data: { ai: ai as any, aiState: 'done', aiError: null } });
    this.bus.emit('calls', { id });
    if (ai.urg === 'high') this.bus.emit('notify', { role: '*', text: 'پیام فوری: ' + (ai.sum[0] || 'یک تماس با اولویت فوری تحلیل شد') });
  }

  async status() {
    const rows = await this.db.call.groupBy({ by: ['aiState'], _count: { _all: true }, where: { recPath: { not: null } } });
    const by = Object.fromEntries(rows.map(r => [r.aiState, r._count._all]));
    const lastFail = await this.db.call.findFirst({ where: { aiState: 'failed' }, orderBy: { startedAt: 'desc' }, select: { aiError: true } });
    return { done: by.done || 0, queued: (by.queued || 0), failed: by.failed || 0, waiting: by.none || 0, inQueue: this.q.length + (this.busy ? 1 : 0), lastError: lastFail?.aiError || '' };
  }

  /** Queue everything eligible that is not analysed yet (or failed) from the last N days. */
  async requeue(days: number, includeFailed: boolean) {
    const s = await this.settings();
    if (!s.enabled) throw new BadRequestException('ابتدا تحلیل خودکار را فعال و ذخیره کنید');
    const since = new Date(Date.now() - days * 86400e3);
    const list = await this.db.call.findMany({ where: { startedAt: { gte: since }, recPath: { not: null }, aiState: { in: includeFailed ? ['none', 'queued', 'failed'] : ['none', 'queued'] } }, orderBy: { startedAt: 'desc' }, take: 500 });
    let n = 0;
    for (const c of list) if (await this.eligible(c, s)) { this.enqueue(c.id); n++; }
    return { queued: n };
  }

  /** Settings test: analyse a sample sentence, and optionally transcribe the latest eligible recording. */
  async test(text: string, withStt: boolean) {
    const s = await this.settings();
    const out: any = {};
    const t0 = Date.now();
    try {
      out.analysis = this.toAi(await this.analyzeText(text, s), text, null);
      out.analysisMs = Date.now() - t0;
    } catch (e: any) { out.analysisError = e instanceof Anthropic.AuthenticationError ? 'کلید API معتبر نیست' : e.message; }
    if (withStt) {
      const c = await this.db.call.findFirst({ where: { recPath: { not: null }, NOT: { recPath: 'demo' } }, orderBy: [{ st: 'desc' }, { startedAt: 'desc' }] });
      if (!c?.recPath) out.sttError = 'هنوز فایل ضبطی برای تست وجود ندارد';
      else {
        const t1 = Date.now();
        try { const r = await this.transcribe(c.recPath, s); out.stt = { callId: c.id, text: r.text, conf: r.conf, ms: Date.now() - t1 }; }
        catch (e: any) { out.sttError = e.message; }
      }
    }
    return out;
  }
}

@Roles('admin')
@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}

  @Get()
  async get() { return { settings: this.ai.publicView(await this.ai.settings()), status: await this.ai.status(), categories: CATEGORIES.map(({ id, name }) => ({ id, name })) }; }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.ai.save(b, me); }

  @Post('test')
  test(@Body() b: { text?: string; stt?: boolean }) {
    return this.ai.test(String(b.text || 'سلام وقت بخیر، هفته پیش عمل بینی کردم و از دیشب ورم و درد دارم، لطفاً هرچه زودتر با من تماس بگیرید.').slice(0, 2000), !!b.stt);
  }

  @Post('requeue')
  requeue(@Body() b: { days?: number; failed?: boolean }) { return this.ai.requeue(Math.min(90, Math.max(1, +(b.days ?? 7) || 7)), !!b.failed); }
}
