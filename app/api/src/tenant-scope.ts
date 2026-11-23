// Shared multi-tenant helpers: DID normalize, feature flags, dialplan ID prefixes.
import { BadRequestException } from '@nestjs/common';

export const DID_POOL_MIN = 31985000;
export const DID_POOL_MAX = 31985999;
export const DID_POOL_PREFIX = '31985';

export const TENANT_CONFIG_KEYS = [
  'exts', 'vqs', 'ivrs', 'snds', 'routes', 'oroutes', 'tgroups', 'tconds', 'holidays',
  'rgroups', 'blist', 'fmes', 'bset', 'survey', 'vmbox', 'booking',
] as const;
export type TenantConfigKey = (typeof TENANT_CONFIG_KEYS)[number];

export const DEFAULT_TENANT_FEATURES = {
  booking: true,
  ivr: true,
  queues: true,
  exts: true,
  inbound: true,
  outbound: true,
  recordings: true,
  ai: true,
  agent: true,
  crm: true,
  api: true,
  sms: true,
};

export type TenantFeatures = typeof DEFAULT_TENANT_FEATURES;

/** Human labels for admin create/edit UI (Persian). */
export const TENANT_FEATURE_LABELS: Record<keyof TenantFeatures, string> = {
  booking: 'نوبت‌دهی تلفنی',
  ivr: 'منوی IVR',
  queues: 'صف‌ها',
  exts: 'داخلی‌ها',
  inbound: 'مسیر ورودی',
  outbound: 'مسیر خروجی',
  recordings: 'گزارش و ضبط مکالمه',
  ai: 'هوش مصنوعی (تحلیل و مدل)',
  agent: 'دستیار هوشمند تلفنی',
  crm: 'سامانه بیماران / CRM',
  api: 'ارسال تماس‌ها (API / وب‌هوک)',
  sms: 'پیامک',
};

export const digits = (s: any) => String(s ?? '').replace(/\D/g, '');

export function isPoolDid(raw: any): boolean {
  const d = digits(raw);
  if (d.length !== 8 || !d.startsWith(DID_POOL_PREFIX)) return false;
  const n = Number(d);
  return n >= DID_POOL_MIN && n <= DID_POOL_MAX;
}

export function normalizePoolDid(raw: any): string {
  const d = normalizeInboundDid(raw);
  if (!isPoolDid(d)) throw new BadRequestException('شماره باید بین ۳۱۹۸۵۰۰۰ و ۳۱۹۸۵۹۹۹ باشد');
  return d;
}

/** Provider may send 31985007, 031985007, 9831985007, or longer suffixes — reduce to pool DID when possible. */
export function normalizeInboundDid(raw: any): string {
  let d = digits(raw);
  if (!d) return '';
  if (d.startsWith('98') && d.length >= 10) d = d.slice(2);
  if (d.startsWith('0') && d.length >= 9) d = d.slice(1);
  if (d.length > 8) {
    const last8 = d.slice(-8);
    if (last8.startsWith(DID_POOL_PREFIX)) return last8;
  }
  return d;
}

/** Short stable Asterisk-safe prefix from tenant id (avoids cross-tenant id collisions). */
export function tenantPrefix(tenantId: string) {
  const s = String(tenantId || '').replace(/[^A-Za-z0-9]/g, '');
  return 'tn' + (s.slice(-8) || 'x');
}

export function prefixEntityId(tenantId: string, id: any) {
  const raw = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!raw) return raw;
  const p = tenantPrefix(tenantId);
  return raw.startsWith(p + '_') ? raw : `${p}_${raw}`;
}

/** Rewrite dest like q:q1 / ivr:i2 / e:101 for a tenant's prefixed entities. Extensions keep digits; ids get prefix. */
export function prefixDest(tenantId: string, dest: string) {
  if (!dest || !dest.includes(':')) return dest;
  const [kind, id] = dest.split(':');
  if (!id) return dest;
  if (kind === 'e' || kind === 'busy' || kind === 'vm' || kind === 'hang' || kind === 'book' || kind === 'booktrack' || kind === 'ai') return dest;
  return `${kind}:${prefixEntityId(tenantId, id)}`;
}

const DEST_COLLECTION: Record<string, string> = { q: 'vqs', ivr: 'ivrs', rg: 'rgroups', tc: 'tconds', ann: 'snds' };

/**
 * Prefix a destination only when the tenant owns that entity.
 * Admin defaultDest often points at a platform queue (q:q400) — leave those unprefixed.
 */
export function prefixDestIfOwned(tenantId: string, dest: string, tenantRaw: Record<string, any> | null | undefined) {
  if (!dest || !dest.includes(':')) return dest;
  const [kind, id] = dest.split(':');
  if (!id) return dest;
  if (kind === 'e' || kind === 'busy' || kind === 'vm' || kind === 'hang' || kind === 'book' || kind === 'booktrack' || kind === 'ai') return dest;
  const key = DEST_COLLECTION[kind];
  if (!key || !tenantRaw) return dest;
  const rows = tenantRaw[key];
  if (!Array.isArray(rows)) return dest;
  const owns = rows.some((x: any) => String(x?.id) === id || String(x?.id) === prefixEntityId(tenantId, id));
  return owns ? `${kind}:${prefixEntityId(tenantId, id)}` : dest;
}

export function cleanFeatures(raw: any): TenantFeatures {
  const out = { ...DEFAULT_TENANT_FEATURES };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(out) as (keyof TenantFeatures)[]) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

export function featureAllows(features: TenantFeatures | null | undefined, key: TenantConfigKey | string): boolean {
  const f = features || DEFAULT_TENANT_FEATURES;
  if (key === 'booking') return !!f.booking;
  if (key === 'ivrs' || key === 'vivr') return !!f.ivr;
  if (key === 'vqs' || key === 'vqueue') return !!f.queues;
  if (key === 'exts' || key === 'vext') return !!f.exts;
  if (key === 'routes' || key === 'vroute' || key === 'inbound') return !!f.inbound;
  if (key === 'oroutes' || key === 'vout' || key === 'outbound') return !!f.outbound;
  if (key === 'recordings') return !!f.recordings;
  return true;
}

/** Panel section keys gated by a tenant feature flag. */
export const FEATURE_SECTIONS: Record<keyof TenantFeatures, string[]> = {
  booking: ['bookings', 'vbook', 'breport', 'bsurvey'],
  ivr: ['vivr'],
  queues: ['vqueue'],
  exts: ['vext'],
  inbound: ['vroute'],
  outbound: ['vout'],
  recordings: [],
  ai: ['vai', 'ai', 'coach'],
  agent: ['vagent', 'aiconv'],
  crm: ['vcrm'],
  api: ['vapi'],
  sms: ['vsms'],
};

/** Build full pool DID from a 3-digit suffix (000–999). */
export function didFromSuffix(suffix: any): string {
  const s = String(suffix ?? '').replace(/\D/g, '');
  if (!/^\d{3}$/.test(s)) throw new BadRequestException('سه رقم آخر شماره را وارد کنید (۰۰۰ تا ۹۹۹)');
  return normalizePoolDid(DID_POOL_PREFIX + s);
}

/** Subscription plan periods offered on create/edit. */
export const PLAN_PERIODS = [
  { id: '1w', label: '۱ هفته', days: 7 },
  { id: '1m', label: '۱ ماه', days: 30 },
  { id: '6m', label: '۶ ماه', days: 182 },
  { id: '1y', label: '۱ سال', days: 365 },
  { id: '2y', label: '۲ سال', days: 730 },
  { id: '3y', label: '۳ سال', days: 1095 },
] as const;
export type PlanPeriodId = (typeof PLAN_PERIODS)[number]['id'];

export function cleanPlanPeriod(raw: any): PlanPeriodId {
  const id = String(raw || '1m');
  if (PLAN_PERIODS.some(p => p.id === id)) return id as PlanPeriodId;
  throw new BadRequestException('مدت اشتراک نامعتبر است');
}

export function planDays(period: PlanPeriodId) {
  return PLAN_PERIODS.find(p => p.id === period)!.days;
}

export function planLabel(period: string) {
  return PLAN_PERIODS.find(p => p.id === period)?.label || period;
}

/** Extend from max(now, currentExpiry) by the plan length. */
export function extendExpiry(from: Date | null | undefined, period: PlanPeriodId, now = new Date()) {
  const base = from && from.getTime() > now.getTime() ? from : now;
  return new Date(base.getTime() + planDays(period) * 86400e3);
}

export function tenantAccess(t: { active?: boolean; locked?: boolean; expiresAt?: Date | null }) {
  const now = Date.now();
  const expired = !!(t.expiresAt && new Date(t.expiresAt).getTime() < now);
  const locked = !t.active || !!t.locked || expired;
  return {
    locked,
    expired,
    active: !!t.active && !t.locked && !expired,
    reason: !t.active ? 'disabled' : t.locked ? 'locked' : expired ? 'expired' : null as string | null,
  };
}

/** Deep-clone a tenant config collection and prefix entity ids (and dest references). */
export function prefixTenantCollection(tenantId: string, key: string, data: any): any {
  if (data == null) return data;
  const p = (id: any) => prefixEntityId(tenantId, id);
  if (key === 'exts' && Array.isArray(data)) {
    // extension numbers stay as dialled; uniqueness is enforced on save against other tenants
    return data.map((e: any) => ({ ...e }));
  }
  if (key === 'snds' && Array.isArray(data)) {
    // sound file names on disk are the raw id (s123.wav) — do not rewrite
    return data.map((s: any) => ({ ...s }));
  }
  if (key === 'blist' && Array.isArray(data)) {
    // blacklist is by phone number; keep numbers as-is
    return data.map((x: any) => ({ ...x }));
  }
  if (Array.isArray(data)) {
    return data.map((row: any) => {
      const y = { ...row };
      if (y.id != null) y.id = p(y.id);
      if (y.dest) y.dest = prefixDest(tenantId, String(y.dest));
      if (y.fail) y.fail = prefixDest(tenantId, String(y.fail));
      if (y.open) y.open = prefixDest(tenantId, String(y.open));
      if (y.closed) y.closed = prefixDest(tenantId, String(y.closed));
      if (y.trunk) delete y.trunk; // tenants never own trunks in dialplan outbound via platform chain only
      if (Array.isArray(y.members)) y.members = y.members.map(String);
      // MOH / announcement refs point at snd ids which are not prefixed
      if (Array.isArray(y.keys)) {
        y.keys = y.keys.map((k: any) => (k && k.dest ? { ...k, dest: prefixDest(tenantId, String(k.dest)) } : k));
      }
      return y;
    });
  }
  if (typeof data === 'object') {
    // fmes keyed by extension number
    if (key === 'fmes') {
      const out: any = {};
      for (const [k, v] of Object.entries(data)) out[k] = v;
      return out;
    }
    return { ...data };
  }
  return data;
}
