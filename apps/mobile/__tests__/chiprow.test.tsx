import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot } from 'test-renderer';

import { ChipRow } from '../components/ChipRow';
import tokens from '../lib/tokens.json';

jest.mock('lucide-react-native/icons/check', () => () => null); // jest가 lucide의 ESM 파일을 읽지 못해서 가짜로 바꾼다

const OPTIONS = ['친구', '팀원', '기타'] as const;
type Opt = (typeof OPTIONS)[number];

async function setup(p: { value: Opt | null; allowNone?: boolean; labels?: Partial<Record<Opt, string>> }) {
  const onChange = jest.fn();
  const root = createRoot();
  await act(async () => {
    root.render(<ChipRow options={OPTIONS} onChange={onChange} accessibilityLabel="관계" {...p} />);
  });
  const chips = () => root.container.queryAll((n) => n.props.accessibilityRole === 'radio');
  const press = (i: number) => act(async () => chips()[i].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { onChange, chips, press, root };
}

test('ChipRow: 칩마다 radio 역할과 checked 상태, 묶음에는 라벨', async () => {
  const { chips, root } = await setup({ value: '팀원' });
  expect(chips().map((c) => c.props.accessibilityLabel)).toEqual(['친구', '팀원', '기타']);
  expect(chips().map((c) => c.props.accessibilityState.checked)).toEqual([false, true, false]);
  expect(root.container.queryAll((n) => n.props.accessibilityRole === 'radiogroup' && n.props.accessibilityLabel === '관계')).toHaveLength(1);
});

test('ChipRow: 높이 44, 알약 모서리, 선택한 칩만 primary 바탕', async () => {
  const { chips } = await setup({ value: '친구' });
  const styles = chips().map((c) => StyleSheet.flatten(typeof c.props.style === 'function' ? c.props.style({ pressed: false }) : c.props.style));
  for (const s of styles) {
    expect(s.minHeight).toBe(44);
    expect(s.borderRadius).toBe(tokens.radius.chip);
  }
  expect(styles.map((s) => s.backgroundColor === tokens.light.primary)).toEqual([true, false, false]);
});

test('ChipRow: 누르면 그 값으로 바꾼다. 고른 칩을 다시 눌러도 기본은 그대로', async () => {
  const { onChange, press } = await setup({ value: '친구' });
  await press(1);
  expect(onChange).toHaveBeenLastCalledWith('팀원');
  await press(0);
  expect(onChange).toHaveBeenLastCalledWith('친구');
});

test('ChipRow: allowNone이면 고른 칩을 다시 눌렀을 때 null', async () => {
  const { onChange, press } = await setup({ value: '친구', allowNone: true });
  await press(0);
  expect(onChange).toHaveBeenLastCalledWith(null);
  await press(2);
  expect(onChange).toHaveBeenLastCalledWith('기타');
});

test('ChipRow: labels로 보이는 글과 스크린리더 라벨을 바꾸고, 값은 그대로 넘긴다', async () => {
  const { chips, onChange, press } = await setup({ value: null, labels: { 팀원: '팀 동료' } });
  expect(chips().map((c) => c.props.accessibilityLabel)).toEqual(['친구', '팀 동료', '기타']);
  expect(chips().map((c) => c.props.accessibilityState.checked)).toEqual([false, false, false]);
  await press(1);
  expect(onChange).toHaveBeenLastCalledWith('팀원');
});

test('ChipRow: Space 키로 고른다(웹 radio는 기본으로 안 됨), 다른 키는 무시, allowNone이면 다시 눌러 해제', async () => {
  const { chips, onChange } = await setup({ value: '팀원', allowNone: true });
  const preventDefault = jest.fn();
  await act(async () => chips()[0].props.onKeyDown({ key: ' ', preventDefault }));
  expect(onChange).toHaveBeenLastCalledWith('친구');
  expect(preventDefault).toHaveBeenCalledTimes(1); // 페이지가 스크롤되지 않게
  await act(async () => chips()[1].props.onKeyDown({ key: ' ', preventDefault }));
  expect(onChange).toHaveBeenLastCalledWith(null);
  onChange.mockClear();
  await act(async () => chips()[0].props.onKeyDown({ key: 'a', preventDefault }));
  expect(onChange).not.toHaveBeenCalled();
});

// Space를 누르고 있으면 keydown이 반복된다: 살펴보기 의도 칩에서 모델 요청이 줄줄이 나가지 않게 반복은 무시(T-08).
test('ChipRow: 눌러 둔 Space의 반복 keydown은 무시한다', async () => {
  const { chips, onChange } = await setup({ value: null });
  await act(async () => chips()[0].props.onKeyDown({ key: ' ', repeat: true, preventDefault() {} }));
  expect(onChange).not.toHaveBeenCalled();
});
