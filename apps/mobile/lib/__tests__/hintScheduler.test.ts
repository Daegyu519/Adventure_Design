import { EngineError, type HintRes } from '../engine';
import { createHintScheduler, type Hint } from '../hintScheduler';

const H: Hint = { title: '차갑게 느껴질 수도 있어요', detail: 'd' };
type Call = { text: string; seq: number; signal: AbortSignal; resolve(r: HintRes): void; reject(e: unknown): void };
let calls: Call[];
let results: { hint: Hint | null; traceId: string | null }[];
let on: boolean;
const request = jest.fn((text: string, seq: number, signal: AbortSignal) => new Promise<HintRes>((resolve, reject) => calls.push({ text, seq, signal, resolve, reject })));
const mk = () => createHintScheduler({ request, onResult: (r) => results.push(r), enabled: () => on });
const ok = (seq: number, hint: Hint | null = H): HintRes => ({ seq, hint, trace_id: 't' });
const last = () => results[results.length - 1];

beforeEach(() => {
  jest.useFakeTimers();
  calls = [];
  results = [];
  on = true;
  request.mockClear();
});
afterEach(() => jest.useRealTimers());

test('debounces: one request 500ms after the last keystroke', async () => {
  const s = mk();
  s.input('안');
  await jest.advanceTimersByTimeAsync(200);
  s.input('안 돼요.');
  await jest.advanceTimersByTimeAsync(499);
  expect(request).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('안 돼요.', 2, expect.any(AbortSignal));
});

test('result is delivered for the latest seq', async () => {
  const s = mk();
  s.input('안 돼요.');
  await jest.advanceTimersByTimeAsync(500);
  calls[0].resolve(ok(1));
  await jest.advanceTimersByTimeAsync(0);
  expect(last()).toEqual({ hint: H, traceId: 't' });
});

test('new input aborts the in-flight request', async () => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  s.input('ab');
  expect(calls[0].signal.aborted).toBe(true);
});

test('late response for an older seq is dropped', async () => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  s.input('ab');
  await jest.advanceTimersByTimeAsync(500);
  calls[0].resolve(ok(1));
  await jest.advanceTimersByTimeAsync(0);
  expect(results.filter((r) => r.hint)).toHaveLength(0);
});

test('response whose res.seq is stale is dropped', async () => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  calls[0].resolve(ok(0));
  await jest.advanceTimersByTimeAsync(0);
  expect(results).toHaveLength(0);
});

test('empty or whitespace text -> null immediately, no request', async () => {
  const s = mk();
  s.input('   ');
  expect(last()).toEqual({ hint: null, traceId: null });
  await jest.advanceTimersByTimeAsync(2000);
  expect(request).not.toHaveBeenCalled();
});

test('text over 500 chars -> null, no request', async () => {
  const s = mk();
  s.input('a'.repeat(501));
  expect(last()).toEqual({ hint: null, traceId: null });
  await jest.advanceTimersByTimeAsync(2000);
  expect(request).not.toHaveBeenCalled();
});

test.each([new EngineError(0), new EngineError(429), new EngineError(503)])('engine error %# -> hint cleared', async (err) => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  calls[0].reject(err);
  await jest.advanceTimersByTimeAsync(0);
  expect(last()).toEqual({ hint: null, traceId: null });
});

test('429 backs off: no request until Retry-After passes', async () => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  calls[0].reject(Object.assign(new EngineError(429), { retryAfterMs: 3000 }));
  await jest.advanceTimersByTimeAsync(0);
  s.input('ab');
  await jest.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2500);
  expect(request).toHaveBeenCalledTimes(2);
});

test('sent() clears and ignores the in-flight response', async () => {
  const s = mk();
  s.input('안 돼요.');
  await jest.advanceTimersByTimeAsync(500);
  s.sent();
  expect(calls[0].signal.aborted).toBe(true);
  expect(last()).toEqual({ hint: null, traceId: null });
  calls[0].resolve(ok(1));
  await jest.advanceTimersByTimeAsync(0);
  expect(last().hint).toBeNull();
});

test('sent() cancels a pending debounce timer', async () => {
  const s = mk();
  s.input('a');
  s.sent();
  await jest.advanceTimersByTimeAsync(1000);
  expect(request).not.toHaveBeenCalled();
});

test('enabled() false -> never requests', async () => {
  const s = mk();
  on = false;
  for (let i = 0; i < 10; i++) s.input('안 돼요' + i);
  await jest.advanceTimersByTimeAsync(2000);
  expect(request).not.toHaveBeenCalled();
});

test('turning it off mid-debounce still sends nothing', async () => {
  const s = mk();
  s.input('안 돼요.');
  on = false;
  await jest.advanceTimersByTimeAsync(600);
  expect(request).not.toHaveBeenCalled();
});

test('dispose aborts and silences', async () => {
  const s = mk();
  s.input('a');
  await jest.advanceTimersByTimeAsync(500);
  s.dispose();
  expect(calls[0].signal.aborted).toBe(true);
  calls[0].resolve(ok(1));
  await jest.advanceTimersByTimeAsync(0);
  expect(results).toHaveLength(0);
});
