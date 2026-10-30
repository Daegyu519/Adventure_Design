import { act } from 'react';
import { createRoot } from 'test-renderer';

import { useTyping } from '../useTyping';

let mockOpts: unknown;
let mockChName = '';
let mockTracked: unknown[] = [];
let mockState: Record<string, unknown> = {};
let mockOnSync: () => void = () => {};
let mockOnStatus: (s: string) => void = () => {};
const mockRemove = jest.fn();
jest.mock('../supabase', () => ({
  supabase: {
    channel: (name: string, o: unknown) => {
      mockChName = name;
      mockOpts = o;
      const ch = {
        on: (_t: string, _f: unknown, cb: () => void) => ((mockOnSync = cb), ch),
        subscribe: (cb: (s: string) => void) => ((mockOnStatus = cb), ch),
        track: async (p: unknown) => void mockTracked.push(p),
        presenceState: () => mockState,
      };
      return ch;
    },
    removeChannel: (c: unknown) => mockRemove(c),
  },
}));

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
  await act(async () => mockOnStatus('SUBSCRIBED'));
  return root;
};
beforeEach(() => {
  room = 'room1';
  apis = [];
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  mockTracked = [];
  mockState = {};
  mockRemove.mockClear();
});
afterEach(() => jest.useRealTimers());

test('opens a private presence channel keyed by me', async () => {
  await mount();
  expect(mockChName).toBe('typing:room1');
  expect(mockOpts).toEqual({ config: { private: true, presence: { key: 'me' } } });
});

test('typing is mockTracked at most once per throttle window', async () => {
  await mount();
  await act(async () => api.onDraftChange('a'));
  await act(async () => void jest.advanceTimersByTime(500));
  await act(async () => api.onDraftChange('ab'));
  await act(async () => void jest.advanceTimersByTime(500));
  await act(async () => api.onDraftChange('abc'));
  expect(mockTracked).toEqual([{ user_id: 'me', typing: true }]);
  await act(async () => void jest.advanceTimersByTime(1000));
  await act(async () => api.onDraftChange('abcd'));
  expect(mockTracked).toHaveLength(2);
});

test('idle 3s after the last keystroke sends typing:false', async () => {
  await mount();
  await act(async () => api.onDraftChange('a'));
  await act(async () => void jest.advanceTimersByTime(2999));
  expect(mockTracked).toHaveLength(1);
  await act(async () => void jest.advanceTimersByTime(1));
  expect(mockTracked.at(-1)).toEqual({ user_id: 'me', typing: false });
});

test('stop() and an emptied draft send typing:false once; stop when not typing is silent', async () => {
  await mount();
  await act(async () => api.stop());
  expect(mockTracked).toEqual([]);
  await act(async () => api.onDraftChange('a'));
  await act(async () => api.onDraftChange(''));
  expect(mockTracked.at(-1)).toEqual({ user_id: 'me', typing: false });
  await act(async () => api.stop());
  expect(mockTracked).toHaveLength(2);
});

test('does not track before SUBSCRIBED', async () => {
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  await act(async () => api.onDraftChange('a'));
  expect(mockTracked).toEqual([]);
  await act(async () => mockOnStatus('SUBSCRIBED'));
  await act(async () => api.onDraftChange('ab')); // the early keystroke must not use up the throttle window
  expect(mockTracked).toEqual([{ user_id: 'me', typing: true }]);
});

test('label follows presence sync and ignores me', async () => {
  await mount();
  expect(api.label).toBeNull();
  mockState = { me: [{ user_id: 'me', typing: true }], u2: [{ user_id: 'u2', typing: true }] };
  await act(async () => mockOnSync());
  expect(api.label).toBe('지은님이 입력 중');
  mockState = {};
  await act(async () => mockOnSync());
  expect(api.label).toBeNull();
});

test('unmount removes the channel', async () => {
  const root = await mount();
  await act(async () => root.render(<></>));
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test('returned object is stable across re-renders with the same inputs', async () => {
  const root = await mount();
  await act(async () => root.render(<Probe />));
  expect(apis.at(-1)).toBe(apis.at(-2));
});

test('presence state is cleared when the room changes', async () => {
  const root = await mount();
  mockState = { u2: [{ user_id: 'u2', typing: true }] };
  await act(async () => mockOnSync());
  expect(api.label).toBe('지은님이 입력 중');
  room = 'room2';
  await act(async () => root.render(<Probe />));
  expect(api.label).toBeNull();
});
