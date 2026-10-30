import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot } from 'test-renderer';

import { ScaleRow } from '../components/ScaleRow';
import tokens from '../lib/tokens.json';

async function setup(value: number | null) {
  const onChange = jest.fn();
  const root = createRoot();
  await act(async () => {
    root.render(<ScaleRow value={value} onChange={onChange} lowLabel="전혀" highLabel="매우" accessibilityLabel="얼마나 차갑게" />);
  });
  return { onChange, radios: () => root.container.queryAll((n) => n.props.accessibilityRole === 'radio') };
}

test('ScaleRow: 1~5 radio 다섯 개, 각 44 이상, 고른 칸만 mirror 바탕', async () => {
  const { radios } = await setup(3);
  expect(radios().map((r) => r.props.accessibilityLabel)).toEqual(['1', '2', '3', '4', '5']);
  const styles = radios().map((r) => StyleSheet.flatten(typeof r.props.style === 'function' ? r.props.style({ pressed: false }) : r.props.style));
  expect(styles.every((s) => s.minHeight >= 44 && s.minWidth >= 44)).toBe(true);
  expect(styles.map((s) => s.backgroundColor === tokens.light.mirror)).toEqual([false, false, true, false, false]);
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
