import { act } from 'react';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import Report from '../app/(tabs)/report';
import { engine, type StatsRes } from '../lib/engine';

// 화면이 열릴 때(포커스) 한 번 불러오는 동작은 마운트 때 한 번 도는 effect로 대신한다(탭 내비게이션 없이 그리려고).
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]) }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
jest.mock('../lib/engine', () => ({ engine: { stats: jest.fn() } }));

const stats = engine.stats as jest.Mock;

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
    { week: '2026-11-02', count: 3 },
  ],
  predict_gap_trend: [
    { week: '2026-10-19', avg_gap: 1.5 },
    { week: '2026-10-26', avg_gap: 0.8 },
  ],
};

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const labels = (root: { container: TestInstance }) =>
  root.container.queryAll((n) => typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Report />);
  });
  return root;
}

beforeEach(() => stats.mockReset());

test('report: 숫자 타일 세 개가 엔진 숫자와 같다(힌트 12 · 살펴보기 5 · 스스로 고친 비율 33%)', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  expect(labels(root)).toEqual(expect.arrayContaining(['힌트 12', '살펴보기 5', '스스로 고친 비율 33%']));
});

test('report: 막대는 최근 5주만, 막대마다 주와 개수를 읽어 준다', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  const bars = labels(root).filter((l) => /주 힌트 \d+번$/.test(l));
  expect(bars).toEqual([
    '10월 5일 주 힌트 1번',
    '10월 12일 주 힌트 0번',
    '10월 19일 주 힌트 3번',
    '10월 26일 주 힌트 5번',
    '11월 2일 주 힌트 3번',
  ]);
});

test('report: 예측 차이 한 줄은 마지막 주를 붙이고, 맨 아래에 평가하지 않는다는 안내가 있다', async () => {
  stats.mockResolvedValue(FIXTURE);
  const root = await setup();
  const text = textOf(root.container);
  expect(text).toContain('10/26 주 예측과 평균 0.8칸 차이');
  expect(text).toContain('숫자는 나만 봐요. 사람을 평가하는 점수가 아니에요.');
});

test('report: 예측 차이 기록이 없으면 그 줄만 빠지고 나머지는 그대로다', async () => {
  stats.mockResolvedValue({ ...FIXTURE, predict_gap_trend: [] });
  const root = await setup();
  expect(textOf(root.container)).not.toContain('예측과 평균');
  expect(labels(root)).toContain('힌트 12');
});

test('report: 불러오지 못하면 안내와 다시 시도 버튼이 뜨고, 누르면 숫자가 나온다', async () => {
  stats.mockRejectedValueOnce(new Error('engine down')).mockResolvedValueOnce(FIXTURE);
  const root = await setup();
  expect(textOf(root.container)).toContain('지금은 불러오지 못했어요');
  expect(labels(root)).not.toContain('힌트 12');

  const retry = root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '다시 시도')[0];
  expect(retry).toBeDefined();
  await act(async () => retry.props.onClick({ stopPropagation() {}, nativeEvent: {} }));

  expect(stats).toHaveBeenCalledTimes(2);
  expect(textOf(root.container)).not.toContain('지금은 불러오지 못했어요');
  expect(labels(root)).toContain('힌트 12');
});
