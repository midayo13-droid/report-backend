import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CriteriaService } from '../criteria/criteria.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { PdfService } from './pdf.service.js';
import { CurrentUser, Roles, canSeeUnpublished, type AuthUser } from '../auth/auth.js';
import { addDays, isDate, monthStart, today, weekday } from '../common/dates.js';
import { buildSnapshot, templateSummary, type Dataset, type ReportType } from '../domain/report-builder.js';
import { TEMPLATE_NAME, type TemplateType } from '../domain/template-config.js';
import { computeCustomChart, isCustomKey, validateCustomSpec, type CustomChartResult } from '../domain/custom-chart.js';

const TYPES: ReportType[] = ['daily', 'weekly', 'monthly'];

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly criteria: CriteriaService,
    private readonly templates: TemplatesService,
    private readonly pdf: PdfService,
  ) {}

  /** 보고서를 만드는 데 필요한 자료를 DB에서 읽어요. */
  async loadDataset(reportDate: string): Promise<Dataset> {
    const basis = addDays(reportDate, -1);
    const from = addDays(basis, -75);
    const stockFrom = addDays(reportDate, -40);
    const [chs, dayChannel, dayProduct, ads, stock, products, runs, first] = await Promise.all([
      this.db.query<{ code: string; name: string }>('SELECT code, name FROM channels'),
      this.db.query<any>(
        `SELECT s.sales_date AS date, c.code AS channel, sum(s.amount) AS amount, sum(s.orders) AS orders, sum(s.quantity) AS quantity, sum(s.cancels) AS cancels
         FROM sales_daily s JOIN channels c ON c.id = s.channel_id WHERE s.sales_date BETWEEN $1 AND $2 GROUP BY 1, 2`,
        [from, basis],
      ),
      this.db.query<any>(
        `SELECT sales_date AS date, product_id AS "productId", sum(amount) AS amount, sum(quantity) AS quantity
         FROM sales_daily WHERE sales_date BETWEEN $1 AND $2 GROUP BY 1, 2`,
        [from, basis],
      ),
      this.db.query<any>(
        `SELECT a.ad_date AS date, c.code AS channel, a.cost, a.clicks FROM ad_daily a JOIN channels c ON c.id = a.channel_id WHERE a.ad_date BETWEEN $1 AND $2`,
        [from, basis],
      ),
      this.db.query<any>(`SELECT snap_date AS date, product_id AS "productId", quantity AS qty FROM stock_snapshots WHERE slot = 1 AND snap_date BETWEEN $1 AND $2`, [stockFrom, reportDate]),
      this.db.query<any>('SELECT id, name, category FROM products'),
      this.db.query<any>(
        `SELECT DISTINCT ON (r.run_date, r.channel_id) r.run_date AS date, c.code AS channel, r.status, COALESCE(r.error_message,'') AS message
         FROM collect_runs r JOIN channels c ON c.id = r.channel_id
         WHERE r.run_date BETWEEN $1 AND $2 ORDER BY r.run_date, r.channel_id, r.started_at DESC, r.id DESC`,
        [from, reportDate],
      ),
      this.db.one<{ d: string }>('SELECT min(sales_date) AS d FROM sales_daily'),
    ]);
    return {
      channelNames: Object.fromEntries(chs.map((c) => [c.code, c.name])),
      dayChannel,
      dayProduct,
      ads,
      stock,
      products,
      issues: runs.filter((r) => r.status !== 'success'),
      dataStart: first?.d ?? undefined,
    };
  }

  private checkDate(type: ReportType, date: unknown): string {
    if (!isDate(date)) throw new BadRequestException('날짜는 2026-11-10 모양으로 보내 주세요.');
    if (date > today()) throw new BadRequestException('오늘보다 뒤의 날짜로는 보고서를 만들 수 없어요.');
    if (type === 'weekly' && weekday(date) !== 1) throw new BadRequestException('주간 보고서는 월요일 날짜로만 만들 수 있어요.');
    if (type === 'monthly' && !date.endsWith('-01')) throw new BadRequestException('월말 보고서는 매달 1일 날짜로만 만들 수 있어요.');
    return date;
  }

  /** 가장 최근에 만들 수 있는 날짜 (시연 버튼용) */
  latestDate(type: ReportType): string {
    const t = today();
    if (type === 'daily') return t;
    if (type === 'weekly') {
      let d = t;
      while (weekday(d) !== 1) d = addDays(d, -1);
      return d;
    }
    return monthStart(t);
  }

  async generate(user: AuthUser | null, typeIn: unknown, dateIn?: unknown) {
    if (!TYPES.includes(typeIn as ReportType)) throw new BadRequestException('보고서 종류는 daily, weekly, monthly 중 하나예요.');
    const type = typeIn as ReportType;
    const date = this.checkDate(type, dateIn ?? this.latestDate(type));
    const existing = await this.db.one<{ id: number; status: string }>('SELECT id, status FROM reports WHERE report_type = $1 AND report_date = $2', [type, date]);
    if (existing?.status === 'published') throw new ConflictException('공개된 보고서는 다시 만들 수 없어요. 고쳐야 하면 새로 만들어 다시 승인받아야 해요.');

    const [ds, { crit, versionIds }, tpl] = await Promise.all([this.loadDataset(date), this.criteria.critAt(date), this.templates.currentConfig(type as TemplateType)]);
    if (!ds.dataStart || ds.dayChannel.length === 0) throw new BadRequestException('이 날짜의 판매 자료가 아직 없어요. 먼저 수집을 실행해 주세요.');
    const snap = buildSnapshot(type, ds, date, crit);
    const summary = templateSummary(snap);

    const id = await this.db.tx(async (c) => {
      let rid: number;
      if (existing) {
        rid = existing.id;
        await c.query(
          `UPDATE reports SET period_start=$2, period_end=$3, template_version_id=$4, status='pending', data_snapshot=$5::jsonb, summary_text=$6,
                  approved_by=NULL, approved_at=NULL, rejected_reason=NULL, created_at=now() WHERE id=$1`,
          [rid, snap.meta.periodStart, snap.meta.periodEnd, tpl.versionId || null, JSON.stringify(snap), summary],
        );
        await c.query('DELETE FROM report_criteria WHERE report_id = $1', [rid]);
      } else {
        const r = await c.query(
          `INSERT INTO reports (report_type, report_date, period_start, period_end, template_version_id, status, data_snapshot, summary_text)
           VALUES ($1,$2,$3,$4,$5,'pending',$6::jsonb,$7) RETURNING id`,
          [type, date, snap.meta.periodStart, snap.meta.periodEnd, tpl.versionId || null, JSON.stringify(snap), summary],
        );
        rid = r.rows[0].id;
      }
      if (versionIds.length) {
        await c.query('INSERT INTO report_criteria (report_id, criteria_version_id) SELECT $1, unnest($2::int[])', [rid, versionIds]);
      }
      return rid;
    });
    await this.audit.write(user?.id ?? null, 'report.generate', 'report', id, { type, date, regenerated: !!existing });
    return { id, type, date, status: 'pending', regenerated: !!existing };
  }

  async list(user: AuthUser, q: any) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!canSeeUnpublished(user)) where.push(`r.status = 'published'`);
    else if (['pending', 'published', 'rejected'].includes(q.status)) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (TYPES.includes(q.type)) {
      params.push(q.type);
      where.push(`r.report_type = $${params.length}`);
    }
    if (isDate(q.from)) {
      params.push(q.from);
      where.push(`r.report_date >= $${params.length}`);
    }
    if (isDate(q.to)) {
      params.push(q.to);
      where.push(`r.report_date <= $${params.length}`);
    }
    params.push(Math.min(Math.max(Number(q.limit) || 60, 1), 200));
    const rows = await this.db.query<any>(
      `SELECT r.id, r.report_type, r.report_date, r.period_start, r.period_end, r.status, r.approved_at, r.rejected_reason, u.name AS approved_by_name,
              r.data_snapshot->'kpis' AS kpis, r.data_snapshot->'stockSummary' AS stock_summary, r.data_snapshot->'flags' AS flags,
              (r.data_snapshot->>'missingSuspected')::boolean AS missing_suspected,
              jsonb_array_length(COALESCE(r.data_snapshot->'issues','[]'::jsonb)) AS issue_count,
              (SELECT count(*)::int FROM anomaly_notes n WHERE n.report_id = r.id) AS note_count
       FROM reports r LEFT JOIN users u ON u.id = r.approved_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.report_date DESC, r.report_type LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.report_type,
      typeLabel: TEMPLATE_NAME[r.report_type as TemplateType],
      date: r.report_date,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      status: r.status,
      approvedAt: r.approved_at,
      approvedBy: r.approved_by_name,
      rejectedReason: r.rejected_reason,
      kpis: r.kpis,
      stockSummary: r.stock_summary,
      flags: r.flags,
      missingSuspected: !!r.missing_suspected,
      issueCount: r.issue_count,
      noteCount: r.note_count,
    }));
  }

  private async row(id: number) {
    if (!Number.isInteger(id)) throw new NotFoundException('보고서를 찾을 수 없어요.');
    const r = await this.db.one<any>(
      `SELECT r.*, u.name AS approved_by_name FROM reports r LEFT JOIN users u ON u.id = r.approved_by WHERE r.id = $1`,
      [id],
    );
    if (!r) throw new NotFoundException('보고서를 찾을 수 없어요.');
    return r;
  }

  /** 승인되기 전 보고서는 관리자와 총관리자만 볼 수 있어요. */
  private assertVisible(user: AuthUser, r: any) {
    if (r.status !== 'published' && !canSeeUnpublished(user)) {
      throw new ForbiddenException('승인 전 보고서는 볼 수 없어요.');
    }
  }

  async get(user: AuthUser, id: number) {
    const r = await this.row(id);
    this.assertVisible(user, r);
    const [tpl, notes, used, stockAi, runInfo] = await Promise.all([
      this.db.one<any>('SELECT v.id, v.version_no, v.config FROM template_versions v WHERE v.id = $1', [r.template_version_id]),
      this.db.query<any>(
        `SELECT n.id, n.metric_key, n.note, n.source, n.created_at, n.author_id, u.name AS author_name, u.title AS author_title
         FROM anomaly_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.report_id = $1 ORDER BY n.created_at, n.id`,
        [id],
      ),
      this.db.query<any>(
        `SELECT c.code, c.name, c.unit, v.value, v.effective_from FROM report_criteria rc
         JOIN criteria_versions v ON v.id = rc.criteria_version_id JOIN criteria c ON c.id = v.criteria_id WHERE rc.report_id = $1 ORDER BY c.id`,
        [id],
      ),
      this.db.one<any>(`SELECT id, output, source, created_at FROM ai_suggestions WHERE kind = 'stock_suggestion' AND target_type = 'report' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [id]),
      Promise.resolve(null),
    ]);
    void runInfo;
    // "그래프 추가"로 만든 그래프는 보고서를 열 때 계산해요. (더하기만 하는 숫자라 지난 데이터는 달라지지 않아요)
    const customCharts: Record<string, CustomChartResult> = {};
    const meta = r.data_snapshot?.meta;
    for (const s of (tpl?.config?.sections ?? []) as any[]) {
      if (!isCustomKey(s.key) || s.enabled === false || !meta) continue;
      const check = validateCustomSpec(s.custom);
      if (!check.ok || !check.spec) continue;
      customCharts[s.key] = await computeCustomChart((sql, params) => this.db.query<any>(sql, params), check.spec, meta.periodStart, meta.periodEnd);
    }
    return {
      id: r.id,
      type: r.report_type,
      typeLabel: TEMPLATE_NAME[r.report_type as TemplateType],
      date: r.report_date,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      status: r.status,
      summary: r.summary_text,
      approvedAt: r.approved_at,
      approvedBy: r.approved_by_name,
      rejectedReason: r.rejected_reason,
      createdAt: r.created_at,
      snapshot: r.data_snapshot,
      customCharts,
      template: tpl ? { versionId: tpl.id, versionNo: tpl.version_no, config: tpl.config } : null,
      notes: notes.map((n) => ({ id: n.id, metricKey: n.metric_key, note: n.note, source: n.source, createdAt: n.created_at, authorId: n.author_id, author: n.author_name, authorTitle: n.author_title })),
      criteriaUsed: used.map((c) => ({ code: c.code, name: c.name, unit: c.unit, value: c.value, effectiveFrom: c.effective_from })),
      aiStock: stockAi ? { id: stockAi.id, source: stockAi.source, createdAt: stockAi.created_at, items: stockAi.output?.items ?? [] } : null,
      canEdit: r.status !== 'published',
    };
  }

  async approve(user: AuthUser, id: number) {
    const r = await this.row(id);
    if (r.status !== 'pending') throw new ConflictException('승인을 기다리는 보고서만 승인할 수 있어요.');
    await this.db.query(`UPDATE reports SET status='published', approved_by=$2, approved_at=now(), rejected_reason=NULL WHERE id=$1`, [id, user.id]);
    await this.audit.write(user.id, 'report.publish', 'report', id, { type: r.report_type, date: r.report_date });
    return { id, status: 'published' };
  }

  async reject(user: AuthUser, id: number, reason: unknown) {
    const why = String(reason ?? '').trim();
    if (why.length < 2 || why.length > 200) throw new BadRequestException('반려하는 이유를 2~200자로 적어 주세요.');
    const r = await this.row(id);
    if (r.status !== 'pending') throw new ConflictException('승인을 기다리는 보고서만 반려할 수 있어요.');
    await this.db.query(`UPDATE reports SET status='rejected', rejected_reason=$2 WHERE id=$1`, [id, why]);
    await this.audit.write(user.id, 'report.reject', 'report', id, { reason: why });
    return { id, status: 'rejected' };
  }

  async setSummary(user: AuthUser, id: number, text: unknown) {
    const t = String(text ?? '').trim();
    if (t.length > 400) throw new BadRequestException('요약은 400자 이하로 써 주세요.');
    const r = await this.row(id);
    if (r.status === 'published') throw new ConflictException('공개된 보고서는 고칠 수 없어요.');
    await this.db.query('UPDATE reports SET summary_text = $2 WHERE id = $1', [id, t]);
    await this.audit.write(user.id, 'report.summary', 'report', id, {});
    return { id, summary: t };
  }

  async addNote(user: AuthUser, id: number, b: any) {
    const r = await this.row(id);
    if (r.status === 'published') throw new ConflictException('공개된 보고서에는 메모를 더할 수 없어요.');
    const note = String(b?.note ?? '').trim();
    if (note.length < 2 || note.length > 300) throw new BadRequestException('이유를 2~300자로 적어 주세요.');
    const key = String(b?.metricKey ?? 'general');
    if (!/^[a-zA-Z_]{1,24}(:[a-zA-Z0-9_]{1,24})?$/.test(key)) throw new BadRequestException('메모를 붙일 숫자 이름이 올바르지 않아요.');
    const source = b?.source === 'ai_draft' ? 'ai_draft' : 'manual';
    const row = await this.db.one<{ id: number }>('INSERT INTO anomaly_notes (report_id, metric_key, note, author_id, source) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, key, note, user.id, source]);
    await this.audit.write(user.id, 'note.add', 'report', id, { metricKey: key, source });
    return { id: row!.id };
  }

  async deleteNote(user: AuthUser, id: number, noteId: number) {
    const r = await this.row(id);
    if (r.status === 'published') throw new ConflictException('공개된 보고서의 메모는 지울 수 없어요.');
    const n = await this.db.one<any>('SELECT id, author_id FROM anomaly_notes WHERE id = $1 AND report_id = $2', [noteId, id]);
    if (!n) throw new NotFoundException('메모를 찾을 수 없어요.');
    if (n.author_id !== user.id && user.role !== 'admin') throw new ForbiddenException('내가 쓴 메모만 지울 수 있어요.');
    await this.db.query('DELETE FROM anomaly_notes WHERE id = $1', [noteId]);
    await this.audit.write(user.id, 'note.delete', 'report', id, { noteId });
    return { ok: true };
  }

  async pdfFor(user: AuthUser, id: number) {
    const detail = await this.get(user, id);
    const buf = await this.pdf.render(detail);
    const name = `모아뷰티_${detail.typeLabel.replace(' ', '')}_${detail.date}.pdf`;
    await this.audit.write(user.id, 'report.download', 'report', id, { format: 'pdf' });
    return { buf, name };
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: any) {
    return this.svc.list(u, q);
  }

  @Roles('admin')
  @Post('generate')
  generate(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.svc.generate(u, b?.type ?? 'daily', b?.date);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(u, Number(id));
  }

  @Get(':id/pdf')
  async pdf(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { buf, name } = await this.svc.pdfFor(u, Number(id));
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    return new StreamableFile(buf);
  }

  @Roles('admin')
  @Post(':id/approve')
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.approve(u, Number(id));
  }

  @Roles('admin')
  @Post(':id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) {
    return this.svc.reject(u, Number(id), b?.reason);
  }

  @Roles('user', 'admin')
  @Patch(':id/summary')
  summary(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) {
    return this.svc.setSummary(u, Number(id), b?.text);
  }

  @Roles('user', 'admin')
  @Post(':id/notes')
  addNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: any) {
    return this.svc.addNote(u, Number(id), b);
  }

  @Roles('user', 'admin')
  @Delete(':id/notes/:noteId')
  deleteNote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('noteId') noteId: string) {
    return this.svc.deleteNote(u, Number(id), Number(noteId));
  }
}
