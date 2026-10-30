import { act } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
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
  await click(radio(0, '5, 매우'));
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

// ---- fix round 1 ----
const focused: Record<string, unknown>[] = [];
beforeAll(() => {
  jest.replaceProperty(Platform, 'OS', 'web'); // FocusBox는 웹에서 ref.focus()를 부른다
  (View as unknown as { prototype: { focus: unknown } }).prototype.focus = function (this: { props: Record<string, unknown> }) {
    focused.push(this.props);
  };
});
beforeEach(() => (focused.length = 0));

async function finishAll(h: Awaited<ReturnType<typeof setup>>) {
  const input = h.root.container.queryAll((n) => n.props.accessibilityLabel === '답장' && n.props.onChangeText)[0];
  await act(async () => input.props.onChangeText('네'));
  await click(h.btn('보내기'));
  await click(h.btn('그대로'));
  await click(h.radio(0, '3'));
  await click(h.btn('확인하기'));
  await click(h.radio(0, '3'));
}

test('a11y-1: 마지막 카드를 끝내도 포커스·알림은 그 카드 결과에 남고, 마무리 문구는 포커스도 alert도 아니다', async () => {
  answer.mockResolvedValue({ readings: READINGS, gap: 1, inner_voice: '괜찮아요', options: [] });
  const h = await setup();
  await finishAll(h);
  const before = focused.length;
  await click(h.btn('확인하기')); // 세 번째 카드
  expect(focused.length - before).toBe(1); // 결과 상자 하나만 포커스를 받는다
  const finish = h.root.container.queryAll((n) => typeof n.props.children === 'string' && n.props.children.includes('오늘 카드는 여기까지예요'));
  expect(finish.length).toBeGreaterThan(0);
  expect(h.root.container.queryAll((n) => n.props.accessibilityRole === 'alert' && textOf(n).includes('오늘 카드는 여기까지예요'))).toHaveLength(0);
  expect(h.root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite' && textOf(n).includes('오늘 카드는 여기까지예요'))).not.toHaveLength(0);
  expect(h.root.container.queryAll((n) => n.props.accessibilityRole === 'alert' && textOf(n).includes('예측과 한 칸 차이'))).not.toHaveLength(0);
});

test('a11y-2: 다시 시도를 누르는 동안에도 실패 안내와 버튼이 그대로 남고, 카드가 나오면 포커스가 카드 묶음으로 간다', async () => {
  let release!: (v: unknown) => void;
  today.mockReset().mockRejectedValueOnce(new EngineError(0)).mockReturnValueOnce(new Promise((r) => (release = r)));
  const { btn, text, byLabel } = await setup();
  const first = btn('다시 시도');
  await click(first);
  expect(text()).toContain('지금은 카드를 불러오지 못했어요');
  expect(byLabel('다시 시도').filter((n) => n.props.accessibilityRole === 'button')).toHaveLength(1);
  expect(btn('다시 시도').props.accessibilityState.busy).toBe(true);
  focused.length = 0;
  await act(async () => release({ cards: CARDS }));
  expect(text()).toContain('역할극');
  expect(focused.some((p) => p.accessibilityLabel === '오늘의 카드')).toBe(true);
});

test('a11y-M7: 처음 불러오는 동안 스피너는 polite로 알리고, 실패 블록 바깥에는 live region이 없다', async () => {
  today.mockReset().mockReturnValue(new Promise(() => {}));
  const { root } = await setup();
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === '불러오는 중' && n.props.accessibilityLiveRegion === 'polite')).not.toHaveLength(0);
  today.mockReset().mockRejectedValue(new EngineError(0));
  const failed = await setup();
  expect(failed.root.container.queryAll((n) => n.props.accessibilityLiveRegion != null && textOf(n).includes('카드를 불러오지 못했어요') && n.props.accessibilityRole !== 'alert')).toHaveLength(0);
});

test('a11y-6: 역할극 결과 상자는 이름 있는 group이라 포커스가 오면 "역할극 결과"를 읽는다', async () => {
  answer.mockResolvedValue({ readings: READINGS, inner_voice: '서운할 수도 있어요', options: [] });
  const { root, btn } = await setup();
  const input = root.container.queryAll((n) => n.props.accessibilityLabel === '답장' && n.props.onChangeText)[0];
  await act(async () => input.props.onChangeText('네'));
  focused.length = 0;
  await click(btn('보내기'));
  expect(focused.map((p) => p.accessibilityLabel)).toContain('역할극 결과');
  expect(root.container.queryAll((n) => n.props.role === 'group' && n.props.accessibilityLabel === '역할극 결과')).not.toHaveLength(0);
});

test('a11y-M4: 진행 문구는 "오늘 카드 N장 중 M장 풀었어요"로 읽힌다', async () => {
  const { root } = await setup();
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === '오늘 카드 3장 중 0장 풀었어요')).not.toHaveLength(0);
});

test('a11y-M6: 비활성 보내기·확인하기 아래에 왜 못 누르는지 글로 보인다', async () => {
  const { text } = await setup();
  expect(text()).toContain('답장을 먼저 적어 주세요');
  expect(text()).toContain('칸을 먼저 고르세요');
});

test('code-M2: 422(카드가 바뀜)이면 안내와 "카드 새로 받기"가 뜨고, 누르면 카드를 다시 받는다. 429에는 이 버튼이 없다', async () => {
  answer.mockRejectedValueOnce(new EngineError(429)).mockRejectedValueOnce(new EngineError(422, 'bad_card'));
  const { radio, btn, text, byLabel } = await setup();
  await click(radio(1, '4'));
  await click(btn('확인하기', 1));
  expect(byLabel('카드 새로 받기')).toHaveLength(0);
  await click(btn('확인하기', 1));
  expect(text()).toContain('카드가 바뀌었을 수도 있어요. 새로 받아 주세요.');
  expect(today).toHaveBeenCalledTimes(1);
  await click(btn('카드 새로 받기'));
  expect(today).toHaveBeenCalledTimes(2);
  expect(byLabel('카드 새로 받기')).toHaveLength(0); // 새 카드로 바뀌어 폼이 새로 열렸다
});
