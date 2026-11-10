import {
  CanActivate,
  Body,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Post,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AREA_LABEL, ROLE_LABEL, type Area, type Role } from '../domain/constants.js';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  area: Area;
  title: string;
}

export const Public = () => SetMetadata('isPublic', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

/** 조회자를 뺀 나머지는 승인 전 보고서를 볼 수 있어요. (사용자는 확인 메모를 쓰려면 승인 전 보고서를 봐야 해요) */
export const canSeeUnpublished = (u: AuthUser) => u.role !== 'viewer';

export function publicUser(u: AuthUser) {
  return { ...u, roleLabel: ROLE_LABEL[u.role], areaLabel: AREA_LABEL[u.area] };
}

@Injectable()
export class AuthService {
  private readonly jwt: JwtService;

  constructor(private readonly db: DbService, private readonly audit: AuditService) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET 은 32자 이상이어야 해요. backend/.env 를 확인해 주세요.');
    this.jwt = new JwtService({ secret });
  }

  private sign(u: AuthUser) {
    return this.jwt.sign({ sub: u.id }, { expiresIn: '12h' });
  }

  async userById(id: number): Promise<AuthUser | undefined> {
    return this.db.one<AuthUser>('SELECT id, name, email, role, area, title FROM users WHERE id = $1 AND is_active', [id]);
  }

  async verify(token: string): Promise<AuthUser> {
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('로그인이 만료됐어요. 다시 로그인해 주세요.');
    }
    const u = await this.userById(Number(payload.sub));
    if (!u) throw new UnauthorizedException('사용할 수 없는 계정이에요.');
    return u;
  }

  private readonly fails = new Map<string, { n: number; until: number }>();

  async login(email: string, password: string) {
    const key = String(email ?? '').toLowerCase().slice(0, 80);
    const f = this.fails.get(key);
    if (f && f.n >= 5 && Date.now() < f.until) {
      throw new HttpException('로그인에 여러 번 실패해서 잠시 막았어요. 10분 뒤에 다시 시도해 주세요.', 429);
    }
    const row = await this.db.one<AuthUser & { password_hash: string }>(
      'SELECT id, name, email, role, area, title, password_hash FROM users WHERE lower(email) = lower($1) AND is_active',
      [String(email ?? '')],
    );
    if (!row || !(await bcrypt.compare(String(password ?? ''), row.password_hash))) {
      this.fails.set(key, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
      await this.audit.write(null, 'auth.login_failed', 'user', key);
      throw new UnauthorizedException('이메일이나 비밀번호가 맞지 않아요.');
    }
    this.fails.delete(key);
    const { password_hash: _ph, ...u } = row;
    await this.audit.write(u.id, 'auth.login', 'user', u.id);
    return { token: this.sign(u), user: publicUser(u) };
  }

  /** 시연용: 비밀번호 없이 들어가요. DEMO_MODE=true 일 때만 열려요. */
  async demoLogin(email: string) {
    const row = await this.db.one<AuthUser>('SELECT id, name, email, role, area, title FROM users WHERE lower(email) = lower($1) AND is_active', [String(email ?? '')]);
    if (!row) throw new NotFoundException('없는 계정이에요.');
    await this.audit.write(row.id, 'auth.demo_login', 'user', row.id);
    return { token: this.sign(row), user: publicUser(row) };
  }

  async demoAccounts() {
    const rows = await this.db.query<AuthUser>('SELECT id, name, email, role, area, title FROM users WHERE is_active ORDER BY id');
    return rows.map(publicUser);
  }
}

/** 모든 요청에서 로그인과 역할을 서버가 확인해요. 화면에서 메뉴를 숨기는 것만으로는 막은 게 아니에요. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('isPublic', targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('로그인이 필요해요.');
    const user = await this.auth.verify(token);
    req.user = user;
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', targets);
    if (roles && roles.length && !roles.includes(user.role)) {
      throw new ForbiddenException('이 기능을 쓸 수 있는 권한이 없어요.');
    }
    return true;
  }
}

function demoOn() {
  return (process.env.DEMO_MODE ?? 'true') !== 'false';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() b: any) {
    return this.auth.login(b?.email, b?.password);
  }

  @Public()
  @Get('demo-accounts')
  async demoAccounts() {
    if (!demoOn()) return { enabled: false, accounts: [] };
    return { enabled: true, accounts: await this.auth.demoAccounts() };
  }

  @Public()
  @Post('demo-login')
  demoLogin(@Body() b: any) {
    if (!demoOn()) throw new ForbiddenException('시연 로그인이 꺼져 있어요.');
    return this.auth.demoLogin(b?.email);
  }

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return publicUser(u);
  }
}
