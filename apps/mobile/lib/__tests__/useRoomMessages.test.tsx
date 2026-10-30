import { act } from 'react';
import { createRoot } from 'test-renderer';

import type { Msg } from '../messages';
import { useRoomMessages } from '../useRoomMessages';

// 메모리 DB + 채널 가짜. Realtime 페이로드는 실제처럼 공백·`+00` 시각 형태로 보낸다.
let db: Msg[] = [];
let handlers: { insert?: (p: { new: Msg }) => void; status?: (s: string) => void } = {};
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
    if (!ins) {
      mockFetchCount++;
      if (mockFetchGate) await mockFetchGate;
      if (mockFetchFail === 'throw') throw new TypeError('Failed to fetch');
      if (mockFetchFail === 'error') return { data: null, error: { message: 'boom' }, status: 500 };
    }
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
// 이름을 지키는 채널 가짜: 같은 이름이 둘 열려 있으면 mockOpen에 두 번 들어 있다.
let mockOpen: { name: string }[] = [];
const mockRemove = jest.fn((ch: { name: string }) => {
  mockOpen = mockOpen.filter((c) => c !== ch);
});
const mockChannelFor = (name: string) => {
  const ch = {
    name,
    on: (_t: string, _f: unknown, cb: (p: { new: Msg }) => void) => ((handlers.insert = cb), ch),
    subscribe: (cb: (s: string) => void) => ((handlers.status = cb), ch),
  };
  mockOpen.push(ch);
  return ch;
};
let mockFetchGate: Promise<void> | null = null; // 있으면 select가 이게 풀릴 때까지 기다린다
let mockFetchFail: 'error' | 'throw' | null = null;
let mockFetchCount = 0;
jest.mock('../supabase', () => ({ supabase: { from: () => mockBuilder(), channel: (n: string) => mockChannelFor(n), removeChannel: (c: { name: string }) => mockRemove(c) } }));

const m = (id: number, over: Partial<Msg> = {}): Msg => ({ id, room_id: 'r', sender_id: 'other', text: `m${id}`, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:32:17.000000+00:00', ...over });

let api: ReturnType<typeof useRoomMessages>;
let mockRoomId = 'r';
function Probe() {
  api = useRoomMessages(mockRoomId, 'me');
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
  mockRemove.mockClear();
  mockOpen = [];
  mockFetchGate = null;
  mockFetchFail = null;
  mockFetchCount = 0;
  mockRoomId = 'r';
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

// ── fix round 1 ──
test('방을 바꾸면 이전 채널은 닫히고 새 채널 하나만 열려 있다(중복 구독 없음)', async () => {
  const root = await mount();
  expect(mockOpen.map((c) => c.name)).toEqual(['room:r']);
  mockRoomId = 'r2';
  await act(async () => root.render(<Probe />));
  expect(mockOpen.map((c) => c.name)).toEqual(['room:r2']);
});

test('방을 바꾼 뒤 늦게 도착한 이전 방의 결과는 무시한다', async () => {
  let open!: () => void;
  mockFetchGate = new Promise<void>((r) => (open = r));
  const root = createRoot();
  await act(async () => root.render(<Probe />)); // 방 'r'의 첫 페이지가 아직 오는 중
  mockRoomId = 'r2';
  await act(async () => root.render(<Probe />));
  await act(async () => open()); // 'r'의 30개가 이제 도착(방 'r2'에는 메시지가 없다)
  expect(api.messages).toHaveLength(0);
});

test('loadOlder: 가져오는 동안 다시 불러도 요청은 한 번', async () => {
  await mount();
  const base = mockFetchCount;
  let open!: () => void;
  mockFetchGate = new Promise<void>((r) => (open = r));
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => {
    a = api.loadOlder();
    b = api.loadOlder();
    open();
    await Promise.all([a, b]);
  });
  expect(mockFetchCount - base).toBe(1);
});

test('hasMore가 false면 loadOlder는 더 가져오지 않는다', async () => {
  db = db.slice(0, 5); // 5개뿐 → 첫 페이지가 덜 차서 hasMore=false
  await mount();
  expect(api.hasMore).toBe(false);
  const base = mockFetchCount;
  await act(async () => api.loadOlder());
  expect(mockFetchCount - base).toBe(0);
});

test('loadOlder 실패(오류 응답)는 olderError로 알리고, 다시 하면 풀린다', async () => {
  await mount();
  mockFetchFail = 'error';
  await act(async () => api.loadOlder());
  expect(api.olderError).toBe(true);
  expect(ids()).toHaveLength(30);
  mockFetchFail = null;
  await act(async () => api.loadOlder());
  expect(api.olderError).toBe(false);
  expect(ids()).toHaveLength(60);
});

test('loadOlder가 던져도(연결 끊김) 처리되지 않은 거부 없이 olderError가 된다', async () => {
  await mount();
  mockFetchFail = 'throw';
  await act(async () => {
    await expect(api.loadOlder()).resolves.toBeUndefined();
  });
  expect(api.olderError).toBe(true);
});

test('첫 페이지 가져오기가 던져도 error가 되고, reload로 다시 받는다', async () => {
  mockFetchFail = 'throw';
  await mount();
  expect(api.error).toBe(true);
  mockFetchFail = null;
  await act(async () => api.reload());
  expect(api.error).toBe(false);
  expect(ids()).toHaveLength(30);
});
