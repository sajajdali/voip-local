// VoIP configuration store: one JSON document per collection; every save regenerates Asterisk config.
import { BadRequestException, Body, Controller, Get, Injectable, Param, Put } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CurrentUser, Me, Roles } from './auth';
import { AsteriskService } from './asterisk/asterisk.service';
import { VoipConfig } from './asterisk/generator';
import { Bus } from './bus';
import { PrismaService } from './prisma.service';

export const ARRAY_KEYS = ['exts', 'trunks', 'vqs', 'ivrs', 'snds', 'routes', 'oroutes', 'tgroups', 'tconds', 'holidays', 'rgroups', 'blist'] as const;
export const OBJECT_KEYS = ['fmes', 'bset', 'survey'] as const;

/** Post-call survey: off until prompts are recorded. One 1..5 rating; a low score may leave a voice comment. */
export const DEFAULT_SURVEY = {
  on: false, minTalk: 10, timeout: 6, retry: 1, intro: '', thanks: '', invalid: '',
  qs: [{ label: 'رضایت از مکالمه', snd: '' }],
  comment: { on: true, max: 2, snd: '', maxSec: 60 },
};
export const KEYS = [...ARRAY_KEYS, ...OBJECT_KEYS] as string[];
const LIVE: Record<string, string[]> = { exts: ['st'], vqs: ['waiting', 'sla'], trunks: ['reg', 'used'] };
const ID: Record<string, string> = { exts: 'n', blist: 'num', holidays: 'date' };

export const secret = () => randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);

@Injectable()
export class ConfigStore {
  private cache: Record<string, any> | null = null;
  constructor(private db: PrismaService, private ast: AsteriskService, private bus: Bus) {}

  async all(): Promise<VoipConfig> {
    if (!this.cache) {
      const rows = await this.db.configEntry.findMany();
      const c: Record<string, any> = {};
      for (const k of KEYS) c[k] = ARRAY_KEYS.includes(k as any) ? [] : k === 'bset' ? { anon: false, action: 'hang', sound: '' } : k === 'survey' ? DEFAULT_SURVEY : {};
      for (const r of rows) c[r.key] = r.data;
      this.cache = c;
    }
    return this.cache as VoipConfig;
  }

  async applyAll() { return this.ast.apply(await this.all()); }

  /** Forget cached settings (after a restore wrote them straight to the database). */
  reset() { this.cache = null; }

  /** Server-owned fields survive client saves (SIP secrets, blacklist counters, uploaded file metadata). */
  private merge(key: string, data: any, old: any) {
    if (!Array.isArray(data)) return data;
    const idk = ID[key] || 'id';
    const prev = new Map<string, any>((old || []).map((x: any) => [String(x[idk]), x]));
    return data.map((x: any) => {
      const o = prev.get(String(x[idk])) || {};
      const y = { ...x };
      (LIVE[key] || []).forEach(f => delete y[f]);
      if (key === 'exts') {
        y.n = String(y.n).replace(/\D/g, '');
        // an explicit password change from the panel; otherwise the stored secret is kept
        const ns = typeof y.newSecret === 'string' ? y.newSecret.trim() : '';
        delete y.newSecret;
        if (ns && (ns.length < 4 || ns.length > 64 || /[\s;"\\]/.test(ns))) throw new BadRequestException('رمز SIP نامعتبر است (حداقل ۴ کاراکتر، بدون فاصله)');
        y.secret = ns || o.secret || y.secret || secret();
      }
      if (key === 'blist') { y.num = String(y.num).replace(/\D/g, ''); y.hits = o.hits ?? y.hits ?? 0; y.today = o.today ?? y.today ?? 0; y.last = o.last ?? y.last ?? '—'; y.lastDay = o.lastDay; }
      if (key === 'snds') { if (o.file) y.file = o.file; if (o.dur) y.dur = o.dur; }
      return y;
    });
  }

  async save(key: string, data: any, me: Me | null, reapply = true) {
    if (!KEYS.includes(key)) throw new BadRequestException('کلید نامعتبر');
    const isArr = ARRAY_KEYS.includes(key as any);
    if (isArr !== Array.isArray(data) || data === null || typeof data !== 'object') throw new BadRequestException('ساختار داده نامعتبر است');
    const cfg = await this.all();
    const old = (cfg as any)[key];
    const merged = this.merge(key, data, old);
    if (key === 'exts') {
      const seen = new Set<string>();
      for (const e of merged) { if (!e.n || seen.has(e.n)) throw new BadRequestException('شماره داخلی تکراری یا خالی است: ' + e.n); seen.add(e.n); }
    }
    await this.db.configEntry.upsert({ where: { key }, create: { key, data: merged, updatedBy: me?.id }, update: { data: merged, updatedBy: me?.id } });
    (cfg as any)[key] = merged;
    if (me) await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'config.save', target: key, detail: diff(key, old, merged) as any } });
    this.bus.emit('config', { key, data: this.publicView(key, merged, 'admin'), by: me?.id });
    let res: any = { applied: true };
    if (reapply) res = await this.ast.apply(cfg).catch(e => ({ applied: false, error: e.message }));
    return { data: merged, ...res };
  }

  /** Server-side counter updates (blacklist hits): stored as-is, no Asterisk reload. */
  async saveRaw(key: string, data: any) {
    const cfg = await this.all();
    await this.db.configEntry.upsert({ where: { key }, create: { key, data }, update: { data } });
    (cfg as any)[key] = data;
    this.bus.emit('config', { key, data, by: null });
  }

  /** Non-admins never receive SIP secrets or trunk passwords. */
  publicView(key: string, data: any, role: string) {
    if (role === 'admin' || !Array.isArray(data)) return data;
    if (key === 'exts') return data.map((e: any) => ({ ...e, secret: undefined }));
    if (key === 'trunks') return data.map((t: any) => ({ ...t, pass: undefined, user: undefined }));
    return data;
  }

  async forRole(role: string) {
    const c = await this.all();
    const out: Record<string, any> = {};
    for (const k of KEYS) out[k] = this.publicView(k, (c as any)[k], role);
    return out;
  }
}

function diff(key: string, a: any, b: any) {
  if (!Array.isArray(a) || !Array.isArray(b)) return { before: a, after: b };
  const idk = ID[key] || 'id';
  const A = new Map(a.map((x: any) => [String(x[idk]), JSON.stringify(x)]));
  const B = new Map(b.map((x: any) => [String(x[idk]), JSON.stringify(x)]));
  return {
    added: [...B.keys()].filter(k => !A.has(k)),
    removed: [...A.keys()].filter(k => !B.has(k)),
    changed: [...B.keys()].filter(k => A.has(k) && A.get(k) !== B.get(k)),
  };
}

@Controller('config')
export class ConfigController {
  constructor(private store: ConfigStore, private db: PrismaService) {}

  @Roles('admin')
  @Put(':key')
  save(@Param('key') key: string, @Body() b: { data: any }, @CurrentUser() me: Me) { return this.store.save(key, b.data, me); }

  @Roles('admin')
  @Get('audit/log')
  audit() { return this.db.auditLog.findMany({ orderBy: { at: 'desc' }, take: 200 }); }
}
