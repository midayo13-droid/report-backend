// 보고서를 PDF 파일로 만들어요. 가벼운 라이브러리(pdfmake)로 문서와 그래프를 직접 그려서,
// 서버에서 브라우저를 띄우지 않아도 돼요. 승인 당시의 숫자 사본(snapshot)으로 만들기 때문에 과거 보고서가 그대로 나와요.
import { Injectable, Logger } from '@nestjs/common';
import pdfmake from 'pdfmake';
import path from 'node:path';
import fs from 'node:fs';
import { KPI_LABEL, SECTION_LABEL, type KpiItem } from '../domain/template-config.js';
import { WEEKDAY_KO, weekday } from '../common/dates.js';
import { isCustomKey, type CustomChartResult } from '../domain/custom-chart.js';

const BLUE = '#3182F6';
const G900 = '#191F28';
const G700 = '#4E5968';
const G600 = '#6B7684';
const G500 = '#8B95A1';
const G400 = '#B0B8C1';
const G200 = '#E5E8EB';
const G100 = '#F2F4F6';
const BLUE50 = '#E8F3FF';
const RED = '#F04452';
const ORANGE = '#B45F00';

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const man = (n: number) => `${Math.round(n / 10000).toLocaleString('ko-KR')}만원`;
const pctText = (d: number | null | undefined, suffix = '%') => (d == null ? '-' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}${suffix}`);
const deltaColor = (d: number | null | undefined) => (d != null && d > 0 ? BLUE : G900);

function dateKo(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return `${y}년 ${m}월 ${day}일 ${WEEKDAY_KO[weekday(d)]}요일`;
}

function findFont(rel: string): string {
  const candidates = [
    path.resolve(import.meta.dirname, '../../node_modules/@expo-google-fonts/noto-sans-kr', rel),
    path.resolve(process.cwd(), 'node_modules/@expo-google-fonts/noto-sans-kr', rel),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('한글 글꼴 파일을 찾을 수 없어요. npm install 을 다시 실행해 주세요.');
  return hit;
}

function svgBars(series: { sales: number; adCost: number }[], mode: 'bar' | 'line', w = 480, h = 110): string {
  const n = series.length;
  const max = Math.max(1, ...series.map((s) => s.sales));
  const gw = w / n;
  const base = h - 4;
  const k = (h - 18) / max;
  const parts: string[] = [];
  if (mode === 'bar') {
    series.forEach((s, i) => {
      const bw = Math.min(16, gw * 0.3);
      const cx = i * gw + gw / 2;
      const h1 = Math.max(1, s.sales * k);
      const h2 = Math.max(1, s.adCost * k);
      parts.push(`<rect x="${cx - bw - 1}" y="${base - h1}" width="${bw}" height="${h1}" rx="3" fill="${i === n - 1 ? BLUE : G200}"/>`);
      parts.push(`<rect x="${cx + 1}" y="${base - h2}" width="${bw}" height="${h2}" rx="3" fill="${G400}"/>`);
    });
  } else {
    const pts = (key: 'sales' | 'adCost') => series.map((s, i) => `${i * gw + gw / 2},${base - s[key] * k}`).join(' ');
    parts.push(`<polyline points="${pts('adCost')}" fill="none" stroke="${G400}" stroke-width="2" stroke-linejoin="round"/>`);
    parts.push(`<polyline points="${pts('sales')}" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linejoin="round"/>`);
    const last = series[n - 1];
    parts.push(`<circle cx="${(n - 1) * gw + gw / 2}" cy="${base - last.sales * k}" r="3.5" fill="${BLUE}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

function svgLine(values: number[], mode: 'line' | 'bar', w = 480, h = 90): string {
  const n = values.length;
  const gw = w / n;
  const lo = Math.min(...values) * 0.9;
  const hi = Math.max(...values) * 1.05 || 1;
  const base = h - 6;
  const y = (v: number) => base - ((v - lo) / Math.max(hi - lo, 0.0001)) * (h - 22);
  const parts: string[] = [];
  if (mode === 'line') {
    parts.push(`<polyline points="${values.map((v, i) => `${i * gw + gw / 2},${y(v)}`).join(' ')}" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linejoin="round"/>`);
    parts.push(`<circle cx="${(n - 1) * gw + gw / 2}" cy="${y(values[n - 1])}" r="3.5" fill="${BLUE}"/>`);
  } else {
    values.forEach((v, i) => {
      const bw = Math.min(22, gw * 0.5);
      const hh = Math.max(2, base - y(v));
      parts.push(`<rect x="${i * gw + gw / 2 - bw / 2}" y="${base - hh}" width="${bw}" height="${hh}" rx="3" fill="${i === n - 1 ? BLUE : G200}"/>`);
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

const SHARE_COLORS = [BLUE, G500, G400, G200];

function svgDonut(shares: number[], size = 110): string {
  const r = 42;
  const rin = 26;
  const c = size / 2;
  let a0 = -Math.PI / 2;
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  const parts = shares.map((s, i) => {
    const a1 = a0 + (s / total) * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
    const d = `M ${p(r, a0)} A ${r} ${r} 0 ${big} 1 ${p(r, a1)} L ${p(rin, a1)} A ${rin} ${rin} 0 ${big} 0 ${p(rin, a0)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${SHARE_COLORS[i % SHARE_COLORS.length]}" stroke="#ffffff" stroke-width="1.5"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join('')}</svg>`;
}

function labelRow(labels: string[], width = 480) {
  const w = width / labels.length;
  return { columns: labels.map((t, i) => ({ text: t, width: w, alignment: 'center', fontSize: 7, color: i === labels.length - 1 ? G900 : G500 })), margin: [0, 2, 0, 0] };
}

function legendDot(color: string) {
  return { canvas: [{ type: 'rect', x: 0, y: 3, w: 8, h: 8, r: 2, color }], width: 10 };
}

function sectionTitle(text: string, sub?: string) {
  return { text: [{ text, bold: true, fontSize: 11.5, color: G900 }, ...(sub ? [{ text: `  ${sub}`, fontSize: 8, color: G500 }] : [])], margin: [0, 12, 0, 5] };
}

/** "그래프 추가"로 만든 그래프를 PDF에 그려요. (숫자는 서버가 이미 계산해 둔 값이에요) */
function customChartBlocks(cc: CustomChartResult): any[] {
  const out: any[] = [];
  const show = (v: number) => (cc.scale > 1 ? Math.round(v / cc.scale) : Math.round(v)).toLocaleString('ko-KR');
  out.push(sectionTitle(cc.title, `${cc.note ?? ''} · ${cc.unit}`));
  if (!cc.points.length || cc.total <= 0) {
    out.push({ text: '이 기간에는 보여 줄 숫자가 없어요.', fontSize: 9, color: G600 });
    return out;
  }
  if (cc.shape === 'line' || cc.shape === 'vbar') {
    const vals = cc.points.map((p) => p.value / cc.scale);
    const n = cc.points.length;
    const step = Math.ceil(n / 7);
    const labels = cc.points.map((p, i) => (i % step === 0 || i === n - 1 ? p.label.slice(0, 5) : ''));
    out.push({ svg: svgLine(vals, cc.shape === 'vbar' ? 'bar' : 'line'), width: 480 });
    out.push(labelRow(labels));
    out.push({ text: `가장 최근 ${show(cc.points[n - 1].value)}${cc.unit} · 합계 ${show(cc.total)}${cc.unit}`, fontSize: 8.5, color: G600, margin: [0, 2, 0, 0] });
  } else if (cc.shape === 'donut') {
    const items = cc.others > 0 ? [...cc.points, { label: '기타', value: cc.others, share: Math.round((cc.others / cc.total) * 1000) / 10 }] : cc.points;
    out.push({
      columns: [
        { svg: svgDonut(items.map((p) => p.share ?? 0)), width: 110 },
        {
          width: '*',
          margin: [14, 14, 0, 0],
          stack: items.map((p, i) => ({ columns: [{ canvas: [{ type: 'rect', x: 0, y: 3, w: 8, h: 8, r: 2, color: SHARE_COLORS[i % SHARE_COLORS.length] }], width: 12 }, { text: p.label, fontSize: 9, width: 110 }, { text: `${p.share ?? 0}%`, fontSize: 9, bold: true, width: 40 }, { text: `${show(p.value)}${cc.unit}`, fontSize: 8.5, color: G600, width: '*' }], margin: [0, 1, 0, 1] })),
        },
      ],
    });
  } else if (cc.shape === 'table') {
    out.push({
      table: { headerRows: 1, widths: [24, '*', 80, 50], body: [[{ text: '순위', fontSize: 8, color: G600 }, { text: cc.groupLabel, fontSize: 8, color: G600 }, { text: `${cc.metricLabel}(${cc.unit})`, fontSize: 8, color: G600, alignment: 'right' }, { text: '비중', fontSize: 8, color: G600, alignment: 'right' }], ...cc.points.map((p, i) => [{ text: String(i + 1), fontSize: 9 }, { text: p.label, fontSize: 9 }, { text: show(p.value), fontSize: 9, alignment: 'right' }, { text: `${p.share ?? 0}%`, fontSize: 9, alignment: 'right' }])] },
      layout: { hLineColor: () => G200, vLineWidth: () => 0, hLineWidth: (i: number) => (i === 0 ? 0 : 0.6) },
    });
  } else {
    const max = Math.max(1, ...cc.points.map((p) => p.value));
    out.push({
      table: { widths: [110, '*', 50], body: cc.points.map((p, i) => [{ text: p.label, fontSize: 8.5, color: G700, margin: [0, 1, 0, 1] }, { canvas: [{ type: 'rect', x: 0, y: 4, w: Math.max(2, (p.value / max) * 260), h: 7, r: 3, color: i === 0 ? BLUE : G200 }] }, { text: show(p.value), fontSize: 8.5, alignment: 'right', bold: i === 0 }]) },
      layout: 'noBorders',
    });
  }
  return out;
}

@Injectable()
export class PdfService {
  private readonly log = new Logger('Pdf');
  private ready = false;

  private init() {
    if (this.ready) return;
    const normal = findFont('400Regular/NotoSansKR_400Regular.ttf');
    const bold = findFont('700Bold/NotoSansKR_700Bold.ttf');
    (pdfmake as any).setFonts({ NotoSansKR: { normal, bold, italics: normal, bolditalics: bold } });
    // 보안: 글꼴 파일 외에는 읽지 않고, 인터넷 주소는 열지 않아요.
    if (typeof (pdfmake as any).setLocalAccessPolicy === 'function') (pdfmake as any).setLocalAccessPolicy((p: string) => p === normal || p === bold);
    if (typeof (pdfmake as any).setUrlAccessPolicy === 'function') (pdfmake as any).setUrlAccessPolicy(() => false);
    this.ready = true;
  }

  async render(d: any): Promise<Buffer> {
    this.init();
    const snap = d.snapshot;
    const cfg = d.template?.config ?? { title: `모아뷰티 ${d.typeLabel}`, footer: '', sections: [] };
    const content: any[] = [];

    const published = d.status === 'published';
    content.push({
      columns: [
        {
          width: '*',
          stack: [
            { text: cfg.title, bold: true, fontSize: 18, color: G900 },
            { text: `${dateKo(d.date)} · ${snap.meta.basisLabel}`, fontSize: 9, color: G600, margin: [0, 2, 0, 0] },
          ],
        },
        {
          width: 150,
          alignment: 'right',
          stack: [
            { text: published ? '승인됨' : d.status === 'rejected' ? '반려됨' : '승인 전 초안', bold: true, fontSize: 10, color: published ? '#1A7F45' : RED },
            { text: published ? `${d.approvedBy ?? ''} · ${String(d.approvedAt ?? '').slice(5, 16).replace('T', ' ')}` : '아직 공개되지 않았어요', fontSize: 8, color: G500 },
          ],
        },
      ],
    });

    if ((snap.issues ?? []).length) {
      content.push({
        margin: [0, 8, 0, 0],
        table: { widths: ['*'], body: [[{ text: ['수집 확인  ', { text: snap.issues.map((i: any) => `${i.channel} ${i.status === 'partial' ? '일부 누락' : i.status === 'failed' ? '실패' : '누락 의심'}`).join(', '), color: ORANGE }], fontSize: 8.5, color: G700, margin: [6, 4, 6, 4] }]] },
        layout: { fillColor: () => '#FFF1DF', hLineWidth: () => 0, vLineWidth: () => 0 },
      });
    }

    for (const s of cfg.sections) {
      if (!s.enabled) continue;
      if (isCustomKey(s.key)) {
        const cc = d.customCharts?.[s.key] as CustomChartResult | undefined;
        if (cc) content.push(...customChartBlocks(cc));
        continue;
      }
      switch (s.key) {
        case 'summary':
          if (d.summary) {
            content.push({
              margin: [0, 10, 0, 0],
              table: { widths: ['*'], body: [[{ text: [{ text: '요약  ', bold: true, color: BLUE }, { text: d.summary, color: '#333D4B' }], fontSize: 9.5, margin: [8, 6, 8, 6] }]] },
              layout: { fillColor: () => BLUE50, hLineWidth: () => 0, vLineWidth: () => 0 },
            });
          }
          break;
        case 'kpis': {
          const items: KpiItem[] = s.items?.length ? s.items : (Object.keys(KPI_LABEL) as KpiItem[]);
          const k = snap.kpis;
          const valueOf = (i: KpiItem) => (i === 'sales' ? won(k.sales) : i === 'adCost' ? won(k.adCost) : i === 'adEfficiency' ? `${k.adEfficiency}배` : i === 'orders' ? `${k.orders.toLocaleString('ko-KR')}건` : `${k.cancelRate}%`);
          const deltaOf = (i: KpiItem) => (i === 'cancelRate' ? pctText(k.delta.cancelRate, '%p') : pctText(k.delta[i]));
          content.push({
            margin: [0, 10, 0, 0],
            table: {
              widths: items.map(() => '*'),
              body: [
                items.map((i) => ({ stack: [{ text: KPI_LABEL[i], fontSize: 8, color: G600 }, { text: valueOf(i), bold: true, fontSize: 11 }, { text: deltaOf(i), fontSize: 8, color: deltaColor(i === 'cancelRate' ? -(k.delta.cancelRate ?? 0) : k.delta[i]) }], margin: [4, 5, 4, 5] })),
              ],
            },
            layout: { hLineColor: () => G200, vLineColor: () => G200, hLineWidth: () => 0.7, vLineWidth: () => 0.7 },
          });
          break;
        }
        case 'target_progress':
          if (snap.target) {
            const pct = Math.min(100, snap.target.achievement);
            content.push(sectionTitle('목표 달성률'));
            content.push({ canvas: [{ type: 'rect', x: 0, y: 0, w: 480, h: 8, r: 4, color: G100 }, { type: 'rect', x: 0, y: 0, w: (480 * pct) / 100, h: 8, r: 4, color: BLUE }] });
            content.push({ text: `월 매출 목표 ${man(snap.target.value)} 중 ${snap.target.achievement}% 달성`, fontSize: 9, color: G700, margin: [0, 4, 0, 0] });
          }
          break;
        case 'chart_sales_ad': {
          const mode = s.chart === 'line' ? 'line' : 'bar';
          content.push(sectionTitle(SECTION_LABEL[s.key], d.type === 'monthly' ? '주차별' : '최근 7일'));
          content.push({ columns: [legendDot(BLUE), { text: '매출', fontSize: 8, color: G600, width: 28 }, legendDot(G400), { text: '광고비', fontSize: 8, color: G600, width: '*' }], margin: [0, 0, 0, 3] });
          content.push({ svg: svgBars(snap.series, mode), width: 480 });
          content.push(labelRow(snap.series.map((x: any) => x.label)));
          break;
        }
        case 'chart_channel_share': {
          content.push(sectionTitle(SECTION_LABEL[s.key]));
          const ch = snap.channelShare as { name: string; share: number; amount: number }[];
          if (s.chart === 'bar') {
            content.push({
              table: { widths: [90, '*', 70], body: ch.map((c, i) => [{ text: c.name, fontSize: 9, margin: [0, 2, 0, 2] }, { canvas: [{ type: 'rect', x: 0, y: 4, w: Math.max(2, (c.share / 100) * 280), h: 7, r: 3, color: i === 0 ? BLUE : G400 }] }, { text: `${c.share}%`, fontSize: 9, bold: true, alignment: 'right' }]) },
              layout: 'noBorders',
            });
          } else {
            content.push({
              columns: [
                { svg: svgDonut(ch.map((c) => c.share)), width: 110 },
                {
                  width: '*',
                  margin: [14, 22, 0, 0],
                  stack: ch.map((c, i) => ({ columns: [{ canvas: [{ type: 'rect', x: 0, y: 3, w: 8, h: 8, r: 2, color: SHARE_COLORS[i % SHARE_COLORS.length] }], width: 12 }, { text: c.name, fontSize: 9, width: 110 }, { text: `${c.share}%`, fontSize: 9, bold: true, width: 40 }, { text: man(c.amount), fontSize: 8.5, color: G600, width: '*' }], margin: [0, 1, 0, 1] })),
                },
              ],
            });
          }
          break;
        }
        case 'chart_top_products': {
          const limit = Math.min(s.limit ?? 10, snap.topProducts.length);
          const top = (snap.topProducts as any[]).slice(0, limit);
          content.push(sectionTitle(SECTION_LABEL[s.key], '만원'));
          if (s.chart === 'table') {
            content.push({
              table: { headerRows: 1, widths: [24, '*', 80, 60], body: [[{ text: '순위', fontSize: 8, color: G600 }, { text: '상품', fontSize: 8, color: G600 }, { text: '매출', fontSize: 8, color: G600, alignment: 'right' }, { text: '수량', fontSize: 8, color: G600, alignment: 'right' }], ...top.map((p, i) => [{ text: String(i + 1), fontSize: 9 }, { text: p.name, fontSize: 9 }, { text: won(p.amount), fontSize: 9, alignment: 'right' }, { text: `${p.quantity}개`, fontSize: 9, alignment: 'right' }])] },
              layout: { hLineColor: () => G200, vLineWidth: () => 0, hLineWidth: (i: number) => (i === 0 ? 0 : 0.6) },
            });
          } else {
            const max = Math.max(1, ...top.map((p) => p.amount));
            content.push({
              table: { widths: [110, '*', 40], body: top.map((p, i) => [{ text: p.name, fontSize: 8.5, color: G700, margin: [0, 1, 0, 1] }, { canvas: [{ type: 'rect', x: 0, y: 4, w: Math.max(2, (p.amount / max) * 260), h: 7, r: 3, color: i === 0 ? BLUE : G200 }] }, { text: Math.round(p.amount / 10000).toLocaleString('ko-KR'), fontSize: 8.5, alignment: 'right', bold: i === 0 }]) },
              layout: 'noBorders',
            });
          }
          break;
        }
        case 'chart_product_movers': {
          const mv = snap.productMovers;
          if (!mv) break;
          const lim = s.limit ?? 3;
          const vs = snap.meta.type === 'daily' ? '전일 대비' : snap.meta.type === 'weekly' ? '지난주 대비' : '지난달 대비';
          content.push(sectionTitle(SECTION_LABEL[s.key], vs));
          if (!mv.hasPrev) {
            content.push({ text: '비교할 지난 기간 자료가 없어요.', fontSize: 9, color: G600 });
            break;
          }
          const line = (p: any, i: number, up: boolean) => ({ columns: [{ text: p.name, fontSize: 9, width: 110 }, { text: p.rate == null ? '새로 팔렸어요' : `${up ? '▲' : '▼'} ${Math.abs(p.rate)}%`, fontSize: 9, bold: true, color: up ? BLUE : G600, width: 70 }, { text: `${up ? '+' : '−'}${Math.round(Math.abs(p.diff) / 10000).toLocaleString('ko-KR')}만원`, fontSize: 8.5, color: G600, width: '*' }], margin: [0, 1, 0, 1] });
          content.push({ text: '많이 늘었어요', fontSize: 8.5, color: G600, margin: [0, 2, 0, 2] });
          if (!mv.up.length) content.push({ text: '늘어난 상품이 없어요.', fontSize: 9, color: G600 });
          for (const [i, p] of (mv.up as any[]).slice(0, lim).entries()) content.push(line(p, i, true));
          content.push({ text: '많이 줄었어요', fontSize: 8.5, color: G600, margin: [0, 6, 0, 2] });
          if (!mv.down.length) content.push({ text: '줄어든 상품이 없어요.', fontSize: 9, color: G600 });
          for (const [i, p] of (mv.down as any[]).slice(0, lim).entries()) content.push(line(p, i, false));
          break;
        }
        case 'chart_ad_efficiency': {
          const vals = (snap.efficiencyTrend as any[]).map((x) => x.value);
          content.push(sectionTitle(SECTION_LABEL[s.key], '배'));
          content.push({ svg: svgLine(vals, s.chart === 'bar' ? 'bar' : 'line'), width: 480 });
          content.push(labelRow((snap.efficiencyTrend as any[]).map((x) => x.label)));
          content.push({ text: `가장 최근 ${vals[vals.length - 1]}배${snap.flags?.adEfficiencyLow ? ` · 기준(${snap.flags.adEfficiencyLowThreshold}배)보다 낮아요` : ''}`, fontSize: 8.5, color: snap.flags?.adEfficiencyLow ? RED : G600, margin: [0, 2, 0, 0] });
          break;
        }
        case 'chart_cancel_trend': {
          if (!snap.cancelTrend?.length) break;
          const vals = (snap.cancelTrend as any[]).map((x) => x.value);
          content.push(sectionTitle(SECTION_LABEL[s.key], '%'));
          content.push({ svg: svgLine(vals, s.chart === 'bar' ? 'bar' : 'line'), width: 480 });
          content.push(labelRow((snap.cancelTrend as any[]).map((x) => x.label)));
          break;
        }
        case 'stock_table': {
          let alerts = snap.stockAlerts as any[];
          if (s.filter === 'danger') alerts = alerts.filter((a) => a.level === 'danger');
          alerts = alerts.slice(0, s.limit ?? 10);
          const ai = new Map<number, string>((d.aiStock?.items ?? []).map((x: any) => [x.productId, x.sentence]));
          content.push(sectionTitle(SECTION_LABEL[s.key], `위험 ${snap.stockSummary.danger} · 주의 ${snap.stockSummary.warn}`));
          if (!alerts.length) {
            content.push({ text: '확인이 필요한 재고가 없어요.', fontSize: 9, color: G600 });
          } else {
            const head = ['상품', '재고', '재고 일수', '상태', '권장 발주'].map((t) => ({ text: t, fontSize: 8, color: G600 }));
            content.push({
              table: {
                headerRows: 1,
                widths: ['*', 42, 54, 38, 58],
                body: [
                  head,
                  ...alerts.flatMap((a) => {
                    const row = [
                      { text: a.name, fontSize: 9, bold: true },
                      { text: `${a.qty}개`, fontSize: 9 },
                      { text: a.days >= 999 ? '-' : `${a.days}일치`, fontSize: 9 },
                      { text: a.level === 'danger' ? '위험' : '주의', fontSize: 9, bold: true, color: a.level === 'danger' ? RED : ORANGE },
                      { text: a.suggestOrderQty > 0 ? `${a.suggestOrderQty}개` : '-', fontSize: 9 },
                    ];
                    return ai.has(a.productId)
                      ? [row, [{ text: [{ text: 'AI 제안  ', bold: true, color: BLUE }, { text: ai.get(a.productId) as string, color: G700 }], fontSize: 8, colSpan: 5, margin: [0, 0, 0, 2] }, {}, {}, {}, {}]]
                      : [row];
                  }),
                ],
              },
              layout: { hLineColor: () => G200, vLineWidth: () => 0, hLineWidth: (i: number) => (i === 0 ? 0 : 0.6) },
            });
          }
          break;
        }
        case 'notes': {
          content.push(sectionTitle(SECTION_LABEL[s.key]));
          if (!d.notes.length) content.push({ text: '남겨진 메모가 없어요.', fontSize: 9, color: G600 });
          for (const n of d.notes) {
            content.push({ text: [{ text: `${n.author ?? ''}  `, bold: true, fontSize: 8.5, color: G700 }, { text: n.note, fontSize: 9, color: '#333D4B' }, ...(n.source === 'ai_draft' ? [{ text: '  (AI 초안을 고쳐 썼어요)', fontSize: 7.5, color: G500 }] : [])], margin: [0, 1, 0, 3] });
          }
          break;
        }
        default:
          break;
      }
    }

    const used = (d.criteriaUsed as any[]).filter((c) => ['stock_warn_qty', 'stock_warn_days', 'stock_danger_qty', 'stock_danger_days'].includes(c.code));
    const footLeft = [`양식 ${d.template?.versionNo ? 'v' + d.template.versionNo : ''}`, used.length ? `기준: ${used.map((c) => `${c.name} ${c.value}${c.unit}`).join(' · ')}` : '', cfg.footer].filter(Boolean).join('  |  ');

    const doc: any = {
      pageSize: 'A4',
      pageMargins: [36, 40, 36, 44],
      info: { title: `${cfg.title} ${d.date}`, author: '모아뷰티 리포트' },
      defaultStyle: { font: 'NotoSansKR', fontSize: 9.5, color: G900, lineHeight: 1.25 },
      content,
      footer: (page: number, pages: number) => ({
        margin: [36, 10, 36, 0],
        columns: [{ text: footLeft, fontSize: 7, color: G500, width: '*' }, { text: `${page} / ${pages}`, fontSize: 7, color: G500, alignment: 'right', width: 40 }],
      }),
    };
    const buf = await (pdfmake as any).createPdf(doc).getBuffer();
    return Buffer.from(buf);
  }
}
