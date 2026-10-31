import { act } from 'react';
import { createRoot } from 'test-renderer';

import { useTyping } from '../useTyping';
import { rt } from '../../test-utils/realtime';

// 채널은 realtime-js처럼 움직이는 공용 가짜. typing:<방>은 private 채널이라 이름 그대로 쓴다(정책이 이름을 본다).
jest.mock('../supabase', () => ({ supabase: jest.requireActual('../../test-utils/realtime').realtime }));
const ch = () => rt.one('typing:room1');
const sync = () => rt.emit('typing:room1', {}, 'presence');

let api: ReturnType<typeof useTyping>;
let apis: unknown[] = [];
let room = 'room1';
const NAMES = { u2: '지은' };
function Probe() {
  api = useTyping(room, 'me', NAMES);
  apis.push(api);
  return null;
}
const mount = async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  await act(async () => rt.status('typing:room1', 'SUBSCRIBED'));
  return root;
};
beforeEach(() => {
  room = 'room1';
  apis = [];
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  rt.reset();
});
afterEach(() => jest.useRealTimers());

test('opens a private presence channel keyed by me', async () => {
  await mount();
  expect(ch().topic).toBe('realtime:typing:room1');
  expect(ch().params).toEqual({ config: { private: true, presence: { key: 'me' } } });
});

test('typing is rt.tracked at most once per throttle window', async () => {
  await mount();
  await act(async () => api.onDraftChange('a'));
  await act(async () => void jest.advanceTimersByTime(500));
  await act(async () => api.onDraftChange('ab'));
  await act(async () => void jest.advanceTimersByTime(500));
  await act(async () => api.onDraftChange('abc'));
  expect(rt.tracked).toEqual([{ user_id: 'me', typing: true }]);
  await act(async () => void jest.advanceTimersByTime(1000));
  await act(async () => api.onDraftChange('abcd'));
  expect(rt.tracked).toHaveLength(2);
});

test('idle 3s after the last keystroke sends typing:false', async () => {
  await mount();
  await act(async () => api.onDraftChange('a'));
  await act(async () => void jest.advanceTimersByTime(2999));
  expect(rt.tracked).toHaveLength(1);
  await act(async () => void jest.advanceTimersByTime(1));
  expect(rt.tracked.at(-1)).toEqual({ user_id: 'me', typing: false });
});

test('stop() and an emptied draft send typing:false once; stop when not typing is silent', async () => {
  await mount();
  await act(async () => api.stop());
  expect(rt.tracked).toEqual([]);
  await act(async () => api.onDraftChange('a'));
  await act(async () => api.onDraftChange(''));
  expect(rt.tracked.at(-1)).toEqual({ user_id: 'me', typing: false });
  await act(async () => api.stop());
  expect(rt.tracked).toHaveLength(2);
});

test('does not track before SUBSCRIBED', async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  await act(async () => api.onDraftChange('a'));
  expect(rt.tracked).toEqual([]);
  await act(async () => rt.status('typing:room1', 'SUBSCRIBED'));
  await act(async () => api.onDraftChange('ab')); // the early keystroke must not use up the throttle window
  expect(rt.tracked).toEqual([{ user_id: 'me', typing: true }]);
});

test('label follows presence sync and ignores me', async () => {
  await mount();
  expect(api.label).toBeNull();
  rt.presence = { me: [{ user_id: 'me', typing: true }], u2: [{ user_id: 'u2', typing: true }] };
  await act(async () => sync());
  expect(api.label).toBe('지은님이 입력 중');
  rt.presence = {};
  await act(async () => sync());
  expect(api.label).toBeNull();
});

test('unmount removes the channel', async () => {
  const root = await mount();
  await act(async () => root.render(<></>));
  expect(rt.removed).toHaveLength(1);
});

test('returned object is stable across re-renders with the same inputs', async () => {
  const root = await mount();
  await act(async () => root.render(<Probe />));
  expect(apis.at(-1)).toBe(apis.at(-2));
});

test('presence state is cleared when the room changes', async () => {
  const root = await mount();
  rt.presence = { u2: [{ user_id: 'u2', typing: true }] };
  await act(async () => sync());
  expect(api.label).toBe('지은님이 입력 중');
  room = 'room2';
  await act(async () => root.render(<Probe />));
  expect(api.label).toBeNull();
});
