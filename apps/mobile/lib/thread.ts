import { tsMicros, type Msg } from './messages';

// 메신저식 대화 배치(MASTER 5장). 화면과 무관한 순수 함수라 따로 시험한다.
type M = Pick<Msg, 'sender_id' | 'created_at'>;
export type Slot = {
  first: boolean; // 묶음(같은 사람·같은 날 연속)의 첫 말풍선: 상대는 사진·이름
  last: boolean; // 묶음의 마지막 말풍선: 꼬리
  showTime: boolean; // 같은 사람·같은 분 묶음의 마지막: 시간과 안 읽은 수
  dateBefore: string | null; // 날이 바뀌면 그 위에 놓을 구분("2026년 11월 1일 일요일")
};

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const date = (ts: string) => new Date(tsMicros(ts) / 1000);
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const minuteKey = (d: Date) => `${dayKey(d)}-${d.getHours()}-${d.getMinutes()}`;

export function dateLabel(ts: string): string {
  const d = date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일`;
}

// prev/next는 시간 순서로 바로 앞·뒤 메시지(없으면 undefined). 시각을 못 읽으면(NaN) 날짜·분이 같다고 보지 않는다.
export function slotFor(m: M, prev?: M, next?: M): Slot {
  const d = date(m.created_at);
  const same = (o: M | undefined, key: (x: Date) => string) => !!o && o.sender_id === m.sender_id && !Number.isNaN(d.getTime()) && key(date(o.created_at)) === key(d);
  const sameDay = (o: M | undefined) => !!o && !Number.isNaN(d.getTime()) && dayKey(date(o.created_at)) === dayKey(d);
  return {
    first: !(same(prev, dayKey)),
    last: !same(next, dayKey),
    showTime: !same(next, minuteKey),
    dateBefore: sameDay(prev) ? null : dateLabel(m.created_at) || null,
  };
}
