import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import Mirror from '../app/(tabs)/mirror';
import { EngineError, engine } from '../lib/engine';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
jest.mock('lucide-react-native/icons/check', () => () => null);
jest.mock('../lib/engine', () => {
  class EngineError extends Error {
    status: number;
    constructor(status: number, message = 'x') {
      super(message);
      this.status = status;
    }
  }
  return { EngineError, engine: { mirrorToday: jest.fn(), mirrorAnswer: jest.fn() } };
});

const today = engine.mirrorToday as jest.Mock;
const answer = engine.mirrorAnswer as jest.Mock;

const CARDS = [
  { card_id: 'c-role', kind: 'roleplay', persona: '민지', relation: '팀원', situation: '발표 전날', message: '오늘 밤까지 같이 해 줄 수 있어요?' },
  { card_id: 'c-recv', kind: 'receive', persona: '민지', relation: '팀원', situation: '회의 시간을 잡는 중', message: '안 돼요.' },
  { card_id: 'c-pred', kind: 'predict', persona: '민지', relation: '선배', situation: '역할을 정하는 중', message: '알아서 해 주세요.' },
];
const READINGS = { 차갑게: '자주', 성의없게: '가끔', 화나게: '드물어요', 무난하게: '가끔', 따뜻하게: '드물어요' };

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const click = (n: TestInstance) => act(async () => n.props.onClick({ stopPropagation() {}, nativeEvent: {} }));

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Mirror />);
  });
  const byLabel = (l: string) => root.container.queryAll((n) => n.props.accessibilityLabel === l || n.props.accessibilityLabel === `${l}, 처리 중`);
  const btn = (l: string, nth = 0) => byLabel(l).filter((n) => n.props.accessibilityRole === 'button')[nth];
  const radio = (card: number, l: string) => root.container.queryAll((n) => n.props.accessibilityRole === 'radiogroup')[card].queryAll((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === l)[0];
  const text = () => textOf(root.container);
  return { root, byLabel, btn, radio, text };
}

beforeEach(() => {
  today.mockReset().mockResolvedValue({ cards: CARDS });
  answer.mockReset();
});

test('세 카드를 한 번만 불러와 종류 머리말과 함께 세로로 보여 준다', async () => {
  const { text } = await setup();
  expect(today).toHaveBeenCalledTimes(1);
  const t = text();
  expect(t.indexOf('역할극')).toBeLessThan(t.indexOf('되돌려 받기'));
  expect(t.indexOf('되돌려 받기')).toBeLessThan(t.indexOf('예측 맞히기'));
  expect(t).toContain('선배라면 얼마나 부정적으로 읽을까요?');
});

test('예측 맞히기: 칸을 고르고 확인하면 차이만 보이고 폼 대신 결과가 포커스를 받는다', async () => {
  answer.mockResolvedValue({ readings: READINGS, gap: 1 });
  const { radio, btn, text, root } = await setup();
  await click(radio(1, '2'));
  await click(btn('확인하기', 1));
  expect(answer).toHaveBeenCalledWith({ card_id: 'c-pred', predicted: 2 });
  expect(text()).toContain('예측과 한 칸 차이');
  expect(text()).toContain('차갑게');
  expect(text()).not.toMatch(/\d+점|%/);
  const status = root.container.queryAll((n) => n.props.accessibilityRole === 'alert' && textOf(n).includes('예측과 한 칸 차이'));
  expect(status.length).toBeGreaterThan(0);
});

test('되돌려 받기: score를 보내고 reveal과 "내 느낌" 차이를 보여 준다', async () => {
  answer.mockResolvedValue({ readings: READINGS, reveal: '지난주에 당신이 보낸 문장이에요', gap: 4 });
  const { radio, btn, text } = await setup();
  await click(radio(0, '5'));
  await click(btn('확인하기'));
  expect(answer).toHaveBeenCalledWith({ card_id: 'c-recv', score: 5 });
  expect(text()).toContain('지난주에 당신이 보낸 문장이에요');
  expect(text()).toContain('내 느낌과 네 칸 차이');
});

test('역할극: 답장을 보내면 속마음과 읽힘이 나오고, A를 고르면 바뀐 어절만 따로 표시된다', async () => {
  answer.mockResolvedValue({
    readings: READINGS,
    inner_voice: '조금 서운할 수도 있어요',
    options: [{ label: '조금만 바꾼 문장', text: '미안해요 안 돼요.', keep: [], change: [] }],
  });
  const { root, btn, text } = await setup();
  const input = root.container.queryAll((n) => n.props.accessibilityLabel === '답장' && n.props.onChangeText)[0];
  await act(async () => input.props.onChangeText('안 돼요.'));
  await click(btn('보내기'));
  expect(answer).toHaveBeenCalledWith({ card_id: 'c-role', reply: '안 돼요.' });
  expect(text()).toContain('받았을 때 속마음');
  expect(text()).toContain('조금 서운할 수도 있어요');
  expect(btn('그대로')).toBeDefined();
  await click(btn('A, 고친 문장 고르기'));
  const changed = root.container.queryAll((n) => n.props.style && StyleSheet.flatten(n.props.style).textDecorationLine === 'underline').map(textOf);
  expect(changed).toEqual(['미안해요']);
});

test('세 카드를 다 하면 마무리 문구가 나온다(점수 합계 · 연속 기록 · 효과 없음)', async () => {
  answer.mockResolvedValue({ readings: READINGS, gap: 0, inner_voice: '괜찮아요', options: [] });
  const { root, radio, btn, text } = await setup();
  expect(text()).not.toContain('오늘 카드는 여기까지예요');
  const input = root.container.queryAll((n) => n.props.accessibilityLabel === '답장' && n.props.onChangeText)[0];
  await act(async () => input.props.onChangeText('네'));
  await click(btn('보내기'));
  await click(btn('그대로'));
  await click(radio(0, '3'));
  await click(btn('확인하기'));
  await click(radio(0, '3'));
  await click(btn('확인하기'));
  expect(text()).toContain('오늘 카드는 여기까지예요. 내일 또 만나요.');
  expect(text()).not.toMatch(/연속|축하/);
});

test.each([
  [429, '요청이 많아요. 잠시 뒤 다시 해 주세요.'],
  [503, '연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.'],
])('답 보내기 %i 오류는 고정 문구를 alert로 보여 주고 폼과 고른 칸을 그대로 둔다', async (status, copy) => {
  answer.mockRejectedValue(new EngineError(status, 'SERVER TEXT'));
  const { radio, btn, text, root } = await setup();
  await click(radio(1, '4'));
  await click(btn('확인하기', 1));
  expect(text()).toContain(copy);
  expect(text()).not.toContain('SERVER TEXT');
  expect(root.container.queryAll((n) => n.props.accessibilityRole === 'alert' && textOf(n) === copy)).not.toHaveLength(0);
  expect(radio(1, '4').props.accessibilityState.checked).toBe(true);
});

test('카드를 불러오지 못하면 안내와 다시 시도가 뜨고, 다시 시도하면 카드가 나온다', async () => {
  today.mockReset().mockRejectedValueOnce(new EngineError(0)).mockResolvedValueOnce({ cards: CARDS });
  const { btn, text } = await setup();
  expect(text()).toContain('지금은 카드를 불러오지 못했어요. 잠시 뒤 다시 해 주세요.');
  await click(btn('다시 시도'));
  expect(today).toHaveBeenCalledTimes(2);
  expect(text()).toContain('역할극');
});
