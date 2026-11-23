// Multi-tenant admin: tenants + DID pool 31985000…31985999 + feature flags + access matrix.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, Post, Put } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, Me, Roles, forgetUser, isSuperAdmin } from './auth';
import { ConfigStore } from './config';
import { cleanPerms, rolePerms } from './perms';
import { PrismaService } from './prisma.service';
import {
  DEFAULT_TENANT_FEATURES, DID_POOL_MAX, DID_POOL_MIN, DID_POOL_PREFIX,
  cleanFeatures, isPoolDid, normalizePoolDid,
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

/** Default perms for a tenant-admin account (no trunks / platform sections). */
export function tenantAdminPerms() {
  return cleanPerms({
    ...rolePerms('supervisor'),
    vext: ['view', 'add', 'edit', 'delete'],
    vqueue: ['view', 'add', 'edit', 'delete'],
    vivr: ['view', 'add', 'edit', 'delete'],
    vsound: ['view', 'add', 'edit', 'delete'],
    vroute: ['view', 'add', 'edit', 'delete'],
    vout: ['view'],
    users: ['view', 'add', 'edit', 'delete'],
  });
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
      tenants: tenants.map(t => ({
        ...t,
        features: cleanFeatures(t.features),
        dids: (byTenant.get(t.id) || []).map(d => ({ id: d.id, did: d.did, note: d.note || '' })),
        users: (usersBy.get(t.id) || []).map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })),
      })),
    };
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

  /** What the signed-in tenant user may see about their own access. */
  @Get('me')
  async mine(@CurrentUser() me: Me) {
    if (!me.tenantId) {
      if (!isSuperAdmin(me)) return { tenant: null, dids: [], superAdmin: false, features: null };
      return { tenant: null, dids: [], superAdmin: true, features: null, ...(await this.tenants.list()) };
    }
    const t = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
    if (!t) return { tenant: null, dids: [], superAdmin: false, features: null };
    const dids = await this.db.didAssignment.findMany({ where: { tenantId: t.id }, orderBy: { did: 'asc' } });
    const features = cleanFeatures(t.features);
    return {
      superAdmin: false,
      tenant: { id: t.id, name: t.name, slug: t.slug, active: t.active, defaultDest: t.defaultDest, note: t.note },
      features,
      dids: dids.map(d => ({ did: d.did, note: d.note || '' })),
    };
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
    let slug = String(b.slug || '').trim().toLowerCase() || slugify(name);
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug)) throw new BadRequestException('شناسه انگلیسی مستأجر نامعتبر است');
    if (await this.db.tenant.findUnique({ where: { slug } })) {
      slug = slug.slice(0, 32) + '-' + Date.now().toString(36).slice(-6);
    }
    const defaultDest = String(b.defaultDest || '').trim().slice(0, 80);
    const features = cleanFeatures(b.features);
    const t = await this.db.tenant.create({
      data: {
        name, slug, defaultDest,
        note: String(b.note || '').trim().slice(0, 200) || null,
        active: b.active !== false,
        features: features as any,
      },
    });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.create', target: t.slug, detail: { id: t.id, name, features } as any } });
    if (b.username && b.password) {
      const username = String(b.username).trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new BadRequestException('نام کاربری مستأجر نامعتبر است');
      if (await this.db.user.findUnique({ where: { username } })) throw new BadRequestException('این نام کاربری قبلاً استفاده شده است');
      if (String(b.password).length < 6) throw new BadRequestException('رمز عبور حداقل ۶ کاراکتر باشد');
      await this.db.user.create({
        data: {
          username,
          name: String(b.userName || name).trim().slice(0, 60),
          role: 'admin',
          tenantId: t.id,
          password: await bcrypt.hash(String(b.password), 10),
          perms: tenantAdminPerms() as any,
        },
      });
    }
    if (defaultDest) await this.tenants.reapply().catch(() => null);
    return { id: t.id, slug: t.slug, features };
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
    if (b.features !== undefined) data.features = cleanFeatures(b.features) as any;
    const t = await this.db.tenant.update({ where: { id }, data });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.update', target: t.slug, detail: data } });
    forgetUser();
    await this.tenants.reapply().catch(() => null);
    return { ok: true, features: cleanFeatures(t.features) };
  }

  @Roles('admin')
  @Put(':id/features')
  async setFeatures(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const cur = await this.db.tenant.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('مستأجر پیدا نشد');
    const features = cleanFeatures({ ...cleanFeatures(cur.features), ...(b.features || b) });
    await this.db.tenant.update({ where: { id }, data: { features: features as any } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.features', target: cur.slug, detail: features as any } });
    forgetUser();
    await this.tenants.reapply().catch(() => null);
    return { ok: true, features };
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
  async assign(@Param('id') id: string, @Body() b: { did?: string; note?: string }, @CurrentUser() me: Me) {
    this.assertSuper(me);
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new BadRequestException('مستأجر پیدا نشد');
    const did = normalizePoolDid(b.did);
    const other = await this.db.didAssignment.findUnique({ where: { did } });
    if (other) throw new BadRequestException(other.tenantId === id ? 'این شماره قبلاً به همین مستأجر داده شده' : 'این شماره به مستأجر دیگری تخصیص داده شده');
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
    const u = await this.db.user.create({
      data: {
        username, name, role, tenantId: id,
        password: await bcrypt.hash(String(b.password), 10),
        perms: (role === 'admin' ? tenantAdminPerms() : cleanPerms(b.perms || rolePerms(role))) as any,
      },
    });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.user.create', target: username, detail: { tenantId: id, role } as any } });
    return { id: u.id, username };
  }

}
