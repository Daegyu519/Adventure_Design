// 리포트 화면의 순수 함수. 타입은 생성 파일에서 꺼내기만 한다. 시계는 읽지 않는다(오늘 날짜는 호출자가 넘긴다).
import type { StatsRes } from './engine';

export const WEEKS_SHOWN = 5; // 엔진이 주는 hints_by_week 주 수와 같다
const MIN_BAR_PX = 4; // 0이 아닌 막대가 점처럼 사라지지 않게
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 한국은 서머타임이 없어 고정 +9시간이면 정확하다

export function formatRate(r: number | null | undefined): string {
  return r == null || !Number.isFinite(r) ? '–' : `${Math.round(r * 100)}%`;
}

export function barHeights(counts: number[], maxPx: number): number[] {
  const max = Math.max(0, ...counts);
  return counts.map((c) => (c <= 0 || max === 0 ? 0 : Math.max(MIN_BAR_PX, Math.round((c / max) * maxPx))));
}

// 'YYYY-MM-DD'를 잘라 쓴다. Date로 바꾸면 시간대 때문에 하루 밀린다.
const month = (iso: string) => Number(iso.slice(5, 7));
const day = (iso: string) => Number(iso.slice(8, 10));

export const weekLabel = (iso: string) => `${month(iso)}/${day(iso)}`;
export const weekSpoken = (iso: string) => `${month(iso)}월 ${day(iso)}일`;

// 한국 날짜(YYYY-MM-DD). 기기 시간대와 무관하다.
export const kstDate = (now: Date) => new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

// 그 날이 속한 주의 월요일(엔진의 주 기준과 같다: KST 월요일).
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function thisWeekCount(byWeek: StatsRes['hints_by_week'], todayKST: string): number {
  const start = weekStart(todayKST);
  return byWeek.find((w) => w.week === start)?.count ?? 0;
}

// 타일 하나: 마지막 주의 평균 차이. 어느 주 값인지 설명에 붙인다. 기록이 없으면 "–".
export function gapTile(trend: StatsRes['predict_gap_trend']): { value: string; label: string } {
  const last = trend[trend.length - 1];
  return last ? { value: `${last.avg_gap.toFixed(1)}칸`, label: `${weekLabel(last.week)} 주 예측과의 차이` } : { value: '–', label: '예측과의 차이' };
}
