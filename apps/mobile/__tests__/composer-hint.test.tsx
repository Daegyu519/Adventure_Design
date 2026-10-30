import { act } from 'react';
import { createRoot } from 'test-renderer';

import { Composer } from '../components/Composer';

jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/x', () => () => null);
jest.mock('lucide-react-native/icons/image-plus', () => () => null);
jest.mock('../lib/motion', () => ({ MOTION_MS: 200, useReducedMotion: () => true }));

const A = { title: '차갑게 느껴질 수도 있어요', detail: '' };
const B = { title: '조금 딱딱해요', detail: '' };

test('hint is announced once per title, not per re-render; dismiss keeps focus on the input', async () => {
  const say = jest.fn();
  const onDismissHint = jest.fn();
  const focus = jest.fn();
  const ref = { current: null as null | { focus(): void } };
  const root = createRoot();
  const render = (hint: typeof A | null, value = 'a') =>
    act(async () => void root.render(<Composer value={value} onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} say={say} hint={hint} onDismissHint={onDismissHint} inputRef={ref as never} />));
  await render(A);
  ref.current!.focus = focus;
  await render(A, 'ab');
  await render(A, 'abc');
  expect(say.mock.calls.filter(([t]) => t.includes('힌트'))).toEqual([[`힌트: ${A.title}`]]);
  await render(B);
  expect(say).toHaveBeenLastCalledWith(`힌트: ${B.title}`);
  const close = root.container.queryAll((n) => n.props.accessibilityLabel === '힌트 닫기' && n.props.accessibilityRole === 'button')[0];
  await act(async () => close.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(onDismissHint).toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  await render(null);
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === '힌트 닫기')).toHaveLength(0);
});
