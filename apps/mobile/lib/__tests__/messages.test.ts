import { mergeMessages, shouldMarkRead, tsMicros, type Msg } from '../messages';

const m = (id: number): Msg => ({ id, room_id: 'r', sender_id: 'u', text: `m${id}`, image_path: null, file_path: null, file_name: null, file_size: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:32:17.000000+00:00' });
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

// ── T-09b ──
import fs from 'fs';
import path from 'path';
import { nextReactionOp, REACTIONS, summarizeReactions, unreadCount } from '../messages';

const A = 'a', B = 'b', C = 'c';
test('unreadCount excludes sender, null last_read_at is unread', () =>
  expect(unreadCount({ sender_id: A, created_at: '2026-10-27T01:32:17.000000+00:00' }, [{ user_id: A, last_read_at: null }, { user_id: B, last_read_at: null }, { user_id: C, last_read_at: null }])).toBe(2));
test('unreadCount: last_read_at equal to created_at is read', () =>
  expect(unreadCount({ sender_id: A, created_at: '2026-10-27T01:32:17.123456+00:00' }, [{ user_id: B, last_read_at: '2026-10-27 01:32:17.123456+00' }])).toBe(0));
test('unreadCount: a message 1µs after last_read_at is unread', () =>
  expect(unreadCount({ sender_id: A, created_at: '2026-10-27T01:32:17.123457+00:00' }, [{ user_id: B, last_read_at: '2026-10-27T01:32:17.123456+00:00' }])).toBe(1));
test('summarizeReactions groups in REACTIONS order and marks mine', () => {
  const rows = [
    { message_id: 1, user_id: A, emoji: '❤️' },
    { message_id: 1, user_id: B, emoji: '👍' },
    { message_id: 1, user_id: C, emoji: '❤️' },
    { message_id: 2, user_id: A, emoji: '😂' },
  ];
  expect(summarizeReactions(rows, 1, A)).toEqual([
    { emoji: '👍', count: 1, mine: false },
    { emoji: '❤️', count: 2, mine: true },
  ]);
  expect(summarizeReactions(rows, 3, A)).toEqual([]);
});
test('nextReactionOp: insert when none, update when changing, delete when tapping the same', () => {
  expect(nextReactionOp(null, '😂')).toEqual({ op: 'insert', emoji: '😂' });
  expect(nextReactionOp('👍', '❤️')).toEqual({ op: 'update', emoji: '❤️' });
  expect(nextReactionOp('👍', '👍')).toEqual({ op: 'delete' });
  for (const a of [null, ...REACTIONS]) for (const b of REACTIONS) expect(nextReactionOp(a, b).op).not.toBe('upsert');
});
const chatSql = () => fs.readFileSync(path.join(__dirname, '../../../../supabase/migrations/20261027000001_chat.sql'), 'utf8');
test('reactions grant stays insert(message_id,user_id,emoji) + update(emoji) only', () => {
  const grant = chatSql().split('\n').find((l) => /^grant .* on public\.reactions to authenticated/.test(l))!;
  expect(grant).toMatch(/insert \(message_id, user_id, emoji\)/);
  expect(grant).toMatch(/update \(emoji\)/);
  expect(grant).not.toMatch(/update \([^)]*message_id/);
});
test('REACTIONS match the DB check constraint', () => {
  for (const e of REACTIONS) expect(chatSql()).toContain(`'${e}'`);
});
