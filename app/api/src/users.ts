// «کاربران و دسترسی‌ها»: panel accounts, their role template and per-section permissions.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, Me, Perm, forgetUser, isSuperAdmin } from './auth';
import { SECTIONS, cleanPerms, permsOf, rolePerms } from './perms';
import { PrismaService } from './prisma.service';
import { tenantAdminPerms } from './tenants';

const ROLES = ['admin', 'supervisor', 'operator'];
const ROLE_LABEL: Record<string, string> = { admin: 'مدیر', supervisor: 'سرپرست', operator: 'اپراتور' };

@Perm('users')
@Controller('users')
export class UsersController {
  constructor(private db: PrismaService) {}

  @Get()
  async list(@CurrentUser() me: Me) {
    const where = me.tenantId ? { tenantId: me.tenantId } : {};
    const [users, logins] = await Promise.all([
      this.db.user.findMany({ where, orderBy: [{ role: 'asc' }, { username: 'asc' }] }),
      this.db.auditLog.groupBy({ by: ['userId'], where: { action: 'login' }, _max: { at: true } }),
    ]);
    const last = new Map(logins.map(l => [l.userId, l._max.at]));
    return {
      sections: SECTIONS, roles: ROLES.map(r => ({ id: r, label: ROLE_LABEL[r], perms: rolePerms(r) })),
      users: users.map(u => ({ id: u.id, username: u.username, name: u.name, title: u.title || '', role: u.role, ext: u.ext, active: u.active, tenantId: u.tenantId || null, perms: permsOf(u), custom: !!u.perms && u.role !== 'admin', lastLogin: last.get(u.id) || null })),
    };
  }

  private async check(b: any, id: string | null) {
    const username = String(b.username ?? '').trim().toLowerCase();
    if (id === null || b.username !== undefined) {
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new BadRequestException('نام کاربری فقط حروف انگلیسی، عدد، نقطه و خط تیره و ۳ تا ۳۰ کاراکتر باشد');
      const other = await this.db.user.findUnique({ where: { username } });
      if (other && other.id !== id) throw new BadRequestException('این نام کاربری قبلاً استفاده شده است');
    }
    if (b.role !== undefined && !ROLES.includes(b.role)) throw new BadRequestException('نقش نامعتبر است');
    if (b.password !== undefined && b.password !== '' && String(b.password).length < 6) throw new BadRequestException('رمز عبور حداقل ۶ کاراکتر باشد');
    if (b.ext !== undefined && b.ext !== '' && b.ext !== null && !/^\d{2,6}$/.test(String(b.ext))) throw new BadRequestException('شماره داخلی نامعتبر است');
    return username;
  }

  /** There must always be someone who can manage users (scoped: platform vs same tenant). */
  private async keepAnAdmin(exceptId: string, tenantId: string | null) {
    const n = await this.db.user.count({
      where: {
        role: 'admin', active: true, id: { not: exceptId },
        ...(tenantId ? { tenantId } : { tenantId: null }),
      },
    });
    if (!n) throw new BadRequestException('حداقل یک مدیر فعال باید باقی بماند');
  }

  private assertSameTenant(me: Me, cur: { tenantId: string | null }) {
    if (isSuperAdmin(me)) return;
    if (me.tenantId) {
      if (cur.tenantId !== me.tenantId) throw new ForbiddenException('دسترسی به کاربر مستأجر دیگر مجاز نیست');
      return;
    }
  }

  @Post()
  async create(@Body() b: any, @CurrentUser() me: Me) {
    const username = await this.check(b, null);
    if (!b.password) throw new BadRequestException('رمز عبور را وارد کنید');
    if (!String(b.name || '').trim()) throw new BadRequestException('نام را وارد کنید');
    const role = b.role || 'operator';
    // Tenant admins always create users bound to their tenant; platform admin may bind via body.tenantId
    let tenantId: string | null = null;
    if (me.tenantId) {
      tenantId = me.tenantId;
      if (role === 'admin' && !me.tenantId) throw new ForbiddenException();
    } else if (isSuperAdmin(me) && b.tenantId) {
      tenantId = String(b.tenantId);
      const t = await this.db.tenant.findUnique({ where: { id: tenantId } });
      if (!t) throw new BadRequestException('مستأجر پیدا نشد');
    } else if (!isSuperAdmin(me) && b.tenantId) {
      throw new ForbiddenException('فقط مدیر سامانه می‌تواند کاربر را به مستأجر وصل کند');
    }
    const perms = tenantId
      ? (role === 'admin' ? tenantAdminPerms() : cleanPerms(b.perms || rolePerms(role)))
      : (role === 'admin' ? undefined : cleanPerms(b.perms));
    const u = await this.db.user.create({ data: {
      username, name: String(b.name).trim().slice(0, 60), title: String(b.title || '').trim().slice(0, 60) || null, role,
      ext: b.ext ? String(b.ext) : null, active: b.active !== false, tenantId,
      password: await bcrypt.hash(String(b.password), 10), perms: perms as any,
    } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'user.create', target: u.username, detail: { role, tenantId, perms: role === 'admin' && !tenantId ? 'all' : perms } as any } });
    return { id: u.id, tenantId };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    const cur = await this.db.user.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('کاربر پیدا نشد');
    this.assertSameTenant(me, cur);
    const username = await this.check(b, id);
    const role = b.role ?? cur.role, active = b.active ?? cur.active;
    if (id === me.id && (!active || role !== cur.role)) throw new BadRequestException('نقش یا وضعیت حساب خودتان را نمی‌توانید تغییر دهید');
    if (cur.role === 'admin' && cur.active && (role !== 'admin' || !active)) await this.keepAnAdmin(id, cur.tenantId);
    // Tenant users cannot promote someone out of the tenant or to platform admin
    if (me.tenantId && b.tenantId !== undefined && b.tenantId !== me.tenantId) throw new ForbiddenException('نمی‌توانید مستأجر کاربر را عوض کنید');
    const data: any = { role, active };
    if (b.username !== undefined) data.username = username;
    if (b.name !== undefined) data.name = String(b.name).trim().slice(0, 60) || cur.name;
    if (b.ext !== undefined) data.ext = b.ext ? String(b.ext) : null;
    if (b.title !== undefined) data.title = String(b.title || '').trim().slice(0, 60) || null;
    if (b.password) data.password = await bcrypt.hash(String(b.password), 10);
    if (cur.tenantId || me.tenantId) {
      data.tenantId = cur.tenantId || me.tenantId;
      data.perms = role === 'admin' ? tenantAdminPerms() : (b.perms !== undefined ? cleanPerms(b.perms) : cur.perms);
    } else if (role === 'admin') data.perms = null;
    else if (b.perms !== undefined) data.perms = cleanPerms(b.perms);
    await this.db.user.update({ where: { id }, data });
    forgetUser(id);
    const { password, ...safe } = data;
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'user.update', target: cur.username, detail: { ...safe, passwordChanged: !!b.password } } });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: Me) {
    if (id === me.id) throw new BadRequestException('حساب خودتان را نمی‌توانید حذف کنید');
    const cur = await this.db.user.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('کاربر پیدا نشد');
    this.assertSameTenant(me, cur);
    if (cur.role === 'admin' && cur.active) await this.keepAnAdmin(id, cur.tenantId);
    await this.db.user.delete({ where: { id } });
    forgetUser(id);
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'user.delete', target: cur.username } });
    return { ok: true };
  }
}
