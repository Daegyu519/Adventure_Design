import { engine, type HintRes } from '../engine';
import { reviewBeforeSend, SEND_REVIEW_MS } from '../sendReview';

jest.mock('../engine', () => ({ engine: { hint: jest.fn() } }));
const hint = engine.hint as jest.Mock;
const body = { room_id: 'room', text: '안 돼.', seq: 1, reply_to: 7 };
const warning: HintRes = { seq: 1, hint: { title: '차갑게 느껴질 수도 있어요', detail: '이유가 없어요', level: 'card', can_soften: false }, trace_id: 'trace' };

beforeEach(() => { jest.useFakeTimers(); hint.mockReset(); });
afterEach(() => jest.useRealTimers());

test('경고·경고 없음 모두 응답 즉시 반환하고 타이머를 정리한다', async () => {
  for (const result of [warning, { ...warning, hint: null }]) {
    hint.mockResolvedValueOnce(result);
    expect(await reviewBeforeSend(body, new AbortController().signal)).toEqual(result);
    expect(jest.getTimerCount()).toBe(0);
  }
  expect(hint.mock.calls[0][0]).toEqual(body);
});

test('abort를 무시하는 요청도 SEND_REVIEW_MS에 끝나고 늦은 경고를 버린다', async () => {
  let resolve!: (r: HintRes) => void;
  hint.mockImplementation(() => new Promise<HintRes>((r) => { resolve = r; }));
  const done = jest.fn();
  const p = reviewBeforeSend(body, new AbortController().signal).then(done);
  await jest.advanceTimersByTimeAsync(SEND_REVIEW_MS - 1);
  expect(done).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await p;
  expect(done).toHaveBeenCalledWith(null);
  expect(hint.mock.calls[0][1].signal.aborted).toBe(true);
  resolve(warning);
  await Promise.resolve();
  expect(done).toHaveBeenCalledTimes(1);
});

test('오류·오래된 seq는 경고 없이 끝낸다', async () => {
  hint.mockRejectedValueOnce(new Error('offline'));
  expect(await reviewBeforeSend(body, new AbortController().signal)).toBeNull();
  hint.mockResolvedValueOnce({ ...warning, seq: 0 });
  expect(await reviewBeforeSend(body, new AbortController().signal)).toBeNull();
});

test('방 이탈 시 요청을 취소하고 타이머를 정리한다', async () => {
  hint.mockReturnValue(new Promise(() => {}));
  const ctrl = new AbortController();
  const p = reviewBeforeSend(body, ctrl.signal);
  await Promise.resolve();
  ctrl.abort();
  expect(await p).toBeNull();
  expect(hint.mock.calls[0][1].signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('이미 취소됐거나 500자 초과면 요청하지 않는다', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  expect(await reviewBeforeSend(body, ctrl.signal)).toBeNull();
  expect(await reviewBeforeSend({ ...body, text: '가'.repeat(501) }, new AbortController().signal)).toBeNull();
  expect(hint).not.toHaveBeenCalled();
});
