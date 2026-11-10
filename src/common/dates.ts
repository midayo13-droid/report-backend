// 날짜는 'YYYY-MM-DD' 문자열로만 다뤄요. (시간대 문제를 피하려고 UTC로 계산합니다)
const DAY = 86400000;

function toUtc(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 서버 컴퓨터의 오늘 날짜 */
export function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(s: string, n: number): string {
  return fromUtc(toUtc(s) + n * DAY);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / DAY);
}

/** 0=일요일 … 6=토요일 */
export function weekday(s: string): number {
  return new Date(toUtc(s)).getUTCDay();
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthStart(s: string): string {
  return `${s.slice(0, 7)}-01`;
}

export function monthEnd(s: string): string {
  const [y, m] = s.split('-').map(Number);
  return fromUtc(Date.UTC(y, m, 0));
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUtc(s));
}

export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** 한국 시간 기준 시각 문자열(타임스탬프용) */
export function kst(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00+09:00`;
}
