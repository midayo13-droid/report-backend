// 보고서 숫자를 계산하는 곳이에요. 모든 계산은 여기(시스템)에서만 하고, AI는 이 값을 가져다 설명만 해요.
// DB를 직접 읽지 않고 받은 자료(Dataset)로만 계산하기 때문에, 가상 데이터를 만들 때도, 실제로 보고서를 만들 때도 같은 코드를 씁니다.
import { addDays, eachDay, monthStart, weekday, WEEKDAY_KO } from '../common/dates.js';

export type ReportType = 'daily' | 'weekly' | 'monthly';

export interface DayChannel { date: string; channel: string; amount: number; orders: number; quantity: number; cancels: number }
export interface DayProduct { date: string; productId: number; amount: number; quantity: number }
export interface AdRow { date: string; channel: string; cost: number; clicks: number }
export interface StockRow { date: string; productId: number; qty: number }
export interface ProductInfo { id: number; name: string; category: string }
export interface IssueRow { date: string; channel: string; status: string; message: string }

export interface Dataset {
  channelNames: Record<string, string>;
  dayChannel: DayChannel[];
  dayProduct: DayProduct[];
  ads: AdRow[];
  stock: StockRow[]; // 매일 아침(09:05) 재고
  products: ProductInfo[];
  issues: IssueRow[];
  dataStart?: string; // 자료가 시작되는 날. 이전 기간 비교가 불가능한지 판단할 때 써요.
}

export type Crit = Record<string, number>;

interface Index {
  dc: Map<string, DayChannel[]>;
  dp: Map<string, DayProduct[]>;
  ad: Map<string, AdRow[]>;
  stock: Map<string, Map<number, number>>;
  prod: Map<number, string>;
  issues: Map<string, IssueRow[]>;
  dpQty: Map<string, Map<number, number>>;
}

const cache = new WeakMap<Dataset, Index>();

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function index(ds: Dataset): Index {
  const hit = cache.get(ds);
  if (hit) return hit;
  const ix: Index = { dc: new Map(), dp: new Map(), ad: new Map(), stock: new Map(), prod: new Map(), issues: new Map(), dpQty: new Map() };
  for (const r of ds.dayChannel) push(ix.dc, r.date, r);
  for (const r of ds.dayProduct) {
    push(ix.dp, r.date, r);
    let m = ix.dpQty.get(r.date);
    if (!m) ix.dpQty.set(r.date, (m = new Map()));
    m.set(r.productId, (m.get(r.productId) ?? 0) + r.quantity);
  }
  for (const r of ds.ads) push(ix.ad, r.date, r);
  for (const r of ds.stock) {
    let m = ix.stock.get(r.date);
    if (!m) ix.stock.set(r.date, (m = new Map()));
    m.set(r.productId, r.qty);
  }
  for (const p of ds.products) ix.prod.set(p.id, p.name);
  for (const r of ds.issues) push(ix.issues, r.date, r);
  cache.set(ds, ix);
  return ix;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Totals { sales: number; orders: number; quantity: number; cancels: number; adCost: number; adEfficiency: number; cancelRate: number; days: number }

function totals(ix: Index, from: string, to: string): Totals {
  let sales = 0, orders = 0, quantity = 0, cancels = 0, adCost = 0, days = 0;
  for (const d of eachDay(from, to)) {
    const rows = ix.dc.get(d);
    if (rows) {
      days++;
      for (const r of rows) { sales += r.amount; orders += r.orders; quantity += r.quantity; cancels += r.cancels; }
    }
    for (const a of ix.ad.get(d) ?? []) adCost += a.cost;
  }
  return {
    sales, orders, quantity, cancels, adCost, days,
    adEfficiency: adCost > 0 ? r2(sales / adCost) : 0,
    cancelRate: orders + cancels > 0 ? r1((cancels / (orders + cancels)) * 100) : 0,
  };
}

const pct = (a: number, b: number): number | null => (b > 0 ? r1(((a - b) / b) * 100) : null);

function channelShare(ds: Dataset, ix: Index, from: string, to: string) {
  const sum = new Map<string, number>();
  for (const d of eachDay(from, to)) for (const r of ix.dc.get(d) ?? []) sum.set(r.channel, (sum.get(r.channel) ?? 0) + r.amount);
  const total = [...sum.values()].reduce((a, b) => a + b, 0);
  return [...sum.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, amount]) => ({ code, name: ds.channelNames[code] ?? code, amount, share: total > 0 ? r1((amount / total) * 100) : 0 }));
}

function topProducts(ix: Index, from: string, to: string, n: number) {
  const sum = new Map<number, { amount: number; quantity: number }>();
  for (const d of eachDay(from, to)) {
    for (const r of ix.dp.get(d) ?? []) {
      const c = sum.get(r.productId) ?? { amount: 0, quantity: 0 };
      c.amount += r.amount;
      c.quantity += r.quantity;
      sum.set(r.productId, c);
    }
  }
  return [...sum.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, n)
    .map(([productId, v]) => ({ productId, name: ix.prod.get(productId) ?? `상품 ${productId}`, amount: v.amount, quantity: v.quantity }));
}

/** 지난 기간과 비교해서 매출이 가장 많이 늘어난 상품과 가장 많이 줄어든 상품을 골라요. */
function productMovers(ix: Index, from: string, to: string, pFrom: string, pTo: string, n: number) {
  const sumOf = (a: string, b: string) => {
    const m = new Map<number, number>();
    for (const d of eachDay(a, b)) for (const r of ix.dp.get(d) ?? []) m.set(r.productId, (m.get(r.productId) ?? 0) + r.amount);
    return m;
  };
  const cur = sumOf(from, to);
  const prev = sumOf(pFrom, pTo);
  const hasPrev = [...prev.values()].some((v) => v > 0);
  if (!hasPrev) return { up: [], down: [], hasPrev: false };
  const rows = [...new Set([...cur.keys(), ...prev.keys()])].map((productId) => {
    const c = cur.get(productId) ?? 0;
    const p = prev.get(productId) ?? 0;
    return { productId, name: ix.prod.get(productId) ?? `상품 ${productId}`, cur: c, prev: p, diff: c - p, rate: pct(c, p) };
  });
  return {
    up: rows.filter((r) => r.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, n),
    down: rows.filter((r) => r.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, n),
    hasPrev: true,
  };
}

export interface StockAlert {
  productId: number;
  name: string;
  qty: number;
  avgPerDay: number;
  days: number;
  level: 'danger' | 'warn';
  depletionDays: number;
  suggestOrderQty: number;
}

/** 기준표에 따라 재고 경고를 판단해요. 소진 예상일과 권장 발주 수량도 여기서(시스템이) 계산해요. */
export function stockAlertsAt(ds: Dataset, date: string, crit: Crit): StockAlert[] {
  const ix = index(ds);
  const snap = ix.stock.get(date);
  if (!snap) return [];
  const period = Math.max(1, Math.round(crit.avg_sales_period ?? 7));
  const out: StockAlert[] = [];
  for (const [productId, qty] of snap) {
    let sold = 0;
    for (let i = 1; i <= period; i++) sold += ix.dpQty.get(addDays(date, -i))?.get(productId) ?? 0;
    const avg = sold / period;
    const days = avg > 0 ? qty / avg : 999;
    const danger = qty <= crit.stock_danger_qty || days < crit.stock_danger_days;
    const warn = qty <= crit.stock_warn_qty || days < crit.stock_warn_days;
    if (!danger && !warn) continue;
    out.push({
      productId,
      name: ix.prod.get(productId) ?? `상품 ${productId}`,
      qty,
      avgPerDay: r1(avg),
      days: days >= 999 ? 999 : r1(days),
      level: danger ? 'danger' : 'warn',
      depletionDays: days >= 999 ? 999 : r1(days),
      suggestOrderQty: Math.max(0, Math.ceil((crit.stock_target_days ?? 7) * avg - qty)),
    });
  }
  out.sort((a, b) => (a.level === b.level ? a.days - b.days : a.level === 'danger' ? -1 : 1));
  return out;
}

const md = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
const mdw = (d: string) => `${md(d)}(${WEEKDAY_KO[weekday(d)]})`;

function weekBlocks(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let s = from; s <= to; s = addDays(s, 7)) {
    const e = addDays(s, 6) > to ? to : addDays(s, 6);
    out.push({ from: s, to: e });
  }
  return out;
}

export function periodOf(type: ReportType, reportDate: string) {
  const basis = addDays(reportDate, -1);
  if (type === 'daily') return { periodStart: basis, periodEnd: basis, prevStart: addDays(basis, -1), prevEnd: addDays(basis, -1) };
  if (type === 'weekly') {
    const start = addDays(basis, -6);
    return { periodStart: start, periodEnd: basis, prevStart: addDays(start, -7), prevEnd: addDays(start, -1) };
  }
  const start = monthStart(basis);
  const prevEnd = addDays(start, -1);
  return { periodStart: start, periodEnd: basis, prevStart: monthStart(prevEnd), prevEnd };
}

export function buildSnapshot(type: ReportType, ds: Dataset, reportDate: string, crit: Crit) {
  const ix = index(ds);
  const { periodStart, periodEnd, prevStart, prevEnd } = periodOf(type, reportDate);
  const cur = totals(ix, periodStart, periodEnd);
  const prev = totals(ix, prevStart, prevEnd);
  const hasPrev = prev.sales > 0 && (!ds.dataStart || prevStart >= ds.dataStart);

  const kpis = {
    sales: cur.sales,
    adCost: cur.adCost,
    adEfficiency: cur.adEfficiency,
    orders: cur.orders,
    cancels: cur.cancels,
    cancelRate: cur.cancelRate,
    delta: {
      sales: hasPrev ? pct(cur.sales, prev.sales) : null,
      adCost: hasPrev ? pct(cur.adCost, prev.adCost) : null,
      adEfficiency: hasPrev ? pct(cur.adEfficiency, prev.adEfficiency) : null,
      orders: hasPrev ? pct(cur.orders, prev.orders) : null,
      cancelRate: hasPrev ? r1(cur.cancelRate - prev.cancelRate) : null,
    },
  };

  let series: { label: string; date?: string; sales: number; adCost: number; efficiency: number }[] = [];
  let efficiencyTrend: { label: string; value: number }[] = [];
  let cancelTrend: { label: string; value: number }[] = [];

  if (type === 'daily') {
    const days = eachDay(addDays(periodEnd, -6), periodEnd);
    series = days.map((d) => {
      const t = totals(ix, d, d);
      return { label: mdw(d), date: d, sales: t.sales, adCost: t.adCost, efficiency: t.adEfficiency };
    });
    efficiencyTrend = series.map((s) => ({ label: s.label, value: s.efficiency }));
  } else if (type === 'weekly') {
    const days = eachDay(periodStart, periodEnd);
    series = days.map((d) => {
      const t = totals(ix, d, d);
      return { label: mdw(d), date: d, sales: t.sales, adCost: t.adCost, efficiency: t.adEfficiency };
    });
    for (let i = 3; i >= 0; i--) {
      const e = addDays(periodEnd, -7 * i);
      const t = totals(ix, addDays(e, -6), e);
      efficiencyTrend.push({ label: i === 0 ? '이번 주' : `${i}주 전`, value: t.adEfficiency });
    }
  } else {
    const blocks = weekBlocks(periodStart, periodEnd);
    series = blocks.map((b, i) => {
      const t = totals(ix, b.from, b.to);
      return { label: `${i + 1}주차`, sales: t.sales, adCost: t.adCost, efficiency: t.adEfficiency };
    });
    efficiencyTrend = series.map((s) => ({ label: s.label, value: s.efficiency }));
    cancelTrend = blocks.map((b, i) => ({ label: `${i + 1}주차`, value: totals(ix, b.from, b.to).cancelRate }));
  }

  const topN = Math.round(crit.top_n ?? 10) * (type === 'monthly' ? 2 : 1);
  const alerts = stockAlertsAt(ds, reportDate, crit);

  let stockAlertDays: number | undefined;
  if (type !== 'daily') {
    let n = 0;
    for (const d of eachDay(periodStart, periodEnd)) {
      if (stockAlertsAt(ds, d, crit).length > 0) n++;
    }
    stockAlertDays = n;
  }

  const issues: { date: string; channel: string; status: string; message: string }[] = [];
  for (const d of eachDay(type === 'daily' ? addDays(reportDate, -1) : periodStart, reportDate)) {
    for (const i of ix.issues.get(d) ?? []) issues.push({ date: d, channel: ds.channelNames[i.channel] ?? i.channel, status: i.status, message: i.message });
  }
  let missingSuspected = false;
  if (type === 'daily' && prev.orders > 0 && cur.orders < (prev.orders * (crit.missing_alert ?? 50)) / 100) {
    missingSuspected = true;
    issues.push({ date: periodEnd, channel: '전체', status: 'suspect', message: `주문 건수가 전일의 ${r1((cur.orders / prev.orders) * 100)}%예요. 누락이 의심돼요.` });
  }

  return {
    meta: {
      type,
      reportDate,
      periodStart,
      periodEnd,
      prevStart,
      prevEnd,
      basisLabel: type === 'daily' ? '어제 마감 기준' : type === 'weekly' ? '지난 7일 기준' : '지난달 기준',
    },
    kpis,
    series,
    efficiencyTrend,
    cancelTrend,
    channelShare: channelShare(ds, ix, periodStart, periodEnd),
    topProducts: topProducts(ix, periodStart, periodEnd, topN),
    productMovers: productMovers(ix, periodStart, periodEnd, prevStart, prevEnd, 5),
    stockAlerts: alerts.slice(0, 20),
    stockSummary: { danger: alerts.filter((a) => a.level === 'danger').length, warn: alerts.filter((a) => a.level === 'warn').length },
    stockAlertDays,
    target: type === 'monthly' ? { value: crit.monthly_target, achievement: crit.monthly_target > 0 ? r1((cur.sales / crit.monthly_target) * 100) : 0 } : undefined,
    issues,
    missingSuspected,
    flags: {
      adEfficiencyLow: crit.ad_efficiency_low != null && cur.adCost > 0 && cur.adEfficiency < crit.ad_efficiency_low,
      adEfficiencyLowThreshold: crit.ad_efficiency_low ?? null,
    },
    criteria: crit,
  };
}

export type Snapshot = ReturnType<typeof buildSnapshot>;

/** 재고 제안 문장 틀 (숫자는 시스템이 계산한 값을 그대로 써요) */
export function stockSentence(a: { days: number; depletionDays: number; suggestOrderQty: number }): string {
  const when = a.days < 1 ? '오늘 안에 품절될 수 있어요' : `약 ${a.depletionDays}일 안에 떨어질 것 같아요`;
  return a.suggestOrderQty > 0 ? `${when}. ${a.suggestOrderQty}개 발주를 권해요.` : `${when}. 지금은 발주가 필요 없어요.`;
}

const manwon = (n: number) => `${Math.round(n / 10000).toLocaleString('ko-KR')}만원`;

/** 미리 정해 둔 문장 틀로 요약을 만들어요. (AI를 쓰지 못할 때와 가상 데이터에 써요) */
export function templateSummary(s: Snapshot): string {
  const t = s.meta.type;
  const who = t === 'daily' ? '어제' : t === 'weekly' ? '지난주' : '지난달';
  const d = s.kpis.delta.sales;
  const trend = d == null ? '' : d >= 0 ? `전기간보다 ${Math.abs(d)}% 올랐어요.` : `전기간보다 ${Math.abs(d)}% 줄었어요.`;
  const parts = [`${who} 매출은 ${manwon(s.kpis.sales)}이고 ${trend}`.trim(), `광고 효율은 ${s.kpis.adEfficiency}배, 취소율은 ${s.kpis.cancelRate}%예요.`];
  if (s.stockSummary.danger + s.stockSummary.warn > 0) {
    parts.push(`재고는 위험 ${s.stockSummary.danger}건, 주의 ${s.stockSummary.warn}건이라 확인이 필요해요.`);
  }
  if (s.missingSuspected) parts.push('주문 누락이 의심돼서 수집 상태도 확인해 주세요.');
  return parts.join(' ');
}
