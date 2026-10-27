// 리포트 화면의 순수 함수. 타입은 생성 파일에서 꺼내기만 한다.
import type { StatsRes } from './engine';

export const WEEKS_SHOWN = 5; // 엔진이 주는 hints_by_week 주 수와 같다
const MIN_BAR_PX = 4; // 0이 아닌 막대가 점처럼 사라지지 않게

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

export function latestGap(trend: StatsRes['predict_gap_trend']): string | null {
  const last = trend[trend.length - 1];
  return last ? `${weekLabel(last.week)} 주 예측과 평균 ${last.avg_gap.toFixed(1)}칸 차이` : null;
}
