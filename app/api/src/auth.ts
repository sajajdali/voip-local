import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, Injectable, Post, Req, SetMetadata, UnauthorizedException, UseGuards, createParamDecorator } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { env } from './env';
import { Action, Perms, can, permsOf } from './perms';
import { PrismaService } from './prisma.service';

export interface Me { id: string; name: string; role: string; ext: string | null; username: string; title?: string | null; perms?: Perms }

export const Roles = (...r: string[]) => SetMetadata('roles', r);
/** Section permission; the action defaults from the HTTP method (GET view, POST add, PUT/PATCH edit, DELETE delete). */
export const Perm = (section: string, action?: Action) => SetMetadata('perm', { section, action });
export const Public = () => SetMetadata('public', true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as Me);

export function verifyToken(t: string): Me | null {
  try { return jwt.verify(t, env.jwtSecret) as Me; } catch { return null; }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const h = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', h)) return true;
    const req = ctx.switchToHttp().getRequest();
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token || '';
    const tok = raw && verifyToken(String(raw));
    if (!tok) throw new UnauthorizedException('ابتدا وارد شوید');
    // the token only says who; role, permissions and «active» are read fresh so changes apply at once
    const me = await currentUser(this.db, tok.id);
    if (!me) throw new UnauthorizedException('حساب کاربری شما غیرفعال یا حذف شده است');
    req.user = me;
    const perm = this.reflector.getAllAndOverride<{ section: string; action?: Action }>('perm', h);
    if (perm) {
      const m = String(req.method).toUpperCase();
      const action: Action = perm.action || (m === 'GET' ? 'view' : m === 'POST' ? 'add' : m === 'DELETE' ? 'delete' : 'edit');
      if (!can(me, perm.section, action)) throw new ForbiddenException('دسترسی به این بخش مجاز نیست');
      return true;
    }
    const roles = this.reflector.getAllAndOverride<string[]>('roles', h);
    if (roles && roles.length && !roles.includes(me.role)) throw new ForbiddenException('دسترسی به این بخش مجاز نیست');
    return true;
  }
}

/** The signed-in user as stored now (short cache), or null when disabled or deleted. */
const userCache = new Map<string, { at: number; me: Me | null }>();
export function forgetUser(id?: string) { if (id) userCache.delete(id); else userCache.clear(); }
export async function currentUser(db: PrismaService, id: string): Promise<Me | null> {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 15e3) return c.me;
  const u = await db.user.findUnique({ where: { id } });
  const me: Me | null = u && u.active ? { id: u.id, name: u.name, role: u.role, ext: u.ext, username: u.username, title: u.title, perms: permsOf(u) } : null;
  userCache.set(id, { at: Date.now(), me });
  return me;
}

// ---- login protection: a numeric captcha per attempt, and a pause after repeated failures
const captchas = new Map<string, { code: string; exp: number }>();
const failures = new Map<string, { n: number; until: number; first: number }>();
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩';
const latin = (s: string) => String(s || '').replace(/[۰-۹٠-٩]/g, d => String(FA_DIGITS.indexOf(d) % 10)).replace(/\D/g, '');

// a small stroke font on a 10×16 grid
const DIGIT: Record<string, string> = {
  '0': 'M3 1 L7 1 L9 3 L9 13 L7 15 L3 15 L1 13 L1 3 Z',
  '1': 'M3 4 L6 1 L6 15 M3 15 L9 15',
  '2': 'M1 4 L3 1 L7 1 L9 3 L9 6 L1 15 L9 15',
  '3': 'M1 2 L3 1 L8 1 L9 3 L9 6 L5 8 L9 10 L9 13 L7 15 L2 15 L1 13',
  '4': 'M7 15 L7 1 L1 11 L9 11',
  '5': 'M9 1 L1 1 L1 7 L7 7 L9 9 L9 13 L7 15 L1 15',
  '6': 'M8 1 L3 1 L1 4 L1 13 L3 15 L7 15 L9 13 L9 9 L7 7 L1 7',
  '7': 'M1 1 L9 1 L4 15',
  '8': 'M3 1 L7 1 L9 3 L9 6 L7 8 L3 8 L1 10 L1 13 L3 15 L7 15 L9 13 L9 10 L7 8 M3 8 L1 6 L1 3 L3 1',
  '9': 'M9 8 L3 8 L1 6 L1 3 L3 1 L7 1 L9 3 L9 12 L7 15 L2 15',
};

function captchaSvg(code: string) {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const W = 170, H = 56;
  let g = '';
  for (let i = 0; i < 6; i++) g += `<line x1="${rnd(0, W).toFixed(0)}" y1="${rnd(0, H).toFixed(0)}" x2="${rnd(0, W).toFixed(0)}" y2="${rnd(0, H).toFixed(0)}" stroke="#${['8DC63F', 'b9bbb6', '5b9bd0', 'e0a83a'][i % 4]}" stroke-width="${rnd(1, 2).toFixed(1)}" opacity=".7"/>`;
  for (let i = 0; i < 40; i++) g += `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="${rnd(0.6, 1.6).toFixed(1)}" fill="#9a9d97" opacity=".6"/>`;
  // digits are drawn as strokes, never as text, so the answer is not sitting in the markup
  [...code].forEach((d, i) => {
    const x = 14 + i * 30 + rnd(-3, 3), y = 10 + rnd(-4, 4), k = rnd(1.9, 2.3);
    const path = DIGIT[d].replace(/-?\d+(\.\d+)?/g, n => (+n + rnd(-0.35, 0.35)).toFixed(2));
    g += `<path d="${path}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rnd(-18, 18).toFixed(0)} 5 8) scale(${k.toFixed(2)} ${(k * rnd(0.9, 1.1)).toFixed(2)})" fill="none" stroke="#2E2F31" stroke-width="${rnd(1, 1.35).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  g += `<path d="M0 ${rnd(15, 40).toFixed(0)} C ${W / 3} ${rnd(0, H).toFixed(0)}, ${(2 * W) / 3} ${rnd(0, H).toFixed(0)}, ${W} ${rnd(15, 40).toFixed(0)}" stroke="#2E2F31" stroke-width="1.6" fill="none" opacity=".55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" rx="10" fill="#f4f5f1"/>${g}</svg>`;
}

@Controller('auth')
export class AuthController {
  constructor(private db: PrismaService) {}

  /** A fresh 5-digit captcha (valid for 3 minutes, one use). */
  @Public()
  @Get('captcha')
  captcha() {
    const now = Date.now();
    for (const [k, v] of captchas) if (v.exp < now) captchas.delete(k);
    const id = randomBytes(12).toString('hex'), code = String(Math.floor(10000 + Math.random() * 90000));
    captchas.set(id, { code, exp: now + 180e3 });
    return { id, svg: captchaSvg(code) };
  }

  @Public()
  @Post('login')
  async login(@Body() b: { username: string; password: string; captchaId?: string; captcha?: string }, @Req() req: Request) {
    const xff = String(req.headers['x-forwarded-for'] || '');
    const ip = xff.split(',')[0].trim() || (req.socket.remoteAddress || '').replace('::ffff:', '');
    // the panel always comes through nginx; direct calls on the server itself (maintenance scripts) skip the captcha
    const internal = !xff && ['127.0.0.1', '::1'].includes(ip);
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.until > now) throw new HttpException(`به دلیل چند ورود ناموفق، ${Math.ceil((f.until - now) / 60000)} دقیقه دیگر دوباره تلاش کنید`, 429);
    if (!internal) {
      const c = captchas.get(String(b.captchaId || ''));
      captchas.delete(String(b.captchaId || ''));
      if (!c || c.exp < now) throw new BadRequestException('کد امنیتی منقضی شده است؛ کد جدید را وارد کنید');
      if (latin(b.captcha || '') !== c.code) throw new BadRequestException('کد امنیتی اشتباه است');
    }
    const u = await this.db.user.findUnique({ where: { username: String(b.username || '').toLowerCase() } });
    if (!u || !u.active || !(await bcrypt.compare(String(b.password || ''), u.password))) {
      const x = f && now - f.first < 600e3 ? f : { n: 0, until: 0, first: now };
      x.n++;
      if (x.n >= 5) { x.until = now + 600e3; x.n = 0; x.first = now; }
      failures.set(ip, x);
      await this.db.auditLog.create({ data: { userId: u ? u.id : 'unknown', userName: u ? u.name : String(b.username || '').slice(0, 40), action: 'login.failed', target: 'auth', detail: { ip } as any } }).catch(() => {});
      throw new UnauthorizedException('نام کاربری یا رمز عبور اشتباه است');
    }
    failures.delete(ip);
    const me: Me = { id: u.id, name: u.name, role: u.role, ext: u.ext, username: u.username };
    forgetUser(u.id);
    await this.db.auditLog.create({ data: { userId: u.id, userName: u.name, action: 'login', target: 'auth' } });
    return { token: jwt.sign(me, env.jwtSecret, { expiresIn: '12h' }), me: { ...me, title: u.title, perms: permsOf(u) } };
  }

  @Get('me')
  me(@CurrentUser() me: Me) { return me; }
}

export { UseGuards };
