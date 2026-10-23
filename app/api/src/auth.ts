import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post, SetMetadata, UnauthorizedException, UseGuards, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { env } from './env';
import { PrismaService } from './prisma.service';

export interface Me { id: string; name: string; role: string; ext: string | null; username: string }

export const Roles = (...r: string[]) => SetMetadata('roles', r);
export const Public = () => SetMetadata('public', true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as Me);

export function verifyToken(t: string): Me | null {
  try { return jwt.verify(t, env.jwtSecret) as Me; } catch { return null; }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext) {
    const h = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', h)) return true;
    const req = ctx.switchToHttp().getRequest();
    const raw = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token || '';
    const me = raw && verifyToken(String(raw));
    if (!me) throw new UnauthorizedException('ابتدا وارد شوید');
    req.user = me;
    const roles = this.reflector.getAllAndOverride<string[]>('roles', h);
    if (roles && roles.length && !roles.includes(me.role)) throw new ForbiddenException('دسترسی به این بخش مجاز نیست');
    return true;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private db: PrismaService) {}

  @Public()
  @Post('login')
  async login(@Body() b: { username: string; password: string }) {
    const u = await this.db.user.findUnique({ where: { username: String(b.username || '').toLowerCase() } });
    if (!u || !u.active || !(await bcrypt.compare(String(b.password || ''), u.password))) throw new UnauthorizedException('نام کاربری یا رمز عبور اشتباه است');
    const me: Me = { id: u.id, name: u.name, role: u.role, ext: u.ext, username: u.username };
    await this.db.auditLog.create({ data: { userId: u.id, userName: u.name, action: 'login', target: 'auth' } });
    return { token: jwt.sign(me, env.jwtSecret, { expiresIn: '12h' }), me };
  }

  @Get('me')
  me(@CurrentUser() me: Me) { return me; }
}

export { UseGuards };
