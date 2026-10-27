import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import Report from '../app/(tabs)/report';
import { engine, type StatsRes } from '../lib/engine';
import tokens from '../lib/tokens.json';

// 화면이 열릴 때(포커스) 한 번 불러오는 동작은 마운트 때 한 번 도는 effect로 대신한다(탭 내비게이션 없이 그리려고).
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
jest.mock('../lib/engine', () => ({ engine: { stats: jest.fn() } }));

const stats = engine.stats as jest.Mock;

// 오늘 = 2026-11-04(수) 낮 12시 KST. 이번 주 월요일은 2026-11-02.
// Date만 고정한다(타이머까지 가짜로 만들면 act가 멈춘다).
const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
beforeAll(() => jest.useFakeTimers({ now: new Date('2026-11-04T03:00:00Z'), doNotFake: [...ALL_BUT_DATE] }));
afterAll(() => jest.useRealTimers());

const FIXTURE: StatsRes = {
  hints: 12,
  details: 5,
  fixed: 4,
  fix_rate: 0.33,
  hints_by_week: [
    { week: '2026-09-21', count: 7 }, // 5주를 넘는 오래된 주는 보이지 않는다
    { week: '2026-09-28', count: 9 },
    { week: '2026-10-05', count: 1 },
    { week: '2026-10-12', count: 0 },
    { week: '2026-10-19', count: 3 },
    { week: '2026-10-26', count: 5 },
    { week: '2026-11-02', count: 6 }, // 이번 주
  ],
  predict_gap_trend: [
    { week: '2026-10-19', avg_gap: 1.5 },
    { week: '2026-10-26', avg_gap: 0.8 },
  ],
};

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const labels = (root: { container: TestInstance }) =>
  root.container.queryAll((n) => typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);
const bars = (root: { container: TestInstance }) => root.container.queryAll((n) => n.props.accessibilityRole === 'image');
// 막대 칸 안에서 위 모서리가 4px로 둥근 상자가 막대 자체다.
const barBox = (col: TestInstance) => col.queryAll((n) => StyleSheet.flatten(n.props.style)?.borderTopLeftRadius === 4)[0];
const barColor = (col: TestInstance) => StyleSheet.flatten(barBox(col).props.style).backgroundColor;

// 풀어 줄 때까지 멈춰 있는 응답(요청이 겹칠 때 도착 순서를 우리가 정한다).
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
// 당겨서 새로고침(네이티브 RefreshControl)을 흉내 낸다.
const pullToRefresh = (root: { container: TestInstance }) =>
  act(async () => {
    root.container.queryAll((n) => n.props.refreshControl != null)[0].props.refreshControl.props.onRefresh();
  });

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Report />);
  });
  return root;
}

beforeEach(() => stats.mockReset());

test('report: 타일 세 개는 순서대로 예측과의 차이(주 표시) · 이번 주 힌트 · 스스로 고친 비율이고, 살펴보기 수는 없다', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  const tiles = root.container.queryAll((n) => n.props.accessible === true && !n.props.accessibilityRole).map((n) => n.props.accessibilityLabel);
  expect(tiles).toEqual(['10/26 주 예측과의 차이 0.8칸', '이번 주 힌트 6번', '스스로 고친 비율 33%']);
  expect(labels(root).some((l) => l.includes('살펴보기'))).toBe(false);
});

test('report: 이번 주 항목이 없으면 이번 주 힌트는 0번, 예측 차이 기록이 없으면 타일은 –', async () => {
  stats.mockResolvedValue({ ...FIXTURE, hints_by_week: FIXTURE.hints_by_week.slice(0, 6), predict_gap_trend: [] });
  const root = await setup();
  expect(labels(root)).toEqual(expect.arrayContaining(['예측과의 차이 –', '이번 주 힌트 0번']));
});

test('report: 막대는 최근 5주만, 막대마다 주와 개수를 읽어 주고 이번 주는 "이번 주"로 읽는다', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  expect(bars(root).map((b) => b.props.accessibilityLabel)).toEqual([
    '10월 5일 주 힌트 1번',
    '10월 12일 주 힌트 0번',
    '10월 19일 주 힌트 3번',
    '10월 26일 주 힌트 5번',
    '이번 주 힌트 6번',
  ]);
  expect(textOf(root.container)).toContain('이번 주'); // 눈에 보이는 주 이름도 "이번 주"
});

test('report: 이번 주 막대는 primary, 지난 주 막대는 textMuted(색만으로 뜻을 전하지 않고 값 글자가 같이 있다)', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  const colors = bars(root).map(barColor);
  expect(colors).toEqual([tokens.light.textMuted, tokens.light.textMuted, tokens.light.textMuted, tokens.light.textMuted, tokens.light.primary]);
  expect(textOf(bars(root)[4])).toContain('6'); // 막대 위 값
});

test('report: 맨 아래에 목업의 안내 문구가 있고, 예측 차이는 타일 하나로만 나온다', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  const text = textOf(root.container);
  expect(text).toContain('힌트 수는 점수가 아니에요. 보내기 전에 한 번 더 돌아본 횟수일 수 있어요.');
  expect(text).not.toContain('예측과 평균'); // 따로 한 줄을 두지 않는다
});

test('report: 불러오지 못하면 안내와 다시 시도 버튼이 뜨고, 누르면 숫자가 나온다', async () => {
  stats.mockRejectedValueOnce(new Error('engine down')).mockResolvedValueOnce(FIXTURE);
  const root = await setup();
  expect(textOf(root.container)).toContain('지금은 불러오지 못했어요');
  expect(labels(root)).not.toContain('이번 주 힌트 6번');

  const retry = root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '다시 시도')[0];
  expect(retry).toBeDefined();
  await act(async () => retry.props.onClick({ stopPropagation() {}, nativeEvent: {} }));

  expect(stats).toHaveBeenCalledTimes(2);
  expect(textOf(root.container)).not.toContain('지금은 불러오지 못했어요');
  expect(labels(root)).toContain('이번 주 힌트 6번');
});

test('report: 열 때 시작한 요청과 당겨서 새로고침이 겹치면, 늦게 도착한 옛 응답이 새 숫자를 덮지 않는다', async () => {
  const first = deferred<StatsRes>();
  const second = deferred<StatsRes>();
  stats.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const root = await setup(); // 첫 요청이 아직 안 왔다
  await pullToRefresh(root); // 두 번째 요청

  await act(async () => second.resolve({ ...FIXTURE, fix_rate: 0.5 })); // 새 요청이 먼저 온다
  expect(labels(root)).toContain('스스로 고친 비율 50%');
  await act(async () => first.resolve({ ...FIXTURE, fix_rate: 0.33 })); // 옛 요청이 늦게 온다
  expect(labels(root)).toContain('스스로 고친 비율 50%');
  expect(labels(root)).not.toContain('스스로 고친 비율 33%');
});

test('report: 숫자가 이미 떠 있는데 다시 읽기가 실패하면 숫자는 그대로 두고 안내와 다시 시도를 그 위에 보여 준다', async () => {
  stats.mockResolvedValueOnce(FIXTURE).mockRejectedValueOnce(new Error('engine down')).mockResolvedValueOnce({ ...FIXTURE, fix_rate: 0.5 });
  const root = await setup();
  expect(labels(root)).toContain('스스로 고친 비율 33%');

  await pullToRefresh(root); // 실패
  const text = textOf(root.container);
  expect(labels(root)).toContain('스스로 고친 비율 33%'); // 옛 숫자가 사라지지 않는다
  expect(text).toContain('지금은 불러오지 못했어요');
  expect(text.indexOf('지금은 불러오지 못했어요')).toBeLessThan(text.indexOf('주별 힌트 수')); // 숫자 위
  const retry = root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '다시 시도')[0];
  expect(retry).toBeDefined();

  await act(async () => retry.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(textOf(root.container)).not.toContain('지금은 불러오지 못했어요');
  expect(labels(root)).toContain('스스로 고친 비율 50%');
});
