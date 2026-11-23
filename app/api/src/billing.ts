// «شارژ دلاری»: this panel's account on the central top-up server (billing/). When connected, every AI request
// goes through that server, which checks the dollar balance, uses its own OpenAI key and deducts the cost.
// Settings live in ConfigEntry('billing'); the key is never sent back to the browser.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, Me, Perm } from './auth';
import { PrismaService } from './prisma.service';

export interface BillingSettings { enabled: boolean; url: string; key: string }
const DEFAULTS: BillingSettings = { enabled: false, url: '', key: '' };

/** Where AI requests go while billing is on: an OpenAI-compatible base URL and the customer key. */
export interface BillingRoute { base: string; key: string }

@Injectable()
export class BillingService {
  private log = new Logger('Billing');
  private cache: BillingSettings | null = null;

  constructor(private db: PrismaService) {}

  async settings(): Promise<BillingSettings> {
    if (!this.cache) {
      const row = await this.db.configEntry.findUnique({ where: { key: 'billing' } });
      this.cache = { ...DEFAULTS, ...((row?.data as any) || {}) };
    }
    return this.cache!;
  }

  /** The proxy route for AI requests, or null when this panel uses its own AI keys. */
  async route(): Promise<BillingRoute | null> {
    const s = await this.settings();
    return s.enabled && s.url && s.key ? { base: s.url + '/api/v1/openai', key: s.key } : null;
  }

  publicView(s: BillingSettings) {
    return { enabled: s.enabled, url: s.url, hasKey: !!s.key, keyHint: s.key ? s.key.slice(0, 8) + '…' + s.key.slice(-4) : '' };
  }

  async save(b: Partial<BillingSettings>, me: Me) {
    const cur = await this.settings();
    const url = String(b.url ?? cur.url).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) throw new BadRequestException('آدرس سرور شارژ باید با http:// یا https:// شروع شود');
    const key = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : cur.key; // empty = keep the saved key
    if (key && !/^nrn_[A-Za-z0-9]{20,}$/.test(key)) throw new BadRequestException('کلید اتصال باید با nrn_ شروع شود');
    const next: BillingSettings = { enabled: !!(b.enabled ?? cur.enabled), url, key };
    let account: any = null;
    if (next.enabled) {
      if (!url || !key) throw new BadRequestException('برای فعال کردن، آدرس سرور شارژ و کلید اتصال را وارد کنید');
      account = await this.request(next, 'GET', '/api/v1/account'); // refuse to switch AI over to a server that does not answer
    }
    await this.db.configEntry.upsert({ where: { key: 'billing' }, create: { key: 'billing', data: next as any, updatedBy: me.id }, update: { data: next as any, updatedBy: me.id } });
    this.cache = next;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'billing.save', target: 'billing', detail: { enabled: next.enabled, url: next.url, keyChanged: key !== cur.key } } });
    return { settings: this.publicView(next), account };
  }

  /** One call to the top-up server; its Persian error message is passed on as is. */
  async request(s: BillingSettings, method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
    let r: Response;
    try {
      r = await fetch(s.url + path, {
        method, signal: AbortSignal.timeout(15e3),
        headers: { Authorization: 'Bearer ' + s.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      this.log.warn(`${method} ${path}: ${e.message}`);
      throw new BadRequestException('ارتباط با سرور شارژ برقرار نشد؛ آدرس و اینترنت سرور را بررسی کنید');
    }
    const d: any = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = d?.error?.message || d?.message || (d?.errors && Object.values(d.errors).flat()[0]) || `خطای ${r.status} از سرور شارژ`;
      throw new BadRequestException(String(msg));
    }
    return d;
  }

  async overview() {
    const s = await this.settings();
    const configured = !!(s.url && s.key);
    if (!configured) return { settings: this.publicView(s), configured, account: null, statement: null, error: '' };
    try {
      const [account, statement] = await Promise.all([this.request(s, 'GET', '/api/v1/account'), this.request(s, 'GET', '/api/v1/statement?days=30')]);
      return { settings: this.publicView(s), configured, account, statement, error: '' };
    } catch (e: any) {
      return { settings: this.publicView(s), configured, account: null, statement: null, error: e.message };
    }
  }

  async topup(usd: number, returnUrl: string) {
    const s = await this.settings();
    if (!s.url || !s.key) throw new BadRequestException('اتصال به سرور شارژ تنظیم نشده است');
    if (!(usd > 0)) throw new BadRequestException('مبلغ شارژ را وارد کنید');
    const ret = /^https?:\/\/\S+$/i.test(returnUrl || '') ? returnUrl : undefined;
    return this.request(s, 'POST', '/api/v1/topups', { usd: Math.round(usd * 100) / 100, return_url: ret });
  }

  async invoice(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('شناسه فاکتور نامعتبر است');
    return this.request(await this.settings(), 'GET', '/api/v1/topups/' + id);
  }
}

@Perm('billing')
@Controller('billing')
export class BillingController {
  constructor(private billing: BillingService) {}

  @Get()
  overview() { return this.billing.overview(); }

  @Perm('billing', 'edit')
  @Put()
  save(@Body() b: any, @CurrentUser() me: Me) { return this.billing.save(b, me); }

  @Perm('billing', 'add')
  @Post('topup')
  topup(@Body() b: any) { return this.billing.topup(+b?.usd, String(b?.returnUrl || '')); }

  @Get('topup/:id')
  invoice(@Param('id') id: string) { return this.billing.invoice(id); }
}
