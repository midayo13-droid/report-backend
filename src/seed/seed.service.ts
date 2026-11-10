import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { DbService } from '../db/db.service.js';
import { addDays, eachDay, isDate, kst, monthStart, today as todayStr, weekday } from '../common/dates.js';
import { encryptText, maskKey } from '../common/crypto.js';
import { CHANNELS, CRITERIA_DEFS, DEMO_ACCOUNTS } from '../domain/constants.js';
import { buildSnapshot, stockSentence, templateSummary, type Crit, type Dataset, type ReportType } from '../domain/report-builder.js';
import { defaultConfig, type TemplateConfig } from '../domain/template-config.js';
import { generate } from './generator.js';

type Col = [string, string];

async function bulk(c: pg.PoolClient, table: string, cols: Col[], rows: unknown[][], chunk = 3000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const arrays = cols.map((_, k) => part.map((r) => r[k]));
    const sel = cols.map((col, k) => `$${k + 1}::${col[1]}[]`).join(', ');
    await c.query(`INSERT INTO ${table} (${cols.map((col) => col[0]).join(', ')}) SELECT * FROM unnest(${sel})`, arrays);
  }
}

function demoPassword(): string {
  return process.env.DEMO_PASSWORD || 'MoaDemo#2026';
}

@Injectable()
export class SeedService {
  private readonly log = new Logger('Seed');
  status: 'idle' | 'running' | 'done' | 'failed' = 'idle';
  message = '';

  constructor(private readonly db: DbService) {}

  /** 테이블이 비어 있을 때만 가상 데이터를 채워요. */
  async seedIfEmpty(): Promise<boolean> {
    await this.db.ensureSchema();
    const r = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM users');
    if ((r?.n ?? 0) > 0) {
      this.status = 'done';
      return false;
    }
    await this.seedAll();
    return true;
  }

  /** 시연용 초기화: 우리 스키마만 지우고 다시 만들어요. 다른 스키마는 건드리지 않아요. */
  async reset(): Promise<void> {
    await this.db.dropOurSchema();
    await this.db.ensureSchema();
    await this.seedAll();
  }

  async seedAll(): Promise<void> {
    this.status = 'running';
    this.message = '가상 데이터를 만들고 있어요.';
    const t0 = Date.now();
    try {
      // 시연 날짜를 미리 맞출 때만 SEED_TODAY(예: 2026-11-11)를 한 번만 붙여서 실행해요. 서버 설정에는 넣지 않아요.
      const override = process.env.SEED_TODAY;
      const today = override && isDate(override) ? override : todayStr();
      if (today !== todayStr()) this.log.warn(`시연용으로 오늘 날짜를 ${today}로 맞춰서 데이터를 만들어요. (서버 날짜: ${todayStr()})`);
      const g = generate(today, 90);
      this.log.log(`가상 데이터 생성: 판매 ${g.sales.length}줄, 광고 ${g.ads.length}줄, 재고 ${g.stock.length}줄`);
      const hash = bcrypt.hashSync(demoPassword(), 10);
      const ago = (n: number) => addDays(today, -n);

      await this.db.tx(async (c) => {
        // ----- 판매처와 연결 -----
        const chIds = new Map<string, number>();
        for (const ch of CHANNELS) {
          const r = await c.query('INSERT INTO channels (code, name, type) VALUES ($1,$2,$3) RETURNING id', [ch.code, ch.name, ch.type]);
          chIds.set(ch.code, r.rows[0].id);
        }

        // ----- 사용자 -----
        const userIds = new Map<string, number>();
        for (const u of DEMO_ACCOUNTS) {
          const r = await c.query(
            'INSERT INTO users (name,email,password_hash,role,area,title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [u.name, u.email, hash, u.role, u.area, u.title],
          );
          userIds.set(u.email, r.rows[0].id);
        }
        const admin = userIds.get('director@moabeauty.test')!;
        const sysadmin = userIds.get('sysadmin@moabeauty.test')!;
        const stockUser = userIds.get('stock@moabeauty.test')!;
        const mktUser = userIds.get('mkt@moabeauty.test')!;
        const ops1 = userIds.get('ops1@moabeauty.test')!;
        const ops2 = userIds.get('ops2@moabeauty.test')!;

        for (const ch of CHANNELS) {
          const fake = `demo-${ch.code}-key-${Math.random().toString(36).slice(2, 10)}`;
          await c.query(
            'INSERT INTO connections (channel_id,key_masked,key_encrypted,status,last_checked_at,updated_by) VALUES ($1,$2,$3,$4,now(),$5)',
            [chIds.get(ch.code), maskKey(fake), encryptText(fake), 'ok', sysadmin],
          );
        }

        // ----- 상품 -----
        await bulk(c, 'products', [['id', 'int'], ['sku', 'text'], ['name', 'text'], ['category', 'text'], ['price', 'int']],
          g.products.map((p) => [p.id, p.sku, p.name, p.category, p.price]));
        await c.query(`SELECT setval(pg_get_serial_sequence('products','id'), (SELECT max(id) FROM products))`);

        // ----- 기준과 기준 버전 -----
        const critIds = new Map<string, number>();
        for (const d of CRITERIA_DEFS) {
          const r = await c.query('INSERT INTO criteria (code,name,unit,owner_area,description) VALUES ($1,$2,$3,$4,$5) RETURNING id', [d.code, d.name, d.unit, d.ownerArea, d.description]);
          critIds.set(d.code, r.rows[0].id);
        }
        interface Ver { id: number; code: string; value: string; status: string; effective: string | null }
        const versions: Ver[] = [];
        const addVer = async (code: string, value: string, status: string, proposedBy: number, approvedBy: number | null, reason: string, effective: string | null, createdAt: string, rejectReason?: string) => {
          const r = await c.query(
            `INSERT INTO criteria_versions (criteria_id,value,status,proposed_by,approved_by,reason,reject_reason,effective_from,created_at,decided_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [critIds.get(code), value, status, proposedBy, approvedBy, reason, rejectReason ?? null, effective, createdAt, status === 'pending' ? null : createdAt],
          );
          versions.push({ id: r.rows[0].id, code, value, status, effective });
        };
        for (const d of CRITERIA_DEFS) {
          const first = d.code === 'stock_warn_qty' ? '8' : d.value;
          await addVer(d.code, first, 'approved', admin, admin, '처음 정한 기준이에요.', g.start, kst(g.start, '09:00'));
        }
        await addVer('stock_warn_qty', '10', 'approved', stockUser, admin, '주의 알림이 너무 늦다는 의견이 있었어요.', ago(45), kst(ago(46), '14:10'));
        await addVer('top_n', '15', 'rejected', ops1, admin, '상품 순위를 더 길게 보고 싶어요.', null, kst(ago(20), '11:00'), '보고서가 너무 길어져요.');
        await addVer('stock_warn_qty', '15', 'pending', stockUser, null, '이벤트 때 품절이 빨라서 여유를 두고 싶어요.', null, kst(ago(1), '17:40'));

        const critAt = (date: string) => {
          const best = new Map<string, Ver>();
          for (const v of versions) {
            if (v.status !== 'approved' || !v.effective || v.effective > date) continue;
            const cur = best.get(v.code);
            if (!cur || cur.effective! < v.effective || (cur.effective === v.effective && cur.id < v.id)) best.set(v.code, v);
          }
          const crit: Crit = {};
          const ids: number[] = [];
          for (const [code, v] of best) {
            ids.push(v.id);
            const n = Number(v.value);
            if (Number.isFinite(n)) crit[code] = n;
          }
          return { crit, ids };
        };

        // ----- 양식과 양식 버전 -----
        const tplIds = new Map<ReportType, number>();
        const tplVer = new Map<string, number>();
        const names: Record<ReportType, string> = { daily: '일일 보고서', weekly: '주간 보고서', monthly: '월말 보고서' };
        for (const t of ['daily', 'weekly', 'monthly'] as ReportType[]) {
          const r = await c.query('INSERT INTO report_templates (code,name) VALUES ($1,$2) RETURNING id', [t, names[t]]);
          tplIds.set(t, r.rows[0].id);
        }
        const mkVer = async (t: ReportType, no: number, cfg: TemplateConfig, note: string, source: string, by: number | null, at: string) => {
          const r = await c.query(
            'INSERT INTO template_versions (template_id,version_no,config,note,source,created_by,created_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING id',
            [tplIds.get(t), no, JSON.stringify(cfg), note, source, by, at],
          );
          tplVer.set(`${t}:${no}`, r.rows[0].id);
        };
        await mkVer('daily', 1, defaultConfig('daily'), '처음 양식', 'seed', admin, kst(g.start, '09:00'));
        const d2 = defaultConfig('daily');
        const eff = d2.sections.find((s) => s.key === 'chart_ad_efficiency')!;
        d2.sections = d2.sections.filter((s) => s.key !== 'chart_ad_efficiency');
        d2.sections.splice(3, 0, eff);
        await mkVer('daily', 2, d2, '광고 효율 그래프를 위로 올렸어요.', 'manual', ops1, kst(ago(30), '10:20'));
        await mkVer('weekly', 1, defaultConfig('weekly'), '처음 양식', 'seed', admin, kst(g.start, '09:00'));
        // 주간·월말 양식 2번째 버전: "그래프 추가"로 만든 그래프 2개 (시연용 예시)
        // 판매처별 매출 바로 옆에 카테고리별 매출 비중이 오도록 나란히 놓아요.
        const withCustom = (cfg: TemplateConfig, day?: { title: string; days: number }) => {
          const put = (afterKey: string, sec: TemplateConfig['sections'][number]) => cfg.sections.splice(cfg.sections.findIndex((s) => s.key === afterKey) + 1, 0, sec);
          put('chart_channel_share', { key: 'custom:catshare', enabled: true, custom: { title: '카테고리별 매출 비중', metric: 'sales', groupBy: 'category', shape: 'donut', days: 0, limit: 5 } });
          if (day) put('chart_product_movers', { key: 'custom:daysales', enabled: true, custom: { title: day.title, metric: 'sales', groupBy: 'date', shape: 'line', days: day.days, limit: 10 } });
          return cfg;
        };
        await mkVer('weekly', 2, withCustom(defaultConfig('weekly'), { title: '최근 14일 일별 매출', days: 14 }), '그래프 2개를 추가했어요. (카테고리별 매출 비중, 최근 14일 일별 매출)', 'manual', ops1, kst(ago(30), '10:40'));
        await mkVer('monthly', 1, defaultConfig('monthly'), '처음 양식', 'seed', admin, kst(g.start, '09:00'));
        await mkVer('monthly', 2, withCustom(defaultConfig('monthly')), '그래프를 추가했어요. (카테고리별 매출 비중)', 'manual', ops1, kst(ago(30), '10:45'));
        await c.query('UPDATE report_templates SET current_version_id = $2 WHERE id = $1', [tplIds.get('daily'), tplVer.get('daily:2')]);
        await c.query('UPDATE report_templates SET current_version_id = $2 WHERE id = $1', [tplIds.get('weekly'), tplVer.get('weekly:2')]);
        await c.query('UPDATE report_templates SET current_version_id = $2 WHERE id = $1', [tplIds.get('monthly'), tplVer.get('monthly:2')]);

        // ----- 판매·광고·재고·수집 기록 -----
        await bulk(c, 'sales_daily', [['sales_date', 'date'], ['channel_id', 'int'], ['product_id', 'int'], ['orders', 'int'], ['quantity', 'int'], ['amount', 'bigint'], ['cancels', 'int']],
          g.sales.map((s) => [s.date, chIds.get(s.channel), s.productId, s.orders, s.quantity, s.amount, s.cancels]));
        await bulk(c, 'ad_daily', [['ad_date', 'date'], ['channel_id', 'int'], ['cost', 'bigint'], ['clicks', 'int']],
          g.ads.map((a) => [a.date, chIds.get(a.channel), a.cost, a.clicks]));
        await bulk(c, 'stock_snapshots', [['snap_date', 'date'], ['slot', 'smallint'], ['captured_at', 'timestamptz'], ['product_id', 'int'], ['quantity', 'int']],
          g.stock.map((s) => [s.date, s.slot, kst(s.date, s.slot === 1 ? '09:05' : '15:00'), s.productId, s.qty]));
        await bulk(c, 'collect_runs', [['run_date', 'date'], ['channel_id', 'int'], ['status', 'text'], ['row_count', 'int'], ['error_message', 'text'], ['retry_count', 'int'], ['started_at', 'timestamptz'], ['finished_at', 'timestamptz']],
          g.runs.map((r) => [r.runDate, chIds.get(r.channel), r.status, r.rowCount, r.error ?? null, r.retry, kst(r.runDate, r.startHm), kst(r.runDate, r.endHm)]));

        // ----- 보고서 만들기에 쓰는 자료 -----
        const dcMap = new Map<string, { date: string; channel: string; amount: number; orders: number; quantity: number; cancels: number }>();
        const dpMap = new Map<string, { date: string; productId: number; amount: number; quantity: number }>();
        for (const s of g.sales) {
          const k1 = `${s.date}|${s.channel}`;
          const a = dcMap.get(k1) ?? { date: s.date, channel: s.channel, amount: 0, orders: 0, quantity: 0, cancels: 0 };
          a.amount += s.amount; a.orders += s.orders; a.quantity += s.quantity; a.cancels += s.cancels;
          dcMap.set(k1, a);
          const k2 = `${s.date}|${s.productId}`;
          const b = dpMap.get(k2) ?? { date: s.date, productId: s.productId, amount: 0, quantity: 0 };
          b.amount += s.amount; b.quantity += s.quantity;
          dpMap.set(k2, b);
        }
        const lastRun = new Map<string, (typeof g.runs)[number]>();
        for (const r of g.runs) lastRun.set(`${r.runDate}|${r.channel}`, r);
        const issues = [...lastRun.values()]
          .filter((r) => r.status !== 'success')
          .map((r) => ({ date: r.runDate, channel: r.channel, status: r.status, message: r.error ?? '' }));
        const ds: Dataset = {
          channelNames: Object.fromEntries(CHANNELS.map((x) => [x.code, x.name])),
          dayChannel: [...dcMap.values()],
          dayProduct: [...dpMap.values()],
          ads: g.ads,
          stock: g.stock.filter((s) => s.slot === 1).map((s) => ({ date: s.date, productId: s.productId, qty: s.qty })),
          products: g.products.map((p) => ({ id: p.id, name: p.name, category: p.category })),
          issues,
          dataStart: g.start,
        };

        // ----- 보고서 -----
        const plan: { type: ReportType; date: string }[] = [];
        for (const d of eachDay(addDays(g.start, 8), today)) plan.push({ type: 'daily', date: d });
        for (const d of eachDay(addDays(g.start, 15), today)) {
          if (weekday(d) === 1) plan.push({ type: 'weekly', date: d });
          if (d.endsWith('-01') && monthStart(addDays(d, -1)) >= g.start) plan.push({ type: 'monthly', date: d });
        }
        const rejectedDate = ago(12);
        const rows: any[][] = [];
        const links: { idx: number; ids: number[] }[] = [];
        plan.forEach((p, idx) => {
          const { crit, ids } = critAt(p.date);
          const snap = buildSnapshot(p.type, ds, p.date, crit);
          const verKey = p.type === 'daily' ? (p.date >= ago(30) ? 'daily:2' : 'daily:1') : `${p.type}:${p.date >= ago(30) ? 2 : 1}`;
          const pending = p.date === today;
          const rejected = p.type === 'daily' && p.date === rejectedDate;
          const minute = String(20 + (Number(p.date.slice(8)) % 30)).padStart(2, '0');
          rows.push([
            p.type, p.date, snap.meta.periodStart, snap.meta.periodEnd, tplVer.get(verKey),
            pending ? 'pending' : rejected ? 'rejected' : 'published',
            JSON.stringify(snap), templateSummary(snap),
            pending || rejected ? null : admin,
            pending || rejected ? null : kst(p.date, `09:${minute}`),
            rejected ? '핵심 숫자 항목이 빠져 있어요. 다시 만들어 주세요.' : null,
            kst(p.date, '09:10'),
          ]);
          links.push({ idx, ids });
        });
        const reportIds: number[] = [];
        for (let i = 0; i < rows.length; i += 40) {
          const part = rows.slice(i, i + 40);
          const ph = part.map((_, k) => `(${Array.from({ length: 12 }, (__, j) => `$${k * 12 + j + 1}${j === 6 ? '::jsonb' : ''}`).join(',')})`).join(',');
          const r = await c.query(
            `INSERT INTO reports (report_type,report_date,period_start,period_end,template_version_id,status,data_snapshot,summary_text,approved_by,approved_at,rejected_reason,created_at)
             VALUES ${ph} RETURNING id`,
            part.flat(),
          );
          for (const x of r.rows) reportIds.push(x.id);
        }
        const rc: unknown[][] = [];
        links.forEach((l) => l.ids.forEach((id) => rc.push([reportIds[l.idx], id])));
        await bulk(c, 'report_criteria', [['report_id', 'int'], ['criteria_version_id', 'int']], rc);
        const idOf = (type: ReportType, date: string) => reportIds[plan.findIndex((p) => p.type === type && p.date === date)];

        // ----- 확인 메모 -----
        const notes: [string, string, string, number, string][] = [
          [addDays(g.marks.eventDays[0], 1), 'sales', '인스타 이벤트로 주문이 크게 늘었어요.', mktUser, '1'],
          [addDays(g.marks.eventDays[1], 1), 'sales', '두 번째 이벤트예요. 광고비도 같이 늘렸어요.', mktUser, '1'],
          [addDays(g.marks.outageDay, 1), 'orders', '스마트스토어와 쿠팡 연결 장애로 주문 일부가 빠졌어요. 복구 뒤 다시 확인했어요.', ops1, '1'],
          [addDays(g.marks.cancelSpikeDays[0], 1), 'cancelRate', '배송 지연 공지 뒤에 취소가 늘었어요.', ops2, '1'],
          [addDays(g.marks.cancelSpikeDays[1], 1), 'cancelRate', '품절 상품이 있어서 취소가 늘었어요.', ops2, '1'],
          [today, 'stock:1', '수분 크림은 입고 예정이 3일 뒤예요.', stockUser, '1'],
        ];
        const nrows = notes.filter((n) => idOf('daily', n[0])).map((n) => [idOf('daily', n[0]), n[1], n[2], n[3], 'manual', kst(n[0], '09:20')]);
        await bulk(c, 'anomaly_notes', [['report_id', 'int'], ['metric_key', 'text'], ['note', 'text'], ['author_id', 'int'], ['source', 'text'], ['created_at', 'timestamptz']], nrows);

        // ----- AI 제안 예시와 이력 -----
        const dailyToday = idOf('daily', today);
        await c.query(
          `INSERT INTO ai_suggestions (kind,target_type,target_id,request_text,output,status,source,requested_by,decided_by,created_at,decided_at) VALUES
           ('template_change','template',$1,'광고 효율 그래프를 위로 올려줘',$2::jsonb,'applied','mock',$3,$3,$4,$4),
           ('template_change','template',$1,'취소율 계산에 환불도 넣어줘',$5::jsonb,'failed','mock',$3,NULL,$6,NULL),
           ('cause_candidates','report',$7,'매출이 늘어난 이유',$8::jsonb,'applied','mock',$9,$9,$10,$10)`,
          [
            tplIds.get('daily'),
            JSON.stringify({ summary: '"광고 효율 추이"를 4번째로 옮겨요.', changes: ['"광고 효율 추이" 위치: 6번째 → 4번째'] }),
            ops1, kst(ago(30), '10:19'),
            JSON.stringify({ redirect: 'criteria', message: '계산 방법은 기준이라서 양식 도우미가 바꿀 수 없어요. 기준 수정안으로 올려 주세요.' }),
            kst(ago(10), '15:00'),
            idOf('daily', addDays(g.marks.eventDays[0], 1)),
            JSON.stringify({ candidates: [{ title: '인스타 광고비 증가', evidence: '이벤트 날 광고비가 평소보다 많이 늘었어요.' }] }),
            mktUser, kst(addDays(g.marks.eventDays[0], 1), '09:18'),
          ],
        );

        // 오늘 보고서에는 재고 AI 제안을 미리 하나 넣어 둬서, 처음 열어도 "AI 제안"이 보이게 해요.
        if (dailyToday) {
          const todayRow = rows[plan.findIndex((p) => p.type === 'daily' && p.date === today)];
          const alerts = (JSON.parse(todayRow[6]).stockAlerts ?? []).slice(0, 12);
          const items = alerts.map((a: any) => ({ productId: a.productId, name: a.name, level: a.level, qty: a.qty, days: a.days, depletionDays: a.depletionDays, suggestOrderQty: a.suggestOrderQty, sentence: stockSentence(a) }));
          await c.query(
            `INSERT INTO ai_suggestions (kind,target_type,target_id,request_text,output,status,source,requested_by,created_at) VALUES ('stock_suggestion','report',$1,'',$2::jsonb,'suggested','mock',$3,$4)`,
            [dailyToday, JSON.stringify({ items }), stockUser, kst(today, '09:12')],
          );
        }

        const audit: unknown[][] = [];
        plan.forEach((p, i) => {
          audit.push([null, 'report.generate', 'report', String(reportIds[i]), JSON.stringify({ type: p.type, date: p.date }), kst(p.date, '09:10')]);
          const published = p.date !== today && !(p.type === 'daily' && p.date === rejectedDate);
          if (published) audit.push([admin, 'report.publish', 'report', String(reportIds[i]), JSON.stringify({ type: p.type, date: p.date }), String(rows[i][9])]);
        });
        audit.push([admin, 'criteria.approve', 'criteria', 'stock_warn_qty', JSON.stringify({ value: '10', effectiveFrom: ago(45) }), kst(ago(46), '15:00')]);
        audit.push([admin, 'criteria.reject', 'criteria', 'top_n', JSON.stringify({ reason: '보고서가 너무 길어져요.' }), kst(ago(20), '13:00')]);
        audit.push([ops1, 'template.update', 'template', 'daily', JSON.stringify({ version: 2 }), kst(ago(30), '10:20')]);
        audit.push([sysadmin, 'connection.update', 'connection', 'all', JSON.stringify({ note: '연결 키 등록' }), kst(g.start, '09:30')]);
        await bulk(c, 'audit_logs', [['actor_id', 'int'], ['action', 'text'], ['target_type', 'text'], ['target_id', 'text'], ['detail', 'jsonb'], ['created_at', 'timestamptz']], audit);

        this.log.log(`보고서 ${plan.length}건, 확인 메모 ${nrows.length}건, 이력 ${audit.length}건`);
      });
      this.status = 'done';
      this.message = `가상 데이터를 채웠어요. (${Math.round((Date.now() - t0) / 1000)}초)`;
      this.log.log(this.message);
    } catch (e: any) {
      this.status = 'failed';
      this.message = `가상 데이터 만들기에 실패했어요: ${e?.message ?? e}`;
      this.log.error(this.message);
      throw e;
    }
  }
}
