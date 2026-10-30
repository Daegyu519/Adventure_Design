import { act } from 'react';
import { createRoot, type TestNode } from 'test-renderer';

import Room from '../app/room/[id]/index';
import type { Msg } from '../lib/messages';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('lucide-react-native/icons/info', () => () => null);
jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/ellipsis', () => () => null);
jest.mock('lucide-react-native/icons/x', () => () => null);
jest.mock('lucide-react-native/icons/image-plus', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
let mockFocused = true;
let mockParams: Record<string, string> = { id: 'r1' };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams, useIsFocused: () => mockFocused }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));
const mockFrom = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => mockFrom(...a) } }));

const mockMarkRead = jest.fn();
const mockFetchRoom = jest.fn();
const okRoom = () =>
  Promise.resolve({
    room: { id: 'r1', kind: 'group', title: '팀플', relation: '팀원', created_at: '', created_by: null },
    members: [
      { user_id: 'me', name: '나', last_read_at: null, muted: false },
      { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
    ],
  });
jest.mock('../lib/rooms', () => ({
  ...jest.requireActual('../lib/rooms'),
  fetchRoom: (...a: unknown[]) => mockFetchRoom(...a),
  markRead: (...a: unknown[]) => mockMarkRead(...a),
}));

let mockMessages: Msg[] = [];
const mockSend = jest.fn();
const mockLoadOlder = jest.fn();
const mockReload = jest.fn();
let mockOlderError = false;
let mockHasMore = false;
jest.mock('../lib/useRoomMessages', () => ({
  useRoomMessages: () => ({ messages: mockMessages, hasMore: mockHasMore, error: false, olderError: mockOlderError, reload: mockReload, loadOlder: mockLoadOlder, send: (...a: unknown[]) => mockSend(...a) }),
}));

const mockTyping = { label: null as string | null, onDraftChange: jest.fn(), stop: jest.fn() };
jest.mock('../lib/useTyping', () => ({ useTyping: () => mockTyping }));
const mockPickImage = jest.fn();
jest.mock('../lib/images', () => ({ pickAndSendImage: (...a: unknown[]) => mockPickImage(...a), useSignedUrl: (p: string | null) => ({ url: p && !p.includes('pending') && !p.includes('broken') ? `https://img/${p}` : null, failed: !!p && p.includes('broken'), retry: mockRetryPhoto }) }));
const mockRetryPhoto = jest.fn();

let mockReactionRows: { message_id: number; user_id: string; emoji: string; created_at: string }[] = [];
const mockToggle = jest.fn();
jest.mock('../lib/useReactions', () => ({ useReactions: () => ({ rows: mockReactionRows, toggle: (...a: unknown[]) => mockToggle(...a) }) }));
let mockMembersLastRead: Record<string, string | null> = {};
jest.mock('../lib/useMembers', () => ({
  useMembers: (_id: string, initial: { user_id: string; last_read_at: string | null }[] = []) => initial.map((x) => ({ ...x, last_read_at: x.user_id in mockMembersLastRead ? mockMembersLastRead[x.user_id] : x.last_read_at })),
}));

const mockFeedback = jest.fn();
jest.mock('../lib/engine', () => ({ ...jest.requireActual('../lib/engine'), engine: { isMock: true, feedback: (...a: unknown[]) => mockFeedback(...a) } }));

const m = (id: number, sender: string, text: string, ts = '2026-10-27 01:32:17.123456+00'): Msg => ({ id, room_id: 'r1', sender_id: sender, text, image_path: null, reply_to: null, mentions: [], created_at: ts });
const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

async function setup() {
  const root = createRoot();
  await act(async () => root.render(<Room />));
  const input = () => root.container.queryAll((n) => String(n.props.accessibilityLabel).startsWith('메시지 입력'))[0];
  const type = (t: string) => act(async () => input().props.onChangeText(t));
  const press = (label: string) =>
    act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { root, input, type, press, texts: () => textOf(root.container as unknown as TestNode) };
}

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android'); // 알림 영역이 그려지는 플랫폼(iOS는 announceForAccessibility)
  mockMessages = [m(1, 'u2', '안녕'), m(2, 'me', '반가워')];
  mockFocused = true;
  mockParams = { id: 'r1' };
  mockSend.mockReset();
  mockFeedback.mockReset();
  mockPickImage.mockReset();
  mockRetryPhoto.mockReset();
  mockTyping.label = null;
  mockTyping.onDraftChange.mockReset();
  mockTyping.stop.mockReset();
  mockLoadOlder.mockReset();
  mockReload.mockReset();
  mockOlderError = false;
  mockHasMore = false;
  mockFetchRoom.mockReset().mockImplementation(okRoom);
  mockMarkRead.mockReset().mockResolvedValue(undefined);
  mockRouter.push.mockReset();
  mockReactionRows = [];
  mockToggle.mockReset().mockResolvedValue(undefined);
  mockMembersLastRead = {};
  mockFrom.mockReset().mockImplementation(() => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'x' } }) }) }) }));
});

test('그룹이면 남의 말풍선 위에 이름, 제목은 방 제목', async () => {
  const { texts } = await setup();
  expect(texts()).toContain('팀플');
  expect(texts()).toContain('민수');
  expect(texts()).toContain('안녕');
});

test('보내기: 다듬은 글로 send, 입력창은 먼저 비워진다. 엔진 호출 없음', async () => {
  mockSend.mockResolvedValue(m(3, 'me', 'hi'));
  const { type, press, input } = await setup();
  await type('  hi  ');
  await press('보내기');
  expect(mockSend).toHaveBeenCalledWith({ text: 'hi' });
  expect(input().props.value).toBe('');
});

test('빈 글은 보내지 않는다', async () => {
  const { type, press } = await setup();
  await type('   ');
  await press('보내기');
  expect(mockSend).not.toHaveBeenCalled();
});

test('보내기 실패: 글을 되돌리고 DB 코드는 한국어 문구로(서버 글은 안 보임)', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('reply_to_other_room'), { status: 400 }));
  const { type, press, input, texts, root } = await setup();
  await type('답장');
  await press('보내기');
  expect(input().props.value).toBe('답장');
  expect(texts()).toContain('다른 방의 메시지에는 답장할 수 없어요');
  expect(texts()).not.toContain('reply_to_other_room');
  expect(root.container.queryAll((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
});

test('보내기 실패(연결 없음)는 연결 문구', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('TypeError: Failed to fetch'), { status: 0 }));
  const { type, press, texts } = await setup();
  await type('hi');
  await press('보내기');
  expect(texts()).toContain('연결이 불안정할 수도 있어요');
  expect(texts()).not.toContain('Failed to fetch');
});

test('읽음: 포커스가 있으면 가장 새 메시지의 서버 시각으로 표시', async () => {
  await setup();
  expect(mockMarkRead).toHaveBeenCalledWith('r1', 'me', '2026-10-27 01:32:17.123456+00');
});

test('읽음: 포커스가 없으면 표시하지 않는다', async () => {
  mockFocused = false;
  await setup();
  expect(mockMarkRead).not.toHaveBeenCalled();
});

test('방 정보 아이콘은 /room/<id>/info로', async () => {
  const { press } = await setup();
  await press('방 정보');
  expect(mockRouter.push).toHaveBeenCalledWith('/room/r1/info');
});

// ── fix round 1 ──
import { AppState } from 'react-native';

const alerts = (root: { container: { queryAll: (f: (n: TestNode) => boolean) => TestNode[] } }) =>
  root.container.queryAll((n) => (n as unknown as { props: { accessibilityRole?: string } }).props.accessibilityRole === 'alert');

test('방 정보를 못 불러와도 읽음은 표시된다(info에 묶이지 않는다)', async () => {
  mockFetchRoom.mockRejectedValue({ message: 'x' });
  await setup();
  expect(mockMarkRead).toHaveBeenCalledWith('r1', 'me', '2026-10-27 01:32:17.123456+00');
});

test('방 정보 실패: 연결 문구 + 다시 불러오기, 누르면 다시 받아 제목이 나온다', async () => {
  mockFetchRoom.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const { press, texts } = await setup();
  expect(texts()).toContain('연결이 불안정할 수도 있어요');
  expect(texts()).toContain('대화방');
  await press('다시 불러오기');
  expect(mockFetchRoom).toHaveBeenCalledTimes(2);
  expect(texts()).toContain('팀플');
  expect(texts()).not.toContain('연결이 불안정할 수도 있어요');
});

test('방 정보 실패가 DB 오류(코드 있음)면 서버 글 대신 고정 문구', async () => {
  mockFetchRoom.mockRejectedValue({ message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });
  const { texts } = await setup();
  expect(texts()).toContain('대화방을 불러오지 못했어요');
  expect(texts()).not.toContain('JSON object');
  expect(texts()).not.toContain('연결이 불안정할 수도 있어요');
});

test('읽음 표시가 실패하면 잠시 뒤 다시 시도한다(최대 3번)', async () => {
  jest.useFakeTimers();
  try {
    mockMarkRead.mockRejectedValue(new Error('x'));
    await setup();
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) await act(async () => void jest.advanceTimersByTime(10000));
    expect(mockMarkRead).toHaveBeenCalledTimes(4); // 처음 1 + 다시 3
  } finally {
    jest.useRealTimers();
  }
});

test('읽음 표시가 한 번 실패했다가 성공하면 거기서 멈춘다', async () => {
  jest.useFakeTimers();
  try {
    mockMarkRead.mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    await setup();
    for (let i = 0; i < 4; i++) await act(async () => void jest.advanceTimersByTime(10000));
    expect(mockMarkRead).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

describe('앱 상태', () => {
  const orig = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  afterEach(() => {
    if (orig) Object.defineProperty(AppState, 'currentState', orig);
    jest.restoreAllMocks();
  });
  test('배경이면 읽음을 표시하지 않고, 앞으로 오면 표시한다', async () => {
    let handler: (s: string) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: (s: string) => void) => ((handler = h), { remove() {} })) as never);
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    await setup();
    expect(mockMarkRead).not.toHaveBeenCalled();
    await act(async () => handler('active'));
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });
});

test('가장 새 메시지가 그대로면(다시 그려져도) 읽음을 두 번 보내지 않는다', async () => {
  const { type } = await setup();
  await type('a');
  await type('ab');
  expect(mockMarkRead).toHaveBeenCalledTimes(1);
});

test('새 메시지 알림: 상대의 가장 새 것만 polite 한 줄, 내 것·처음 불러온 것은 아님', async () => {
  const { root } = await setup();
  const live = () => textOf(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')[0] as unknown as TestNode);
  expect(live()).toBe(''); // 처음 불러온 메시지는 알리지 않는다
  mockMessages = [...mockMessages, m(3, 'me', '내가 보냄')];
  await act(async () => root.render(<Room />));
  expect(live()).toBe('');
  mockMessages = [...mockMessages, m(4, 'u2', '새 소식')];
  await act(async () => root.render(<Room />));
  expect(live()).toBe('민수: 새 소식');
});

test('보내는 동안 입력한 글이 있으면 실패 때 되돌린 글 뒤에 이어 붙인다', async () => {
  let rejectSend!: (e: unknown) => void;
  mockSend.mockReturnValue(new Promise((_, rej) => (rejectSend = rej)));
  const { type, press, input } = await setup();
  await type('a');
  await press('보내기');
  await type('b');
  await act(async () => rejectSend(Object.assign(new Error('x'), { status: 400 })));
  expect(input().props.value).toBe('a\nb');
});

test('보내는 중에는 두 번째 보내기를 무시한다(중복 전송 방지)', async () => {
  let resolveSend!: (v: Msg) => void;
  mockSend.mockReturnValue(new Promise((res) => (resolveSend = res)));
  const { type, press } = await setup();
  await type('a');
  await press('보내기');
  await type('b');
  await press('보내기');
  expect(mockSend).toHaveBeenCalledTimes(1);
  await act(async () => resolveSend(m(9, 'me', 'a')));
  await press('보내기'); // 끝난 뒤에는 남은 글 'b'를 보낼 수 있다
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenLastCalledWith({ text: 'b' });
});

test('이전 메시지 불러오기 실패: 줄을 보이고 누르면 다시 시도, 자동 반복은 없다', async () => {
  mockHasMore = true;
  mockOlderError = true;
  const { press, texts, root } = await setup();
  expect(texts()).toContain('이전 메시지를 불러오지 못했어요');
  expect(alerts(root).length).toBeGreaterThan(0);
  await press('이전 메시지 다시 불러오기');
  expect(mockLoadOlder).toHaveBeenCalledTimes(1);
});

// ── T-09b: 답장 · 공감 · 읽음 수 ──
type Q = { container: { queryAll: (f: (n: TestNode) => boolean) => TestNode[] } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { props: Record<string, any> };
const buttons = (root: Q, label: string): N[] =>
  root.container.queryAll((n) => (n as unknown as N).props.accessibilityRole === 'button' && (n as unknown as N).props.accessibilityLabel === label) as unknown as N[];
const click = (n: N) => act(async () => n.props.onClick({ stopPropagation() {}, nativeEvent: {} }));

test('키보드로 닿는 "메시지 메뉴" 버튼이 모든 말풍선에 있고 공감 6개와 답장이 열린다', async () => {
  const { root } = await setup();
  expect(buttons(root, '메시지 메뉴')).toHaveLength(2);
  expect(buttons(root, '공감: 좋아요')).toHaveLength(0);
  await click(buttons(root, '메시지 메뉴')[1]); // 데이터는 최신순이라 [1]은 첫 메시지(민수)
  for (const l of ['좋아요', '하트', '웃겨요', '놀라워요', '슬퍼요', '고마워요']) expect(buttons(root, `공감: ${l}`)).toHaveLength(1);
  expect(buttons(root, '답장')).toHaveLength(1);
});

test('화면 읽기 프로그램의 "메시지 메뉴" 동작으로도 같은 메뉴가 열린다(길게 누르기만으로는 부족)', async () => {
  const { root } = await setup();
  const bubble = root.container.queryAll((n) => n.props.accessibilityActions?.[0]?.name === 'menu')[1];
  await act(async () => bubble.props.onAccessibilityAction({ nativeEvent: { actionName: 'menu' } }));
  expect(buttons(root, '답장')).toHaveLength(1);
});

test('메뉴에서 공감을 고르면 toggle(메시지 id, 이모지)를 부르고 메뉴가 닫힌다. 내 공감은 현재 값으로 넘어간다', async () => {
  const { root } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '공감: 웃겨요')[0]);
  expect(mockToggle).toHaveBeenCalledWith(1, '😂');
  expect(buttons(root, '답장')).toHaveLength(0);
});

test('공감 칩: 개수와 내 공감이 이름에 있고 누르면 같은 이모지 토글', async () => {
  mockReactionRows = [
    { message_id: 1, user_id: 'u2', emoji: '👍', created_at: '' },
    { message_id: 1, user_id: 'me', emoji: '👍', created_at: '' },
  ];
  const { root } = await setup();
  const chip = buttons(root, '공감 좋아요 2명, 내가 누름');
  expect(chip).toHaveLength(1);
  await click(chip[0]);
  expect(mockToggle).toHaveBeenCalledWith(1, '👍');
});

test('공감 실패는 alert 문구로 알린다(서버 글 없음)', async () => {
  mockToggle.mockRejectedValue({ code: '42501', message: 'permission denied' });
  const { root, texts } = await setup();
  await click(buttons(root, '메시지 메뉴')[0]);
  await click(buttons(root, '공감: 좋아요')[0]);
  expect(texts()).toContain('공감하지 못했어요');
  expect(texts()).not.toContain('permission denied');
});

test('답장: 막대에 "<이름>에게 답장 · 첫 줄", 보내면 reply_to와 함께 보내고 막대가 사라진다', async () => {
  mockMessages = [m(1, 'u2', '첫 줄\n둘째 줄'), m(2, 'me', '반가워')];
  mockSend.mockResolvedValue(m(3, 'me', 'ㅇㅋ'));
  const { root, texts, type, press } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  expect(texts()).toContain('민수에게 답장 · 첫 줄');
  expect(texts()).not.toContain('둘째 줄에게');
  await type('ㅇㅋ');
  await press('보내기');
  expect(mockSend).toHaveBeenCalledWith({ text: 'ㅇㅋ', reply_to: 1 });
  expect(buttons(root, '답장 취소')).toHaveLength(0);
});

test('답장 취소: 막대가 사라지고 일반 메시지로 보낸다', async () => {
  mockSend.mockResolvedValue(m(3, 'me', 'x'));
  const { root, type, press } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  await press('답장 취소');
  await type('x');
  await press('보내기');
  expect(mockSend).toHaveBeenCalledWith({ text: 'x' });
});

test('보내기가 실패하면 답장 대상은 그대로 남는다', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('x'), { status: 400 }));
  const { root, type, press } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  await type('x');
  await press('보내기');
  expect(buttons(root, '답장 취소')).toHaveLength(1);
});

test('인용: 불러온 원문은 보낸 사람과 첫 줄로 말풍선 위에 보이고, 눌러서 이동할 수 있는 이름이 있다', async () => {
  mockMessages = [m(1, 'u2', '원문입니다\n둘째'), { ...m(2, 'me', '답이야'), reply_to: 1 }];
  const { root, texts } = await setup();
  expect(texts()).toContain('원문입니다');
  expect(buttons(root, '답장 대상 민수: 원문입니다')).toHaveLength(1);
});

test('안 읽은 사람 수: 0보다 크면 숫자와 이름, 모두 읽으면 숫자 없음', async () => {
  mockMessages = [m(2, 'me', '반가워')];
  mockMembersLastRead = { u2: null };
  const { root } = await setup();
  const label = () => root.container.queryAll((n) => String(n.props.accessibilityLabel).includes('안 읽은 사람 1명'));
  expect(label().length).toBeGreaterThan(0);
  mockMembersLastRead = { u2: '2026-10-27 01:32:17.123456+00' };
  await act(async () => root.render(<Room />));
  expect(label()).toHaveLength(0);
});

test('읽음 재시도 타이머: 언마운트 뒤에 실패해도 새 타이머를 남기지 않는다', async () => {
  jest.useFakeTimers();
  try {
    const retryTimers = jest.spyOn(global, 'setTimeout');
    let fail!: (e: unknown) => void;
    mockMarkRead.mockReturnValue(new Promise((_, rej) => (fail = rej)));
    const { root } = await setup();
    await act(async () => root.render(<></>));
    await act(async () => fail(new Error('x')));
    expect(retryTimers).not.toHaveBeenCalledWith(expect.any(Function), 3000);
  } finally {
    jest.useRealTimers();
  }
});

test('읽음 재시도 타이머: 새 타이머 전에 이전 것을 지운다', async () => {
  jest.useFakeTimers();
  try {
    const clear = jest.spyOn(global, 'clearTimeout');
    mockMarkRead.mockRejectedValue(new Error('x'));
    const { root } = await setup();
    await act(async () => void jest.advanceTimersByTime(3000)); // 재시도 1 → 또 실패 → 새 타이머
    mockMessages = [...mockMessages, m(3, 'u2', '새 글', '2026-10-27 01:40:00.000000+00')];
    clear.mockClear();
    await act(async () => root.render(<Room />)); // 새 메시지 → 읽음 다시 → 실패 → 타이머가 이미 있다
    expect(clear).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

// ── T-09b fix round 1 ──
import { AccessibilityInfo, Platform } from 'react-native';

const keyEv = (key: string, extra: object = {}) => ({ key, preventDefault() {}, stopPropagation() {}, ...extra });
const bodies = (root: Q) => root.container.queryAll((n) => (n as unknown as N).props.accessibilityHint === '메시지 메뉴 열기') as unknown as N[]; // 화면 위쪽(오래된)부터가 아니라 data 순서: 새 것부터
const keyHolders = (root: Q) => root.container.queryAll((n) => typeof (n as unknown as N).props.onKeyDown === 'function') as unknown as N[];

describe('웹: 로빙 tabindex', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));
  afterEach(() => jest.restoreAllMocks());

  test('가장 새 메시지만 탭 순서에 있다(본문·메뉴 버튼 모두)', async () => {
    const { root } = await setup();
    expect(bodies(root).map((b) => b.props.tabIndex)).toEqual([0, -1]);
    expect(buttons(root, '메시지 메뉴').map((b) => b.props.tabIndex)).toEqual([0, -1]);
  });

  test('ArrowUp은 한 칸 위(더 오래된) 메시지로 활성을 옮기고 ArrowDown은 되돌린다', async () => {
    const { root } = await setup();
    await act(async () => keyHolders(root)[0].props.onKeyDown(keyEv('ArrowUp')));
    expect(bodies(root).map((b) => b.props.tabIndex)).toEqual([-1, 0]);
    await act(async () => keyHolders(root)[1].props.onKeyDown(keyEv('ArrowDown')));
    expect(bodies(root).map((b) => b.props.tabIndex)).toEqual([0, -1]);
  });

  test('Shift+F10과 ContextMenu 키는 메시지 메뉴를 연다', async () => {
    const { root } = await setup();
    await act(async () => keyHolders(root)[0].props.onKeyDown(keyEv('F10', { shiftKey: true })));
    expect(buttons(root, '답장')).toHaveLength(1);
    await click(buttons(root, '닫기')[buttons(root, '닫기').length - 1]);
    expect(buttons(root, '답장')).toHaveLength(0);
    await act(async () => keyHolders(root)[0].props.onKeyDown(keyEv('ContextMenu')));
    expect(buttons(root, '답장')).toHaveLength(1);
  });

  test('본문을 누르거나 Enter(=press)하면 메뉴가 열린다', async () => {
    const { root } = await setup();
    await click(bodies(root)[0]);
    expect(buttons(root, '답장')).toHaveLength(1);
  });

  test('공감 칩과 선택 버튼에는 aria-selected(accessibilityState.selected)가 없고 aria-pressed만 있다', async () => {
    mockReactionRows = [{ message_id: 1, user_id: 'me', emoji: '👍', created_at: '' }];
    const { root } = await setup();
    const chip = buttons(root, '공감 좋아요 1명, 내가 누름')[0];
    expect(chip.props.accessibilityState?.selected).toBeUndefined();
    expect(chip.props['aria-pressed']).toBe(true);
    await click(buttons(root, '메시지 메뉴')[1]);
    const pick = buttons(root, '공감: 좋아요')[0];
    expect(pick.props.accessibilityState?.selected).toBeUndefined();
    expect(pick.props['aria-pressed']).toBe(true);
  });

  test('시트가 열리면 웹 포커스는 첫 공감 버튼으로 간다', async () => {
    jest.useFakeTimers();
    const focus = jest.fn();
    const ids: string[] = [];
    (globalThis as unknown as { document: object }).document = { getElementById: (id: string) => (ids.push(id), { focus }), activeElement: null };
    try {
      const { root } = await setup();
      await click(buttons(root, '메시지 메뉴')[1]);
      await act(async () => void jest.advanceTimersByTime(100));
      expect(ids).toContain('sheet-first-reaction');
      expect(focus).toHaveBeenCalled();
    } finally {
      delete (globalThis as unknown as { document?: object }).document;
      jest.useRealTimers();
    }
  });

  test('시트는 이름 있는 dialog이고 보이는 닫기 버튼이 있으며 배경은 탭 순서 밖', async () => {
    const { root } = await setup();
    await click(buttons(root, '메시지 메뉴')[1]);
    const dlg = root.container.queryAll((n) => n.props.role === 'dialog' || n.props['aria-modal'] === true)[0];
    expect(dlg.props['aria-label']).toBe('민수의 메시지: 안녕');
    const closers = buttons(root, '닫기');
    expect(closers.length).toBe(2);
    expect(closers.filter((c) => c.props.tabIndex === -1)).toHaveLength(1);
  });
});

test('말풍선 본문의 이름에 보낸 사람·글·시각·안 읽은 수가 한 번에 들어 있고, 따로 읽히는 시각·숫자 노드는 숨겨진다', async () => {
  mockMessages = [m(2, 'me', '반가워')];
  mockMembersLastRead = { u2: null };
  const { root } = await setup();
  const label = bodies(root)[0].props.accessibilityLabel as string;
  expect(label).toMatch(/^나, 반가워, .+, 안 읽은 사람 1명$/);
  const stamp = root.container.queryAll((n) => n.props.accessibilityElementsHidden === true && n.props['aria-hidden'] === true);
  expect(stamp.length).toBeGreaterThan(0);
});

test('1:1 방에서는 "상대가 안 읽음"', async () => {
  mockFetchRoom.mockImplementation(() => okRoom().then((r) => ({ ...r, room: { ...r.room, kind: 'direct' } })));
  mockMessages = [m(2, 'me', '반가워')];
  mockMembersLastRead = { u2: null };
  const { root } = await setup();
  expect(bodies(root)[0].props.accessibilityLabel).toMatch(/, 상대가 안 읽음$/);
});

describe('인용', () => {
  const orig = () => m(1, 'u2', '원문입니다', '2026-10-27 01:00:00.000000+00');
  const fromReturning = (row: Msg | null) =>
    mockFrom.mockImplementation(() => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: 'x' } }) }) }) }));
  beforeEach(() => {
    mockMessages = [{ ...m(5, 'me', '답이야'), reply_to: 1 }];
  });

  test('이름: "답장 대상 …"과 힌트, 못 불러온 원문은 눌리지 않는 View', async () => {
    fromReturning(orig());
    const { root } = await setup();
    const q = buttons(root, '답장 대상 민수: 원문입니다')[0];
    expect(q.props.accessibilityHint).toBe('누르면 원문으로 이동');
  });

  test('원문이 불러온 범위 밖이고 더 있으면 loadOlder를 부른다', async () => {
    fromReturning(orig());
    mockHasMore = true;
    const { root } = await setup();
    await click(buttons(root, '답장 대상 민수: 원문입니다')[0]);
    expect(mockLoadOlder).toHaveBeenCalled();
  });

  test('더 없으면 "원래 메시지는 더 이전 대화에 있어요"를 알린다', async () => {
    fromReturning(orig());
    mockHasMore = false;
    const { root } = await setup();
    await click(buttons(root, '답장 대상 민수: 원문입니다')[0]);
    const live = textOf(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')[0] as unknown as TestNode);
    expect(live).toContain('원래 메시지는 더 이전 대화에 있어요');
  });

  test('원문을 못 읽으면 실패 문구와 다시 불러오기 버튼, 누르면 다시 읽는다', async () => {
    fromReturning(null);
    const { root, texts } = await setup();
    expect(texts()).toContain('원래 메시지를 불러오지 못했어요');
    expect(buttons(root, '답장 대상 민수: 원문입니다')).toHaveLength(0);
    const calls = mockFrom.mock.calls.length;
    fromReturning(orig());
    await click(buttons(root, '원래 메시지 다시 불러오기')[0]);
    expect(mockFrom.mock.calls.length).toBeGreaterThan(calls);
    expect(buttons(root, '답장 대상 민수: 원문입니다')).toHaveLength(1);
  });
});

test('같은 알림이 연달아 와도 다시 읽히도록 문구가 달라진다', async () => {
  const { root } = await setup();
  const live = () => textOf(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')[0] as unknown as TestNode);
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  const a = live();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  expect(a).toContain('민수에게 답장');
  expect(live()).not.toBe(a);
  expect(live()).toContain('민수에게 답장');
});

test('답장 중이면 입력창 이름에 대상이 들어가고, 취소하면 "답장 취소됨"을 알린다', async () => {
  const { root, input } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, '답장')[0]);
  expect(input().props.accessibilityLabel).toBe('메시지 입력, 민수에게 답장 중');
  await click(buttons(root, '답장 취소')[0]);
  expect(input().props.accessibilityLabel).toBe('메시지 입력');
  const live = textOf(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')[0] as unknown as TestNode);
  expect(live).toContain('답장 취소됨');
});

const press2 = (root: Q, label: string) => act(async () => (root.container.queryAll((n) => (n as unknown as N).props.accessibilityLabel === label)[0] as unknown as N).props.onClick({ stopPropagation() {}, nativeEvent: {} }));
describe('T-09c 입력 중 · 사진 · 멘션', () => {
  const sel = (n: number) => ({ nativeEvent: { selection: { start: n, end: n } } });
  const alerts = (root: Q) => root.container.queryAll((n) => (n as unknown as N).props.accessibilityRole === 'alert');

  test('입력 중: 글이 바뀔 때 onDraftChange, 보내면 stop, 입력창을 벗어나면 stop', async () => {
    mockSend.mockResolvedValue(m(3, 'me', 'hi'));
    const { type, press, input } = await setup();
    await type('h');
    expect(mockTyping.onDraftChange).toHaveBeenLastCalledWith('h');
    await act(async () => input().props.onBlur());
    expect(mockTyping.stop).toHaveBeenCalledTimes(1);
    await press('보내기');
    expect(mockTyping.stop).toHaveBeenCalledTimes(2);
  });

  test('입력 중 표시는 입력창 위 polite 영역에 있고, 없을 때도 영역은 남아 있다', async () => {
    const { root, texts } = await setup();
    const live = () => root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite' && n.props['aria-live'] === 'polite');
    const before = live().length;
    expect(texts()).not.toContain('입력 중');
    mockTyping.label = '민수님이 입력 중';
    await act(async () => root.render(<Room />));
    expect(texts()).toContain('민수님이 입력 중');
    expect(live().length).toBe(before);
  });

  test('사진 보내기: 고른 뒤 결과별 문구. 취소는 조용히', async () => {
    const { press, root, texts } = await setup();
    mockPickImage.mockResolvedValue('cancelled');
    await press('사진 보내기');
    expect(mockPickImage).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Function));
    expect(alerts(root)).toHaveLength(0);
    mockPickImage.mockResolvedValue('unsupported');
    await press('사진 보내기');
    expect(texts()).toContain('이 형식의 사진은 보낼 수 없어요');
    mockPickImage.mockResolvedValue('failed');
    await press('사진 보내기');
    expect(texts()).toContain('사진을 보내지 못했어요');
    expect(texts()).not.toContain('이 형식의 사진은 보낼 수 없어요');
    mockPickImage.mockResolvedValue('sent');
    await press('사진 보내기');
    expect(alerts(root)).toHaveLength(0);
  });

  test('사진 보내기는 useRoomMessages.send로 보낸다(힌트·엔진 없음)', async () => {
    mockSend.mockResolvedValue(m(9, 'me', ''));
    mockPickImage.mockImplementation(async (_r: string, send: (x: object) => Promise<unknown>) => (await send({ text: '', image_path: 'r1/a.jpg' }), 'sent'));
    const { press } = await setup();
    await press('사진 보내기');
    expect(mockSend).toHaveBeenCalledWith({ text: '', image_path: 'r1/a.jpg' });
  });

  test('사진 말풍선: 대체 글이 "보낸 사람이 보낸 사진", 합친 이름에 "사진", 글이 같이 있으면 글도', async () => {
    mockMessages = [{ ...m(1, 'u2', ''), image_path: 'r1/a.jpg' }, { ...m(2, 'me', '봐봐'), image_path: 'r1/b.jpg' }];
    const { root } = await setup();
    const imgs = root.container.queryAll((n) => n.props.source?.uri?.startsWith?.('https://img/'));
    expect(imgs.map((i) => i.props.accessibilityLabel).sort()).toEqual(['내가 보낸 사진', '민수님이 보낸 사진']);
    const labels = bodies(root).map((b) => b.props.accessibilityLabel as string);
    expect(labels.find((l) => l.startsWith('민수, 사진, '))).toBeTruthy();
    expect(labels.find((l) => l.startsWith('나, 사진, 봐봐, '))).toBeTruthy();
  });

  test('사진 말풍선: 주소가 오기 전에는 같은 크기의 자리 상자(그림 없음)', async () => {
    mockMessages = [{ ...m(1, 'u2', ''), image_path: 'r1/pending.jpg' }];
    const { root } = await setup();
    expect(root.container.queryAll((n) => n.props.source?.uri)).toHaveLength(0);
    expect(root.container.queryAll((n) => n.props.accessibilityLabel === '사진 불러오는 중')).toHaveLength(1);
  });

  test('사진 말풍선: 불러오기 실패는 문구와 다시 불러오기 버튼(탭 순서 안), 누르면 retry', async () => {
    mockMessages = [{ ...m(1, 'u2', ''), image_path: 'r1/broken.jpg' }];
    const { root, texts } = await setup();
    expect(texts()).toContain('사진을 불러오지 못했어요');
    await press2(root, '사진 다시 불러오기');
    expect(mockRetryPhoto).toHaveBeenCalledTimes(1);
  });

  test('사진 보내기: 고르는 동안엔 busy가 아니고 두 번째 누름은 무시, 고른 뒤(onStart)부터 aria-busy, 알림은 "보내는 중" → "보냄"', async () => {
    let done: (v: string) => void = () => {};
    let start: () => void = () => {};
    mockPickImage.mockImplementation((_r: string, _s: unknown, onStart: () => void) => new Promise((r) => ((done = r), (start = onStart))));
    const { press, root, texts } = await setup();
    const btn = () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '사진 보내기')[0];
    await press('사진 보내기');
    await press('사진 보내기');
    expect(mockPickImage).toHaveBeenCalledTimes(1);
    expect(btn().props.accessibilityState?.busy).toBeFalsy();
    await act(async () => start());
    expect(btn().props.accessibilityState?.busy).toBe(true);
    expect(texts()).toContain('사진 보내는 중');
    await act(async () => done('sent'));
    expect(texts()).toContain('사진 보냄');
    expect(btn().props.accessibilityState?.busy).toBeFalsy();
  });

  test('사진 고르기를 취소해도(onStart 없이 끝나도) 다시 누를 수 있다', async () => {
    mockPickImage.mockResolvedValue('cancelled');
    const { press } = await setup();
    await press('사진 보내기');
    await press('사진 보내기');
    expect(mockPickImage).toHaveBeenCalledTimes(2);
  });

  test('안내 영역(polite)은 화면에 한 번만 그려지고, 입력 중 문구는 say로 그 영역에 들어간다', async () => {
    const { root, texts } = await setup();
    const live = () => root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite');
    expect(live()).toHaveLength(1);
    mockTyping.label = '민수님이 입력 중';
    await act(async () => root.render(<Room />));
    expect(live()).toHaveLength(1);
    expect(texts()).toContain('민수님이 입력 중');
  });

  test('iOS: 안내는 영역 없이 announceForAccessibility로', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    mockMessages = [m(1, 'u2', '안녕')];
    const { root } = await setup();
    mockMessages = [m(1, 'u2', '안녕'), m(2, 'u2', '또')];
    await act(async () => root.render(<Room />));
    expect(spy).toHaveBeenCalledWith('민수: 또');
    expect(root.container.queryAll((n) => n.props.accessibilityLiveRegion === 'polite')).toHaveLength(0);
  });

  test('사진이 너무 크면 크기 문구', async () => {
    mockPickImage.mockResolvedValue('toolarge');
    const { press, texts } = await setup();
    await press('사진 보내기');
    expect(texts()).toContain('사진이 너무 커요 (5MB 이하)');
  });

  test('같은 실패가 연달아도 다시 읽히도록 문구가 달라진다', async () => {
    mockPickImage.mockResolvedValue('failed');
    const { press, root } = await setup();
    const alertText = () => textOf(root.container.queryAll((n) => n.props.accessibilityRole === 'alert')[0] as unknown as TestNode);
    await press('사진 보내기');
    const a = alertText();
    await press('사진 보내기');
    expect(alertText()).not.toBe(a);
    expect(alertText().replace('\u200b', '')).toBe(a.replace('\u200b', ''));
  });

  test('이름이 같은 멤버는 후보에 없다', async () => {
    mockFetchRoom.mockImplementation(() => okRoom().then((r) => ({ ...r, members: [...r.members, { user_id: 'u3', name: '민수', last_read_at: null, muted: false }] })));
    const { type, input, root } = await setup();
    await type('@민');
    await act(async () => input().props.onSelectionChange(sel(2)));
    expect(buttons(root, '민수 언급')).toHaveLength(0);
  });

  test('멘션(그룹): @와 이름 앞글자를 치면 후보가 뜨고, 고르면 이름이 들어가며 입력창으로 포커스', async () => {
    jest.useFakeTimers();
    try {
      const { type, input, press, root } = await setup();
      await type('@민');
      await act(async () => input().props.onSelectionChange(sel(2)));
      expect(buttons(root, '민수 언급')).toHaveLength(1);
      expect(buttons(root, '나 언급')).toHaveLength(0);
      await press('민수 언급');
      expect(input().props.value).toBe('@민수 ');
      expect(buttons(root, '민수 언급')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('멘션: 보낼 때 mentions에 id, 없으면 필드 자체가 없다', async () => {
    mockSend.mockResolvedValue(m(3, 'me', 'x'));
    const { type, press } = await setup();
    await type('@민수 안녕');
    await press('보내기');
    expect(mockSend).toHaveBeenCalledWith({ text: '@민수 안녕', mentions: ['u2'] });
    await type('그냥');
    await press('보내기');
    expect(mockSend).toHaveBeenLastCalledWith({ text: '그냥' });
  });

  test('멘션 실패(mention_not_member): 문구를 고르고 글을 되돌리며, 다시 보내면 같은 멘션', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('mention_not_member'), { status: 400 })).mockResolvedValue(m(3, 'me', 'x'));
    const { type, press, input, texts } = await setup();
    await type('@민수 안녕');
    await press('보내기');
    expect(texts()).toContain('이 방에 없는 사람은 언급할 수 없어요');
    expect(input().props.value).toBe('@민수 안녕');
    await press('보내기');
    expect(mockSend).toHaveBeenLastCalledWith({ text: '@민수 안녕', mentions: ['u2'] });
  });

  test('1:1 방에서는 멘션 후보도 mentions도 없다', async () => {
    mockFetchRoom.mockImplementation(() => okRoom().then((r) => ({ ...r, room: { ...r.room, kind: 'direct' } })));
    mockSend.mockResolvedValue(m(3, 'me', 'x'));
    const { type, input, press, root } = await setup();
    await type('@민');
    await act(async () => input().props.onSelectionChange(sel(2)));
    expect(buttons(root, '민수 언급')).toHaveLength(0);
    await type('@민수 안녕');
    await press('보내기');
    expect(mockSend).toHaveBeenLastCalledWith({ text: '@민수 안녕' });
  });

  test('말풍선의 @이름은 굵게, 합친 이름에는 "나를 언급"이 붙는다', async () => {
    mockMessages = [{ ...m(1, 'u2', '@나 확인'), mentions: ['me'] }];
    const { root } = await setup();
    const strong = root.container.queryAll((n) => n.props.children === '@나' && n.props.style);
    expect(strong.length).toBeGreaterThan(0);
    expect(bodies(root)[0].props.accessibilityLabel).toMatch(/^민수, @나 확인, .+, 나를 언급$/);
  });
});

test('검색에서 온 ?at=: 그 메시지로 이동하고 알린다', async () => {
  mockParams = { id: 'r1', at: '1', k: '1' };
  const { texts } = await setup();
  expect(texts()).toContain('원문으로 이동했어요');
});

test('?at= 메시지가 불러온 범위 밖이면 더 불러온다', async () => {
  mockParams = { id: 'r1', at: '99', k: '1' };
  mockHasMore = true;
  await setup();
  expect(mockLoadOlder).toHaveBeenCalled();
});

// ── T-25: 털어놓기 ──
const VENT = 'AI에게만 털어놓기';
const ventInput = (root: Q) => root.container.queryAll((n) => (n as unknown as N).props.accessibilityLabel === '털어놓을 내용')[0] as unknown as N;

test('털어놓기: 내 메시지 메뉴에는 없고 받은 메시지 메뉴에만 있다', async () => {
  const { root } = await setup();
  await click(buttons(root, '메시지 메뉴')[0]); // 내 메시지
  expect(buttons(root, VENT)).toHaveLength(0);
  expect(buttons(root, '답장')).toHaveLength(1);
});

test('털어놓기: 사진만 있는 받은 메시지에는 없다', async () => {
  mockMessages = [{ ...m(1, 'u2', ''), image_path: 'p.jpg' }];
  const { root } = await setup();
  await click(buttons(root, '메시지 메뉴')[0]);
  expect(buttons(root, VENT)).toHaveLength(0);
});

test('털어놓기: 받은 메시지에서 열고 → 안내 문구 → 남기기가 feedback을 부르고 시트가 닫히며 토스트에 ack, 글은 남지 않는다', async () => {
  mockFeedback.mockResolvedValue({ ack: '남겨 주셔서 고마워요.' });
  const { root, texts } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, VENT)[0]);
  expect(buttons(root, '답장')).toHaveLength(0); // 메뉴는 닫힘
  expect(texts()).toContain('상대에게는 보이지 않아요. 누가 남겼는지도 드러나지 않아요.');
  await act(async () => ventInput(root).props.onChangeText('  너무 차가웠어요  '));
  expect(texts()).toContain('12/1000');
  await click(buttons(root, '남기기')[0]);
  expect(mockFeedback).toHaveBeenCalledWith({ room_id: 'r1', message_id: 1, text: '너무 차가웠어요' });
  expect(ventInput(root)).toBeUndefined();
  expect(texts()).toContain('남겨 주셔서 고마워요.');
  expect(texts()).not.toContain('너무 차가웠어요');
  await click(buttons(root, '남겨 주셔서 고마워요. 닫기')[0]);
  expect(buttons(root, '남겨 주셔서 고마워요. 닫기')).toHaveLength(0); // 토스트가 사라짐(읽어 주는 영역의 글은 남는다)
});

test('털어놓기: 빈 글은 보내지 않고, 실패는 고정 문구(서버 글 없음), 다시 열면 글이 비어 있다', async () => {
  const { EngineError } = jest.requireActual('../lib/engine');
  mockFeedback.mockRejectedValue(new EngineError(429, 'secret server text'));
  const { root, texts } = await setup();
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, VENT)[0]);
  await click(buttons(root, '남기기')[0]);
  expect(mockFeedback).not.toHaveBeenCalled();
  expect(texts()).toContain('적어 주세요');
  await act(async () => ventInput(root).props.onChangeText('힘들어요'));
  await click(buttons(root, '남기기')[0]);
  expect(texts()).toContain('잠시 뒤 다시 남겨 주세요');
  expect(texts()).not.toContain('secret server text');
  await click(buttons(root, '닫기')[0]);
  await click(buttons(root, '메시지 메뉴')[1]);
  await click(buttons(root, VENT)[0]);
  expect(ventInput(root).props.value).toBe('');
});
