import { act } from 'react';
import { createRoot } from 'test-renderer';

import type { Msg } from '../messages';
import { useRoomMessages } from '../useRoomMessages';
import { rt } from '../../test-utils/realtime';

// 메모리 DB + 채널 가짜. Realtime 페이로드는 실제처럼 공백·`+00` 시각 형태로 보낸다.
let db: Msg[] = [];
const insert = (x: Msg) => rt.emit('room:r', { eventType: 'INSERT', new: x });
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
      const row = { id: db.length + 100, image_path: null, file_path: null, file_name: null, file_size: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:00:00.000000+00:00', ...ins } as Msg;
      db.push(row);
      return { data: [row], error: null, status: 201 };
    }
    let rows = db.filter((m) => f.every((x) => x(m))).sort((a, c) => (desc ? c.id - a.id : a.id - c.id));
    rows = rows.slice(0, lim);
    return { data: rows, error: null, status: 200 };
  };
  return b;
}
let mockFetchGate: Promise<void> | null = null; // 있으면 select가 이게 풀릴 때까지 기다린다
let mockFetchFail: 'error' | 'throw' | null = null;
let mockFetchCount = 0;
// 채널은 realtime-js처럼 움직이는 공용 가짜(같은 이름이면 같은 객체, subscribe 뒤 on()은 던짐, removeChannel은 그 하나를 닫음).
jest.mock('../supabase', () => ({ supabase: { ...jest.requireActual('../../test-utils/realtime').realtime, from: () => mockBuilder() } }));

const m = (id: number, over: Partial<Msg> = {}): Msg => ({ id, room_id: 'r', sender_id: 'other', text: `m${id}`, image_path: null, file_path: null, file_name: null, file_size: null, reply_to: null, mentions: [], created_at: '2026-10-27T01:32:17.000000+00:00', ...over });

let api: ReturnType<typeof useRoomMessages>;
let mockRoomId = 'r';
function Probe() {
  api = useRoomMessages(mockRoomId, 'me');
  return null;
}
const mount = async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  await act(async () => rt.status('room:r', 'SUBSCRIBED'));
  return root;
};
const ids = () => api.messages.map((x) => x.id);

beforeEach(() => {
  db = Array.from({ length: 70 }, (_, i) => m(i + 1));
  rt.reset();
  insertError = null;
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
  await act(async () => insert(m(71, { created_at: '2026-10-27 01:32:17.123456+00' })));
  expect(ids().slice(-2)).toEqual([70, 71]);
  let sent!: Msg;
  await act(async () => (sent = await api.send({ text: '안녕' })));
  await act(async () => insert(sent));
  expect(ids().filter((i) => i === sent.id)).toHaveLength(1);
  expect(db.at(-1)).toMatchObject({ text: '안녕', room_id: 'r', sender_id: 'me' });
});

test('재연결(SUBSCRIBED 다시)이면 끊긴 사이 메시지를 한 번씩만 채운다', async () => {
  await mount();
  db.push(m(71), m(72));
  await act(async () => insert(m(72))); // 71은 놓침
  await act(async () => rt.status('room:r', 'SUBSCRIBED'));
  expect(ids().slice(-3)).toEqual([70, 71, 72]);
  expect(new Set(ids()).size).toBe(ids().length);
});

test('보내기 실패는 status를 단 Error를 던지고 목록은 그대로', async () => {
  await mount();
  insertError = { message: 'reply_to_other_room' };
  await expect(act(async () => api.send({ text: 'x' }))).rejects.toMatchObject({ message: 'reply_to_other_room', status: 400 });
  expect(ids()).toHaveLength(30);
});

test('언마운트하면 채널을 끊는다(내가 닫아서 오는 CLOSED는 오류·경고가 아니다)', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const root = await mount();
  await act(async () => root.unmount());
  expect(rt.removed).toHaveLength(1);
  expect(rt.open).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

// ── fix round 1 ──
test('방을 바꾸면 이전 채널은 닫히고 새 채널 하나만 열려 있다(중복 구독 없음)', async () => {
  const root = await mount();
  expect(rt.find('room:r')).toHaveLength(1);
  mockRoomId = 'r2';
  await act(async () => root.render(<Probe />));
  expect(rt.find('room:r')).toHaveLength(0);
  expect(rt.find('room:r2')).toHaveLength(1);
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

// ── P-05: 같은 방 두 화면(AC-1) · Realtime 끊김(S-I1) ──
const all: ReturnType<typeof useRoomMessages>[] = [];
function P({ k }: { k: number }) {
  all[k] = useRoomMessages('r', 'me');
  return null;
}
test('같은 방을 두 화면이 열어도(알림 탭·두 번 누름) 각자 채널을 쓰고, 하나를 닫아도 다른 쪽은 계속 받는다', async () => {
  const a = createRoot();
  const b = createRoot();
  await act(async () => a.render(<P k={0} />));
  await act(async () => b.render(<P k={1} />)); // realtime-js는 같은 이름이면 구독된 채널을 돌려주고 on()이 던진다
  expect(rt.find('room:r')).toHaveLength(2);
  await act(async () => b.unmount());
  await act(async () => rt.status('room:r', 'SUBSCRIBED'));
  await act(async () => insert(m(71)));
  expect(all[0].messages.at(-1)?.id).toBe(71);
});

test.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const)('Realtime %s면 error(다시 불러오기 줄)와 개발 중 경고, 다시 SUBSCRIBED면 풀린다', async (s) => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await mount();
  await act(async () => rt.status('room:r', s));
  expect(api.error).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(s));
  if (s !== 'CLOSED') {
    await act(async () => rt.status('room:r', 'SUBSCRIBED')); // realtime-js가 스스로 다시 들어간 경우
    expect(api.error).toBe(false);
  }
  warn.mockRestore();
});

test('서버가 채널을 닫으면(CLOSED, 다시 들어가지 않음) reload가 새 채널로 다시 구독하고 빈 구간을 채운다', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await mount();
  const old = rt.one('room:r');
  await act(async () => rt.status('room:r', 'CLOSED'));
  db.push(m(71));
  await act(async () => api.reload());
  expect(rt.removed).toContain(old);
  const fresh = rt.one('room:r');
  expect(fresh).not.toBe(old);
  await act(async () => rt.status('room:r', 'SUBSCRIBED'));
  expect(api.error).toBe(false);
  expect(ids().at(-1)).toBe(71);
  expect(ids()).toHaveLength(31); // 불러 둔 것은 그대로
  warn.mockRestore();
});
