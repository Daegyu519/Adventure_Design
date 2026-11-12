import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot } from 'test-renderer';

import { ScaleRow } from '../components/ScaleRow';
import tokens from '../lib/tokens.json';

jest.mock('lucide-react-native/icons/check', () => () => null);

async function setup(value: number | null) {
  const onChange = jest.fn();
  const root = createRoot();
  await act(async () => {
    root.render(<ScaleRow value={value} onChange={onChange} lowLabel="전혀" highLabel="매우" accessibilityLabel="얼마나 차갑게" />);
  });
  return { onChange, radios: () => root.container.queryAll((n) => n.props.accessibilityRole === 'radio') };
}

test('ScaleRow: 1~5 radio 다섯 개, 각 44 이상, 고른 칸만 checked', async () => {
  const { radios } = await setup(3);
  expect(radios().map((r) => r.props.accessibilityLabel)).toEqual(['1, 전혀', '2', '3', '4', '5, 매우']);
  const styles = radios().map((r) => StyleSheet.flatten(typeof r.props.style === 'function' ? r.props.style({ pressed: false }) : r.props.style));
  expect(styles.every((s) => s.minHeight >= 44 && s.minWidth >= 44)).toBe(true);
  expect(radios().map((r) => r.props.accessibilityState.checked)).toEqual([false, false, true, false, false]);
});

test('ScaleRow: 누르기와 Space 키로 고르고, disabled면 무시한다', async () => {
  const { onChange, radios } = await setup(null);
  await act(async () => radios()[3].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(onChange).toHaveBeenLastCalledWith(4);
  const preventDefault = jest.fn();
  await act(async () => radios()[0].props.onKeyDown({ key: ' ', preventDefault }));
  expect(onChange).toHaveBeenLastCalledWith(1);
  expect(preventDefault).toHaveBeenCalled();
});

test('ScaleRow: 고른 칸은 색 말고도 커지고 종이색(primary)으로 뒤집힌다(1.4.1), 칸마다 말이 붙는다', async () => {
  const onChange = jest.fn();
  const root = createRoot();
  await act(async () => {
    root.render(<ScaleRow value={3} onChange={onChange} lowLabel="전혀" highLabel="매우" accessibilityLabel="q" words={['a칸', 'b칸', '살짝 서늘해요', 'd칸', 'e칸']} />);
  });
  const radios = root.container.queryAll((n) => n.props.accessibilityRole === 'radio');
  expect(radios[2].props.accessibilityLabel).toBe('3, 살짝 서늘해요');
  const dot = (r: (typeof radios)[number]) => StyleSheet.flatten(r.queryAll((n) => StyleSheet.flatten(n.props.style)?.borderRadius === 13)[0].props.style);
  expect(dot(radios[2]).backgroundColor).toBe(tokens.light.primary);
  expect(dot(radios[2]).transform).toEqual([{ scale: 1.35 }]);
  expect(dot(radios[0]).backgroundColor).toBe(tokens.light.surface);
  const shown = root.container.queryAll((n) => typeof n.props.children === 'string' && n.props.children === '살짝 서늘해요');
  expect(shown.length).toBeGreaterThan(0); // 고른 칸 위 알약
});
