// 보고서 양식 설정. 양식은 "모양"만 바꿔요: 항목 켜기·끄기, 순서, 그래프 종류, 표시 개수, 제목 문구.
// 계산 방법은 여기에 없고(= 기준), 양식으로는 바꿀 수 없어요.
import { CUSTOM_GROUPS, CUSTOM_METRICS, CUSTOM_SHAPES, MAX_CUSTOM_CHARTS, isCustomKey, validateCustomSpec, type CustomChartSpec } from './custom-chart.js';

export type TemplateType = 'daily' | 'weekly' | 'monthly';

export const KPI_ITEMS = ['sales', 'adCost', 'adEfficiency', 'orders', 'cancelRate'] as const;
export type KpiItem = (typeof KPI_ITEMS)[number];

export const KPI_LABEL: Record<KpiItem, string> = {
  sales: '매출',
  adCost: '광고비',
  adEfficiency: '광고 효율',
  orders: '주문',
  cancelRate: '취소율',
};

export const SECTION_LABEL: Record<string, string> = {
  summary: '요약',
  kpis: '핵심 숫자',
  target_progress: '목표 달성률',
  chart_sales_ad: '매출과 광고비',
  chart_channel_share: '판매처별 매출 비중',
  chart_top_products: '상품 매출 순위',
  chart_product_movers: '많이 달라진 상품',
  chart_ad_efficiency: '광고 효율 추이',
  chart_cancel_trend: '취소율 추이',
  stock_table: '재고 부족 상품',
  notes: '비고',
};

export const CHART_LABEL: Record<string, string> = {
  bar: '막대',
  line: '꺾은선',
  donut: '원',
  hbar: '가로 막대',
  table: '표',
};

const CHART_CHOICES: Record<string, string[]> = {
  chart_sales_ad: ['bar', 'line'],
  chart_channel_share: ['donut', 'bar'],
  chart_top_products: ['hbar', 'table'],
  chart_ad_efficiency: ['line', 'bar'],
  chart_cancel_trend: ['line', 'bar'],
};

const ALLOWED_KEYS: Record<TemplateType, string[]> = {
  daily: ['summary', 'kpis', 'chart_sales_ad', 'chart_channel_share', 'chart_top_products', 'chart_product_movers', 'chart_ad_efficiency', 'stock_table', 'notes'],
  weekly: ['summary', 'kpis', 'chart_sales_ad', 'chart_channel_share', 'chart_top_products', 'chart_product_movers', 'chart_ad_efficiency', 'stock_table', 'notes'],
  monthly: ['summary', 'kpis', 'target_progress', 'chart_sales_ad', 'chart_channel_share', 'chart_top_products', 'chart_product_movers', 'chart_ad_efficiency', 'chart_cancel_trend', 'stock_table', 'notes'],
};

/** 나중에 새로 생긴 항목이에요. 예전에 저장한 양식에 없으면 에러 대신 기본 설정으로 채워 줘요. */
const LATER_ADDED_KEYS = ['chart_product_movers'];

/** 예전에 저장한 양식에 새 항목이 없으면, 상품 매출 순위 바로 뒤에 기본값으로 넣어 줘요. */
export function withLaterAddedSections(type: TemplateType, config: TemplateConfig): TemplateConfig {
  const sections = [...(config?.sections ?? [])];
  for (const key of LATER_ADDED_KEYS) {
    if (!ALLOWED_KEYS[type].includes(key) || sections.some((s) => s.key === key)) continue;
    const at = sections.findIndex((s) => s.key === 'chart_top_products');
    sections.splice(at === -1 ? sections.length : at + 1, 0, defaultSection(key));
  }
  return { ...config, sections };
}

export interface SectionConfig {
  key: string;
  enabled: boolean;
  chart?: string;
  items?: KpiItem[];
  filter?: 'all' | 'danger';
  limit?: number;
  /** "그래프 추가"로 만든 그래프의 설정 (key 가 custom: 으로 시작할 때만 있어요) */
  custom?: CustomChartSpec;
}

/** 화면과 변경 내용에 보여 줄 항목 이름이에요. 직접 만든 그래프는 사용자가 붙인 이름을 써요. */
export function sectionLabel(sec: { key: string; custom?: CustomChartSpec }): string {
  if (isCustomKey(sec.key)) return sec.custom?.title ?? '추가한 그래프';
  return SECTION_LABEL[sec.key] ?? sec.key;
}

export interface TemplateConfig {
  title: string;
  footer: string;
  sections: SectionConfig[];
}

export const TEMPLATE_NAME: Record<TemplateType, string> = {
  daily: '일일 보고서',
  weekly: '주간 보고서',
  monthly: '월말 보고서',
};

export function defaultSection(key: string): SectionConfig {
  switch (key) {
    case 'kpis':
      return { key, enabled: true, items: [...KPI_ITEMS] };
    case 'chart_sales_ad':
      return { key, enabled: true, chart: 'bar' };
    case 'chart_channel_share':
      return { key, enabled: true, chart: 'donut' };
    case 'chart_top_products':
      return { key, enabled: true, chart: 'hbar', limit: 10 };
    case 'chart_product_movers':
      return { key, enabled: true, limit: 3 };
    case 'chart_ad_efficiency':
      return { key, enabled: true, chart: 'line' };
    case 'chart_cancel_trend':
      return { key, enabled: true, chart: 'line' };
    case 'stock_table':
      return { key, enabled: true, filter: 'all', limit: 10 };
    default:
      return { key, enabled: true };
  }
}

export function defaultConfig(type: TemplateType): TemplateConfig {
  return {
    title: `모아뷰티 ${TEMPLATE_NAME[type]}`,
    footer: '',
    sections: ALLOWED_KEYS[type].map(defaultSection),
  };
}

export function allowedKeys(type: TemplateType): string[] {
  return ALLOWED_KEYS[type];
}

export function chartChoices(key: string): string[] {
  return CHART_CHOICES[key] ?? [];
}

/** 양식 설정이 허용 범위 안인지 검사하고, 깨끗하게 정리한 설정을 돌려줘요. */
export function validateTemplateConfig(
  type: TemplateType,
  input: any,
): { ok: boolean; errors: string[]; config?: TemplateConfig } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['양식 설정이 올바르지 않아요.'] };
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length < 1 || title.length > 40) errors.push('제목은 1~40자로 써 주세요.');
  const footer = typeof input.footer === 'string' ? input.footer.trim() : '';
  if (footer.length > 80) errors.push('맨 아래 문구는 80자 이하로 써 주세요.');
  if (!Array.isArray(input.sections)) {
    errors.push('항목 목록(sections)이 필요해요.');
    return { ok: false, errors };
  }
  const allowed = ALLOWED_KEYS[type];
  const seen = new Set<string>();
  const sections: SectionConfig[] = [];
  let customCount = 0;
  for (const raw of input.sections) {
    const key = raw?.key;
    if (isCustomKey(key)) {
      if (!/^custom:[a-z0-9]{3,12}$/.test(key)) {
        errors.push('추가한 그래프의 이름표가 올바르지 않아요.');
        continue;
      }
      if (seen.has(key)) {
        errors.push('같은 그래프가 두 번 들어 있어요.');
        continue;
      }
      if (++customCount > MAX_CUSTOM_CHARTS) {
        if (customCount === MAX_CUSTOM_CHARTS + 1) errors.push(`추가하는 그래프는 ${TEMPLATE_NAME[type]}마다 ${MAX_CUSTOM_CHARTS}개까지예요.`);
        continue;
      }
      const check = validateCustomSpec(raw.custom);
      if (!check.ok || !check.spec) {
        errors.push(...check.errors.map((e) => `"${raw.custom?.title ?? '추가한 그래프'}": ${e}`));
        continue;
      }
      seen.add(key);
      sections.push({ key, enabled: raw.enabled !== false, custom: check.spec });
      continue;
    }
    if (typeof key !== 'string' || !allowed.includes(key)) {
      errors.push(`"${key}" 항목은 ${TEMPLATE_NAME[type]}에서 쓸 수 없어요.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`"${SECTION_LABEL[key]}" 항목이 두 번 들어 있어요.`);
      continue;
    }
    seen.add(key);
    const sec: SectionConfig = { key, enabled: raw.enabled !== false };
    if (CHART_CHOICES[key]) {
      const chart = raw.chart ?? defaultSection(key).chart;
      if (!CHART_CHOICES[key].includes(chart)) {
        errors.push(`"${SECTION_LABEL[key]}"의 그래프 종류는 ${CHART_CHOICES[key].map((c) => CHART_LABEL[c]).join(', ')} 중에서 골라 주세요.`);
      } else {
        sec.chart = chart;
      }
    }
    if (key === 'kpis') {
      const items = Array.isArray(raw.items) ? raw.items : [...KPI_ITEMS];
      const bad = items.filter((i: any) => !KPI_ITEMS.includes(i));
      if (bad.length) errors.push(`핵심 숫자에 없는 항목이 있어요: ${bad.join(', ')}`);
      if (items.length < 1) errors.push('핵심 숫자는 1개 이상 보여 주세요.');
      sec.items = items.filter((i: any) => KPI_ITEMS.includes(i));
    }
    if (key === 'stock_table') {
      const filter = raw.filter ?? 'all';
      if (filter !== 'all' && filter !== 'danger') errors.push('재고 표시 조건은 전체 또는 위험만 가능해요.');
      sec.filter = filter === 'danger' ? 'danger' : 'all';
      const limit = Number(raw.limit ?? 10);
      if (!Number.isInteger(limit) || limit < 3 || limit > 20) errors.push('재고 표의 표시 개수는 3~20개예요.');
      sec.limit = Math.min(20, Math.max(3, Number.isInteger(limit) ? limit : 10));
    }
    if (key === 'chart_top_products') {
      const limit = Number(raw.limit ?? 10);
      if (!Number.isInteger(limit) || limit < 3 || limit > 20) errors.push('상품 순위의 표시 개수는 3~20개예요.');
      sec.limit = Math.min(20, Math.max(3, Number.isInteger(limit) ? limit : 10));
    }
    if (key === 'chart_product_movers') {
      const limit = Number(raw.limit ?? 3);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) errors.push('많이 달라진 상품의 표시 개수는 1~5개예요.');
      sec.limit = Math.min(5, Math.max(1, Number.isInteger(limit) ? limit : 3));
    }
    sections.push(sec);
  }
  for (const key of allowed) {
    if (LATER_ADDED_KEYS.includes(key) && !seen.has(key)) {
      const at = sections.findIndex((s) => s.key === 'chart_top_products');
      sections.splice(at === -1 ? sections.length : at + 1, 0, defaultSection(key));
      seen.add(key);
    }
    if (!seen.has(key)) errors.push(`"${SECTION_LABEL[key]}" 항목이 빠졌어요. 끄려면 목록에서 빼지 말고 enabled를 false로 해 주세요.`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], config: { title, footer, sections } };
}

/** 두 설정이 어떻게 다른지 쉬운 말로 알려 줘요. (변경 전후 미리보기에 써요) */
export function describeChanges(before: TemplateConfig, after: TemplateConfig): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push(`제목: "${before.title}" → "${after.title}"`);
  if ((before.footer ?? '') !== (after.footer ?? '')) out.push(`맨 아래 문구: "${before.footer || '(없음)'}" → "${after.footer || '(없음)'}"`);
  // 새로 생기거나 지워진 그래프 때문에 번호가 밀린 것은 "위치 바뀜"으로 세지 않아요.
  const bi = before.sections.map((s) => s.key).filter((k) => after.sections.some((s) => s.key === k));
  const ai = after.sections.map((s) => s.key).filter((k) => before.sections.some((s) => s.key === k));
  for (const sec of before.sections) {
    if (isCustomKey(sec.key) && !after.sections.some((s) => s.key === sec.key)) out.push(`그래프 지우기: "${sectionLabel(sec)}"`);
  }
  for (const sec of after.sections) {
    const prev = before.sections.find((s) => s.key === sec.key);
    const label = sectionLabel(sec);
    if (!prev) {
      if (isCustomKey(sec.key) && sec.custom) {
        out.push(`그래프 추가: "${label}" (${CUSTOM_METRICS[sec.custom.metric].label} × ${CUSTOM_GROUPS[sec.custom.groupBy].label} × ${CUSTOM_SHAPES[sec.custom.shape]}${sec.custom.days > 0 ? `, 최근 ${sec.custom.days}일` : ''})`);
      }
      continue;
    }
    if (isCustomKey(sec.key) && JSON.stringify(prev.custom) !== JSON.stringify(sec.custom) && sec.custom) {
      out.push(`"${label}" 설정을 바꿨어요 (${CUSTOM_METRICS[sec.custom.metric].label} × ${CUSTOM_GROUPS[sec.custom.groupBy].label} × ${CUSTOM_SHAPES[sec.custom.shape]})`);
    }
    if (prev.enabled !== sec.enabled) out.push(`"${label}": ${sec.enabled ? '보여 줘요' : '숨겨요'}`);
    if (prev.chart !== sec.chart && sec.chart) out.push(`"${label}" 그래프: ${CHART_LABEL[prev.chart ?? ''] ?? '-'} → ${CHART_LABEL[sec.chart]}`);
    if (prev.filter !== sec.filter && sec.filter) out.push(`"${label}" 표시 조건: ${prev.filter === 'danger' ? '위험만' : '전체'} → ${sec.filter === 'danger' ? '위험만' : '전체'}`);
    if (prev.limit !== sec.limit && sec.limit) out.push(`"${label}" 표시 개수: ${prev.limit}개 → ${sec.limit}개`);
    if (JSON.stringify(prev.items) !== JSON.stringify(sec.items) && sec.items) {
      out.push(`"${label}" 항목: ${sec.items.map((i) => KPI_LABEL[i]).join(', ')}`);
    }
  }
  for (let i = 0; i < ai.length; i++) {
    const key = ai[i];
    const from = bi.indexOf(key);
    if (from !== -1 && from !== i) out.push(`"${sectionLabel(after.sections.find((s) => s.key === key)!)}" 위치: ${from + 1}번째 → ${i + 1}번째`);
  }
  return out;
}
