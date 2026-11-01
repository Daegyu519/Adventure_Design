import { dateLabel, slotFor } from '../thread';

const at = (s: string, h: number, min: number, day = 1) => ({ sender_id: s, created_at: new Date(2026, 10, day, h, min, 0).toISOString() });

describe('slotFor', () => {
  const m1 = at('a', 14, 14);
  const m2 = at('a', 14, 14);
  const m3 = at('a', 14, 15);
  const m4 = at('b', 14, 15);

  it('같은 사람 연속은 첫/마지막만 표시한다', () => {
    expect(slotFor(m1, undefined, m2)).toMatchObject({ first: true, last: false });
    expect(slotFor(m2, m1, m3)).toMatchObject({ first: false, last: false });
    expect(slotFor(m3, m2, m4)).toMatchObject({ first: false, last: true });
    expect(slotFor(m4, m3, undefined)).toMatchObject({ first: true, last: true });
  });
  it('시간은 같은 분 묶음의 마지막에만', () => {
    expect(slotFor(m1, undefined, m2).showTime).toBe(false);
    expect(slotFor(m2, m1, m3).showTime).toBe(true); // 다음이 다른 분
    expect(slotFor(m3, m2, m4).showTime).toBe(true); // 다음이 다른 사람
    expect(slotFor(m4, m3, undefined).showTime).toBe(true);
  });
  it('날짜가 바뀌면 구분을 넣고 묶음도 끊는다', () => {
    const next = at('a', 9, 0, 2);
    expect(slotFor(m1, undefined, m2).dateBefore).toBe('2026년 11월 1일 일요일');
    expect(slotFor(m2, m1, m3).dateBefore).toBeNull();
    expect(slotFor(next, m3, undefined)).toMatchObject({ first: true, dateBefore: '2026년 11월 2일 월요일' });
    expect(slotFor(m3, m2, next).last).toBe(true);
  });
  it('읽을 수 없는 시각은 묶지 않는다', () => {
    const bad = { sender_id: 'a', created_at: 'x' };
    expect(slotFor(bad, m1, m1)).toMatchObject({ first: true, last: true, showTime: true, dateBefore: null });
  });
});

it('dateLabel', () => expect(dateLabel(at('a', 1, 0, 1).created_at)).toBe('2026년 11월 1일 일요일'));
