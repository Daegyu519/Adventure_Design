import { act } from 'react';
import { createRoot } from 'test-renderer';

import type { Tables } from '../types/db';
import { useMembers } from '../useMembers';
import { useReactions } from '../useReactions';
import { rt } from '../../test-utils/realtime';

type R = Tables<'reactions'>;
const r = (message_id: number, user_id: string, emoji: string): R => ({ message_id, user_id, emoji, created_at: '' });

// 메모리 reactions 표 + 호출 기록. insert/update/delete/select만 지원한다(upsert는 없음 → 쓰면 TypeError).
let table: R[] = [];
let calls: string[] = [];
let memberRows: Record<string, unknown>[] = []; // room_members 읽기(다시 연결 뒤 따라잡기)
let insertErr: { code: string } | null = null;
let hideUpdate = false; // true면 update가 0행에 닿은 것처럼 보인다

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
    if (op === 'select' && name === 'room_members') return { data: memberRows, error: null };
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
// 채널은 realtime-js처럼 움직이는 공용 가짜(같은 이름이면 같은 객체, subscribe 뒤 on()은 던짐, removeChannel은 그 하나를 닫음).
jest.mock('../supabase', () => ({ supabase: { ...jest.requireActual('../../test-utils/realtime').realtime, from: (n: string) => mockBuilder(n) } }));
const reaction = (p: { eventType: string; new?: Partial<R>; old?: Partial<R> }) => rt.emit('reactions:room', p);

let api: ReturnType<typeof useReactions>;
let ids = [1, 2];
let renders = 0;
function Probe() {
  api = useReactions('room', ids, 'me');
  renders++;
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
  rt.reset();
  memberRows = [];
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
  await act(async () => reaction({ eventType: 'INSERT', new: r(2, 'u3', '😮') }));
  await act(async () => reaction({ eventType: 'INSERT', new: r(99, 'u3', '😮') }));
  expect(api.rows.map((x) => x.message_id).sort()).toEqual([1, 2]);
  await act(async () => reaction({ eventType: 'UPDATE', new: r(2, 'u3', '😢') }));
  expect(api.rows.find((x) => x.message_id === 2)!.emoji).toBe('😢');
  await act(async () => reaction({ eventType: 'DELETE', old: { message_id: 2, user_id: 'u3' } }));
  expect(api.rows.find((x) => x.message_id === 2)).toBeUndefined();
});

let members: ReturnType<typeof useMembers>['members'];
let mapi: ReturnType<typeof useMembers>;
const INITIAL = [
  { user_id: 'me', name: '나', last_read_at: null, muted: false },
  { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
];
function MProbe() {
  mapi = useMembers('room', INITIAL);
  members = mapi.members;
  return null;
}
const member = (n: Record<string, unknown>) => rt.emit('members:room', { eventType: 'UPDATE', new: n });
test('useMembers: room_members UPDATE가 last_read_at·muted를 갱신(공백·+00 시각), 이전 값으로 되돌리지 않는다', async () => {
  const root = createRoot();
  await act(async () => root.render(<MProbe />));
  await act(async () => member({ user_id: 'u2', last_read_at: '2026-10-27 01:32:17.123456+00', muted: true }));
  expect(members.find((x) => x.user_id === 'u2')).toMatchObject({ last_read_at: '2026-10-27 01:32:17.123456+00', muted: true });
  await act(async () => member({ user_id: 'u2', last_read_at: '2026-10-27 01:00:00.000000+00', muted: true }));
  expect(members.find((x) => x.user_id === 'u2')!.last_read_at).toBe('2026-10-27 01:32:17.123456+00');
});

// ── P-05 ──
test('Realtime: 다른 방·불러오지 않은 메시지의 DELETE(모든 방의 키가 온다)는 다시 그리지 않는다', async () => {
  await mount();
  const before = renders;
  await act(async () => reaction({ eventType: 'DELETE', old: { message_id: 99, user_id: 'u3' } }));
  expect(renders).toBe(before);
});

test('같은 방을 두 화면이 열어도 각자 채널을 쓴다(같은 이름이면 on()이 던진다)', async () => {
  await mount();
  await mount();
  expect(rt.find('reactions:room')).toHaveLength(2);
});

test('Realtime이 끊기면(CHANNEL_ERROR) error + 개발 중 경고, reload는 새 채널로 다시 구독하고 공감을 다시 읽는다(끊긴 사이 지운 것도 맞춘다)', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await mount();
  const old = rt.one('reactions:room');
  await act(async () => rt.status('reactions:room', 'CHANNEL_ERROR'));
  expect(api.error).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('CHANNEL_ERROR'));
  table = [r(2, 'u3', '😮')]; // 끊긴 사이: 1의 공감은 지워지고 2에 새로 생김
  await act(async () => api.reload());
  expect(rt.removed).toContain(old);
  expect(rt.one('reactions:room')).not.toBe(old);
  await act(async () => rt.status('reactions:room', 'SUBSCRIBED'));
  expect(api.error).toBe(false);
  expect(api.rows).toEqual([r(2, 'u3', '😮')]);
  warn.mockRestore();
});

test('useMembers: 같은 방 두 화면도 각자 채널, TIMED_OUT이면 error, reload는 새 채널', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await act(async () => createRoot().render(<MProbe />));
  await act(async () => createRoot().render(<MProbe />));
  expect(rt.find('members:room')).toHaveLength(2);
  rt.reset();
  await act(async () => createRoot().render(<MProbe />));
  const old = rt.one('members:room');
  await act(async () => rt.status('members:room', 'TIMED_OUT'));
  expect(mapi.error).toBe(true);
  await act(async () => mapi.reload());
  expect(rt.one('members:room')).not.toBe(old);
  await act(async () => rt.status('members:room', 'SUBSCRIBED'));
  expect(mapi.error).toBe(false);
  warn.mockRestore();
});

// realtime-js가 스스로 다시 들어가면(끊김 뒤 SUBSCRIBED) 끊긴 사이 놓친 공감·읽음도 다시 읽는다(메시지처럼).
test.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const)('공감: %s 뒤 다시 SUBSCRIBED면 불러온 메시지의 공감을 다시 읽는다(같은 채널)', async (s) => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await mount();
  await act(async () => rt.status('reactions:room', 'SUBSCRIBED'));
  const ch = rt.one('reactions:room');
  await act(async () => rt.status('reactions:room', s));
  table = [r(2, 'u3', '😮')]; // 끊긴 사이: 1의 공감은 지워지고 2에 새로 생김
  if (s === 'CLOSED') rt.open.push(ch); // 가짜는 서버 CLOSED에 목록에서 빼므로, 다시 들어간 경우를 흉내 내려고 되돌린다
  await act(async () => rt.status('reactions:room', 'SUBSCRIBED'));
  expect(api.error).toBe(false);
  expect(api.rows).toEqual([r(2, 'u3', '😮')]);
  warn.mockRestore();
});

test('useMembers: 끊김 뒤 다시 SUBSCRIBED면 방 멤버의 읽음·알림 끔을 다시 읽는다(더 옛 값으로는 안 되돌림)', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await act(async () => createRoot().render(<MProbe />));
  await act(async () => rt.status('members:room', 'SUBSCRIBED'));
  await act(async () => rt.status('members:room', 'CHANNEL_ERROR'));
  memberRows = [
    { user_id: 'me', last_read_at: null, muted: false },
    { user_id: 'u2', last_read_at: '2026-10-27 01:32:17.123456+00', muted: true },
  ];
  calls = [];
  await act(async () => rt.status('members:room', 'SUBSCRIBED'));
  expect(calls).toContain('room_members.select');
  expect(mapi.error).toBe(false);
  expect(members.find((x) => x.user_id === 'u2')).toMatchObject({ last_read_at: '2026-10-27 01:32:17.123456+00', muted: true });
  warn.mockRestore();
});

test('처음 SUBSCRIBED에는 다시 읽지 않는다(끊긴 적이 없으면)', async () => {
  await mount();
  calls = [];
  await act(async () => rt.status('reactions:room', 'SUBSCRIBED'));
  expect(calls).toEqual([]);
});
