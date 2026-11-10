import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Body } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { addDays, today } from '../common/dates.js';
import { CRITERIA_BY_CODE, AREA_LABEL } from '../domain/constants.js';
import type { Crit } from '../domain/report-builder.js';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.js';

@Injectable()
export class CriteriaService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** 그 날짜에 적용 중인 기준 값과 기준 버전 번호를 돌려줘요. (승인되고 적용 시작일이 지난 것만) */
  async critAt(date: string): Promise<{ crit: Crit; versionIds: number[] }> {
    const rows = await this.db.query<{ code: string; id: number; value: string }>(
      `SELECT c.code, v.id, v.value FROM criteria c
       JOIN LATERAL (SELECT id, value FROM criteria_versions
                     WHERE criteria_id = c.id AND status = 'approved' AND effective_from <= $1::date
                     ORDER BY effective_from DESC, id DESC LIMIT 1) v ON true`,
      [date],
    );
    const crit: Crit = {};
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n)) crit[r.code] = n;
    }
    return { crit, versionIds: rows.map((r) => r.id) };
  }

  async list() {
    const t = today();
    const cs = await this.db.query<any>('SELECT id, code, name, unit, owner_area, description FROM criteria ORDER BY id');
    const vs = await this.db.query<any>(
      `SELECT v.id, v.criteria_id, v.value, v.status, v.reason, v.reject_reason, v.effective_from, v.created_at, v.decided_at,
              p.name AS proposed_by_name, a.name AS approved_by_name
       FROM criteria_versions v
       LEFT JOIN users p ON p.id = v.proposed_by LEFT JOIN users a ON a.id = v.approved_by
       ORDER BY v.created_at DESC, v.id DESC`,
    );
    return cs.map((c) => {
      const def = CRITERIA_BY_CODE[c.code];
      const history = vs.filter((v) => v.criteria_id === c.id);
      const current = history.filter((v) => v.status === 'approved' && v.effective_from <= t).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
      const upcoming = history.find((v) => v.status === 'approved' && v.effective_from > t);
      return {
        code: c.code,
        name: c.name,
        unit: c.unit,
        ownerArea: c.owner_area,
        ownerAreaLabel: c.owner_area === 'admin' ? '관리자' : AREA_LABEL[c.owner_area as keyof typeof AREA_LABEL],
        description: c.description,
        editable: def?.editable ?? false,
        min: def?.min,
        max: def?.max,
        decimal: !!def?.decimal,
        currentValue: current?.value ?? null,
        currentSince: current?.effective_from ?? null,
        upcoming: upcoming ? { value: upcoming.value, effectiveFrom: upcoming.effective_from } : null,
        pending: history.filter((v) => v.status === 'pending').map(mapVersion),
        history: history.filter((v) => v.status !== 'pending').slice(0, 8).map(mapVersion),
      };
    });
  }

  private validateValue(code: string, raw: unknown): string {
    const def = CRITERIA_BY_CODE[code];
    if (!def) throw new NotFoundException('없는 기준이에요.');
    if (!def.editable) throw new BadRequestException('이 기준은 계산 방법이라서 바꿀 수 없어요.');
    const n = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) throw new BadRequestException('숫자로 입력해 주세요.');
    if (!def.decimal && !Number.isInteger(n)) throw new BadRequestException('정수로 입력해 주세요.');
    if (def.min !== undefined && n < def.min) throw new BadRequestException(`${def.name}은(는) ${def.min}${def.unit} 이상이어야 해요.`);
    if (def.max !== undefined && n > def.max) throw new BadRequestException(`${def.name}은(는) ${def.max}${def.unit} 이하여야 해요.`);
    return String(n);
  }

  /** 수정안 작성. 사용자는 담당 영역 기준만, 관리자는 모든 기준을 쓸 수 있고 관리자가 쓰면 바로 승인돼요. */
  async propose(u: AuthUser, code: string, value: unknown, reason: unknown) {
    const def = CRITERIA_BY_CODE[code];
    if (!def) throw new NotFoundException('없는 기준이에요.');
    if (u.role === 'user' && def.ownerArea !== u.area) {
      throw new ForbiddenException('담당 영역의 기준만 수정안을 올릴 수 있어요.');
    }
    const v = this.validateValue(code, value);
    const why = String(reason ?? '').trim();
    if (why.length < 2 || why.length > 200) throw new BadRequestException('바꾸려는 이유를 2~200자로 적어 주세요.');
    const crit = await this.db.one<{ id: number }>('SELECT id FROM criteria WHERE code = $1', [code]);
    const open = await this.db.one('SELECT 1 FROM criteria_versions WHERE criteria_id = $1 AND status = $2', [crit!.id, 'pending']);
    if (open) throw new ConflictException('이 기준에는 승인을 기다리는 수정안이 이미 있어요.');
    const latest = await this.db.one<{ value: string }>(
      `SELECT value FROM criteria_versions WHERE criteria_id = $1 AND status = 'approved' ORDER BY effective_from DESC, id DESC LIMIT 1`,
      [crit!.id],
    );
    if (latest && Number(latest.value) === Number(v)) throw new BadRequestException('지금 값과 같아요. 다른 값을 입력해 주세요.');

    const auto = u.role === 'admin';
    const effective = auto ? addDays(today(), 1) : null; // 당일 적용 불가: 항상 다음 날부터
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO criteria_versions (criteria_id,value,status,proposed_by,approved_by,reason,effective_from,decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, $8) RETURNING id`,
      [crit!.id, v, auto ? 'approved' : 'pending', u.id, auto ? u.id : null, why, effective, auto ? new Date() : null],
    );
    await this.audit.write(u.id, auto ? 'criteria.propose_approve' : 'criteria.propose', 'criteria', code, { value: v, reason: why, effectiveFrom: effective });
    return { id: row!.id, status: auto ? 'approved' : 'pending', effectiveFrom: effective };
  }

  async approve(u: AuthUser, id: number) {
    const v = await this.db.one<any>('SELECT v.*, c.code FROM criteria_versions v JOIN criteria c ON c.id = v.criteria_id WHERE v.id = $1', [id]);
    if (!v) throw new NotFoundException('없는 수정안이에요.');
    if (v.status !== 'pending') throw new ConflictException('승인을 기다리는 수정안이 아니에요.');
    const effective = addDays(today(), 1);
    await this.db.query(`UPDATE criteria_versions SET status='approved', approved_by=$2, effective_from=$3, decided_at=now() WHERE id=$1`, [id, u.id, effective]);
    await this.audit.write(u.id, 'criteria.approve', 'criteria', v.code, { value: v.value, effectiveFrom: effective });
    return { id, status: 'approved', effectiveFrom: effective };
  }

  async reject(u: AuthUser, id: number, reason: unknown) {
    const why = String(reason ?? '').trim();
    if (why.length < 2) throw new BadRequestException('반려하는 이유를 적어 주세요.');
    const v = await this.db.one<any>('SELECT v.*, c.code FROM criteria_versions v JOIN criteria c ON c.id = v.criteria_id WHERE v.id = $1', [id]);
    if (!v) throw new NotFoundException('없는 수정안이에요.');
    if (v.status !== 'pending') throw new ConflictException('승인을 기다리는 수정안이 아니에요.');
    await this.db.query(`UPDATE criteria_versions SET status='rejected', approved_by=$2, reject_reason=$3, decided_at=now() WHERE id=$1`, [id, u.id, why]);
    await this.audit.write(u.id, 'criteria.reject', 'criteria', v.code, { reason: why });
    return { id, status: 'rejected' };
  }
}

function mapVersion(v: any) {
  return {
    id: v.id,
    value: v.value,
    status: v.status,
    reason: v.reason,
    rejectReason: v.reject_reason,
    effectiveFrom: v.effective_from,
    createdAt: v.created_at,
    decidedAt: v.decided_at,
    proposedBy: v.proposed_by_name,
    approvedBy: v.approved_by_name,
  };
}

@Controller('criteria')
export class CriteriaController {
  constructor(private readonly svc: CriteriaService) {}

  @Roles('user', 'admin', 'superadmin')
  @Get()
  list() {
    return this.svc.list();
  }

  @Roles('user', 'admin')
  @Post(':code/proposals')
  propose(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: any) {
    return this.svc.propose(u, code, b?.value, b?.reason);
  }

  @Roles('admin')
  @Post('proposals/:id/approve')
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.approve(u, Number(id));
  }

  @Roles('admin')
  @Post('proposals/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) {
    return this.svc.reject(u, Number(id), b?.reason);
  }
}
