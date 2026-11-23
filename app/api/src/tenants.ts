// Multi-tenant admin: tenants + DID pool 31985000…31985999 on trunk 31985.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, Post, Put } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, Me, Roles, forgetUser, isSuperAdmin } from './auth';
import { ConfigStore } from './config';
import { cleanPerms, rolePerms } from './perms';
import { PrismaService } from './prisma.service';

export const DID_POOL_MIN = 31985000;
export const DID_POOL_MAX = 31985999;
export const DID_POOL_PREFIX = '31985';

export const digits = (s: any) => String(s ?? '').replace(/\D/g, '');

/** True when the number is in the product DID pool (31985000…31985999). */
export function isPoolDid(raw: any): boolean {
  const d = digits(raw);
  if (d.length !== 8 || !d.startsWith(DID_POOL_PREFIX)) return false;
  const n = Number(d);
  return n >= DID_POOL_MIN && n <= DID_POOL_MAX;
}

export function normalizePoolDid(raw: any): string {
  const d = digits(raw);
  if (!isPoolDid(d)) throw new BadRequestException('شماره باید بین ۳۱۹۸۵۰۰۰ و ۳۱۹۸۵۹۹۹ باشد');
  return d;
}

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

@Injectable()
export class TenantsService {
  constructor(private db: PrismaService, private store: ConfigStore) {}

  async didsOf(tenantId: string): Promise<string[]> {
    const rows = await this.db.didAssignment.findMany({ where: { tenantId }, select: { did: true } });
    return rows.map(r => r.did);
  }

  /** Dialplan DID → tenant dest rows (active tenants with a destination). */
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
      // first 40 free numbers for the assign UI (full free list is huge)
      freeSample: free.slice(0, 40),
      tenants: tenants.map(t => ({
        ...t,
        dids: (byTenant.get(t.id) || []).map(d => ({ id: d.id, did: d.did, note: d.note || '' })),
        users: (usersBy.get(t.id) || []).map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })),
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
    const t = await this.db.tenant.create({
      data: { name, slug, defaultDest, note: String(b.note || '').trim().slice(0, 200) || null, active: b.active !== false },
    });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.create', target: t.slug, detail: { id: t.id, name } as any } });
    // optional first user for the tenant
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
          // tenant «admin» is scoped: no trunk / no platform tenants section
          perms: cleanPerms({
            ...rolePerms('supervisor'),
            vext: ['view', 'add', 'edit', 'delete'],
            vqueue: ['view', 'add', 'edit', 'delete'],
            vivr: ['view', 'add', 'edit', 'delete'],
            vsound: ['view', 'add', 'edit', 'delete'],
            vroute: ['view', 'add', 'edit', 'delete'],
            vout: ['view'],
            users: ['view', 'add', 'edit', 'delete'],
          }) as any,
        },
      });
    }
    if (defaultDest) await this.tenants.reapply().catch(() => null);
    return { id: t.id, slug: t.slug };
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
    const t = await this.db.tenant.update({ where: { id }, data });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'tenant.update', target: t.slug, detail: data } });
    forgetUser(); // tenant users may need fresh context
    await this.tenants.reapply().catch(() => null);
    return { ok: true };
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

  /** What the signed-in tenant user may see about their own access. */
  @Get('me')
  async mine(@CurrentUser() me: Me) {
    if (!me.tenantId) {
      if (!isSuperAdmin(me)) return { tenant: null, dids: [], superAdmin: false };
      return { tenant: null, dids: [], superAdmin: true, ...(await this.tenants.list()) };
    }
    const t = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
    if (!t) return { tenant: null, dids: [], superAdmin: false };
    const dids = await this.db.didAssignment.findMany({ where: { tenantId: t.id }, orderBy: { did: 'asc' } });
    return {
      superAdmin: false,
      tenant: { id: t.id, name: t.name, slug: t.slug, active: t.active, defaultDest: t.defaultDest, note: t.note },
      dids: dids.map(d => ({ did: d.did, note: d.note || '' })),
    };
  }
}
