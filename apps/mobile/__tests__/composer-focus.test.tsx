import { act } from 'react';
import { createRoot } from 'test-renderer';

import { Platform } from 'react-native';

import { Composer } from '../components/Composer';

jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/arrow-up', () => () => null);
jest.mock('lucide-react-native/icons/plus', () => () => null);
jest.mock('lucide-react-native/icons/image', () => () => null);
jest.mock('lucide-react-native/icons/paperclip', () => () => null);
jest.mock('lucide-react-native/icons/file-text', () => () => null);
jest.mock('lucide-react-native/icons/chevron-left', () => () => null);
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

// P-45: 보내기를 눌러도, 전송 확인 중에도 키보드가 내려가지 않게.
test('보내기를 누르면 그 자리에서 입력창에 포커스를 주고 보낸다', async () => {
  const order: string[] = [];
  const ref = { current: null as null | { focus(): void } };
  const root = createRoot();
  await act(async () => {
    root.render(<Composer value="안녕" onChangeText={() => {}} onSend={() => order.push('send')} replyTo={null} onCancelReply={() => {}} inputRef={ref as never} />);
  });
  ref.current!.focus = () => order.push('focus');
  const button = root.container.queryAll((n) => n.props.accessibilityLabel === '보내기')[0];
  await act(async () => button.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(order).toEqual(['focus', 'send']);
});

test('전송 확인 중에도 입력창은 읽기 전용이 아니고, 바뀐 글만 받지 않는다', async () => {
  const onChangeText = jest.fn();
  const root = createRoot();
  const render = (locked: boolean) =>
    act(async () => {
      root.render(<Composer value="안녕" onChangeText={onChangeText} onSend={() => {}} replyTo={null} onCancelReply={() => {}} inputLocked={locked} />);
    });
  const input = () => root.container.queryAll((n) => String(n.props.accessibilityLabel).startsWith('메시지 입력'))[0];
  await render(true);
  expect(input().props.editable).not.toBe(false);
  expect(input().props.readOnly).toBeUndefined();
  expect(input().props['aria-readonly']).toBe(true);
  await act(async () => input().props.onChangeText('안녕하'));
  expect(onChangeText).not.toHaveBeenCalled();
  await render(false);
  expect(input().props['aria-readonly']).toBeUndefined();
  await act(async () => input().props.onChangeText('안녕하'));
  expect(onChangeText).toHaveBeenCalledWith('안녕하');
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

  test('후보 수는 열릴 때와 수가 바뀔 때만 say로 알리고(글자마다 아님), 후보는 4명까지만 보인다', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ user_id: n, name: `민${n}` }));
    const say = jest.fn();
    const { root, render } = await setup({ mentionCandidates: many, say });
    expect(root.container.queryAll((n) => n.props.role === 'option')).toHaveLength(4);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenLastCalledWith('멘션 후보 4명, 위아래 화살표로 고르세요');
    await render({ value: '@민a', mentionCandidates: many, say });
    expect(say).toHaveBeenCalledTimes(1);
    await render({ value: '@민a', mentionCandidates: many.slice(0, 2), say });
    expect(say).toHaveBeenLastCalledWith('멘션 후보 2명, 위아래 화살표로 고르세요');
    await render({ value: '@민a', mentionCandidates: null, say });
    expect(say).toHaveBeenCalledTimes(2);
  });

  test('aria-controls는 목록이 그려져 있을 때만', async () => {
    const { input, render } = await setup();
    expect(input().props['aria-controls']).toBeTruthy();
    await render({ mentionCandidates: null });
    expect(input().props['aria-controls']).toBeUndefined();
  });
});

describe('멘션 목록(네이티브)', () => {
  test('role·aria·nativeID는 웹에서만, 네이티브 행은 accessibilityRole=button 그대로', async () => {
    const root = createRoot();
    await act(async () => {
      root.render(<Composer value="@민" onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} mentionCandidates={[{ user_id: 'u2', name: '민수' }]} onSelectMention={() => {}} />);
    });
    const row = root.container.queryAll((n) => n.props.accessibilityLabel === '민수 언급')[0];
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.role).toBeUndefined();
    expect(root.container.queryAll((n) => n.props.role === 'listbox')).toHaveLength(0);
    const input = root.container.queryAll((n) => String(n.props.accessibilityLabel).startsWith('메시지 입력'))[0];
    expect(input.props.role).toBeUndefined();
  });
});

describe('입력 중 안내', () => {
  test.each(['ios', 'android', 'web'] as const)('%s: 새 입력 중 문구가 생길 때 say로 한 번(같은 문구로 다시 그려도 반복 없음)', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    const say = jest.fn();
    const root = createRoot();
    const render = (l: string | null) => act(async () => void root.render(<Composer value="" onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} typingLabel={l} say={say} />));
    await render(null);
    await render('민수님이 입력 중');
    await render('민수님이 입력 중');
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('민수님이 입력 중');
    jest.restoreAllMocks();
  });

  test('입력 중 문구는 눈에 보이게 그려지고 따로 live 영역은 없다(안내는 say 하나)', async () => {
    const root = createRoot();
    await act(async () => void root.render(<Composer value="" onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} typingLabel="민수님이 입력 중" say={() => {}} />));
    expect(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')).toHaveLength(0);
  });
});

// 활성 후보를 색(바탕 bubbleOther, 대비 약 1.03:1)만으로 알리지 않는다: 왼쪽 막대(primary)와 굵은 글자도 같이(AI-3).
test('멘션 후보: 활성 줄은 색 말고도 왼쪽 막대와 굵은 글자로 보이고, 다른 줄은 같은 자리에 투명 막대(밀리지 않음)', async () => {
  const { MentionPicker } = jest.requireActual<typeof import('../components/MentionPicker')>('../components/MentionPicker');
  const tokens = jest.requireActual('../lib/tokens.json');
  const root = createRoot();
  await act(async () => root.render(<MentionPicker candidates={[{ user_id: 'u2', name: '민수' }, { user_id: 'u3', name: '지은' }]} active={1} onSelect={() => {}} />));
  const rows = root.container.queryAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.endsWith(' 언급') && typeof n.props.onClick === 'function');
  const style = (i: number) => Object.assign({}, ...[rows[i].props.style].flat(Infinity));
  expect(style(1)).toMatchObject({ borderLeftWidth: 3, borderLeftColor: tokens.light.primary });
  expect(style(0)).toMatchObject({ borderLeftWidth: 3, borderLeftColor: 'transparent' });
  const weight = (i: number) => Object.assign({}, ...[rows[i].queryAll((n) => n.props.style !== undefined && String(n.props.children).startsWith('@'))[0].props.style].flat(Infinity)).fontWeight;
  expect(weight(1)).toBe('600');
  expect(weight(0)).not.toBe('600');
});

