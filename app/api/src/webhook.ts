// "تنظیمات API": every finished call is POSTed as JSON to an external address.
// Settings live in ConfigEntry('webhook'); every delivery attempt is logged in WebhookLog.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, Me, Roles } from './auth';
import { env } from './env';
import { PrismaService } from './prisma.service';

export interface WebhookSettings { enabled: boolean; url: string; headerName: string; token: string; timeoutSec: number }
const DEFAULTS: WebhookSettings = { enabled: false, url: '', headerName: 'Authorization', token: '', timeoutSec: 10 };
const RETRY_DELAYS = [10e3, 60e3, 300e3]; // after the first failure: 10 s, 1 min, 5 min
const ST_FA: Record<string, string> = { answered: 'پاسخ‌داده', missed: 'بی‌پاسخ', voicemail: 'پیام صوتی', transferred: 'انتقال‌یافته' };

@Injectable()
export class WebhookService {
  private log = new Logger('Webhook');
  private cache: WebhookSettings | null = null;

  constructor(private db: PrismaService) {}

  async settings(): Promise<WebhookSettings> {
    if (!this.cache) {
      const row = await this.db.configEntry.findUnique({ where: { key: 'webhook' } });
      this.cache = { ...DEFAULTS, ...((row?.data as any) || {}) };
    }
    return this.cache!;
  }

  async save(b: Partial<WebhookSettings>, me: Me) {
    const cur = await this.settings();
    const url = String(b.url ?? cur.url).trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new BadRequestException('آدرس باید با http:// یا https:// شروع شود');
    if (b.enabled && !url) throw new BadRequestException('برای فعال کردن، آدرس مقصد را وارد کنید');
    const headerName = String(b.headerName ?? cur.headerName).trim() || 'Authorization';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw new BadRequestException('نام هدر فقط می‌تواند حروف انگلیسی، عدد و خط تیره باشد');
    const next: WebhookSettings = {
      enabled: !!(b.enabled ?? cur.enabled), url, headerName,
      token: typeof b.token === 'string' && b.token.length ? b.token.trim() : cur.token, // empty = keep the saved token
      timeoutSec: Math.min(60, Math.max(2, +(b.timeoutSec ?? cur.timeoutSec) || 10)),
    };
    if ((b as any).clearToken) next.token = '';
    await this.db.configEntry.upsert({ where: { key: 'webhook' }, create: { key: 'webhook', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    this.cache = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'webhook.save', target: 'webhook', detail: { enabled: next.enabled, url: next.url, headerName: next.headerName, tokenChanged: !!b.token } } });
    return this.publicView(next);
  }

  publicView(s: WebhookSettings) {
    return { enabled: s.enabled, url: s.url, headerName: s.headerName, hasToken: !!s.token, tokenHint: s.token ? '••••' + s.token.slice(-4) : '', timeoutSec: s.timeoutSec };
  }

  /** The JSON sent for one call (same rules as the panel: < SHORT_CALL_SEC of talk = missed). */
  async payload(callId: string) {
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
      event: 'call.ended',
      callId: c.id,
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
      survey: c.survey || null,
      summary: c.summary || null,
    };
  }

  /** Called after every finished call; never throws. */
  enqueue(callId: string) {
    this.settings().then(s => { if (s.enabled && s.url) this.attempt(callId, 1); }).catch(() => {});
  }

  private async attempt(callId: string, n: number) {
    const r = await this.send(callId, n);
    if (!r.ok && n <= RETRY_DELAYS.length) setTimeout(() => this.attempt(callId, n + 1), RETRY_DELAYS[n - 1]);
  }

  async send(callId: string | null, attempt = 1, body?: any) {
    const s = await this.settings();
    const data = body || (callId ? await this.payload(callId) : null);
    if (!s.url) return { ok: false, error: 'آدرس مقصد تنظیم نشده است' };
    if (!data) return { ok: false, error: 'تماس پیدا نشد' };
    const t0 = Date.now();
    let code: number | null = null, error: string | null = null, ok = false;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'AflakiCallCenter/1.0', 'X-Event': data.event };
      if (s.token) headers[s.headerName] = s.token;
      const r = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.timeout(s.timeoutSec * 1000) });
      code = r.status;
      ok = r.ok;
      if (!ok) error = `پاسخ سرور مقصد: ${r.status}` + (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').replace(/^(.)/, ' — $1');
    } catch (e: any) {
      error = e?.name === 'TimeoutError' ? `بدون پاسخ بعد از ${s.timeoutSec} ثانیه` : `ارسال ناموفق: ${e?.cause?.code || e?.message || e}`;
    }
    const ms = Date.now() - t0;
    await this.db.webhookLog.create({ data: { callId: data.callId || 'test', event: data.event, attempt, ok, httpCode: code, error, ms } }).catch(() => {});
    if (!ok) this.log.warn(`${data.callId || 'test'} attempt ${attempt}: ${error}`);
    return { ok, code, ms, error };
  }

  async logs() {
    const rows = await this.db.webhookLog.findMany({ orderBy: { id: 'desc' }, take: 50 });
    const since = new Date(Date.now() - 24 * 3600e3);
    const [sent, failed] = await Promise.all([
      this.db.webhookLog.count({ where: { at: { gte: since }, ok: true } }),
      this.db.webhookLog.count({ where: { at: { gte: since }, ok: false } }),
    ]);
    return { rows, sent24: sent, failed24: failed };
  }
}

@Roles('admin')
@Controller('webhook')
export class WebhookController {
  constructor(private hooks: WebhookService, private db: PrismaService) {}

  @Get()
  async get() {
    const latest = await this.db.call.findFirst({ orderBy: { startedAt: 'desc' } });
    return { settings: this.hooks.publicView(await this.hooks.settings()), ...(await this.hooks.logs()), sample: latest ? await this.hooks.payload(latest.id) : null };
  }

  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.hooks.save(b, me); }

  @Post('test')
  async test() {
    const latest = await this.db.call.findFirst({ orderBy: { startedAt: 'desc' } });
    const sample = latest ? await this.hooks.payload(latest.id) : null;
    return this.hooks.send(null, 1, { ...(sample || {}), event: 'test', callId: 'test', test: true });
  }

  @Post('resend/:callId')
  async resend(@Param('callId') callId: string) {
    if (!(await this.db.call.findUnique({ where: { id: callId } }))) throw new NotFoundException('تماس پیدا نشد');
    return this.hooks.send(callId, 1);
  }
}
