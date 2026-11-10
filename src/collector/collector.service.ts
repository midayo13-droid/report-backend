// 가상 수집기. 실제 판매처·광고·창고 시스템에 연결하는 대신, 정해진 규칙으로 그날의 자료를 만들어 DB에 넣어요.
// 실패하면 최대 3번까지 다시 시도하고(시연에서는 기다리지 않고 바로), 모든 시도를 수집 기록에 남겨요.
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.js';
import { addDays, diffDays, isDate, today, weekday } from '../common/dates.js';
import { CHANNELS } from '../domain/constants.js';
import { mulberry32 } from '../seed/generator.js';

const MAX_TRIES = 3;
const WEEKDAY_FACTOR = [0.82, 1.04, 1.02, 1.0, 1.0, 1.06, 0.86];

export interface RunOptions {
  channels?: string[]; // 이 판매처만 수집
  failChannels?: string[]; // 시연용: 이 판매처는 일부러 실패시켜요
  failFirst?: number; // 처음 몇 번을 실패시킬지 (3이면 끝내 실패)
  types?: ('sales' | 'ad' | 'stock')[];
}

@Injectable()
export class CollectorService {
  private readonly log = new Logger('Collector');
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private checkRunDate(runDate: unknown): string {
    const d = runDate === undefined || runDate === null || runDate === '' ? today() : runDate;
    if (!isDate(d)) throw new BadRequestException('날짜는 2026-11-10 모양으로 보내 주세요.');
    if (d > today()) throw new BadRequestException('오늘보다 뒤의 날짜는 수집할 수 없어요.');
    if (diffDays(today(), d) > 30) throw new BadRequestException('최근 30일 안의 날짜만 다시 수집할 수 있어요.');
    return d;
  }

  /** 하루치(어제 마감 판매·광고)를 만들어요. 상품별 평균 판매량을 바탕으로 해서 기존 숫자와 비슷한 크기가 나와요. */
  private async virtualSalesAndAds(dataDay: string, channelCodes: { sales: string[]; ads: string[] }) {
    const products = await this.db.query<{ id: number; price: number }>('SELECT id, price FROM products');
    const base = await this.db.query<{ product_id: number; b: number }>(
      `SELECT product_id, sum(quantity)::float / 14 AS b FROM sales_daily WHERE sales_date >= $1 AND sales_date < $2 GROUP BY product_id`,
      [addDays(dataDay, -14), dataDay],
    );
    const baseMap = new Map(base.map((b) => [b.product_id, b.b]));
    const rand = mulberry32(Number(dataDay.replace(/-/g, '')) % 2147483647);
    const f = WEEKDAY_FACTOR[weekday(dataDay)];
    const sales: any[][] = [];
    let total = 0;
    for (const p of products) {
      const b = baseMap.get(p.id) ?? 3;
      for (const ch of CHANNELS.filter((c) => c.type === 'sales' && channelCodes.sales.includes(c.code))) {
        const exp = b * (ch.weight ?? 0.25) * f * (0.75 + 0.5 * rand());
        let qty = Math.round(exp + (rand() - 0.5) * Math.sqrt(Math.max(exp, 0.2)) * 2);
        if (qty < 1) {
          if (rand() < exp) qty = 1;
          else continue;
        }
        const orders = qty <= 1 ? (rand() < 0.45 ? 1 : 0) : Math.round(qty / (2.0 + rand() * 0.5));
        let cancels = 0;
        for (let k = 0; k < orders; k++) if (rand() < 0.03) cancels++;
        const amount = Math.round((qty * p.price * (0.93 + 0.07 * rand())) / 10) * 10;
        sales.push([ch.code, p.id, orders, qty, amount, cancels]);
        total += amount;
      }
    }
    const roas = 4.1 + (rand() - 0.5) * 0.4;
    const ads: any[][] = [];
    for (const [code, share] of [['naver_ad', 0.5], ['meta_ad', 0.33], ['coupang_ad', 0.17]] as [string, number][]) {
      if (!channelCodes.ads.includes(code)) continue;
      const cost = Math.round(((total / roas) * share * (0.92 + 0.16 * rand())) / 10) * 10;
      ads.push([code, cost, Math.round(cost / (380 + rand() * 160))]);
    }
    return { sales, ads };
  }

  private async record(runDate: string, channel: string, status: 'success' | 'failed' | 'partial', rowCount: number, retry: number, error?: string) {
    await this.db.query(
      `INSERT INTO collect_runs (run_date, channel_id, status, row_count, error_message, retry_count, finished_at)
       VALUES ($1, (SELECT id FROM channels WHERE code = $2), $3, $4, $5, $6, now())`,
      [runDate, channel, status, rowCount, error ?? null, retry],
    );
  }

  private async upsertSales(dataDay: string, rows: any[][]) {
    if (!rows.length) return;
    await this.db.query(
      `INSERT INTO sales_daily (sales_date, channel_id, product_id, orders, quantity, amount, cancels)
       SELECT $1::date, ch.id, t.pid, t.o, t.q, t.a, t.c
       FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::bigint[], $7::int[]) AS t(code, pid, o, q, a, c)
       JOIN channels ch ON ch.code = t.code
       ON CONFLICT (sales_date, channel_id, product_id) DO UPDATE SET orders = EXCLUDED.orders, quantity = EXCLUDED.quantity, amount = EXCLUDED.amount, cancels = EXCLUDED.cancels`,
      [dataDay, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4]), rows.map((r) => r[5])],
    );
  }

  private async upsertAds(dataDay: string, rows: any[][]) {
    for (const [code, cost, clicks] of rows) {
      await this.db.query(
        `INSERT INTO ad_daily (ad_date, channel_id, cost, clicks) VALUES ($1, (SELECT id FROM channels WHERE code = $2), $3, $4)
         ON CONFLICT (ad_date, channel_id) DO UPDATE SET cost = EXCLUDED.cost, clicks = EXCLUDED.clicks`,
        [dataDay, code, cost, clicks],
      );
    }
  }

  /** 재고를 받아요. slot 1은 아침 9시 5분, slot 2는 오후 3시예요. */
  private async collectStock(runDate: string, slot: 1 | 2): Promise<number> {
    const has = await this.db.one('SELECT 1 FROM stock_snapshots WHERE snap_date = $1 AND slot = $2 LIMIT 1', [runDate, slot]);
    const rows = await this.db.query<{ product_id: number; q: number }>(
      slot === 1
        ? `SELECT s.product_id, s.quantity AS q FROM stock_snapshots s
           WHERE (s.snap_date, s.slot) = (SELECT snap_date, slot FROM stock_snapshots WHERE snap_date < $1 ORDER BY snap_date DESC, slot DESC LIMIT 1)`
        : `SELECT product_id, quantity AS q FROM stock_snapshots WHERE snap_date = $1 AND slot = 1`,
      [runDate],
    );
    if (!rows.length) return 0;
    const sold = await this.db.query<{ product_id: number; q: number }>(
      `SELECT product_id, sum(quantity)::int AS q FROM sales_daily WHERE sales_date = $1 GROUP BY product_id`,
      [slot === 1 ? addDays(runDate, -1) : addDays(runDate, -1)],
    );
    const soldMap = new Map(sold.map((s) => [s.product_id, s.q]));
    const rand = mulberry32(Number(runDate.replace(/-/g, '')) + slot);
    const qty = rows.map((r) => {
      const s = soldMap.get(r.product_id) ?? 0;
      let v = slot === 1 ? Math.max(0, r.q - Math.round(s * 0.55)) : Math.max(0, r.q - Math.round(s * 0.45));
      if (slot === 1 && v < 20 && rand() < 0.5) v += Math.round(40 + rand() * 120);
      return v;
    });
    await this.db.query(
      `INSERT INTO stock_snapshots (snap_date, slot, captured_at, product_id, quantity)
       SELECT $1::date, $2::smallint, now(), t.pid, t.q FROM unnest($3::int[], $4::int[]) AS t(pid, q)
       ON CONFLICT (snap_date, slot, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, captured_at = EXCLUDED.captured_at`,
      [runDate, slot, rows.map((r) => r.product_id), qty],
    );
    void has;
    return rows.length;
  }

  /** 하루치 수집을 실행해요. 판매처마다 최대 3번까지 시도하고 모든 시도를 기록해요. */
  async runDay(user: AuthUser | null, runDateIn?: unknown, opts: RunOptions = {}) {
    const runDate = this.checkRunDate(runDateIn);
    const dataDay = addDays(runDate, -1);
    const failFirst = Math.min(Math.max(opts.failFirst ?? MAX_TRIES, 0), MAX_TRIES);
    const types = opts.types ?? ['sales', 'ad', 'stock'];
    const targets = CHANNELS.filter((c) => types.includes(c.type) && (!opts.channels || opts.channels.includes(c.code)));
    const failSet = new Set(opts.failChannels ?? []);
    const results: { channel: string; name: string; status: string; tries: number; rows: number; error?: string }[] = [];

    const wantSales = targets.filter((c) => c.type === 'sales').map((c) => c.code);
    const wantAds = targets.filter((c) => c.type === 'ad').map((c) => c.code);
    const gen = wantSales.length || wantAds.length ? await this.virtualSalesAndAds(dataDay, { sales: wantSales, ads: wantAds }) : { sales: [], ads: [] };

    for (const ch of targets) {
      let ok = false;
      let tries = 0;
      let rows = 0;
      let lastErr = '';
      for (let i = 0; i < MAX_TRIES && !ok; i++) {
        tries = i + 1;
        if (failSet.has(ch.code) && i < failFirst) {
          lastErr = i === 0 ? '연결 시간이 초과됐어요.' : '다시 시도했지만 응답이 없어요.';
          await this.record(runDate, ch.code, 'failed', 0, i, lastErr);
          continue;
        }
        if (ch.type === 'sales') {
          const mine = gen.sales.filter((r) => r[0] === ch.code);
          await this.upsertSales(dataDay, mine);
          rows = mine.length;
        } else if (ch.type === 'ad') {
          const mine = gen.ads.filter((r) => r[0] === ch.code);
          await this.upsertAds(dataDay, mine);
          rows = mine.length;
        } else {
          rows = await this.collectStock(runDate, 1);
        }
        await this.record(runDate, ch.code, 'success', rows, i);
        ok = true;
      }
      results.push({ channel: ch.code, name: ch.name, status: ok ? (tries > 1 ? 'retried' : 'success') : 'failed', tries, rows, error: ok ? undefined : lastErr });
    }
    await this.audit.write(user?.id ?? null, 'collect.run', 'collect', runDate, { channels: targets.length, failed: results.filter((r) => r.status === 'failed').length });
    return { runDate, dataDay, results };
  }

  async runStockSlot(user: AuthUser | null, slot: 1 | 2, runDateIn?: unknown) {
    const runDate = this.checkRunDate(runDateIn);
    const rows = await this.collectStock(runDate, slot);
    await this.record(runDate, 'warehouse', rows ? 'success' : 'failed', rows, 0, rows ? undefined : '이전 재고 자료가 없어요.');
    await this.audit.write(user?.id ?? null, 'collect.stock', 'collect', runDate, { slot, rows });
    return { runDate, slot, rows };
  }

  async retryChannel(user: AuthUser, channelCode: unknown, date?: unknown) {
    const ch = CHANNELS.find((c) => c.code === channelCode);
    if (!ch) throw new BadRequestException('없는 수집처예요.');
    const out = await this.runDay(user, date, { channels: [ch.code], types: [ch.type] });
    await this.audit.write(user.id, 'collect.retry', 'collect', ch.code, { runDate: out.runDate });
    return out;
  }

  async status() {
    const t = today();
    const conns = await this.db.query<any>(
      `SELECT c.code, c.name, c.type, n.key_masked, n.status, n.last_checked_at FROM channels c LEFT JOIN connections n ON n.channel_id = c.id ORDER BY c.id`,
    );
    const runs = await this.db.query<any>(
      `SELECT DISTINCT ON (r.run_date, r.channel_id) r.run_date, c.code, r.status, r.row_count, r.error_message, r.retry_count, r.finished_at
       FROM collect_runs r JOIN channels c ON c.id = r.channel_id
       WHERE r.run_date >= $1 ORDER BY r.run_date DESC, r.channel_id, r.started_at DESC, r.id DESC`,
      [addDays(t, -13)],
    );
    const tries = await this.db.query<any>(
      `SELECT c.code, count(*)::int AS tries FROM collect_runs r JOIN channels c ON c.id = r.channel_id WHERE r.run_date = $1 GROUP BY c.code`,
      [t],
    );
    const triesMap = new Map(tries.map((x) => [x.code, x.tries]));
    const channels = conns.map((c) => {
      const mine = runs.filter((r) => r.code === c.code);
      const latest = mine[0];
      return {
        code: c.code,
        name: c.name,
        type: c.type,
        connection: { status: c.status ?? 'error', keyMasked: c.key_masked ?? '', checkedAt: c.last_checked_at },
        latest: latest ? { date: latest.run_date, status: latest.status, rows: latest.row_count, error: latest.error_message, retryCount: latest.retry_count, at: latest.finished_at, tries: triesMap.get(c.code) ?? 1 } : null,
        history: mine.slice(0, 14).map((r) => ({ date: r.run_date, status: r.status })),
      };
    });
    const problems = runs.filter((r) => r.status !== 'success').slice(0, 20).map((r) => ({ date: r.run_date, channel: r.code, status: r.status, error: r.error_message }));
    return { today: t, channels, problems };
  }
}

@Controller('collect')
@Roles('user', 'admin', 'superadmin')
export class CollectorController {
  constructor(private readonly svc: CollectorService) {}

  @Get('status')
  status() {
    return this.svc.status();
  }

  @Post('retry')
  retry(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.svc.retryChannel(u, b?.channel, b?.date);
  }
}
