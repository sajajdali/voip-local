// «کاربران و دسترسی‌ها»: panel accounts, their role template and per-section permissions.
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, Me, Perm, forgetUser } from './auth';
import { SECTIONS, cleanPerms, permsOf, rolePerms } from './perms';
import { PrismaService } from './prisma.service';

const ROLES = ['admin', 'supervisor', 'operator'];
const ROLE_LABEL: Record<string, string> = { admin: 'مدیر', supervisor: 'سرپرست', operator: 'اپراتور' };

@Perm('users')
@Controller('users')
export class UsersController {
  constructor(private db: PrismaService) {}

  @Get()
  async list() {
    const [users, logins] = await Promise.all([
      this.db.user.findMany({ orderBy: [{ role: 'asc' }, { username: 'asc' }] }),
      this.db.auditLog.groupBy({ by: ['userId'], where: { action: 'login' }, _max: { at: true } }),
    ]);
    const last = new Map(logins.map(l => [l.userId, l._max.at]));
    return {
      sections: SECTIONS, roles: ROLES.map(r => ({ id: r, label: ROLE_LABEL[r], perms: rolePerms(r) })),
      users: users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, ext: u.ext, active: u.active, perms: permsOf(u), custom: !!u.perms && u.role !== 'admin', lastLogin: last.get(u.id) || null })),
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

  /** There must always be someone who can manage users. */
  private async keepAnAdmin(exceptId: string) {
    const n = await this.db.user.count({ where: { role: 'admin', active: true, id: { not: exceptId } } });
    if (!n) throw new BadRequestException('حداقل یک مدیر فعال باید باقی بماند');
  }

  @Post()
  async create(@Body() b: any, @CurrentUser() me: Me) {
    const username = await this.check(b, null);
    if (!b.password) throw new BadRequestException('رمز عبور را وارد کنید');
    if (!String(b.name || '').trim()) throw new BadRequestException('نام را وارد کنید');
    const role = b.role || 'operator';
    const u = await this.db.user.create({ data: {
      username, name: String(b.name).trim().slice(0, 60), role, ext: b.ext ? String(b.ext) : null, active: b.active !== false,
      password: await bcrypt.hash(String(b.password), 10), perms: role === 'admin' ? undefined : (cleanPerms(b.perms) as any),
    } });
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'user.create', target: u.username, detail: { role, perms: role === 'admin' ? 'all' : cleanPerms(b.perms) } as any } });
    return { id: u.id };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() b: any, @CurrentUser() me: Me) {
    const cur = await this.db.user.findUnique({ where: { id } });
    if (!cur) throw new BadRequestException('کاربر پیدا نشد');
    const username = await this.check(b, id);
    const role = b.role ?? cur.role, active = b.active ?? cur.active;
    if (id === me.id && (!active || role !== cur.role)) throw new BadRequestException('نقش یا وضعیت حساب خودتان را نمی‌توانید تغییر دهید');
    if (cur.role === 'admin' && cur.active && (role !== 'admin' || !active)) await this.keepAnAdmin(id);
    const data: any = { role, active };
    if (b.username !== undefined) data.username = username;
    if (b.name !== undefined) data.name = String(b.name).trim().slice(0, 60) || cur.name;
    if (b.ext !== undefined) data.ext = b.ext ? String(b.ext) : null;
    if (b.password) data.password = await bcrypt.hash(String(b.password), 10);
    if (role === 'admin') data.perms = null; else if (b.perms !== undefined) data.perms = cleanPerms(b.perms);
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
    if (cur.role === 'admin' && cur.active) await this.keepAnAdmin(id);
    await this.db.user.delete({ where: { id } });
    forgetUser(id);
    await this.db.auditLog.create({ data: { userId: me.id, userName: me.name, action: 'user.delete', target: cur.username } });
    return { ok: true };
  }
}
