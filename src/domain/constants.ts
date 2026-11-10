// 판매처, 기준표, 역할 같은 고정 정보예요. 기획서 5.1-4(기준표 초기값)와 같은 값을 씁니다.
export type Role = 'viewer' | 'user' | 'admin' | 'superadmin';
export type Area = 'ops' | 'marketing' | 'stock' | 'none';

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '조회자',
  user: '사용자',
  admin: '관리자',
  superadmin: '총관리자',
};

export const AREA_LABEL: Record<Area, string> = {
  ops: '운영',
  marketing: '마케팅',
  stock: '재고',
  none: '없음',
};

export interface ChannelDef {
  code: string;
  name: string;
  type: 'sales' | 'ad' | 'stock';
  weight?: number; // 판매 비중(가상 데이터용)
}

export const CHANNELS: ChannelDef[] = [
  { code: 'own', name: '자사몰', type: 'sales', weight: 0.34 },
  { code: 'smartstore', name: '스마트스토어', type: 'sales', weight: 0.29 },
  { code: 'coupang', name: '쿠팡', type: 'sales', weight: 0.25 },
  { code: 'st11', name: '11번가', type: 'sales', weight: 0.12 },
  { code: 'naver_ad', name: '네이버 검색광고', type: 'ad' },
  { code: 'meta_ad', name: '인스타·페이스북 광고', type: 'ad' },
  { code: 'coupang_ad', name: '쿠팡 광고', type: 'ad' },
  { code: 'warehouse', name: '창고 재고', type: 'stock' },
];

export interface CriteriaDef {
  code: string;
  name: string;
  unit: string;
  ownerArea: 'ops' | 'marketing' | 'stock' | 'admin';
  description: string;
  value: string;
  editable: boolean;
  min?: number;
  max?: number;
  decimal?: boolean; // 소수도 쓸 수 있는 기준
}

export const CRITERIA_DEFS: CriteriaDef[] = [
  { code: 'stock_warn_qty', name: '재고 주의 수량', unit: '개', ownerArea: 'stock', description: '재고가 이 수량 이하면 "주의"로 표시해요.', value: '10', editable: true, min: 1, max: 100 },
  { code: 'stock_warn_days', name: '재고 주의 일수', unit: '일', ownerArea: 'stock', description: '재고가 이 일수치 미만이면 "주의"로 표시해요.', value: '3', editable: true, min: 1, max: 14 },
  { code: 'stock_danger_qty', name: '재고 위험 수량', unit: '개', ownerArea: 'stock', description: '재고가 이 수량 이하면 "위험"(품절 임박)으로 표시해요.', value: '3', editable: true, min: 0, max: 50 },
  { code: 'stock_danger_days', name: '재고 위험 일수', unit: '일', ownerArea: 'stock', description: '재고가 이 일수치 미만이면 "위험"으로 표시해요.', value: '1', editable: true, min: 1, max: 7 },
  { code: 'avg_sales_period', name: '평균 판매 기간', unit: '일', ownerArea: 'stock', description: '재고 일수를 계산할 때 쓰는 평균 판매 기간이에요.', value: '7', editable: true, min: 3, max: 30 },
  { code: 'stock_target_days', name: '목표 재고 일수', unit: '일', ownerArea: 'stock', description: '발주를 제안할 때 맞추려는 재고 일수예요.', value: '7', editable: true, min: 3, max: 30 },
  { code: 'ad_efficiency_low', name: '광고 효율 낮음 기준', unit: '배', ownerArea: 'marketing', description: '광고 효율이 이 값보다 낮으면 보고서에 "광고 효율이 낮아요"를 표시해요.', value: '3.5', editable: true, min: 1, max: 10, decimal: true },
  { code: 'ad_efficiency', name: '광고 효율 계산', unit: '', ownerArea: 'marketing', description: '광고 효율 = 매출 ÷ 광고비 (광고비 1원당 매출). 계산 방법은 고정이에요.', value: 'sales_div_ad_cost', editable: false },
  { code: 'sales_basis', name: '매출 집계 기준', unit: '', ownerArea: 'ops', description: '완료된 주문 금액만 더하고 취소는 뺍니다. 계산 방법은 고정이에요.', value: 'completed_only', editable: false },
  { code: 'top_n', name: '상품 순위 개수', unit: '개', ownerArea: 'ops', description: '일일·주간 보고서의 상품 순위 개수예요. 월말은 두 배로 보여 줘요.', value: '10', editable: true, min: 3, max: 15 },
  { code: 'missing_alert', name: '누락 의심 기준', unit: '%', ownerArea: 'ops', description: '주문 건수가 전일의 이 비율 미만이면 "누락 의심"으로 표시해요.', value: '50', editable: true, min: 10, max: 90 },
  { code: 'monthly_target', name: '월 매출 목표', unit: '원', ownerArea: 'admin', description: '월말 보고서의 목표 달성률 계산에 써요.', value: '1000000000', editable: true, min: 100000000, max: 100000000000 },
];

export const CRITERIA_BY_CODE: Record<string, CriteriaDef> = Object.fromEntries(CRITERIA_DEFS.map((c) => [c.code, c]));

export const DEMO_ACCOUNTS: { email: string; name: string; role: Role; area: Area; title: string }[] = [
  { email: 'ceo@moabeauty.test', name: '박대표', role: 'viewer', area: 'none', title: '대표' },
  { email: 'lead.sales@moabeauty.test', name: '윤하은', role: 'viewer', area: 'none', title: '영업 팀장' },
  { email: 'lead.mkt@moabeauty.test', name: '최민준', role: 'viewer', area: 'none', title: '마케팅 팀장' },
  { email: 'lead.ops@moabeauty.test', name: '정서연', role: 'viewer', area: 'none', title: '운영 팀장' },
  { email: 'lead.stock@moabeauty.test', name: '강도윤', role: 'viewer', area: 'none', title: '재고 팀장' },
  { email: 'lead.admin@moabeauty.test', name: '임지후', role: 'viewer', area: 'none', title: '경영지원 팀장' },
  { email: 'ops1@moabeauty.test', name: '오세린', role: 'user', area: 'ops', title: '운영 담당' },
  { email: 'ops2@moabeauty.test', name: '문지훈', role: 'user', area: 'ops', title: '운영 담당' },
  { email: 'mkt@moabeauty.test', name: '한유나', role: 'user', area: 'marketing', title: '마케팅 담당' },
  { email: 'stock@moabeauty.test', name: '송민호', role: 'user', area: 'stock', title: '재고 담당' },
  { email: 'director@moabeauty.test', name: '이서진', role: 'admin', area: 'none', title: '이 이사' },
  { email: 'sysadmin@moabeauty.test', name: '오세린(총관리자)', role: 'superadmin', area: 'ops', title: '운영 담당 겸임' },
];
