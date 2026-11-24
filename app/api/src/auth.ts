import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, Injectable, Post, Req, SetMetadata, UnauthorizedException, UseGuards, createParamDecorator } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { env } from './env';
import { Action, Perms, can, permsOf } from './perms';
import { PrismaService } from './prisma.service';
import { tenantAccess } from './tenant-scope';

export interface Me {
  id: string;
  name: string;
  role: string;
  ext: string | null;
  username: string;
  title?: string | null;
  perms?: Perms;
  tenantId?: string | null;
  /** True only when a platform admin entered via «ورود با این مستأجر». */
  impersonating?: boolean;
  impersonateTenantId?: string | null;
  impersonateTenantName?: string | null;
}

/** Claims we put in the JWT. AuthGuard always reloads the live user by `id`. */
export type TokenClaims = { id: string; impTenantId?: string };

export function isSuperAdmin(me: Me | null | undefined) {
  return !!me && me.role === 'admin' && !me.tenantId && !me.impersonating;
}

export const Roles = (...r: string[]) => SetMetadata('roles', r);
/** Section permission; the action defaults from the HTTP method (GET view, POST add, PUT/PATCH edit, DELETE delete). */
export const Perm = (section: string, action?: Action) => SetMetadata('perm', { section, action });
export const Public = () => SetMetadata('public', true);
/** Allow this route even when the tenant subscription is locked/expired (paywall). */
export const AllowPaywall = () => SetMetadata('allowPaywall', true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as Me);

/** Paths tenant users may hit while subscription is locked (paywall). */
const PAYWALL_PATH_OK = [
  { m: 'GET', re: /^\/auth\/me\/?$/ },
  { m: 'GET', re: /^\/bootstrap\/?$/ },
  { m: 'GET', re: /^\/tenants\/me\/?$/ },
  { m: 'POST', re: /^\/tenants\/me\/pay\/simulate\/?$/ },
  { m: 'POST', re: /^\/auth\/stop-impersonate\/?$/ },
];

function paywallPathOk(method: string, url: string) {
  const path = String(url || '').split('?')[0];
  const m = String(method || 'GET').toUpperCase();
  return PAYWALL_PATH_OK.some(x => x.m === m && x.re.test(path));
}

export function verifyToken(t: string): TokenClaims | null {
  try {
    const raw = jwt.verify(t, env.jwtSecret) as any;
    if (!raw || !raw.id) return null;
    const claims: TokenClaims = { id: String(raw.id) };
    if (raw.impTenantId) claims.impTenantId = String(raw.impTenantId);
    return claims;
  } catch { return null; }
}

/** Live user for a token, including optional admin→tenant impersonation overlay. */
export async function resolveMe(db: PrismaService, tok: TokenClaims | null | undefined): Promise<Me | null> {
  if (!tok?.id) return null;
  const base = await currentUser(db, tok.id);
  if (!base) return null;
  if (!tok.impTenantId) return base;
  // Impersonation is only valid while the signed-in account is still a platform admin.
  if (!(base.role === 'admin' && !base.tenantId)) return null;
  const t = await db.tenant.findUnique({ where: { id: tok.impTenantId } });
  if (!t) return null;
  const { tenantAdminPerms } = await import('./tenants');
  const { cleanFeatures } = await import('./tenant-scope');
  return {
    ...base,
    tenantId: t.id,
    impersonating: true,
    impersonateTenantId: t.id,
    impersonateTenantName: t.name,
    perms: tenantAdminPerms(cleanFeatures(t.features)),
  };
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
    // the token only says who (+ optional impTenantId); role/perms/active come from DB (+ impersonation overlay)
    const me = await resolveMe(this.db, tok);
    if (!me) throw new UnauthorizedException('حساب کاربری شما غیرفعال یا حذف شده است');
    req.user = me;

    // Subscription lock: tenant may only hit paywall-safe routes until payment unlocks access
    if (me.tenantId) {
      const t = await this.db.tenant.findUnique({ where: { id: me.tenantId } });
      const access = t ? tenantAccess(t) : { locked: true, reason: 'disabled', active: false, expired: false };
      req.tenantAccess = access;
      if (access.locked) {
        const allowMeta = this.reflector.getAllAndOverride<boolean>('allowPaywall', h);
        const path = String(req.originalUrl || req.url || '').replace(/^\/api/, '') || '/';
        if (!allowMeta && !paywallPathOk(req.method, path)) {
          throw new HttpException({
            statusCode: 402,
            code: 'TENANT_LOCKED',
            reason: access.reason,
            message: access.reason === 'expired'
              ? 'اشتراک شما به پایان رسیده است؛ برای ادامه کار باید پرداخت کنید'
              : access.reason === 'disabled'
                ? 'حساب مستأجر شما غیرفعال است؛ با مدیر سامانه تماس بگیرید'
                : 'دسترسی مستأجر قفل است؛ ابتدا پرداخت یا تمدید کنید',
            expiresAt: t?.expiresAt || null,
            priceToman: t?.priceToman || 0,
            planPeriod: t?.planPeriod || '1m',
          }, 402);
        }
      }
    }

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
  const me: Me | null = u && u.active ? { id: u.id, name: u.name, role: u.role, ext: u.ext, username: u.username, title: u.title, tenantId: u.tenantId || null, perms: permsOf(u) } : null;
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
  for (let i = 0; i < 6; i++) g += `<line x1="${rnd(0, W).toFixed(0)}" y1="${rnd(0, H).toFixed(0)}" x2="${rnd(0, W).toFixed(0)}" y2="${rnd(0, H).toFixed(0)}" stroke="#${['2BB3A3', 'A9B4C4', '3B82C4', 'F2B134'][i % 4]}" stroke-width="${rnd(1, 2).toFixed(1)}" opacity=".7"/>`;
  for (let i = 0; i < 40; i++) g += `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="${rnd(0.6, 1.6).toFixed(1)}" fill="#8A97AB" opacity=".55"/>`;
  // digits are drawn as strokes, never as text, so the answer is not sitting in the markup
  [...code].forEach((d, i) => {
    const x = 14 + i * 30 + rnd(-3, 3), y = 10 + rnd(-4, 4), k = rnd(1.9, 2.3);
    const path = DIGIT[d].replace(/-?\d+(\.\d+)?/g, n => (+n + rnd(-0.35, 0.35)).toFixed(2));
    g += `<path d="${path}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rnd(-18, 18).toFixed(0)} 5 8) scale(${k.toFixed(2)} ${(k * rnd(0.9, 1.1)).toFixed(2)})" fill="none" stroke="#0B2545" stroke-width="${rnd(1, 1.35).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  g += `<path d="M0 ${rnd(15, 40).toFixed(0)} C ${W / 3} ${rnd(0, H).toFixed(0)}, ${(2 * W) / 3} ${rnd(0, H).toFixed(0)}, ${W} ${rnd(15, 40).toFixed(0)}" stroke="#0B2545" stroke-width="1.6" fill="none" opacity=".45"/>`;
  // scales to whatever box the login page gives it
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="display:block"><rect width="100%" height="100%" fill="#F7F9FC"/>${g}</svg>`;
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
    let paywall: any = null;
    if (u.tenantId) {
      const t = await this.db.tenant.findUnique({ where: { id: u.tenantId } });
      if (!t) throw new UnauthorizedException('حساب مستأجر شما یافت نشد');
      if (!t.active) throw new UnauthorizedException('حساب مستأجر شما غیرفعال است؛ با مدیر سامانه تماس بگیرید');
      const access = tenantAccess(t);
      // Expired/locked tenants may still sign in — they only see the paywall until payment unlocks them
      if (access.locked) {
        paywall = {
          locked: true,
          reason: access.reason,
          expired: access.expired,
          expiresAt: t.expiresAt,
          priceToman: t.priceToman || 0,
          planPeriod: t.planPeriod || '1m',
          name: t.name,
        };
      }
    }
    failures.delete(ip);
    const me: Me = { id: u.id, name: u.name, role: u.role, ext: u.ext, username: u.username, tenantId: u.tenantId || null };
    forgetUser(u.id);
    await this.db.auditLog.create({ data: { userId: u.id, userName: u.name, action: 'login', target: 'auth', detail: { tenantId: me.tenantId, paywall: !!paywall } as any } });
    const claims: TokenClaims = { id: me.id };
    return { token: jwt.sign(claims, env.jwtSecret, { expiresIn: '12h' }), me: { ...me, title: u.title, perms: permsOf(u) }, paywall };
  }

  @Get('me')
  me(@CurrentUser() me: Me) { return me; }

  /** Platform admin only: enter a tenant session (JWT gains impTenantId). */
  @Post('impersonate')
  async impersonate(@Body() b: { tenantId?: string }, @CurrentUser() me: Me) {
    if (!isSuperAdmin(me)) throw new ForbiddenException('فقط مدیر سامانه می‌تواند با مستأجر وارد شود');
    const tenantId = String(b?.tenantId || '').trim();
    if (!tenantId) throw new BadRequestException('شناسه مستأجر لازم است');
    const t = await this.db.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new BadRequestException('مستأجر یافت نشد');
    const claims: TokenClaims = { id: me.id, impTenantId: t.id };
    const token = jwt.sign(claims, env.jwtSecret, { expiresIn: '12h' });
    const next = await resolveMe(this.db, claims);
    await this.db.auditLog.create({
      data: { userId: me.id, userName: me.name, action: 'auth.impersonate', target: t.slug, detail: { tenantId: t.id, tenantName: t.name } as any },
    }).catch(() => {});
    return { token, me: next, tenant: { id: t.id, name: t.name, slug: t.slug } };
  }

  /** Restore platform-admin session after «ورود با این مستأجر». */
  @AllowPaywall()
  @Post('stop-impersonate')
  async stopImpersonate(@CurrentUser() me: Me, @Req() req: Request) {
    if (!me.impersonating) throw new BadRequestException('در حال حاضر در نشست مستأجر نیستید');
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '');
    const tok = raw && verifyToken(String(raw));
    // Confirm the underlying account is still a platform admin (no tenantId in DB).
    const base = tok && (await currentUser(this.db, tok.id));
    if (!base || base.role !== 'admin' || base.tenantId) throw new ForbiddenException('بازگشت به مدیریت مجاز نیست');
    const claims: TokenClaims = { id: base.id };
    const token = jwt.sign(claims, env.jwtSecret, { expiresIn: '12h' });
    await this.db.auditLog.create({
      data: {
        userId: base.id, userName: base.name, action: 'auth.stop-impersonate',
        target: me.impersonateTenantId || 'tenant',
        detail: { tenantId: me.impersonateTenantId, tenantName: me.impersonateTenantName } as any,
      },
    }).catch(() => {});
    return { token, me: { ...base, title: base.title, perms: permsOf(base) } };
  }
}

export { UseGuards };
