// 가상 데이터 생성기. 실제 판매처에 연결하는 대신 90일치 판매·광고·재고를 만들어 줘요.
// 같은 시드 값이면 매번 같은 데이터가 나오고, 날짜는 "오늘 기준 어제까지"로 만들어서 언제 열어도 최신으로 보여요.
import { addDays, eachDay, weekday } from '../common/dates.js';
import { CHANNELS } from '../domain/constants.js';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenProduct { id: number; sku: string; name: string; category: string; price: number; base: number }
export interface GenSale { date: string; channel: string; productId: number; orders: number; quantity: number; amount: number; cancels: number }
export interface GenAd { date: string; channel: string; cost: number; clicks: number }
export interface GenStock { date: string; slot: 1 | 2; productId: number; qty: number }
export interface GenRun { runDate: string; channel: string; status: 'success' | 'failed' | 'partial'; rowCount: number; error?: string; retry: number; startHm: string; endHm: string }

const TOP10: Omit<GenProduct, 'id' | 'sku'>[] = [
  { name: '수분 크림 50ml', category: '스킨케어', price: 38000, base: 34 },
  { name: '선크림 SPF50', category: '선케어', price: 24000, base: 30 },
  { name: '클렌징 폼', category: '클렌징', price: 15000, base: 27 },
  { name: '토너 200ml', category: '스킨케어', price: 21000, base: 25 },
  { name: '립 틴트 01', category: '메이크업', price: 14000, base: 22 },
  { name: '에센스 30ml', category: '스킨케어', price: 42000, base: 20 },
  { name: '마스크팩 10매', category: '마스크팩', price: 19000, base: 18 },
  { name: '핸드크림', category: '바디·헤어', price: 11000, base: 16 },
  { name: '쿠션 파운데이션', category: '메이크업', price: 32000, base: 15 },
  { name: '아이 크림', category: '스킨케어', price: 36000, base: 13 },
];

const ITEMS: [string, string][] = [
  ['세럼', '스킨케어'], ['앰플', '스킨케어'], ['로션', '스킨케어'], ['미스트', '스킨케어'], ['진정 크림', '스킨케어'],
  ['선스틱', '선케어'], ['톤업 선크림', '선케어'], ['선쿠션', '선케어'],
  ['립밤', '메이크업'], ['아이섀도 팔레트', '메이크업'], ['마스카라', '메이크업'], ['블러셔', '메이크업'], ['파우더', '메이크업'], ['프라이머', '메이크업'],
  ['클렌징 오일', '클렌징'], ['클렌징 워터', '클렌징'], ['필링 젤', '클렌징'], ['클렌징 밤', '클렌징'],
  ['시트 마스크팩', '마스크팩'], ['수면 팩', '마스크팩'], ['워시오프 팩', '마스크팩'],
  ['바디로션', '바디·헤어'], ['바디워시', '바디·헤어'], ['샴푸', '바디·헤어'], ['트리트먼트', '바디·헤어'], ['헤어 에센스', '바디·헤어'], ['헤어 오일', '바디·헤어'],
];
const LINES = ['라이트', '딥', '시카', '비타', '히알루', '그린티', '로즈', '어성초', '쌀', '마린'];
const SIZES = ['30ml', '50ml', '100ml', '150ml', '200ml'];

export interface Dataset90 {
  today: string;
  start: string; // 판매 데이터의 첫날
  end: string; // 판매 데이터의 마지막날(어제)
  products: GenProduct[];
  sales: GenSale[];
  ads: GenAd[];
  stock: GenStock[];
  runs: GenRun[];
  marks: { eventDays: string[]; outageDay: string; cancelSpikeDays: string[]; failedAdRun: string; partialRun: string };
}

export function generate(today: string, days = 90, seed = 20261110): Dataset90 {
  const rand = mulberry32(seed);
  const end = addDays(today, -1);
  const start = addDays(today, -days);
  const dates = eachDay(start, end);

  // ----- 상품 150개 -----
  const products: GenProduct[] = [];
  TOP10.forEach((p, i) => products.push({ ...p, id: i + 1, sku: `MB-${String(i + 1).padStart(3, '0')}` }));
  const names = new Set(products.map((p) => p.name));
  let guard = 0;
  while (products.length < 150 && guard++ < 5000) {
    const line = LINES[Math.floor(rand() * LINES.length)];
    const [item, category] = ITEMS[Math.floor(rand() * ITEMS.length)];
    const size = category === '마스크팩' || category === '메이크업' ? '' : ` ${SIZES[Math.floor(rand() * SIZES.length)]}`;
    const name = `${line} ${item}${size}`;
    if (names.has(name)) continue;
    names.add(name);
    const id = products.length + 1;
    products.push({
      id,
      sku: `MB-${String(id).padStart(3, '0')}`,
      name,
      category,
      price: Math.round((12000 + 60000 * Math.pow(rand(), 1.3)) / 100) * 100,
      base: 2.2 + 7.5 * Math.pow(rand(), 1.5),
    });
  }

  // ----- 사건 날짜 -----
  const ago = (n: number) => addDays(today, -n);
  const eventDays = [ago(58), ago(24)];
  const outageDay = ago(33);
  const cancelSpikeDays = [ago(71), ago(9)];
  const failedAdRun = ago(14); // 쿠팡 광고 연결 키가 끝내 실패한 날(실행일)
  const partialRun = ago(28); // 11번가 수집이 일부만 된 날(실행일)

  const wk = [0.82, 1.04, 1.02, 1.0, 1.0, 1.06, 0.86];
  const salesCh = CHANNELS.filter((c) => c.type === 'sales');

  const sales: GenSale[] = [];
  const ads: GenAd[] = [];
  const dayTotal = new Map<string, number>();
  const prodQty = new Map<string, Map<number, number>>();

  dates.forEach((d, i) => {
    let f = wk[weekday(d)] * (0.92 + 0.16 * (i / Math.max(1, dates.length - 1)));
    if (eventDays.includes(d)) f *= 3.0;
    else if (eventDays.some((e) => addDays(e, 1) === d)) f *= 1.4;
    const spike = cancelSpikeDays.includes(d) ? 4 : 1;
    let total = 0;
    const pq = new Map<number, number>();
    for (const p of products) {
      for (const ch of salesCh) {
        let mult = 1;
        if (d === outageDay && (ch.code === 'smartstore' || ch.code === 'coupang')) mult = 0.02;
        const exp = p.base * (ch.weight ?? 0.25) * f * mult * (0.75 + 0.5 * rand());
        let qty = Math.round(exp + (rand() - 0.5) * Math.sqrt(Math.max(exp, 0.2)) * 2);
        if (qty < 1) {
          if (rand() < exp) qty = 1;
          else continue;
        }
        // 11번가 일부 수집: 그날 절반의 줄만 남겨요.
        if (addDays(d, 1) === partialRun && ch.code === 'st11' && rand() < 0.5) continue;
        // 주문 한 건에 여러 상품이 담기므로, 상품 줄마다 주문 수는 수량보다 훨씬 적게 잡아요.
        const orders = qty <= 1 ? (rand() < 0.45 ? 1 : 0) : Math.round(qty / (2.0 + rand() * 0.5));
        let cancels = 0;
        for (let k = 0; k < orders; k++) if (rand() < 0.03 * spike) cancels++;
        const amount = Math.round((qty * p.price * (0.93 + 0.07 * rand())) / 10) * 10;
        sales.push({ date: d, channel: ch.code, productId: p.id, orders, quantity: qty, amount, cancels });
        total += amount;
        pq.set(p.id, (pq.get(p.id) ?? 0) + qty);
      }
    }
    dayTotal.set(d, total);
    prodQty.set(d, pq);

    // 광고: 매출을 광고 효율(약 4배)로 나눈 만큼 쓰고 세 곳에 나눠요.
    const roas = eventDays.includes(d) ? 3.3 : 4.1 + 0.35 * Math.sin(i / 5) + (rand() - 0.5) * 0.4;
    const adTotal = total / roas;
    const split: [string, number][] = [['naver_ad', 0.5], ['meta_ad', 0.33], ['coupang_ad', 0.17]];
    for (const [code, share] of split) {
      if (code === 'coupang_ad' && addDays(d, 1) === failedAdRun) continue; // 수집 실패로 비어 있는 날
      const cost = Math.round((adTotal * share * (0.92 + 0.16 * rand())) / 10) * 10;
      ads.push({ date: d, channel: code, cost, clicks: Math.round(cost / (380 + rand() * 160)) });
    }
  });

  // ----- 재고: 매일 아침(slot 1)과 오후 3시(slot 2) -----
  const stock: GenStock[] = [];
  const lastSlot1 = new Map<number, number>();
  for (const p of products) {
    let s = Math.round(p.base * (8 + rand() * 16));
    for (const d of dates) {
      stock.push({ date: d, slot: 1, productId: p.id, qty: s });
      const q = prodQty.get(d)?.get(p.id) ?? 0;
      const first = Math.round(q * 0.45);
      const s2 = Math.max(0, s - first);
      stock.push({ date: d, slot: 2, productId: p.id, qty: s2 });
      s = Math.max(0, s2 - (q - first));
      if (s < p.base * 5 && rand() < 0.7) s += Math.round(p.base * (12 + rand() * 10));
    }
    lastSlot1.set(p.id, s);
  }
  // 오늘 아침 재고. 시연에서 경고가 보이도록 몇 개는 일부러 낮게 맞춰요.
  const avg7 = (pid: number) => {
    let t = 0;
    for (let k = 0; k < 7; k++) t += prodQty.get(addDays(end, -k))?.get(pid) ?? 0;
    return t / 7;
  };
  const forced: Record<number, { qty?: number; days?: number }> = {
    1: { qty: 3 },
    2: { days: 2.4 },
    4: { days: 0.7 },
    8: { days: 2.8 },
    12: { qty: 9 },
  };
  for (const p of products) {
    let qty = lastSlot1.get(p.id) ?? 0;
    const f = forced[p.id];
    if (f?.qty !== undefined) qty = f.qty;
    if (f?.days !== undefined) qty = Math.max(1, Math.round(avg7(p.id) * f.days));
    stock.push({ date: today, slot: 1, productId: p.id, qty });
  }

  // ----- 수집 기록 (실행일 = 데이터 다음 날) -----
  const runs: GenRun[] = [];
  const runDates = eachDay(addDays(start, 1), today);
  const retryOk: Record<string, [string, string]> = {
    [ago(47)]: ['coupang', '연결 시간이 초과됐어요.'],
    [ago(19)]: ['naver_ad', 'API 응답이 비어 있어요.'],
    [ago(5)]: ['own', '일시적인 서버 오류예요.'],
  };
  for (const rd of runDates) {
    const dataDay = addDays(rd, -1);
    for (const ch of CHANNELS) {
      if (ch.type === 'stock') {
        runs.push({ runDate: rd, channel: ch.code, status: 'success', rowCount: products.length, retry: 0, startHm: '09:05', endHm: '09:06' });
        continue;
      }
      const rows = ch.type === 'sales' ? sales.filter((s) => s.date === dataDay && s.channel === ch.code).length : ads.filter((a) => a.date === dataDay && a.channel === ch.code).length;
      if (retryOk[rd]?.[0] === ch.code) {
        runs.push({ runDate: rd, channel: ch.code, status: 'failed', rowCount: 0, error: retryOk[rd][1], retry: 0, startHm: '07:30', endHm: '07:30' });
        runs.push({ runDate: rd, channel: ch.code, status: 'success', rowCount: rows, retry: 1, startHm: '07:45', endHm: '07:46' });
        continue;
      }
      if (rd === failedAdRun && ch.code === 'coupang_ad') {
        for (let k = 0; k < 3; k++) {
          runs.push({ runDate: rd, channel: ch.code, status: 'failed', rowCount: 0, error: '연결 키가 만료됐어요.', retry: k, startHm: `0${7 + Math.floor((30 + 15 * k) / 60)}:${String((30 + 15 * k) % 60).padStart(2, '0')}`, endHm: '08:15' });
        }
        continue;
      }
      if (rd === partialRun && ch.code === 'st11') {
        runs.push({ runDate: rd, channel: ch.code, status: 'partial', rowCount: rows, error: '일부 주문만 받았어요.', retry: 0, startHm: '07:30', endHm: '07:31' });
        continue;
      }
      if (addDays(outageDay, 1) === rd && (ch.code === 'smartstore' || ch.code === 'coupang')) {
        runs.push({ runDate: rd, channel: ch.code, status: 'partial', rowCount: rows, error: '판매처 장애로 일부만 받았어요.', retry: 0, startHm: '07:30', endHm: '07:32' });
        continue;
      }
      runs.push({ runDate: rd, channel: ch.code, status: 'success', rowCount: rows, retry: 0, startHm: '07:30', endHm: '07:31' });
    }
  }

  return { today, start, end, products, sales, ads, stock, runs, marks: { eventDays, outageDay, cancelSpikeDays, failedAdRun, partialRun } };
}
