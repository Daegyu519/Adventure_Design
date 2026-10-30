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
