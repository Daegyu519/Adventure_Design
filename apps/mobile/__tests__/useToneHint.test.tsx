import { act } from 'react';
import { createRoot } from 'test-renderer';

import { useToneHint } from '../lib/useToneHint';

const mockHint = jest.fn();
jest.mock('../lib/engine', () => ({ HINT_TIMEOUT_MS: 1700, engine: { hint: (...a: unknown[]) => mockHint(...a) } }));
const mockLog = jest.fn();
jest.mock('../lib/toneEvents', () => ({ logToneEvent: (e: unknown) => mockLog(e) }));

const H = { title: '차갑게 느껴질 수도 있어요', detail: 'd' };
let api: ReturnType<typeof useToneHint>;
function Probe({ on, reply }: { on: boolean; reply?: number | null }) {
  api = useToneHint('r1', reply ?? null, on);
  return null;
}
const mount = async (on = true, reply: number | null = null) => {
  const root = createRoot();
  await act(async () => void root.render(<Probe on={on} reply={reply} />));
  return root;
};
const type = async (t: string) => {
  await act(async () => {
    api.input(t);
    await jest.advanceTimersByTimeAsync(500);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockHint.mockReset().mockImplementation(async (b: { seq: number }) => ({ seq: b.seq, hint: H, trace_id: 'tr' }));
  mockLog.mockReset();
});
afterEach(() => jest.useRealTimers());

test('requests with room, seq, reply_to, signal and timeout; shows hint; logs hint_shown once', async () => {
  await mount(true, 7);
  await type('안 돼요.');
  expect(mockHint).toHaveBeenCalledWith({ room_id: 'r1', text: '안 돼요.', seq: 1, reply_to: 7 }, { signal: expect.any(AbortSignal), timeoutMs: 1700 });
  expect(api.hint).toEqual(H);
  await type('안 돼요..');
  expect(mockLog.mock.calls.filter(([e]) => e.kind === 'hint_shown')).toEqual([[{ room_id: 'r1', kind: 'hint_shown', signals: { trace_id: 'tr' } }]]);
});

test('tone_hint_on false -> no request, no hint', async () => {
  await mount(false);
  await type('안 돼요.');
  expect(mockHint).not.toHaveBeenCalled();
  expect(api.hint).toBeNull();
});

test('dismiss hides it and the same hint stays suppressed; sent logs sent_with_hint and clears', async () => {
  await mount();
  await type('안 돼요.');
  await act(async () => api.dismiss());
  expect(api.hint).toBeNull();
  await type('안 돼요.!');
  expect(api.hint).toBeNull();
  await act(async () => api.sent());
  expect(mockLog).toHaveBeenCalledWith({ room_id: 'r1', kind: 'sent_with_hint' });
});

test('fixed then sent logs sent_after_fix', async () => {
  await mount();
  await type('안 돼요.');
  mockHint.mockImplementation(async (b: { seq: number }) => ({ seq: b.seq, hint: null, trace_id: 'tr' }));
  await type('좋아요');
  expect(api.hint).toBeNull();
  await act(async () => api.sent());
  expect(mockLog).toHaveBeenCalledWith({ room_id: 'r1', kind: 'sent_after_fix' });
});
