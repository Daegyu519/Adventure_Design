import type { Tables } from './types/db';

export const PAGE_SIZE = 30;
export type Msg = Tables<'messages'>;

// id(서버 순서) 기준으로 합친다. 같은 id는 나중 것(b)이 이긴다. 내 insert 응답·Realtime 에코·재연결 뒤 따라잡기·이전 페이지가 모두 이 한 길을 지난다.
export function mergeMessages(a: Msg[], b: Msg[]): Msg[] {
  const byId = new Map<number, Msg>();
  for (const x of a) byId.set(x.id, x);
  for (const x of b) byId.set(x.id, x);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

// PostgREST는 `2026-10-27T01:32:17.123456+00:00`, Realtime은 `2026-10-27 01:32:17.123456+00`(공백, 오프셋 시만)로 준다. Date.parse는 밀리초까지라 소수부는 따로 센다.
export function tsMicros(ts: string): number {
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(ts.trim());
  if (!m) return NaN;
  const [, d, t, frac = '', z] = m;
  const off = z === 'Z' ? 'Z' : z.length === 3 ? `${z}:00` : z.length === 5 ? `${z.slice(0, 3)}:${z.slice(3)}` : z;
  const micros = Number(frac.padEnd(6, '0').slice(0, 6));
  return Date.parse(`${d}T${t}${off}`) * 1000 + micros;
}

// 앞에 보이고, 포커스가 있고, 내가 읽은 시각보다 더 새 메시지가 있을 때만(뒤로는 가지 않는다).
export function shouldMarkRead(o: { appActive: boolean; focused: boolean; newest: string | null; lastRead: string | null }): boolean {
  if (!o.appActive || !o.focused || !o.newest) return false;
  return o.lastRead === null || tsMicros(o.newest) > tsMicros(o.lastRead);
}

// 같은 날이면 "오후 3:07", 아니면 "10월 26일"(기기 시간대). Intl은 안드로이드 Hermes에서 믿기 어려워 직접 만든다.
export function formatStamp(ts: string, now: Date = new Date()): string {
  const d = new Date(tsMicros(ts) / 1000);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() !== now.toDateString()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  const h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}
