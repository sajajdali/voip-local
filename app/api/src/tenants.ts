// Multi-tenant admin: tenants + DID pool 31985000…31985999 + feature flags + access matrix.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, Post, Put, Query } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AllowPaywall, CurrentUser, Me, Roles, forgetUser, isSuperAdmin } from './auth';
import { ConfigStore } from './config';
import { Action, Perms, cleanPerms, rolePerms } from './perms';
import { PrismaService } from './prisma.service';
import {
  DEFAULT_TENANT_FEATURES, DID_POOL_MAX, DID_POOL_MIN, DID_POOL_PREFIX, FEATURE_SECTIONS, PLAN_PERIODS, TENANT_FEATURE_LABELS,
  cleanFeatures, cleanPlanPeriod, didFromSuffix, extendExpiry, isPoolDid, normalizePoolDid, planLabel, tenantAccess, type TenantFeatures,
} from './tenant-scope';

export { DID_POOL_MIN, DID_POOL_MAX, DID_POOL_PREFIX, isPoolDid, normalizePoolDid };

export function slugify(name: string) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tenant';
  return base.replace(/[^\w-]/g, 't') || 'tenant';
}

export { isSuperAdmin };

/** Default perms for a tenant-admin account (no trunks / platform sections). Feature flags strip disabled sections. */
export function tenantAdminPerms(features?: TenantFeatures | null): Perms {
  const f = cleanFeatures(features);
  const base: Perms = cleanPerms({
    ...rolePerms('supervisor'),
    vext: ['view', 'add', 'edit', 'delete'] as Action[],
    vqueue: ['view', 'add', 'edit', 'delete'] as Action[],
    vivr: ['view', 'add', 'edit', 'delete'] as Action[],
    vsound: ['view', 'add', 'edit', 'delete'] as Action[],
    vroute: ['view', 'add', 'edit', 'delete'] as Action[],
    vtime: ['view', 'add', 'edit', 'delete'] as Action[],
    vring: ['view', 'add', 'edit', 'delete'] as Action[],
    vfollow: ['view', 'add', 'edit', 'delete'] as Action[],
    vblack: ['view', 'add', 'edit', 'delete'] as Action[],
    vsurvey: ['view', 'edit'] as Action[],
    vvm: ['view', 'edit'] as Action[],
    vbook: ['view', 'edit'] as Action[],
    bookings: ['view', 'edit'] as Action[],
    vout: ['view'] as Action[],
    users: ['view', 'add', 'edit', 'delete'] as Action[],
  });
  for (const [feat, sections] of Object.entries(FEATURE_SECTIONS) as [keyof TenantFeatures, string[]][]) {
    if (f[feat]) continue;
    for (const s of sections) delete base[s];
  }
  return base;
}

@Injectable()
export class TenantsService {
  constructor(private db: PrismaService, private store: ConfigStore) {}

  async didsOf(tenantId: string): Promise<string[]> {
    const rows = await this.db.didAssignment.findMany({ where: { tenantId }, select: { did: true } });
    return rows.map(r => r.did);
  }

  async didRoutes() {
    const rows = await this.db.didAssignment.findMany({
      include: { tenant: { select: { id: true, name: true, active: true, defaultDest: true } } },
      orderBy: { did: 'asc' },
    });
    return rows
      .filter(r => r.tenant.active && r.tenant.defaultDest)
      .map(r => ({ did: r.did, tenantId: r.tenant.id, dest: r.tenant.defaultDest, name: r.tenant.name }));
  }

  async reapply() {
    return this.store.applyAll();
  }

  async list() {
    const [tenants, dids, users] = await Promise.all([
      this.db.tenant.findMany({ orderBy: { createdAt: 'asc' } }),
      this.db.didAssignment.findMany({ orderBy: { did: 'asc' } }),
      this.db.user.findMany({ where: { tenantId: { not: null } }, select: { id: true, username: true, name: true, role: true, active: true, tenantId: true } }),
    ]);
    const byTenant = new Map<string, typeof dids>();
    for (const d of dids) {
      const list = byTenant.get(d.tenantId) || [];
      list.push(d);
      byTenant.set(d.tenantId, list);
    }
    const usersBy = new Map<string, typeof users>();
    for (const u of users) {
      if (!u.tenantId) continue;
      const list = usersBy.get(u.tenantId) || [];
      list.push(u);
      usersBy.set(u.tenantId, list);
    }
    const assigned = new Set(dids.map(d => d.did));
    const free: string[] = [];
    for (let n = DID_POOL_MIN; n <= DID_POOL_MAX; n++) {
      const s = String(n);
      if (!assigned.has(s)) free.push(s);
    }
    return {
      pool: { prefix: DID_POOL_PREFIX, min: String(DID_POOL_MIN), max: String(DID_POOL_MAX), total: DID_POOL_MAX - DID_POOL_MIN + 1, free: free.length },
      freeSample: free.slice(0, 40),
      featureDefaults: DEFAULT_TENANT_FEATURES,
      featureLabels: TENANT_FEATURE_LABELS,
      planPeriods: PLAN_PERIODS,
      loginUrl: 'https://voip.s8n.ir',
      tenants: tenants.map(t => {
        const access = tenantAccess(t);
        return {
          ...t,
          features: cleanFeatures(t.features),
          planPeriod: t.planPeriod || '1m',
          planLabel: planLabel(t.planPeriod || '1m'),
          priceToman: t.priceToman || 0,
          expiresAt: t.expiresAt,
          locked: access.locked,
          expired: access.expired,
          accessReason: access.reason,
          accessOk: access.active,
          dids: (byTenant.get(t.id) || []).map(d => ({ id: d.id, did: d.did, note: d.note || '' })),
          users: (usersBy.get(t.id) || []).map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })),
        };
      }),
    };
  }

  async applyPayment(tenantId: string, opts: { success: boolean; byUserId?: string; byName?: string; simulated?: boolean; note?: string }) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new BadRequestException('مستأجر پیدا نشد');
    const period = cleanPlanPeriod(t.planPeriod || '1m');
    const amount = Math.max(0, t.priceToman || 0);
    if (!opts.success) {
      await this.db.tenantPayment.create({
        data: {
          tenantId, amount, period, success: false, simulated: opts.simulated !== false,
          note: opts.note || 'پرداخت ناموفق (شبیه‌ساز)', byUserId: opts.byUserId || null, byName: opts.byName || null,
        },
      });
      return { ok: false, message: 'پرداخت ناموفق بود؛ دسترسی باز نشد' };
    }
    const expiresAt = extendExpiry(t.expiresAt, period);
    await this.db.tenant.update({ where: { id: tenantId }, data: { expiresAt, locked: false, active: true } });
    await this.db.tenantPayment.create({
      data: {
        tenantId, amount, period, success: true, simulated: opts.simulated !== false,
        note: opts.note || 'پرداخت موفق (شبیه‌ساز) — تمدید اشتراک', byUserId: opts.byUserId || null, byName: opts.byName || null,
      },
    });
    forgetUser();
    return { ok: true, expiresAt, period, amount, message: `دسترسی تا ${expiresAt.toISOString()} تمدید شد` };
  }

  /** Admin access matrix: one row per tenant with DIDs, users, features. */
  async matrix() {
    const data = await this.list();
    return {
      pool: data.pool,
      featureDefaults: data.featureDefaults,
      rows: data.tenants.map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        active: t.active,
        defaultDest: t.defaultDest,
        features: t.features,
        didCount: t.dids.length,
        dids: t.dids.map((d: any) => d.did),
        userCount: t.users.length,
        users: t.users,
      })),
    };
  }
}

@Controller('tenants')
export class TenantsController {
  constructor(private db: PrismaService, private tenants: TenantsService) {}

  private assertSuper(me: Me) {
    if (!isSuperAdmin(me)) throw new ForbiddenException('فقط مدیر سامانه می‌تواند مستأجر و DID را مدیریت کند');
  }

  @Roles('admin')
  @Get()
  async list(@CurrentUser() me: Me) {
    this.assertSuper(me);
    return this.tenants.list();
  }

  @Roles('admin')
  @Get('matrix')
  async matrix(@CurrentUser() me: Me) {
    this.assertSuper(me);
    return this.tenants.matrix();
  }

  /** Live DID uniqueness check for the create form (suffix = 3 digits). */
  @Roles('admin')
  @Get('did-check')
  async didCheck(@Query('suffix') suffix: string, @CurrentUser() me: Me) {
    this.assertSuper(me);
    try {
      const did = didFromSuffix(suffix);
      const other = await this.db.didAssignment.findUnique({ where: { did }, include: { tenant: { select: { name: true, slug: true } } } });
      if (other) {
        return { ok: false, did, free: false, message: `شماره ${did} قبلاً به «${other.tenant.name}» تخصیص داده شده` };
      }
      return { ok: true, did, free: true, message: `شماره ${did} آزاد است` };
    } catch (e) {
      return { ok: false, did: null, free: false, message: (e as Error).message };
    }
  }

  /** What the signed-in tenant user may see about their own access. */
  @AllowPaywall()
  @Get('me')
  async mine(@CurrentUser() me: Me) {
    if (!me.tenantId) {
      if (!isSuperAdmin(me)) return { tenant: null, dids: [], superAdmin: false, features: null };
      return { tenant: null, dids: [], superAdmin: true, features: null, loginUrl: 'https://voip.s8n.ir', ...(await this.tenants.list()) };
    }
    const t = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
    if (!t) return { tenant: null, dids: [], superAdmin: false, features: null };
    const dids = await this.db.didAssignment.findMany({ where: { tenantId: t.id }, orderBy: { did: 'asc' } });
    const features = cleanFeatures(t.features);
    const access = tenantAccess(t);
    const payments = await this.db.tenantPayment.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' }, take: 10 });
    return {
      superAdmin: false,
      loginUrl: 'https://voip.s8n.ir',
      paywall: access.locked,
      access,
      tenant: {
        id: t.id, name: t.name, slug: t.slug, active: t.active, defaultDest: t.defaultDest, note: t.note,
        planPeriod: t.planPeriod || '1m', planLabel: planLabel(t.planPeriod || '1m'),
        priceToman: t.priceToman || 0, expiresAt: t.expiresAt, locked: access.locked, expired: access.expired,
      },
      features,
      featureLabels: TENANT_FEATURE_LABELS,
      dids: dids.map(d => ({ did: d.did, note: d.note || '' })),
      payments: payments.map(p => ({ id: p.id, at: p.createdAt, amount: p.amount, period: p.period, success: p.success, note: p.note })),
    };
  }

  /** Tenant self-service payment simulator (unlock / extend). */
  @AllowPaywall()
  @Post('me/pay/simulate')
  async myPaySimulate(@Body() b: { success?: boolean }, @CurrentUser() me: Me) {
    if (!me.tenantId) throw new ForbiddenException('فقط کاربران مستأجر');
    return this.tenants.applyPayment(me.tenantId, { success: b.success !== false, byUserId: me.id, byName: me.name, simulated: true });
  }

  /** Tenant admin updates own inbound default destination. */
  @Put('me/inbound')
  async myInbound(@Body() b: { defaultDest?: string }, @CurrentUser() me: Me) {
    if (!me.tenantId) throw new ForbiddenException('فقط کاربران مستأجر');
    const dest = String(b.defaultDest || '').trim().slice(0, 80);
    await this.db.tenant.update({ where: { id: me.tenantId }, data: { defaultDest: dest } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.inbound', target: me.tenantId, detail: { defaultDest: dest } as any } });
    await this.tenants.reapply().catch(() => null);
    return { ok: true, defaultDest: dest };
  }

  @Roles('admin')
  @Post()
  async create(@Body() b: any, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new BadRequestException('نام مستأجر را وارد کنید');
    const username = String(b.username || '').trim().toLowerCase();
    if (!username) throw new BadRequestException('نام کاربری ورود مستأجر را وارد کنید');
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new BadRequestException('نام کاربری فقط حروف انگلیسی، عدد، نقطه و خط تیره و ۳ تا ۳۰ کاراکتر باشد');
    if (await this.db.user.findUnique({ where: { username } })) throw new BadRequestException('این نام کاربری قبلاً استفاده شده است');
    const password = String(b.password || '');
    if (!password) throw new BadRequestException('کلمه عبور را وارد کنید');
    if (password.length < 6) throw new BadRequestException('کلمه عبور حداقل ۶ کاراکتر باشد');

    // DID suffixes: primary required, optional extras (3 digits each → 31985XXX)
    const suffixes: string[] = [];
    const primary = String(b.didSuffix ?? b.suffix ?? '').replace(/\D/g, '');
    if (primary) suffixes.push(primary);
    for (const x of [].concat(b.didSuffixes || b.extraSuffixes || [])) {
      const s = String(x).replace(/\D/g, '');
      if (s && !suffixes.includes(s)) suffixes.push(s);
    }
    if (!suffixes.length) throw new BadRequestException('سه رقم آخر شماره (۰۰۰ تا ۹۹۹) را وارد کنید');
    const dids = suffixes.map(s => didFromSuffix(s));
    for (const did of dids) {
      const other = await this.db.didAssignment.findUnique({ where: { did }, include: { tenant: { select: { name: true } } } });
      if (other) throw new BadRequestException(`شماره ${did} قبلاً به «${other.tenant.name}» تخصیص داده شده`);
    }

    let slug = String(b.slug || '').trim().toLowerCase() || slugify(name);
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug)) throw new BadRequestException('شناسه انگلیسی مستأجر نامعتبر است');
    if (await this.db.tenant.findUnique({ where: { slug } })) {
      slug = slug.slice(0, 32) + '-' + Date.now().toString(36).slice(-6);
    }
    const defaultDest = String(b.defaultDest || '').trim().slice(0, 80);
    const features = cleanFeatures(b.features);
    const planPeriod = cleanPlanPeriod(b.planPeriod || b.period || '1m');
    const priceToman = Math.max(0, Math.floor(Number(b.priceToman ?? b.price ?? 0) || 0));
    const expiresAt = extendExpiry(null, planPeriod);
    const t = await this.db.tenant.create({
      data: {
        name, slug, defaultDest,
        note: String(b.note || '').trim().slice(0, 200) || null,
        active: b.active !== false,
        features: features as any,
        planPeriod, priceToman, expiresAt, locked: false,
      },
    });
    for (const did of dids) {
      await this.db.didAssignment.create({ data: { did, tenantId: t.id } });
    }
    await this.db.user.create({
      data: {
        username,
        name: String(b.userName || name).trim().slice(0, 60),
        role: 'admin',
        tenantId: t.id,
        password: await bcrypt.hash(password, 10),
        perms: tenantAdminPerms(features) as any,
      },
    });
    await this.db.auditLog.create({
      data: {
        userId: me.id, userName: me.name, action: 'tenant.create', target: t.slug,
        detail: { id: t.id, name, features, dids, username, planPeriod, priceToman, expiresAt } as any,
      },
    });
    await this.tenants.reapply().catch(() => null);
    return {
      id: t.id, slug: t.slug, features, dids, planPeriod, planLabel: planLabel(planPeriod), priceToman, expiresAt,
      login: { url: 'https://voip.s8n.ir', username, password },
      message: `مستأجر «${name}» ساخته شد. ورود با «${username}» در https://voip.s8n.ir · اشتراک تا ${expiresAt.toISOString().slice(0, 10)}`,
    };
  }

  @Roles('admin')
  @Put(':id')
  async update(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const cur = await this.db.tenant.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('مستأجر پیدا نشد');
    const data: any = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 80);
      if (!name) throw new BadRequestException('نام مستأجر را وارد کنید');
      data.name = name;
    }
    if (b.defaultDest !== undefined) data.defaultDest = String(b.defaultDest || '').trim().slice(0, 80);
    if (b.note !== undefined) data.note = String(b.note || '').trim().slice(0, 200) || null;
    if (b.active !== undefined) data.active = !!b.active;
    if (b.locked !== undefined) data.locked = !!b.locked;
    if (b.features !== undefined) data.features = cleanFeatures(b.features) as any;
    if (b.planPeriod !== undefined || b.period !== undefined) data.planPeriod = cleanPlanPeriod(b.planPeriod || b.period);
    if (b.priceToman !== undefined || b.price !== undefined) data.priceToman = Math.max(0, Math.floor(Number(b.priceToman ?? b.price) || 0));
    // renew: set expiry from now (or extend) without payment
    if (b.renew === true || b.resetExpiry === true) {
      const period = cleanPlanPeriod(data.planPeriod || cur.planPeriod || '1m');
      data.planPeriod = period;
      data.expiresAt = extendExpiry(b.extend === true ? cur.expiresAt : null, period);
      data.locked = false;
      if (b.active !== false) data.active = true;
    }
    if (b.expiresAt !== undefined) {
      const d = b.expiresAt ? new Date(b.expiresAt) : null;
      if (b.expiresAt && Number.isNaN(d!.getTime())) throw new BadRequestException('تاریخ انقضا نامعتبر است');
      data.expiresAt = d;
    }
    const t = await this.db.tenant.update({ where: { id }, data });
    if (data.features) {
      // refresh tenant-admin perms to match reduced/expanded features
      await this.db.user.updateMany({
        where: { tenantId: id, role: 'admin' },
        data: { perms: tenantAdminPerms(cleanFeatures(t.features)) as any },
      });
    }
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.update', target: t.slug, detail: data } });
    forgetUser();
    await this.tenants.reapply().catch(() => null);
    return { ok: true, features: cleanFeatures(t.features), access: tenantAccess(t), expiresAt: t.expiresAt, planPeriod: t.planPeriod, priceToman: t.priceToman };
  }

  @Roles('admin')
  @Put(':id/features')
  async setFeatures(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const cur = await this.db.tenant.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('مستأجر پیدا نشد');
    const features = cleanFeatures({ ...cleanFeatures(cur.features), ...(b.features || b) });
    await this.db.tenant.update({ where: { id }, data: { features: features as any } });
    await this.db.user.updateMany({ where: { tenantId: id, role: 'admin' }, data: { perms: tenantAdminPerms(features) as any } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.features', target: cur.slug, detail: features as any } });
    forgetUser();
    await this.tenants.reapply().catch(() => null);
    return { ok: true, features };
  }

  /** Admin payment simulator: success extends access; fail records attempt. */
  @Roles('admin')
  @Post(':id/pay/simulate')
  async paySimulate(@Param('id') id: string, @Body() b: { success?: boolean; note?: string }, @CurrentUser() me: Me) {
    this.assertSuper(me);
    return this.tenants.applyPayment(id, { success: b.success !== false, byUserId: me.id, byName: me.name, simulated: true, note: b.note });
  }

  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const cur = await this.db.tenant.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('مستأجر پیدا نشد');
    await this.db.user.updateMany({ where: { tenantId: id }, data: { tenantId: null, active: false } });
    await this.db.tenant.delete({ where: { id } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.delete', target: cur.slug } });
    forgetUser();
    await this.tenants.reapply().catch(() => null);
    return { ok: true };
  }

  @Roles('admin')
  @Post(':id/dids')
  async assign(@Param('id') id: string, @Body() b: { did?: string; suffix?: string; didSuffix?: string; note?: string }, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new BadRequestException('مستأجر پیدا نشد');
    const did = (b.suffix != null || b.didSuffix != null)
      ? didFromSuffix(b.suffix ?? b.didSuffix)
      : normalizePoolDid(b.did);
    const other = await this.db.didAssignment.findUnique({ where: { did }, include: { tenant: { select: { name: true } } } });
    if (other) throw new BadRequestException(other.tenantId === id ? 'این شماره قبلاً به همین مستأجر داده شده' : `شماره ${did} قبلاً به «${other.tenant.name}» تخصیص داده شده`);
    const row = await this.db.didAssignment.create({ data: { did, tenantId: id, note: String(b.note || '').trim().slice(0, 120) || null } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'did.assign', target: did, detail: { tenantId: id, tenant: t.name } as any } });
    await this.tenants.reapply().catch(() => null);
    return { id: row.id, did };
  }

  @Roles('admin')
  @Delete(':id/dids/:did')
  async unassign(@Param('id') id: string, @Param('did') didRaw: string, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const did = normalizePoolDid(didRaw);
    const row = await this.db.didAssignment.findUnique({ where: { did } });
    if (!row || row.tenantId !== id) throw new BadRequestException('این شماره برای این مستأجر ثبت نشده');
    await this.db.didAssignment.delete({ where: { did } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'did.unassign', target: did, detail: { tenantId: id } as any } });
    await this.tenants.reapply().catch(() => null);
    return { ok: true };
  }

  /** Create a user bound to a tenant (super-admin only). */
  @Roles('admin')
  @Post(':id/users')
  async createUser(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new BadRequestException('مستأجر پیدا نشد');
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new BadRequestException('نام کاربری نامعتبر است');
    if (await this.db.user.findUnique({ where: { username } })) throw new BadRequestException('این نام کاربری قبلاً استفاده شده است');
    if (!b.password || String(b.password).length < 6) throw new BadRequestException('رمز عبور حداقل ۶ کاراکتر باشد');
    const name = String(b.name || username).trim().slice(0, 60);
    const role = ['admin', 'supervisor', 'operator'].includes(b.role) ? b.role : 'admin';
    const features = cleanFeatures(t.features);
    const u = await this.db.user.create({
      data: {
        username, name, role, tenantId: id,
        password: await bcrypt.hash(String(b.password), 10),
        perms: (role === 'admin' ? tenantAdminPerms(features) : cleanPerms(b.perms || rolePerms(role))) as any,
      },
    });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.user.create', target: username, detail: { tenantId: id, role } as any } });
    return { id: u.id, username };
  }

}
