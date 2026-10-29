import { act } from 'react';
import { createRoot } from 'test-renderer';

import type { Msg } from '../messages';
import { useRoomMessages } from '../useRoomMessages';

// 메모리 DB + 채널 가짜. Realtime 페이로드는 실제처럼 공백·`+00` 시각 형태로 보낸다.
let db: Msg[] = [];
let handlers: { insert?: (p: { new: Msg }) => void; status?: (s: string) => void } = {};
const mockRemove = jest.fn();
let insertError: { message: string } | null = null;

function mockBuilder() {
  const f: ((m: Msg) => boolean)[] = [];
  let desc = false;
  let lim = Infinity;
  let ins: Partial<Msg> | null = null;
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: keyof Msg, v: unknown) => (f.push((m) => m[k] === v), b),
    gt: (_k: string, v: number) => (f.push((m) => m.id > v), b),
    lt: (_k: string, v: number) => (f.push((m) => m.id < v), b),
    order: (_k: string, o: { ascending: boolean }) => ((desc = !o.ascending), b),
    limit: (n: number) => ((lim = n), b),
    insert: (row: Partial<Msg>) => ((ins = row), b),
    single: () => run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  const run = async () => {
    if (ins) {
      if (insertError) return { data: null, error: insertError, status: 400 };
      const row = { id: db.length + 100, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:00:00.000000+00:00', ...ins } as Msg;
      db.push(row);
      return { data: [row], error: null, status: 201 };
    }
    let rows = db.filter((m) => f.every((x) => x(m))).sort((a, c) => (desc ? c.id - a.id : a.id - c.id));
    rows = rows.slice(0, lim);
    return { data: rows, error: null, status: 200 };
  };
  return b;
}
const mockChannel = {
  on: (_t: string, _f: unknown, cb: (p: { new: Msg }) => void) => ((handlers.insert = cb), mockChannel),
  subscribe: (cb: (s: string) => void) => ((handlers.status = cb), mockChannel),
};
jest.mock('../supabase', () => ({ supabase: { from: () => mockBuilder(), channel: () => mockChannel, removeChannel: (...a: unknown[]) => mockRemove(...a) } }));

const m = (id: number, over: Partial<Msg> = {}): Msg => ({ id, room_id: 'r', sender_id: 'other', text: `m${id}`, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:32:17.000000+00:00', ...over });

let api: ReturnType<typeof useRoomMessages>;
function Probe() {
  api = useRoomMessages('r', 'me');
  return null;
}
const mount = async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  await act(async () => handlers.status!('SUBSCRIBED'));
  return root;
};
const ids = () => api.messages.map((x) => x.id);

beforeEach(() => {
  db = Array.from({ length: 70 }, (_, i) => m(i + 1));
  handlers = {};
  insertError = null;
  mockRemove.mockReset();
});

test('첫 페이지는 가장 새 30개, 위로 불러오면 이어 붙고 중복 없음', async () => {
  await mount();
  expect(ids()).toEqual(Array.from({ length: 30 }, (_, i) => i + 41));
  expect(api.hasMore).toBe(true);
  await act(async () => api.loadOlder());
  await act(async () => api.loadOlder());
  expect(ids()).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  expect(api.hasMore).toBe(false);
});

test('Realtime INSERT(공백·+00 시각)는 붙고, 내 insert의 에코는 중복되지 않는다', async () => {
  await mount();
  await act(async () => handlers.insert!({ new: m(71, { created_at: '2026-10-27 01:32:17.123456+00' }) }));
  expect(ids().slice(-2)).toEqual([70, 71]);
  let sent!: Msg;
  await act(async () => (sent = await api.send({ text: '안녕' })));
  await act(async () => handlers.insert!({ new: sent }));
  expect(ids().filter((i) => i === sent.id)).toHaveLength(1);
  expect(db.at(-1)).toMatchObject({ text: '안녕', room_id: 'r', sender_id: 'me' });
});

test('재연결(SUBSCRIBED 다시)이면 끊긴 사이 메시지를 한 번씩만 채운다', async () => {
  await mount();
  db.push(m(71), m(72));
  await act(async () => handlers.insert!({ new: m(72) })); // 71은 놓침
  await act(async () => handlers.status!('SUBSCRIBED'));
  expect(ids().slice(-3)).toEqual([70, 71, 72]);
  expect(new Set(ids()).size).toBe(ids().length);
});

test('보내기 실패는 status를 단 Error를 던지고 목록은 그대로', async () => {
  await mount();
  insertError = { message: 'reply_to_other_room' };
  await expect(act(async () => api.send({ text: 'x' }))).rejects.toMatchObject({ message: 'reply_to_other_room', status: 400 });
  expect(ids()).toHaveLength(30);
});

test('언마운트하면 채널을 끊는다', async () => {
  const root = await mount();
  await act(async () => root.unmount());
  expect(mockRemove).toHaveBeenCalled();
});
