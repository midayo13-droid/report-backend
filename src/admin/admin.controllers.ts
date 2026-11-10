import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Public, Roles, type AuthUser } from '../auth/auth.js';
import { CollectorService } from '../collector/collector.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { SeedService } from '../seed/seed.service.js';
import { encryptText, maskKey } from '../common/crypto.js';
import { AREA_LABEL, CHANNELS, ROLE_LABEL, type Area, type Role } from '../domain/constants.js';
import { today } from '../common/dates.js';

const demoOn = () => (process.env.DEMO_MODE ?? 'true') !== 'false';

// ------------------------------------------------------------------ 상태 확인
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService, private readonly seed: SeedService) {}

  @Public()
  @Get()
  async health() {
    let dbOk = false;
    try {
      await this.db.one('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return { ok: dbOk, now: new Date().toISOString(), today: today(), demo: demoOn(), seed: { status: this.seed.status, message: this.seed.message } };
  }
}

// ------------------------------------------------------------------ 계정 관리 (총관리자)
@Controller('users')
@Roles('superadmin')
export class UsersController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  async list() {
    const rows = await this.db.query<any>('SELECT id, name, email, role, area, title, is_active, created_at FROM users ORDER BY id');
    return rows.map((r) => ({ ...r, roleLabel: ROLE_LABEL[r.role as Role], areaLabel: AREA_LABEL[r.area as Area] }));
  }

  private check(b: any, create: boolean) {
    const out: any = {};
    if (create || b.name !== undefined) {
      const n = String(b.name ?? '').trim();
      if (n.length < 1 || n.length > 30) throw new BadRequestException('이름은 1~30자로 써 주세요.');
      out.name = n;
    }
    if (create || b.email !== undefined) {
      const e = String(b.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 80) throw new BadRequestException('이메일 모양이 올바르지 않아요.');
      out.email = e;
    }
    if (create || b.role !== undefined) {
      if (!['viewer', 'user', 'admin', 'superadmin'].includes(b.role)) throw new BadRequestException('역할을 골라 주세요.');
      out.role = b.role;
    }
    if (create || b.area !== undefined) {
      const a = b.area ?? 'none';
      if (!['ops', 'marketing', 'stock', 'none'].includes(a)) throw new BadRequestException('담당 영역을 골라 주세요.');
      out.area = a;
    }
    if (b.title !== undefined) out.title = String(b.title).trim().slice(0, 30);
    if (b.password !== undefined && b.password !== '') {
      if (String(b.password).length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 해요.');
      out.password = String(b.password);
    }
    if (create && !out.password) throw new BadRequestException('비밀번호를 입력해 주세요.');
    if (b.isActive !== undefined) out.isActive = !!b.isActive;
    return out;
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() b: any) {
    const v = this.check(b, true);
    const dup = await this.db.one('SELECT 1 FROM users WHERE lower(email) = $1', [v.email]);
    if (dup) throw new ConflictException('이미 있는 이메일이에요.');
    const row = await this.db.one<{ id: number }>(
      'INSERT INTO users (name,email,password_hash,role,area,title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [v.name, v.email, await bcrypt.hash(v.password, 10), v.role, v.area, v.title ?? ''],
    );
    await this.audit.write(u.id, 'user.create', 'user', row!.id, { email: v.email, role: v.role });
    return { id: row!.id };
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') idStr: string, @Body() b: any) {
    const id = Number(idStr);
    const cur = await this.db.one<any>('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
    if (!cur) throw new NotFoundException('사용자를 찾을 수 없어요.');
    const v = this.check(b ?? {}, false);
    if (id === u.id && ((v.role && v.role !== 'superadmin') || v.isActive === false)) {
      throw new ForbiddenException('내 계정은 역할을 낮추거나 정지할 수 없어요. (관리가 막히는 것을 막기 위해서예요)');
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (v.name !== undefined) add('name', v.name);
    if (v.email !== undefined) add('email', v.email);
    if (v.role !== undefined) add('role', v.role);
    if (v.area !== undefined) add('area', v.area);
    if (v.title !== undefined) add('title', v.title);
    if (v.isActive !== undefined) add('is_active', v.isActive);
    if (v.password) add('password_hash', await bcrypt.hash(v.password, 10));
    if (!sets.length) throw new BadRequestException('바꿀 내용이 없어요.');
    await this.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    await this.audit.write(u.id, 'user.update', 'user', id, { fields: Object.keys(v).filter((k) => k !== 'password') });
    return { id };
  }
}

// ------------------------------------------------------------------ 연결 키 관리 (총관리자)
@Controller('connections')
@Roles('superadmin')
export class ConnectionsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  async list() {
    const rows = await this.db.query<any>(
      `SELECT c.code, c.name, c.type, n.key_masked, n.status, n.last_checked_at, u.name AS updated_by_name
       FROM channels c LEFT JOIN connections n ON n.channel_id = c.id LEFT JOIN users u ON u.id = n.updated_by ORDER BY c.id`,
    );
    return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, keyMasked: r.key_masked ?? '', status: r.status ?? 'error', checkedAt: r.last_checked_at, updatedBy: r.updated_by_name }));
  }

  /** 새 키를 등록하거나 교체해요. 원문은 저장하지 않고 암호화한 값만 저장해요. */
  @Put(':code')
  async update(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: any) {
    const ch = CHANNELS.find((c) => c.code === code);
    if (!ch) throw new NotFoundException('없는 수집처예요.');
    const key = String(b?.key ?? '').trim();
    if (key.length < 8 || key.length > 200) throw new BadRequestException('연결 키는 8~200자로 입력해 주세요.');
    await this.db.query(
      `UPDATE connections SET key_masked = $2, key_encrypted = $3, status = 'ok', last_checked_at = now(), updated_by = $4
       WHERE channel_id = (SELECT id FROM channels WHERE code = $1)`,
      [code, maskKey(key), encryptText(key), u.id],
    );
    await this.audit.write(u.id, 'connection.update', 'connection', code, { masked: maskKey(key) });
    return { code, keyMasked: maskKey(key), status: 'ok' };
  }
}

// ------------------------------------------------------------------ 이력
@Controller('audit')
@Roles('user', 'admin', 'superadmin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** 관리자와 총관리자는 전체, 사용자는 내가 한 일만 볼 수 있어요. */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('action') action?: string, @Query('limit') limit?: string) {
    const all = u.role === 'admin' || u.role === 'superadmin';
    return this.audit.list({ actorId: all ? undefined : u.id, action: action ? String(action).slice(0, 40) : undefined, limit: Number(limit) || 100 });
  }
}

// ------------------------------------------------------------------ 시연 컨트롤 (관리자)
@Controller('demo')
@Roles('admin')
export class DemoController {
  constructor(
    private readonly collector: CollectorService,
    private readonly reports: ReportsService,
    private readonly seed: SeedService,
    private readonly audit: AuditService,
  ) {}

  private on() {
    if (!demoOn()) throw new ForbiddenException('시연 기능이 꺼져 있어요.');
  }

  @Get('info')
  info() {
    return {
      enabled: demoOn(),
      today: today(),
      latest: { daily: this.reports.latestDate('daily'), weekly: this.reports.latestDate('weekly'), monthly: this.reports.latestDate('monthly') },
      seed: { status: this.seed.status, message: this.seed.message },
      scheduler: (process.env.ENABLE_SCHEDULER ?? 'true') !== 'false',
    };
  }

  /** 지금 수집을 실행해요. failChannel 을 주면 그 판매처는 일부러 실패시켜서 재시도와 알림을 보여 줘요. */
  @Post('collect')
  collect(@CurrentUser() u: AuthUser, @Body() b: any) {
    this.on();
    const fail = typeof b?.failChannel === 'string' && b.failChannel ? [b.failChannel] : [];
    return this.collector.runDay(u, b?.date, { failChannels: fail, failFirst: Number(b?.failFirst ?? 3) });
  }

  @Post('stock')
  stock(@CurrentUser() u: AuthUser, @Body() b: any) {
    this.on();
    return this.collector.runStockSlot(u, b?.slot === 2 ? 2 : 1, b?.date);
  }

  @Post('generate-report')
  generate(@CurrentUser() u: AuthUser, @Body() b: any) {
    this.on();
    return this.reports.generate(u, b?.type ?? 'daily', b?.date);
  }

  /** 우리 스키마(moa)만 지우고 가상 데이터를 처음 상태로 되돌려요. 다른 프로젝트 데이터는 건드리지 않아요. */
  @Post('reset')
  async reset(@CurrentUser() u: AuthUser, @Body() b: any) {
    this.on();
    if (b?.confirm !== 'RESET') throw new BadRequestException('확인을 위해 confirm 에 RESET 을 보내 주세요.');
    await this.audit.write(u.id, 'demo.reset', 'demo', '', {});
    await this.seed.reset();
    return { ok: true, message: this.seed.message };
  }
}
