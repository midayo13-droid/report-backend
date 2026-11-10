import { BadRequestException, Body, Controller, Get, Header, Injectable, NotFoundException, Param, Post, Put, StreamableFile } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.js';
import { addDays, today } from '../common/dates.js';
import { computeCustomChart, customOptions, validateCustomSpec } from '../domain/custom-chart.js';
import {
  CHART_LABEL,
  KPI_LABEL,
  SECTION_LABEL,
  TEMPLATE_NAME,
  allowedKeys,
  chartChoices,
  defaultConfig,
  describeChanges,
  validateTemplateConfig,
  withLaterAddedSections,
  type TemplateConfig,
  type TemplateType,
} from '../domain/template-config.js';

const TYPES: TemplateType[] = ['daily', 'weekly', 'monthly'];

function asType(code: string): TemplateType {
  if (!TYPES.includes(code as TemplateType)) throw new NotFoundException('없는 양식이에요. (daily, weekly, monthly)');
  return code as TemplateType;
}

@Injectable()
export class TemplatesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async list() {
    const rows = await this.db.query<any>(
      `SELECT t.id, t.code, t.name, v.id AS version_id, v.version_no, v.note, v.source, v.created_at, u.name AS created_by_name
       FROM report_templates t
       LEFT JOIN template_versions v ON v.id = t.current_version_id
       LEFT JOIN users u ON u.id = v.created_by ORDER BY t.id`,
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      currentVersion: r.version_id ? { id: r.version_id, versionNo: r.version_no, note: r.note, source: r.source, createdAt: r.created_at, createdBy: r.created_by_name } : null,
    }));
  }

  options(type: TemplateType) {
    const keys = allowedKeys(type);
    return {
      sections: keys.map((k) => ({ key: k, label: SECTION_LABEL[k], charts: chartChoices(k).map((c) => ({ key: c, label: CHART_LABEL[c] })) })),
      kpiItems: Object.entries(KPI_LABEL).map(([key, label]) => ({ key, label })),
      custom: customOptions(),
    };
  }

  /** "그래프 추가" 화면의 미리보기예요. 어제까지의 실제(가상) 데이터로 계산해서 보여 줘요. */
  async customPreview(code: string, spec: unknown) {
    const type = asType(code);
    const check = validateCustomSpec(spec);
    if (!check.ok || !check.spec) throw new BadRequestException({ message: '그래프 설정을 확인해 주세요.', errors: check.errors });
    const end = addDays(today(), -1);
    const start = addDays(end, type === 'daily' ? 0 : type === 'weekly' ? -6 : -29);
    return computeCustomChart((sql, params) => this.db.query<any>(sql, params), check.spec, start, end);
  }

  async get(code: string) {
    const type = asType(code);
    const t = await this.db.one<any>('SELECT id, code, name, current_version_id FROM report_templates WHERE code = $1', [type]);
    if (!t) throw new NotFoundException('양식을 찾을 수 없어요.');
    const versions = await this.db.query<any>(
      `SELECT v.id, v.version_no, v.note, v.source, v.created_at, u.name AS created_by_name, v.config
       FROM template_versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.template_id = $1 ORDER BY v.version_no DESC`,
      [t.id],
    );
    const current = versions.find((v) => v.id === t.current_version_id);
    return {
      code: t.code,
      name: t.name,
      current: current ? { id: current.id, versionNo: current.version_no, config: withLaterAddedSections(type, current.config as TemplateConfig) } : null,
      versions: versions.map((v) => ({ id: v.id, versionNo: v.version_no, note: v.note, source: v.source, createdAt: v.created_at, createdBy: v.created_by_name, isCurrent: v.id === t.current_version_id })),
      options: this.options(type),
    };
  }

  async currentConfig(type: TemplateType): Promise<{ versionId: number; versionNo: number; config: TemplateConfig }> {
    const r = await this.db.one<any>(
      `SELECT v.id, v.version_no, v.config FROM report_templates t JOIN template_versions v ON v.id = t.current_version_id WHERE t.code = $1`,
      [type],
    );
    if (!r) return { versionId: 0, versionNo: 0, config: defaultConfig(type) };
    return { versionId: r.id, versionNo: r.version_no, config: withLaterAddedSections(type, r.config) };
  }

  /** 설정을 검사해서 새 양식 버전으로 저장해요. 공개된 보고서는 바뀌지 않고, 승인 전 보고서만 새 양식을 따라가요. */
  async save(user: AuthUser, code: string, config: unknown, note: string, source: 'manual' | 'ai' | 'upload' | 'rollback') {
    const type = asType(code);
    const check = validateTemplateConfig(type, config);
    if (!check.ok || !check.config) throw new BadRequestException({ message: '양식 설정을 확인해 주세요.', errors: check.errors });
    const t = await this.db.one<any>('SELECT id FROM report_templates WHERE code = $1', [type]);
    const out = await this.db.tx(async (c) => {
      const n = await c.query('SELECT COALESCE(max(version_no),0)+1 AS n FROM template_versions WHERE template_id = $1', [t.id]);
      const ins = await c.query(
        'INSERT INTO template_versions (template_id, version_no, config, note, source, created_by) VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id, version_no',
        [t.id, n.rows[0].n, JSON.stringify(check.config), note.slice(0, 120), source, user.id],
      );
      await c.query('UPDATE report_templates SET current_version_id = $2 WHERE id = $1', [t.id, ins.rows[0].id]);
      const upd = await c.query(`UPDATE reports SET template_version_id = $2 WHERE report_type = $1 AND status <> 'published'`, [type, ins.rows[0].id]);
      return { id: ins.rows[0].id, versionNo: ins.rows[0].version_no, updatedReports: upd.rowCount ?? 0 };
    });
    await this.audit.write(user.id, `template.${source === 'manual' ? 'update' : source}`, 'template', type, { version: out.versionNo, note });
    return out;
  }

  async rollback(user: AuthUser, code: string, versionId: number) {
    const type = asType(code);
    const v = await this.db.one<any>(
      `SELECT v.config, v.version_no FROM template_versions v JOIN report_templates t ON t.id = v.template_id WHERE v.id = $1 AND t.code = $2`,
      [versionId, type],
    );
    if (!v) throw new NotFoundException('그 버전을 찾을 수 없어요.');
    return this.save(user, type, v.config, `버전 ${v.version_no}으로 되돌렸어요.`, 'rollback');
  }

  /** 변경 전후를 쉬운 말로 비교해 줘요. (적용하기 전에 미리 볼 때 써요) */
  preview(type: TemplateType, before: TemplateConfig, after: TemplateConfig) {
    return describeChanges(before, after);
  }

  sample(code: string) {
    const type = asType(code);
    const cfg = defaultConfig(type);
    const doc = {
      _설명: `${TEMPLATE_NAME[type]} 양식 설정 샘플이에요. 항목 순서를 바꾸거나 enabled 를 false 로 바꿔서 쓰세요. 계산 방법은 여기서 바꿀 수 없어요.`,
      _그래프종류: Object.fromEntries(allowedKeys(type).filter((k) => chartChoices(k).length).map((k) => [k, chartChoices(k)])),
      _핵심숫자항목: Object.keys(KPI_LABEL),
      ...cfg,
    };
    return JSON.stringify(doc, null, 2);
  }
}

@Controller('templates')
@Roles('user', 'admin')
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post(':code/custom-preview')
  customPreview(@Param('code') code: string, @Body() b: any) {
    return this.svc.customPreview(code, b?.spec);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.svc.get(code);
  }

  @Get(':code/sample')
  @Header('Content-Type', 'application/json; charset=utf-8')
  sample(@Param('code') code: string) {
    return new StreamableFile(Buffer.from(this.svc.sample(code), 'utf8'), {
      type: 'application/json; charset=utf-8',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(`양식샘플_${code}.json`)}`,
    });
  }

  @Put(':code/config')
  save(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: any) {
    return this.svc.save(u, code, b?.config, String(b?.note ?? '양식을 고쳤어요.'), 'manual');
  }

  /** 샘플 모양의 설정 파일을 올려서 적용해요. */
  @Post(':code/import')
  import(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: any) {
    const raw = b?.config;
    if (!raw || typeof raw !== 'object') throw new BadRequestException('설정 파일 내용이 필요해요.');
    const clean = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
    return this.svc.save(u, code, clean, '설정 파일을 올렸어요.', 'upload');
  }

  @Post(':code/rollback')
  rollback(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body() b: any) {
    return this.svc.rollback(u, code, Number(b?.versionId));
  }
}
