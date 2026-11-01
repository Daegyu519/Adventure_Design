import { roomTitle, sortRooms, type RoomListItem } from '../rooms';

const mem = [
  { user_id: 'me', name: '나' },
  { user_id: 'u2', name: '민수' },
];
test('roomTitle: direct → the other member', () => expect(roomTitle({ kind: 'direct', title: null }, mem, 'me')).toBe('민수'));
test('roomTitle: group → title, fallback 대화방', () => {
  expect(roomTitle({ kind: 'group', title: '팀플 3조' }, mem, 'me')).toBe('팀플 3조');
  expect(roomTitle({ kind: 'group', title: null }, mem, 'me')).toBe('대화방');
});

const r = (id: string, created_at: string, last: string | null): RoomListItem => ({
  id, kind: 'direct', title: id, relation: '친구', muted: false, unread: 0, created_at,
  last: last ? { text: 'x', isImage: false, fileName: null, created_at: last } : null,
});
test('sortRooms: latest message first, empty rooms by created_at', () => {
  const out = sortRooms([r('empty-old', '2026-10-01T00:00:00+00:00', null), r('a', '2026-10-02T00:00:00+00:00', '2026-10-20T00:00:00+00:00'), r('empty-new', '2026-10-25T00:00:00+00:00', null), r('b', '2026-10-03T00:00:00+00:00', '2026-10-21T00:00:00+00:00')]);
  expect(out.map((x) => x.id)).toEqual(['empty-new', 'b', 'a', 'empty-old']);
});
