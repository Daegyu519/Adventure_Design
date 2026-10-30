import { act } from 'react';
import { createRoot } from 'test-renderer';

import type { Tables } from '../types/db';
import { useMembers } from '../useMembers';
import { useReactions } from '../useReactions';

type R = Tables<'reactions'>;
const r = (message_id: number, user_id: string, emoji: string): R => ({ message_id, user_id, emoji, created_at: '' });

// 메모리 reactions 표 + 호출 기록. insert/update/delete/select만 지원한다(upsert는 없음 → 쓰면 TypeError).
let table: R[] = [];
let calls: string[] = [];
let insertErr: { code: string } | null = null;
let hideUpdate = false; // true면 update가 0행에 닿은 것처럼 보인다
let mockHandlers: Record<string, (p: { eventType: string; new?: Partial<R>; old?: Partial<R> }) => void> = {};
let mockMemberHandler: ((p: { new: Record<string, unknown> }) => void) | null = null;

function mockBuilder(name: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Partial<R> = {};
  let inIds: number[] | null = null;
  const eqs: [string, unknown][] = [];
  const b: Record<string, unknown> = {
    select: () => b,
    in: (_k: string, v: number[]) => ((inIds = v), b),
    insert: (row: Partial<R>) => ((op = 'insert'), (payload = row), b),
    update: (row: Partial<R>) => ((op = 'update'), (payload = row), b),
    delete: () => ((op = 'delete'), b),
    eq: (k: string, v: unknown) => (eqs.push([k, v]), b),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  const run = async () => {
    calls.push(`${name}.${op}`);
    if (op === 'select') return { data: table.filter((x) => !inIds || inIds.includes(x.message_id)), error: null };
    if (op === 'insert') {
      if (insertErr) return { data: null, error: insertErr };
      table.push({ ...(payload as R), created_at: '' });
      return { data: null, error: null };
    }
    const hit = table.filter((x) => eqs.every(([k, v]) => x[k as keyof R] === v));
    if (op === 'update') {
      if (hideUpdate) return { data: [], error: null };
      hit.forEach((x) => Object.assign(x, payload));
      return { data: hit.map((x) => ({ message_id: x.message_id })), error: null };
    }
    table = table.filter((x) => !hit.includes(x));
    return { data: null, error: null };
  };
  return b;
}
jest.mock('../supabase', () => ({
  supabase: {
    from: (n: string) => mockBuilder(n),
    channel: (name: string) => {
      const ch = {
        on: (_t: string, f: { table: string; event: string }, cb: never) => {
          if (f.table === 'reactions') mockHandlers.reactions = cb;
          else mockMemberHandler = cb;
          return ch;
        },
        subscribe: () => ch,
        name,
      };
      return ch;
    },
    removeChannel: jest.fn(),
  },
}));

let api: ReturnType<typeof useReactions>;
let ids = [1, 2];
function Probe() {
  api = useReactions('room', ids, 'me');
  return null;
}
const mount = async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  return root;
};
beforeEach(() => {
  table = [r(1, 'u2', '👍')];
  calls = [];
  insertErr = null;
  hideUpdate = false;
  mockHandlers = {};
  ids = [1, 2];
});

test('불러온 메시지의 공감을 읽어 온다', async () => {
  await mount();
  expect(api.rows).toEqual([r(1, 'u2', '👍')]);
});

test('toggle: 없으면 insert, 다른 이모지면 update, 같은 이모지면 delete (upsert 없음)', async () => {
  await mount();
  await act(async () => api.toggle(2, '😂'));
  expect(table).toContainEqual(expect.objectContaining({ message_id: 2, user_id: 'me', emoji: '😂' }));
  await act(async () => api.toggle(2, '❤️'));
  expect(table.find((x) => x.user_id === 'me')!.emoji).toBe('❤️');
  await act(async () => api.toggle(2, '❤️'));
  expect(table.find((x) => x.user_id === 'me')).toBeUndefined();
  expect(calls.filter((c) => c !== 'reactions.select')).toEqual(['reactions.insert', 'reactions.update', 'reactions.delete']);
  expect(api.rows.find((x) => x.user_id === 'me')).toBeUndefined();
});

test('낡은 화면: insert가 23505(이미 있음)면 update로 한 번만', async () => {
  await mount();
  table.push(r(2, 'me', '👍')); // 다른 기기에서 이미 공감함
  insertErr = { code: '23505' };
  await act(async () => api.toggle(2, '😂'));
  expect(calls.filter((c) => c !== 'reactions.select')).toEqual(['reactions.insert', 'reactions.update']);
  expect(table.find((x) => x.user_id === 'me')!.emoji).toBe('😂');
});

test('낡은 화면: update가 0행이면 insert로 한 번만', async () => {
  await mount();
  await act(async () => api.toggle(2, '👍')); // 내 공감 생김
  hideUpdate = true;
  table = table.filter((x) => x.user_id !== 'me'); // 다른 기기에서 지움
  calls = [];
  await act(async () => api.toggle(2, '❤️'));
  expect(calls).toEqual(['reactions.update', 'reactions.insert']);
  expect(table.find((x) => x.user_id === 'me')!.emoji).toBe('❤️');
});

test('그 밖의 오류는 던진다', async () => {
  await mount();
  insertErr = { code: '42501' };
  await expect(act(async () => api.toggle(2, '👍'))).rejects.toBeTruthy();
});

test('Realtime: 불러온 메시지의 것만 반영하고 DELETE는 키로 지운다', async () => {
  await mount();
  await act(async () => mockHandlers.reactions({ eventType: 'INSERT', new: r(2, 'u3', '😮') }));
  await act(async () => mockHandlers.reactions({ eventType: 'INSERT', new: r(99, 'u3', '😮') }));
  expect(api.rows.map((x) => x.message_id).sort()).toEqual([1, 2]);
  await act(async () => mockHandlers.reactions({ eventType: 'UPDATE', new: r(2, 'u3', '😢') }));
  expect(api.rows.find((x) => x.message_id === 2)!.emoji).toBe('😢');
  await act(async () => mockHandlers.reactions({ eventType: 'DELETE', old: { message_id: 2, user_id: 'u3' } }));
  expect(api.rows.find((x) => x.message_id === 2)).toBeUndefined();
});

let members: ReturnType<typeof useMembers>;
function MProbe() {
  members = useMembers('room', [
    { user_id: 'me', name: '나', last_read_at: null, muted: false },
    { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
  ]);
  return null;
}
test('useMembers: room_members UPDATE가 last_read_at·muted를 갱신(공백·+00 시각), 이전 값으로 되돌리지 않는다', async () => {
  const root = createRoot();
  await act(async () => root.render(<MProbe />));
  await act(async () => mockMemberHandler!({ new: { user_id: 'u2', last_read_at: '2026-10-27 01:32:17.123456+00', muted: true } }));
  expect(members.find((x) => x.user_id === 'u2')).toMatchObject({ last_read_at: '2026-10-27 01:32:17.123456+00', muted: true });
  await act(async () => mockMemberHandler!({ new: { user_id: 'u2', last_read_at: '2026-10-27 01:00:00.000000+00', muted: true } }));
  expect(members.find((x) => x.user_id === 'u2')!.last_read_at).toBe('2026-10-27 01:32:17.123456+00');
});
