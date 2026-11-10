// "그래프 추가"로 만드는 그래프예요. 무엇을(숫자) × 무엇별로(나누기) × 어떤 모양으로 를 고르면 시스템이 직접 계산해요.
// 더하기만 해도 맞는 숫자(매출, 주문 수, 판매 수량, 취소 건수)만 고를 수 있게 해서, 어떤 조합을 골라도 숫자가 틀리지 않아요.
// (광고 효율·취소율 같은 비율 숫자는 합치면 틀려져서 일부러 뺐어요.)
import { addDays, eachDay, WEEKDAY_KO, weekday } from '../common/dates.js';

export const CUSTOM_PREFIX = 'custom:';
export const MAX_CUSTOM_CHARTS = 3;

export const CUSTOM_METRICS = {
  sales: { label: '매출', column: 'amount', unit: '만원', scale: 10000 },
  orders: { label: '주문 수', column: 'orders', unit: '건', scale: 1 },
  quantity: { label: '판매 수량', column: 'quantity', unit: '개', scale: 1 },
  cancels: { label: '취소 건수', column: 'cancels', unit: '건', scale: 1 },
} as const;
export type CustomMetric = keyof typeof CUSTOM_METRICS;

export const CUSTOM_GROUPS = {
  channel: { label: '판매처', shapes: ['donut', 'hbar', 'table'] },
  product: { label: '상품', shapes: ['donut', 'hbar', 'table'] },
  category: { label: '카테고리', shapes: ['donut', 'hbar', 'table'] },
  date: { label: '날짜', shapes: ['line', 'vbar'] },
} as const;
export type CustomGroup = keyof typeof CUSTOM_GROUPS;

export const CUSTOM_SHAPES: Record<string, string> = {
  donut: '원',
  hbar: '가로 막대',
  vbar: '세로 막대',
  line: '꺾은선',
  table: '표',
};

/** 0은 "보고서 기간 그대로"예요. 날짜별로 나눌 때는 7·14·30일 중에서 골라야 해요. */
export const CUSTOM_DAYS = [0, 7, 14, 30];

export interface CustomChartSpec {
  title: string;
  metric: CustomMetric;
  groupBy: CustomGroup;
  shape: string;
  days: number;
  limit: number;
}

export function isCustomKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(CUSTOM_PREFIX);
}

export function newCustomKey(): string {
  return `${CUSTOM_PREFIX}c${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 36).toString(36)}`;
}

export function defaultCustomTitle(spec: Pick<CustomChartSpec, 'metric' | 'groupBy' | 'days'>): string {
  const m = CUSTOM_METRICS[spec.metric]?.label ?? '';
  if (spec.groupBy === 'date') return `일별 ${m} 추이`;
  return `${CUSTOM_GROUPS[spec.groupBy]?.label ?? ''}별 ${m}`;
}

export function customOptions() {
  return {
    max: MAX_CUSTOM_CHARTS,
    metrics: Object.entries(CUSTOM_METRICS).map(([key, v]) => ({ key, label: v.label })),
    groups: Object.entries(CUSTOM_GROUPS).map(([key, v]) => ({
      key,
      label: v.label,
      shapes: v.shapes.map((s) => ({ key: s, label: CUSTOM_SHAPES[s] })),
      days: key === 'date' ? CUSTOM_DAYS.filter((d) => d > 0) : CUSTOM_DAYS,
    })),
  };
}

/** 고른 값이 가능한 조합인지 검사하고, 깨끗하게 정리한 값을 돌려줘요. */
export function validateCustomSpec(input: any): { ok: boolean; errors: string[]; spec?: CustomChartSpec } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['그래프 설정이 올바르지 않아요.'] };
  const metric = input.metric as CustomMetric;
  if (!(metric in CUSTOM_METRICS)) errors.push(`"무엇을 볼까요"는 ${Object.values(CUSTOM_METRICS).map((m) => m.label).join(', ')} 중에서 골라 주세요.`);
  const groupBy = input.groupBy as CustomGroup;
  if (!(groupBy in CUSTOM_GROUPS)) errors.push(`"무엇별로 나눌까요"는 ${Object.values(CUSTOM_GROUPS).map((g) => g.label).join(', ')} 중에서 골라 주세요.`);
  if (errors.length) return { ok: false, errors };

  const shape = String(input.shape ?? '');
  const allowedShapes = CUSTOM_GROUPS[groupBy].shapes as readonly string[];
  if (!allowedShapes.includes(shape)) {
    errors.push(`${CUSTOM_GROUPS[groupBy].label}별 그래프의 모양은 ${allowedShapes.map((s) => CUSTOM_SHAPES[s]).join(', ')} 중에서 골라 주세요.`);
  }
  const days = Number(input.days ?? 0);
  if (!CUSTOM_DAYS.includes(days)) errors.push('기간은 보고서 기간, 최근 7일, 14일, 30일 중에서 골라 주세요.');
  if (groupBy === 'date' && days === 0) errors.push('날짜별로 나눌 때는 최근 7일, 14일, 30일 중에서 골라 주세요.');
  const limit = Number(input.limit ?? 5);
  if (!Number.isInteger(limit) || limit < 3 || limit > 10) errors.push('보여 줄 개수는 3~10개예요.');
  if (shape === 'donut' && limit > 8) errors.push('원 그래프는 8개까지만 보여 줄 수 있어요.');
  const title = String(input.title ?? '').trim() || defaultCustomTitle({ metric, groupBy, days });
  if (title.length > 20) errors.push('그래프 이름은 20자 이하로 써 주세요.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], spec: { title, metric, groupBy, shape, days, limit: groupBy === 'date' ? 10 : limit } };
}

export type QueryFn = (sql: string, params: unknown[]) => Promise<any[]>;

export interface CustomChartResult {
  title: string;
  metric: CustomMetric;
  metricLabel: string;
  unit: string;
  scale: number;
  groupBy: CustomGroup;
  groupLabel: string;
  shape: string;
  periodStart: string;
  periodEnd: string;
  points: { label: string; value: number; share?: number }[];
  others: number;
  total: number;
  /** 기간을 줄이거나 늘려서 계산했을 때 알려 주는 문장 */
  note?: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** 보고서 기간(끝 날짜 기준)에 맞춰 그래프 숫자를 계산해요. */
export async function computeCustomChart(
  query: QueryFn,
  spec: CustomChartSpec,
  periodStart: string,
  periodEnd: string,
): Promise<CustomChartResult> {
  const m = CUSTOM_METRICS[spec.metric];
  const from = spec.days > 0 ? addDays(periodEnd, -(spec.days - 1)) : periodStart;
  const col = m.column; // 허용된 이름만 들어오므로 SQL에 안전하게 넣어도 돼요.
  let rows: { label: string; value: number }[];
  if (spec.groupBy === 'date') {
    rows = await query(`SELECT sales_date AS label, sum(${col}) AS value FROM sales_daily WHERE sales_date BETWEEN $1 AND $2 GROUP BY 1`, [from, periodEnd]);
  } else if (spec.groupBy === 'channel') {
    rows = await query(`SELECT c.name AS label, sum(s.${col}) AS value FROM sales_daily s JOIN channels c ON c.id = s.channel_id WHERE s.sales_date BETWEEN $1 AND $2 GROUP BY 1`, [from, periodEnd]);
  } else if (spec.groupBy === 'product') {
    rows = await query(`SELECT p.name AS label, sum(s.${col}) AS value FROM sales_daily s JOIN products p ON p.id = s.product_id WHERE s.sales_date BETWEEN $1 AND $2 GROUP BY 1`, [from, periodEnd]);
  } else {
    rows = await query(`SELECT p.category AS label, sum(s.${col}) AS value FROM sales_daily s JOIN products p ON p.id = s.product_id WHERE s.sales_date BETWEEN $1 AND $2 GROUP BY 1`, [from, periodEnd]);
  }
  const num = (v: unknown) => Number(v ?? 0);
  let points: CustomChartResult['points'];
  let others = 0;
  let total = 0;
  if (spec.groupBy === 'date') {
    const byDay = new Map(rows.map((r) => [String(r.label).slice(0, 10), num(r.value)]));
    points = eachDay(from, periodEnd).map((d) => ({ label: `${d.slice(5, 7)}/${d.slice(8, 10)}(${WEEKDAY_KO[weekday(d)]})`, value: byDay.get(d) ?? 0 }));
    total = points.reduce((a, p) => a + p.value, 0);
  } else {
    const sorted = rows.map((r) => ({ label: String(r.label), value: num(r.value) })).sort((a, b) => b.value - a.value);
    total = sorted.reduce((a, p) => a + p.value, 0);
    points = sorted.slice(0, spec.limit).map((p) => ({ ...p, share: total > 0 ? r1((p.value / total) * 100) : 0 }));
    others = sorted.slice(spec.limit).reduce((a, p) => a + p.value, 0);
  }
  const days = eachDay(from, periodEnd).length;
  return {
    title: spec.title,
    metric: spec.metric,
    metricLabel: m.label,
    unit: m.unit,
    scale: m.scale,
    groupBy: spec.groupBy,
    groupLabel: CUSTOM_GROUPS[spec.groupBy].label,
    shape: spec.shape,
    periodStart: from,
    periodEnd,
    points,
    others,
    total,
    note: `${from.slice(5).replace('-', '/')}~${periodEnd.slice(5).replace('-', '/')} (${days}일)`,
  };
}
