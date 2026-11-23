// VoIP configuration store: platform ConfigEntry + per-tenant TenantConfig; every save regenerates Asterisk.
import { BadRequestException, Body, Controller, Get, Injectable, Param, Put, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CurrentUser, Me, Perm, isSuperAdmin } from './auth';
import { Action, CONFIG_SECTION, can } from './perms';
import { AsteriskService } from './asterisk/asterisk.service';
import { VoipConfig } from './asterisk/generator';
import { Bus } from './bus';
import { PrismaService } from './prisma.service';
import {
  DEFAULT_TENANT_FEATURES, TENANT_CONFIG_KEYS, cleanFeatures, featureAllows,
  normalizeInboundDid, prefixDestIfOwned, prefixTenantCollection,
} from './tenant-scope';

export const ARRAY_KEYS = ['exts', 'trunks', 'vqs', 'ivrs', 'snds', 'routes', 'oroutes', 'tgroups', 'tconds', 'holidays', 'rgroups', 'blist'] as const;
export const OBJECT_KEYS = ['fmes', 'bset', 'survey', 'vmbox'] as const;

/** Post-call survey: off until prompts are recorded. One 1..5 rating; a low score may leave a voice comment. */
export const DEFAULT_SURVEY = {
  on: false, minTalk: 10, timeout: 6, retry: 1, intro: '', thanks: '', invalid: '',
  qs: [{ label: 'رضایت از مکالمه', snd: '' }],
  comment: { on: true, max: 2, snd: '', maxSec: 60 },
};
/** «صندوق پیام»: greeting / closing prompts, how a message ends, and the key that opens it from every IVR. */
export const DEFAULT_VMBOX = { on: false, key: '9', inIvr: true, greet: '', end: '', term: '*', beep: true, maxSec: 120, silence: 5 };
export const KEYS = [...ARRAY_KEYS, ...OBJECT_KEYS] as string[];
const LIVE: Record<string, string[]> = { exts: ['st'], vqs: ['waiting', 'sla'], trunks: ['reg', 'used'] };
const ID: Record<string, string> = { exts: 'n', blist: 'num', holidays: 'date' };

export const secret = () => randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);

function emptyKey(key: string) {
  if (ARRAY_KEYS.includes(key as any)) return [];
  if (key === 'bset') return { anon: false, action: 'hang', sound: '' };
  if (key === 'survey') return DEFAULT_SURVEY;
  if (key === 'vmbox') return DEFAULT_VMBOX;
  return {};
}

@Injectable()
export class ConfigStore {
  private cache: Record<string, any> | null = null;
  private tenantCache = new Map<string, Record<string, any>>();
  constructor(private db: PrismaService, private ast: AsteriskService, private bus: Bus) {}

  /** Platform-wide config (ConfigEntry) — trunks live only here. */
  async all(): Promise<VoipConfig> {
    if (!this.cache) {
      const rows = await this.db.configEntry.findMany();
      const c: Record<string, any> = {};
      for (const k of KEYS) c[k] = emptyKey(k);
      for (const r of rows) c[r.key] = r.data;
      this.cache = c;
    }
    return this.cache as VoipConfig;
  }

  async tenantAll(tenantId: string): Promise<Record<string, any>> {
    let c = this.tenantCache.get(tenantId);
    if (!c) {
      const rows = await this.db.tenantConfig.findMany({ where: { tenantId } });
      c = {};
      for (const k of KEYS) {
        if (k === 'trunks') continue;
        c[k] = emptyKey(k);
      }
      for (const r of rows) {
        if (r.key === 'trunks') continue;
        c[r.key] = r.data;
      }
      this.tenantCache.set(tenantId, c);
    }
    return c;
  }

  reset() {
    this.cache = null;
    this.tenantCache.clear();
  }

  resetTenant(tenantId?: string) {
    if (tenantId) this.tenantCache.delete(tenantId);
    else this.tenantCache.clear();
  }

  /**
   * Merge platform + every active tenant's prefixed collections into one VoipConfig for Asterisk.
   * DID routes use prefixed destinations so tenant entities never collide.
   */
  async withDidRoutes(cfg?: VoipConfig): Promise<VoipConfig> {
    const base = { ...(cfg || await this.all()) } as any;
    const tenants = await this.db.tenant.findMany({
      where: { active: true },
      include: { dids: true, configs: true },
      orderBy: { createdAt: 'asc' },
    });

    const mergeArr = (key: string, rows: any[]) => {
      const cur = Array.isArray(base[key]) ? base[key] : [];
      base[key] = [...cur, ...rows];
    };
    const mergeObj = (key: string, obj: any) => {
      base[key] = { ...(base[key] || {}), ...(obj || {}) };
    };

    const didRoutes: { did: string; tenantId: string; dest: string; name?: string }[] = [];

    for (const t of tenants) {
      const features = cleanFeatures(t.features);
      const raw: Record<string, any> = {};
      for (const k of KEYS) {
        if (k === 'trunks') continue;
        raw[k] = emptyKey(k);
      }
      for (const row of t.configs) {
        if (row.key === 'trunks') continue;
        raw[row.key] = row.data;
      }

      for (const key of TENANT_CONFIG_KEYS) {
        if (key === 'trunks' as any) continue;
        if (!featureAllows(features, key)) continue;
        const data = raw[key];
        if (data == null) continue;
        const prefixed = prefixTenantCollection(t.id, key, data);
        if (ARRAY_KEYS.includes(key as any) && Array.isArray(prefixed)) mergeArr(key, prefixed);
        else if (key === 'fmes' && typeof prefixed === 'object') mergeObj(key, prefixed);
        else if (OBJECT_KEYS.includes(key as any) && key !== 'bset' && key !== 'survey' && key !== 'vmbox') {
          // keep platform object defaults; tenant object keys only matter if we add per-tenant later
        }
      }

      const dest = String(t.defaultDest || '').trim();
      if (!dest) continue;
      for (const d of t.dids) {
        const did = normalizeInboundDid(d.did);
        if (!did) continue;
        didRoutes.push({ did, tenantId: t.id, dest: prefixDestIfOwned(t.id, dest, raw), name: t.name });
      }

      // If any tenant routes to booking, keep dialplan cc-book context reachable
      const bk = raw.booking;
      if (features.booking && bk && typeof bk === 'object' && bk.enabled) {
        base.booking = { ...(base.booking || {}), enabled: true, code: base.booking?.code || bk.code || '', trackCode: base.booking?.trackCode || bk.trackCode || '', fallback: base.booking?.fallback || bk.fallback || '', backDest: base.booking?.backDest || bk.backDest || '' };
      }
    }

    base.didRoutes = didRoutes;
    return base as VoipConfig;
  }

  async applyAll() { return this.ast.apply(await this.withDidRoutes()); }

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
        const ns = typeof y.newSecret === 'string' ? y.newSecret.trim() : '';
        delete y.newSecret;
        if (ns && (ns.length < 4 || ns.length > 64 || /[\s;"\\]/.test(ns))) throw new BadRequestException('رمز SIP نامعتبر است (حداقل ۴ کاراکتر، بدون فاصله)');
        y.secret = ns || o.secret || y.secret || secret();
        if (y.remote && String(y.secret).length < 16) throw new BadRequestException(`برای اتصال داخلی ${y.n} از بیرون، رمز SIP باید حداقل ۱۶ کاراکتر باشد`);
      }
      if (key === 'blist') { y.num = String(y.num).replace(/\D/g, ''); y.hits = o.hits ?? y.hits ?? 0; y.today = o.today ?? y.today ?? 0; y.last = o.last ?? y.last ?? '—'; y.lastDay = o.lastDay; }
      if (key === 'snds') { if (o.file) y.file = o.file; if (o.dur) y.dur = o.dur; }
      return y;
    });
  }

  async save(key: string, data: any, me: Me | null, reapply = true) {
    if (!KEYS.includes(key)) throw new BadRequestException('کلید نامعتبر');
    if (key === 'trunks' && me && !isSuperAdmin(me)) throw new ForbiddenException('تعریف و ویرایش ترانک فقط برای مدیر سامانه است');

    const isArr = ARRAY_KEYS.includes(key as any);
    if (isArr !== Array.isArray(data) || data === null || typeof data !== 'object') throw new BadRequestException('ساختار داده نامعتبر است');

    // Tenant-scoped save
    if (me?.tenantId) {
      if (key === 'trunks') throw new ForbiddenException('ترانک فقط برای مدیر سامانه است');
      const tenant = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
      if (!tenant || !tenant.active) throw new ForbiddenException('مستأجر غیرفعال است');
      const features = cleanFeatures(tenant.features);
      if (!featureAllows(features, key)) throw new ForbiddenException('این قابلیت برای مستأجر شما فعال نیست');

      const cfg = await this.tenantAll(me.tenantId);
      const old = cfg[key];
      const merged = this.merge(key, data, old);
      if (key === 'exts') {
        const seen = new Set<string>();
        for (const e of merged) { if (!e.n || seen.has(e.n)) throw new BadRequestException('شماره داخلی تکراری یا خالی است: ' + e.n); seen.add(e.n); }
        // Extension numbers are global on Asterisk — reject collisions with platform / other tenants
        const platform = await this.all();
        for (const e of platform.exts || []) {
          if (seen.has(String(e.n))) throw new BadRequestException('داخلی ' + e.n + ' قبلاً در پیکربندی سامانه ثبت شده است');
        }
        const others = await this.db.tenantConfig.findMany({ where: { key: 'exts', tenantId: { not: me.tenantId } } });
        for (const row of others) {
          for (const e of (row.data as any[]) || []) {
            if (e?.n && seen.has(String(e.n))) throw new BadRequestException('داخلی ' + e.n + ' متعلق به مستأجر دیگری است');
          }
        }
      }
      await this.db.tenantConfig.upsert({
        where: { tenantId_key: { tenantId: me.tenantId, key } },
        create: { tenantId: me.tenantId, key, data: merged, updatedBy: me.id },
        update: { data: merged, updatedBy: me.id },
      });
      cfg[key] = merged;
      await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.config.save', target: `${me.tenantId}:${key}`, detail: diff(key, old, merged) as any } });
      this.bus.emit('config', { key, data: this.publicView(key, merged, me), by: me.id, tenantId: me.tenantId });
      let res: any = { applied: true };
      if (reapply) res = await this.ast.apply(await this.withDidRoutes()).catch(e => ({ applied: false, error: e.message }));
      return { data: merged, ...res };
    }

    // Platform save (super-admin / platform users)
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
    this.bus.emit('config', { key, data: this.publicView(key, merged, me || { role: 'admin', tenantId: null }), by: me?.id });
    let res: any = { applied: true };
    if (reapply) res = await this.ast.apply(await this.withDidRoutes(cfg)).catch(e => ({ applied: false, error: e.message }));
    return { data: merged, ...res };
  }

  /** Server-side counter updates (blacklist hits): stored as-is, no Asterisk reload. */
  async saveRaw(key: string, data: any) {
    const cfg = await this.all();
    await this.db.configEntry.upsert({ where: { key }, create: { key, data }, update: { data } });
    (cfg as any)[key] = data;
    this.bus.emit('config', { key, data, by: null });
  }

  /** Non-admins never receive SIP secrets or trunk passwords. Tenant users never see trunks. */
  publicView(key: string, data: any, me: Me | { role: string; tenantId?: string | null }) {
    if (!Array.isArray(data)) return data;
    if (key === 'trunks' && !isSuperAdmin(me as Me)) return [];
    if (isSuperAdmin(me as Me)) return data;
    if (key === 'exts') return data.map((e: any) => ({ ...e, secret: undefined }));
    if (key === 'trunks') return data.map((t: any) => ({ ...t, pass: undefined, user: undefined }));
    return data;
  }

  async forUser(me: Me) {
    if (me.tenantId) {
      const tenant = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
      const features = cleanFeatures(tenant?.features);
      const c = await this.tenantAll(me.tenantId);
      const out: Record<string, any> = {};
      for (const k of KEYS) {
        if (k === 'trunks') { out[k] = []; continue; }
        if (!featureAllows(features, k)) {
          out[k] = emptyKey(k);
          continue;
        }
        out[k] = this.publicView(k, c[k], me);
      }
      return out;
    }
    const c = await this.all();
    const out: Record<string, any> = {};
    for (const k of KEYS) out[k] = this.publicView(k, (c as any)[k], me);
    return out;
  }

  async forRole(role: string) {
    return this.forUser({ id: '', name: '', role, ext: null, username: '', tenantId: role === 'admin' ? null : 'x' } as Me);
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

  /** Every VoIP list is saved whole: work out what this save adds, edits and removes, and check each. */
  @Put(':key')
  async save(@Param('key') key: string, @Body() b: { data: any }, @CurrentUser() me: Me) {
    const section = CONFIG_SECTION[key];
    if (!section) throw new ForbiddenException('دسترسی به این بخش مجاز نیست');
    if (key === 'trunks' && !isSuperAdmin(me)) throw new ForbiddenException('تعریف و ویرایش ترانک فقط برای مدیر سامانه است');
    if (!isSuperAdmin(me)) {
      const cfg = me.tenantId ? await this.store.tenantAll(me.tenantId) : await this.store.all();
      const old = (cfg as any)[key];
      let add = false, del = false, edit = false;
      if (Array.isArray(old) && Array.isArray(b.data)) {
        const d = diff(key, old, b.data) as any;
        add = d.added.length > 0; del = d.removed.length > 0; edit = d.changed.length > 0;
      } else edit = JSON.stringify(old) !== JSON.stringify(b.data);
      const need = [add && 'add', del && 'delete', edit && 'edit'].filter(Boolean) as Action[];
      const missing = need.filter(a => !can(me, section, a));
      if (missing.length) throw new ForbiddenException('اجازه ' + missing.map(a => ({ add: 'افزودن', edit: 'ویرایش', delete: 'حذف' } as any)[a]).join(' و ') + ' در این بخش را ندارید');
    }
    return this.store.save(key, b.data, me);
  }

  @Perm('users', 'view')
  @Get('audit/log')
  audit() { return this.db.auditLog.findMany({ orderBy: { at: 'desc' }, take: 200 }); }
}
