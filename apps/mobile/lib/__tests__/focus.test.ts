import { retryFocus } from '../focus';

jest.mock('react-native', () => ({ Platform: { OS: 'web' }, AccessibilityInfo: {}, findNodeHandle: () => null }));

// 목표에 포커스가 실제로 닿을 때까지(Modal이 자기 복원을 끝낸 뒤) 제한된 횟수만 다시 시도한다.
function setup(takesAt: number) {
  const el = { calls: 0, focus() { this.calls++; if (this.calls >= takesAt) (globalThis as { document: { activeElement: unknown } }).document.activeElement = this; } };
  (globalThis as unknown as { document: object }).document = { activeElement: null };
  return el;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('retryFocus: 닿을 때까지 50ms 간격으로 다시 시도하고 닿으면 멈춘다', () => {
  const el = setup(3);
  retryFocus(() => el as never, { delay: 30 });
  jest.advanceTimersByTime(29);
  expect(el.calls).toBe(0);
  jest.advanceTimersByTime(1000);
  expect(el.calls).toBe(3);
});
test('retryFocus: 끝내 안 닿아도 10번에서 멈춘다', () => {
  const el = setup(99);
  retryFocus(() => el as never, { delay: 30 });
  jest.advanceTimersByTime(5000);
  expect(el.calls).toBe(10);
});
test('retryFocus: 동작 줄이기(delay 0)면 기다리지 않고 바로 첫 시도', () => {
  const el = setup(1);
  retryFocus(() => el as never, { delay: 0 });
  expect(el.calls).toBe(1);
});
test('retryFocus: 돌려준 함수로 남은 시도를 취소한다(언마운트·닫힘)', () => {
  const el = setup(99);
  const cancel = retryFocus(() => el as never, { delay: 30 });
  jest.advanceTimersByTime(80); // 첫 시도 + 한 번 더
  cancel();
  jest.advanceTimersByTime(5000);
  expect(el.calls).toBe(2);
});
