import { fetchRoomList, markRead } from '../rooms';

// 진짜 fetchRoomList·markRead를 가짜 클라이언트에 대고 돌린다. 가짜는 부른 질의를 그대로 기록한다.
type Call = { table: string; ops: [string, ...unknown[]][]; head: boolean };
let calls: Call[] = [];
let tables: Record<string, unknown[]> = {};
let counts: Record<string, number> = {};
let failTable: string | null = null;

function mockFrom(table: string) {
  const call: Call = { table, ops: [], head: false };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const op of ['eq', 'neq', 'gt', 'in', 'order', 'limit', 'update']) b[op] = (...a: unknown[]) => (call.ops.push([op, ...a]), b);
  b.select = (_c: string, o?: { head?: boolean }) => ((call.head = !!o?.head), b);
  b.single = () => b;
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
    if (failTable === table) return Promise.resolve({ data: null, error: { message: 'boom' }, count: null }).then(res, rej);
    const eqRoom = call.ops.find((o) => o[0] === 'eq' && o[1] === 'room_id')?.[2];
    const rows = (tables[table] ?? []) as Record<string, unknown>[];
    const data = call.head ? null : eqRoom && table === 'messages' ? rows.filter((r) => r.room_id === eqRoom).slice(0, 1) : rows;
    return Promise.resolve({ data, error: null, count: call.head ? counts[String(eqRoom)] ?? 0 : null }).then(res, rej);
  };
  return b;
}
jest.mock('../supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));

beforeEach(() => {
  calls = [];
  failTable = null;
  counts = { r1: 3, r2: 0 };
  tables = {
    room_members: [
      { room_id: 'r1', user_id: 'me', last_read_at: '2026-10-27T01:00:00.123456+00:00', muted: false },
      { room_id: 'r2', user_id: 'me', last_read_at: null, muted: true },
      { room_id: 'r1', user_id: 'u2' },
      { room_id: 'r2', user_id: 'u2' },
    ],
    rooms: [
      { id: 'r1', kind: 'direct', title: null, relation: '친구', created_at: '2026-10-01T00:00:00+00:00' },
      { id: 'r2', kind: 'group', title: '팀플', relation: '팀원', created_at: '2026-10-02T00:00:00+00:00' },
    ],
    profiles: [{ id: 'me', name: '나' }, { id: 'u2', name: '민수' }],
    messages: [
      { room_id: 'r1', text: '안녕', image_path: null, created_at: '2026-10-27T02:00:00.000001+00:00' },
      { room_id: 'r2', text: '', image_path: 'r2/a.png', created_at: '2026-10-26T02:00:00+00:00' },
    ],
  };
});

const unreadQuery = (room: string) => calls.find((c) => c.table === 'messages' && c.head && c.ops.some((o) => o[0] === 'eq' && o[2] === room))!;

test('fetchRoomList: 제목·마지막 메시지·알림 꺼짐·안 읽은 수를 합치고 최근 순으로 정렬', async () => {
  const list = await fetchRoomList('me');
  expect(list.map((r) => r.id)).toEqual(['r1', 'r2']);
  expect(list[0]).toMatchObject({ title: '민수', unread: 3, muted: false, last: { text: '안녕', isImage: false } });
  expect(list[1]).toMatchObject({ title: '팀플', unread: 0, muted: true, last: { isImage: true } });
});

test('fetchRoomList: 안 읽은 수 질의는 내 메시지 제외 + last_read_at 이후(마이크로초 그대로)', async () => {
  await fetchRoomList('me');
  const q = unreadQuery('r1');
  expect(q.ops).toContainEqual(['neq', 'sender_id', 'me']);
  expect(q.ops).toContainEqual(['gt', 'created_at', '2026-10-27T01:00:00.123456+00:00']);
});

test('fetchRoomList: 읽은 적 없으면(last_read_at null) 시각 조건 없이 센다', async () => {
  await fetchRoomList('me');
  const q = unreadQuery('r2');
  expect(q.ops.some((o) => o[0] === 'gt')).toBe(false);
  expect(q.ops).toContainEqual(['neq', 'sender_id', 'me']);
});

test('fetchRoomList: 마지막 메시지는 id 내림차순 1개, 내 방만(user_id=me)', async () => {
  await fetchRoomList('me');
  const last = calls.find((c) => c.table === 'messages' && !c.head)!;
  expect(last.ops).toContainEqual(['order', 'id', { ascending: false }]);
  expect(last.ops).toContainEqual(['limit', 1]);
  expect(calls[0].table).toBe('room_members');
  expect(calls[0].ops).toContainEqual(['eq', 'user_id', 'me']);
});

test('fetchRoomList: 방이 없으면 빈 목록(추가 질의 없음), 질의 오류는 던진다', async () => {
  tables.room_members = [];
  expect(await fetchRoomList('me')).toEqual([]);
  expect(calls).toHaveLength(1);
  tables.room_members = [{ room_id: 'r1', user_id: 'me', last_read_at: null, muted: false }];
  tables.rooms = tables.rooms.slice(0, 1);
  failTable = 'messages';
  await expect(fetchRoomList('me')).rejects.toMatchObject({ message: 'boom' });
});

test('markRead: 그 방 · 내 행의 last_read_at만 서버 시각으로 고친다', async () => {
  await markRead('r1', 'me', '2026-10-27 01:32:17.123456+00');
  const c = calls[0];
  expect(c.table).toBe('room_members');
  expect(c.ops).toContainEqual(['update', { last_read_at: '2026-10-27 01:32:17.123456+00' }]);
  expect(c.ops).toContainEqual(['eq', 'room_id', 'r1']);
  expect(c.ops).toContainEqual(['eq', 'user_id', 'me']);
});

test('markRead: 오류는 던진다', async () => {
  failTable = 'room_members';
  await expect(markRead('r1', 'me', 'x')).rejects.toMatchObject({ message: 'boom' });
});
