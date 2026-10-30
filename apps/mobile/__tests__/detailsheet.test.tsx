import { act } from 'react';
import { Platform } from 'react-native';
import { createRoot, type TestNode } from 'test-renderer';

import { DetailSheet } from '../components/DetailSheet';
import type { DetailRes } from '../lib/engine';

jest.mock('lucide-react-native/icons/check', () => () => null);
jest.mock('../lib/motion', () => ({ MOTION_MS: 200, useReducedMotion: () => true }));
jest.mock('../lib/supabase', () => ({ supabase: null }));
const mockDetail = jest.fn();
jest.mock('../lib/engine', () => ({ ...jest.requireActual('../lib/engine'), engine: { isMock: true, detail: (...a: unknown[]) => mockDetail(...a) } }));

const TRACE = '11111111-1111-4111-8111-111111111111';
const READINGS: DetailRes['readings'] = { 차갑게: '자주', 성의없게: '가끔', 화나게: '드물어요', 무난하게: '가끔', 따뜻하게: '드물어요' };
const res = (o: Partial<DetailRes> = {}): DetailRes => ({
  alert: true,
  top_reading: '차갑게',
  readings: READINGS,
  why: ['이유 없이 짧게 끊으면 차갑게 읽힐 수도 있어요'],
  options: [
    { label: '조금만 바꾼 문장', text: '지금은 어려워요. 다들 맞춰서 하는 중이에요.', keep: ['거절하는 뜻'], change: ['이유를 더했어요'] },
    { label: '가장 부드럽게 바꾼 문장', text: '미안해요, 안 돼요. 다들 맞춰서 하는 중이에요.', keep: ['거절하는 뜻'], change: ['사과로 시작해요'] },
  ],
  mismatch: null,
  footnote: '틀릴 수도 있어요.',
  trace_id: TRACE,
  ...o,
});

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const TEXT = '안 돼요. 다들 맞춰서 하는 중이에요.';

async function setup(over: Record<string, unknown> = {}) {
  const p = { visible: true, roomId: 'r1', text: TEXT, replyTo: null as number | null, say: jest.fn(), onClose: jest.fn(), onApply: jest.fn(), onSendAsIs: jest.fn(), ...over };
  const root = createRoot();
  await act(async () => root.render(<DetailSheet {...p} />));
  const all = () => root.container.queryAll(() => true);
  const byLabel = (l: string) => root.container.queryAll((n) => n.props.accessibilityLabel === l);
  const click = (n: { props: { onClick(e: object): unknown } }) => act(async () => void n.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { p, root, all, byLabel, click, texts: () => textOf(root.container as unknown as TestNode) };
}
const flush = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  mockDetail.mockReset();
  jest.replaceProperty(Platform, 'OS', 'android');
});

test('열면 살펴보는 중 → 의도 없이 한 번 요청하고(9초) 결과를 그린다', async () => {
  let done!: (r: DetailRes) => void;
  mockDetail.mockReturnValue(new Promise((r) => (done = r)));
  const { texts, p } = await setup({ replyTo: 7 });
  expect(texts()).toContain('살펴보는 중…');
  expect(mockDetail).toHaveBeenCalledTimes(1);
  expect(mockDetail.mock.calls[0][0]).toEqual({ room_id: 'r1', text: TEXT, reply_to: 7 });
  expect(mockDetail.mock.calls[0][1]).toMatchObject({ timeoutMs: 9000 });
  await act(async () => done(res()));
  expect(texts()).not.toContain('살펴보는 중…');
  expect(texts()).toContain('이유 없이 짧게 끊으면');
  expect(texts()).toContain('조금만 바꾼 문장');
  expect(texts()).toContain('지킨 것: 거절하는 뜻');
  expect(texts()).toContain('바꾼 것: 이유를 더했어요');
  expect(texts()).toContain('틀릴 수도 있어요.');
  expect(p.say).toHaveBeenCalledTimes(1); // 결과는 한 번만 읽는다
});

test('후보 문장은 바뀐 어절을 강조하는 DiffText로 읽힌다', async () => {
  mockDetail.mockResolvedValue(res());
  const { root } = await setup();
  await flush();
  const imgs = root.container.queryAll((n) => n.props.role === 'img').map((n) => n.props.accessibilityLabel as string);
  expect(imgs[0]).toBe('고친 문장: 지금은 어려워요. 다들 맞춰서 하는 중이에요. 바뀐 말: 지금은, 어려워요.');
});

test('alert가 false면 걱정할 부분이 없다고 말하고, 후보가 없으면 후보 영역이 없다', async () => {
  mockDetail.mockResolvedValue(res({ alert: false, options: [], why: [] }));
  const { texts } = await setup();
  await flush();
  expect(texts()).toContain('크게 걱정할 부분은 없어 보여요');
  expect(texts()).not.toContain('이렇게 바꿔 볼 수도 있어요');
});

test('칩: 누르면 같은 글에 의도만 바꿔 다시 부르고, 어긋남 한 줄과 후보가 바뀌며 읽힘은 그대로', async () => {
  mockDetail.mockResolvedValueOnce(res());
  const { byLabel, click, texts, root } = await setup();
  await flush();
  mockDetail.mockResolvedValueOnce(res({ mismatch: '미안하게 말하려던 것과 달리 차갑게 읽힐 수도 있어요', options: [{ label: '조금만 바꾼 문장', text: '미안하지만 안 돼요.', keep: ['뜻'], change: ['사과'] }], why: ['다른 이유'] }));
  await click(byLabel('미안하게')[0] as never);
  expect(mockDetail.mock.calls[1][0]).toEqual({ room_id: 'r1', text: TEXT, intent: '미안하게' });
  expect(texts()).toContain('미안하게 말하려던 것과 달리 차갑게 읽힐 수도 있어요');
  expect(texts()).toContain('미안하지만 안 돼요.'.split(' ')[0]);
  expect(texts()).toContain('이유 없이 짧게 끊으면'); // 이유는 처음 응답 그대로
  expect(texts()).not.toContain('다른 이유');
  expect(byLabel('미안하게')[0].props.accessibilityState.checked).toBe(true);
  // 다시 누르면 해제: 의도 없는 원래 후보로(이미 받은 응답을 다시 쓴다)
  await click(byLabel('미안하게')[0] as never);
  expect(mockDetail).toHaveBeenCalledTimes(2);
  expect(texts()).not.toContain('미안하게 말하려던 것과');
  expect(root.container.queryAll((n) => n.props.role === 'img')).toHaveLength(2);
});

test('칩을 빨리 바꾸면 앞 요청을 끊고, 늦게 온 앞 응답은 버린다', async () => {
  mockDetail.mockResolvedValueOnce(res());
  const { byLabel, click, texts } = await setup();
  await flush();
  let first!: (r: DetailRes) => void;
  mockDetail.mockReturnValueOnce(new Promise((r) => (first = r)));
  mockDetail.mockResolvedValueOnce(res({ mismatch: '가볍게 줄', options: [] }));
  await click(byLabel('단호하게')[0] as never);
  const sig1 = mockDetail.mock.calls[1][1].signal as AbortSignal;
  await click(byLabel('가볍게')[0] as never);
  expect(sig1.aborted).toBe(true);
  await act(async () => first(res({ mismatch: '단호하게 줄', options: [] })));
  expect(texts()).toContain('가볍게 줄');
  expect(texts()).not.toContain('단호하게 줄');
});

test('입력창에 적용: 후보 글, label로 정한 choice, 1순위 읽힘, trace_id를 넘긴다 (B 하나만 와도 B)', async () => {
  mockDetail.mockResolvedValue(res({ options: [res().options[1]] }));
  const { byLabel, click, p } = await setup();
  await flush();
  await click(byLabel('입력창에 적용: 가장 부드럽게 바꾼 문장')[0] as never);
  expect(p.onApply).toHaveBeenCalledWith({ text: '미안해요, 안 돼요. 다들 맞춰서 하는 중이에요.', choice: 'B', topReading: '차갑게', traceId: TRACE });
});

test('모르는 label이면 choice는 null(적용만)', async () => {
  mockDetail.mockResolvedValue(res({ options: [{ label: '다른 문장', text: '새 글', keep: [], change: [] }] }));
  const { byLabel, click, p } = await setup();
  await flush();
  await click(byLabel('입력창에 적용: 다른 문장')[0] as never);
  expect(p.onApply).toHaveBeenCalledWith({ text: '새 글', choice: null, topReading: '차갑게', traceId: TRACE });
});

test('그대로 보낼게요: 결과 전에도 눌린다(전송을 막지 않는다). 받은 뒤에는 topReading·traceId를 넘긴다', async () => {
  let done!: (r: DetailRes) => void;
  mockDetail.mockReturnValue(new Promise((r) => (done = r)));
  const { byLabel, click, p } = await setup();
  await click(byLabel('그대로 보낼게요')[0] as never);
  expect(p.onSendAsIs).toHaveBeenLastCalledWith({ topReading: null, traceId: null });
  await act(async () => done(res()));
  await click(byLabel('그대로 보낼게요')[0] as never);
  expect(p.onSendAsIs).toHaveBeenLastCalledWith({ topReading: '차갑게', traceId: TRACE });
});

test('실패: 서버 글은 숨기고 고정 문구 + 다시 해 보기, 다시 하면 결과', async () => {
  const { EngineError } = jest.requireActual('../lib/engine');
  mockDetail.mockRejectedValueOnce(new EngineError(429, 'rate_limited: 내부 사정'));
  const { byLabel, click, texts, p } = await setup();
  await flush();
  expect(texts()).toContain('요청이 많아요. 잠시 뒤 다시 해 주세요.');
  expect(texts()).not.toContain('내부 사정');
  expect(p.say).not.toHaveBeenCalled(); // 안드로이드·웹은 role=alert가 읽는다
  mockDetail.mockResolvedValueOnce(res());
  await click(byLabel('다시 해 보기')[0] as never);
  expect(texts()).toContain('이유 없이 짧게 끊으면');
});

test('iOS: 실패 문구는 say로 한 번 읽는다', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockDetail.mockRejectedValue(new Error('x'));
  const { p } = await setup();
  await flush();
  expect(p.say).toHaveBeenCalledWith('지금은 살펴보기 어려워요. 잠시 뒤 다시 해 주세요.');
});

test('닫혀 있으면 요청하지 않는다', async () => {
  await setup({ visible: false });
  expect(mockDetail).not.toHaveBeenCalled();
});
