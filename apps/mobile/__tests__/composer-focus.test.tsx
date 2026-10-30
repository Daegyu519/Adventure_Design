import { act } from 'react';
import { createRoot } from 'test-renderer';

import { Platform } from 'react-native';

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

describe('멘션 콤보박스(웹)', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));
  afterEach(() => jest.restoreAllMocks());
  const cands = [{ user_id: 'u2', name: '민수' }, { user_id: 'u3', name: '민아' }];
  const key = (k: string, extra = {}) => ({ nativeEvent: { key: k, ...extra }, preventDefault: jest.fn() });
  async function setup(over = {}) {
    const onSend = jest.fn();
    const onSelectMention = jest.fn();
    const root = createRoot();
    const render = (props = {}) =>
      act(async () => {
        root.render(<Composer value="@민" onChangeText={() => {}} onSend={onSend} replyTo={null} onCancelReply={() => {}} mentionCandidates={cands} onSelectMention={onSelectMention} {...over} {...props} />);
      });
    await render();
    const input = () => root.container.queryAll((n) => String(n.props.accessibilityLabel).startsWith('메시지 입력'))[0];
    return { root, input, onSend, onSelectMention, render };
  }

  test('입력창은 combobox, 목록은 listbox, 후보는 option이고 활성 후보를 aria-activedescendant가 가리킨다', async () => {
    const { root, input } = await setup();
    const p = input().props;
    expect(p.role).toBe('combobox');
    expect(p['aria-expanded']).toBe(true);
    expect(p['aria-autocomplete']).toBe('list');
    const list = root.container.queryAll((n) => n.props.role === 'listbox')[0];
    expect(p['aria-controls']).toBe(list.props.nativeID);
    const opts = root.container.queryAll((n) => n.props.role === 'option');
    expect(opts).toHaveLength(2);
    expect(p['aria-activedescendant']).toBe(opts[0].props.nativeID);
    expect(opts.map((o) => o.props.accessibilityState?.selected)).toEqual([true, false]);
  });

  test('목록이 없으면 expanded=false, activedescendant 없음', async () => {
    const { input } = await setup({ mentionCandidates: null });
    expect(input().props['aria-expanded']).toBe(false);
    expect(input().props['aria-activedescendant']).toBeUndefined();
  });

  test('↓↑로 활성 후보를 옮긴다(끝에서 돌아감)', async () => {
    const { root, input } = await setup();
    const id = () => input().props['aria-activedescendant'];
    const first = id();
    const e = key('ArrowDown');
    await act(async () => input().props.onKeyPress(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(id()).not.toBe(first);
    await act(async () => input().props.onKeyPress(key('ArrowDown')));
    expect(id()).toBe(first);
    await act(async () => input().props.onKeyPress(key('ArrowUp')));
    expect(id()).not.toBe(first);
    expect(root.container.queryAll((n) => n.props.role === 'option' && n.props.accessibilityState?.selected === true)).toHaveLength(1);
  });

  test('Enter는 보내지 않고 활성 후보를 고른다', async () => {
    const { input, onSend, onSelectMention } = await setup();
    await act(async () => input().props.onKeyPress(key('ArrowDown')));
    const e = key('Enter');
    await act(async () => input().props.onKeyPress(e));
    expect(onSelectMention).toHaveBeenCalledWith('민아');
    expect(onSend).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  test('Tab도 고르고(기본 동작 막음), 한글 조합 중 Enter는 아무것도 하지 않는다', async () => {
    const { input, onSelectMention, onSend } = await setup();
    const t = key('Tab');
    await act(async () => input().props.onKeyPress(t));
    expect(onSelectMention).toHaveBeenCalledWith('민수');
    expect(t.preventDefault).toHaveBeenCalled();
    onSelectMention.mockClear();
    await act(async () => input().props.onKeyPress(key('Enter', { isComposing: true })));
    expect(onSelectMention).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  test('Esc는 목록만 닫고 보내지 않는다. 포커스는 입력창에 그대로', async () => {
    const { root, input, onSend } = await setup();
    const e = key('Escape');
    await act(async () => input().props.onKeyPress(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(root.container.queryAll((n) => n.props.role === 'option')).toHaveLength(0);
    expect(input().props['aria-expanded']).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  test('Esc로 닫은 뒤 글이 바뀌었다가 같은 글이 되면 다시 열린다', async () => {
    const { root, input, render } = await setup();
    await act(async () => input().props.onKeyPress(key('Escape')));
    await render({ value: '' });
    await render({ value: '@민' });
    expect(root.container.queryAll((n) => n.props.role === 'option')).toHaveLength(2);
  });

  test('목록이 닫혀 있으면 Enter는 보낸다, Tab은 건드리지 않는다', async () => {
    const { input, onSend } = await setup({ mentionCandidates: null });
    const t = key('Tab');
    await act(async () => input().props.onKeyPress(t));
    expect(t.preventDefault).not.toHaveBeenCalled();
    await act(async () => input().props.onKeyPress(key('Enter', { keyCode: 13 })));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('후보 수는 열릴 때와 수가 바뀔 때만 polite로 알리고, 후보는 4명까지만 보인다', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ user_id: n, name: `민${n}` }));
    const { root, render } = await setup({ mentionCandidates: many });
    const say = () => root.container.queryAll((n) => n.props['data-testid'] === 'mention-say')[0];
    expect(root.container.queryAll((n) => n.props.role === 'option')).toHaveLength(4);
    const text = (n: unknown): string => JSON.stringify(n);
    expect(text(say())).toContain('멘션 후보 4명, 위아래 화살표로 고르세요');
    await render({ value: '@민a', mentionCandidates: many });
    expect(text(say())).toContain('멘션 후보 4명');
    await render({ value: '@민a', mentionCandidates: many.slice(0, 2) });
    expect(text(say())).toContain('멘션 후보 2명');
  });
});

describe('입력 중 안내(iOS)', () => {
  test('iOS에서는 새 입력 중 문구가 생길 때 announceForAccessibility로 한 번 읽는다', async () => {
    const { AccessibilityInfo } = require('react-native');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    jest.replaceProperty(Platform, 'OS', 'ios');
    try {
      const root = createRoot();
      const render = (l: string | null) => act(async () => void root.render(<Composer value="" onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} typingLabel={l} />));
      await render(null);
      await render('민수님이 입력 중');
      await render('민수님이 입력 중');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('민수님이 입력 중');
    } finally {
      jest.restoreAllMocks();
    }
  });
});
