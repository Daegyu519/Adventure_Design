import { mergeMessages, shouldMarkRead, tsMicros, type Msg } from '../messages';

const m = (id: number): Msg => ({ id, room_id: 'r', sender_id: 'u', text: `m${id}`, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:32:17.000000+00:00' });
const ids = (xs: Msg[]) => xs.map((x) => x.id);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => m(a + i));

test('mergeMessages dedupes my insert echoed by realtime', () => expect(ids(mergeMessages([m(1), m(2)], [m(2)]))).toEqual([1, 2]));
test('mergeMessages: overlapping catch-up after reconnect → unique ascending', () =>
  expect(ids(mergeMessages([m(5), m(6), m(7)], [m(6), m(7), m(8), m(9)]))).toEqual([5, 6, 7, 8, 9]));
test('mergeMessages: older page prepends', () => expect(ids(mergeMessages(range(31, 60), range(1, 30)))).toEqual(range(1, 60).map((x) => x.id)));
test('mergeMessages: out-of-order arrival is sorted', () => expect(ids(mergeMessages([m(9)], [m(7), m(8)]))).toEqual([7, 8, 9]));

test('tsMicros keeps microsecond order', () =>
  expect(tsMicros('2026-10-27T01:32:17.123457+00:00')).toBeGreaterThan(tsMicros('2026-10-27T01:32:17.123456+00:00')));
test('tsMicros accepts realtime format and short fractions', () => {
  expect(tsMicros('2026-10-27 01:32:17.5+00')).toBe(tsMicros('2026-10-27T01:32:17.500000+00:00'));
  expect(tsMicros('2026-10-27T01:32:17+00:00')).toBe(tsMicros('2026-10-27T01:32:17.000000Z'));
});
test('tsMicros: non-UTC offset', () => expect(tsMicros('2026-10-27 10:32:17+09')).toBe(tsMicros('2026-10-27T01:32:17.000000Z')));

const T1 = '2026-10-27T01:32:17.123456+00:00';
const T2 = '2026-10-27T01:32:17.123457+00:00';
test('shouldMarkRead: background or unfocused → false', () => {
  expect(shouldMarkRead({ appActive: false, focused: true, newest: T2, lastRead: T1 })).toBe(false);
  expect(shouldMarkRead({ appActive: true, focused: false, newest: T2, lastRead: T1 })).toBe(false);
});
test('shouldMarkRead: only forward', () => {
  expect(shouldMarkRead({ appActive: true, focused: true, newest: T2, lastRead: T1 })).toBe(true);
  expect(shouldMarkRead({ appActive: true, focused: true, newest: T1, lastRead: T2 })).toBe(false);
  expect(shouldMarkRead({ appActive: true, focused: true, newest: T1, lastRead: T1 })).toBe(false);
  expect(shouldMarkRead({ appActive: true, focused: true, newest: null, lastRead: null })).toBe(false);
  expect(shouldMarkRead({ appActive: true, focused: true, newest: T1, lastRead: null })).toBe(true);
});

import { formatStamp } from '../messages';
test('formatStamp: same day → 오전/오후 시각, other day → M월 D일', () => {
  const now = new Date(2026, 9, 27, 18, 0);
  expect(formatStamp(new Date(2026, 9, 27, 15, 7).toISOString(), now)).toBe('오후 3:07');
  expect(formatStamp(new Date(2026, 9, 27, 0, 5).toISOString(), now)).toBe('오전 12:05');
  expect(formatStamp(new Date(2026, 9, 26, 15, 7).toISOString(), now)).toBe('10월 26일');
  expect(formatStamp('2026-10-27 ' + '06:00:00.5+00', new Date('2026-10-27T07:00:00Z')).length).toBeGreaterThan(0);
});
