import { act } from 'react';
import { createRoot } from 'test-renderer';

import { Composer } from '../components/Composer';

jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/x', () => () => null);

// 같은 사람의 다른 메시지로 답장 대상을 바꿔도(hasReply는 계속 true) 입력창으로 포커스가 다시 간다.
test('답장 대상이 바뀔 때마다 입력창에 포커스(대상 id 기준)', async () => {
  jest.useFakeTimers();
  try {
    const focus = jest.fn();
    const ref = { current: null as null | { focus(): void } };
    const root = createRoot();
    const render = (id: number) =>
      act(async () => {
        root.render(<Composer value="" onChangeText={() => {}} onSend={() => {}} replyTo={{ id, name: '민수', text: 'a' }} onCancelReply={() => {}} inputRef={ref as never} />);
      });
    await render(1);
    ref.current!.focus = focus;
    await act(async () => void jest.advanceTimersByTime(100));
    await render(2);
    await act(async () => void jest.advanceTimersByTime(100));
    expect(focus).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

jest.mock('lucide-react-native/icons/image-plus', () => () => null);

test('멘션 후보를 고르면 목록이 사라져도 포커스가 입력창으로 간다', async () => {
  const focus = jest.fn();
  const onSelectMention = jest.fn();
  const ref = { current: null as null | { focus(): void } };
  const root = createRoot();
  await act(async () => {
    root.render(<Composer value="@민" onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} inputRef={ref as never} mentionCandidates={[{ user_id: 'u2', name: '민수' }]} onSelectMention={onSelectMention} />);
  });
  ref.current!.focus = focus;
  const row = root.container.queryAll((n) => n.props.accessibilityLabel === '민수 언급')[0];
  await act(async () => row.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(onSelectMention).toHaveBeenCalledWith('민수');
  expect(focus).toHaveBeenCalled();
});
