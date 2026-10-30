import { act } from 'react';
import { createRoot, type TestNode } from 'test-renderer';

import Room from '../app/room/[id]/index';
import type { Msg } from '../lib/messages';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('lucide-react-native/icons/info', () => () => null);
jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
let mockFocused = true;
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ id: 'r1' }), useIsFocused: () => mockFocused }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));
jest.mock('../lib/supabase', () => ({ supabase: {} }));

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

const m = (id: number, sender: string, text: string, ts = '2026-10-27 01:32:17.123456+00'): Msg => ({ id, room_id: 'r1', sender_id: sender, text, image_path: null, reply_to: null, mentions: [], created_at: ts });
const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

async function setup() {
  const root = createRoot();
  await act(async () => root.render(<Room />));
  const input = () => root.container.queryAll((n) => n.props.accessibilityLabel === '메시지 입력')[0];
  const type = (t: string) => act(async () => input().props.onChangeText(t));
  const press = (label: string) =>
    act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { root, input, type, press, texts: () => textOf(root.container as unknown as TestNode) };
}

beforeEach(() => {
  mockMessages = [m(1, 'u2', '안녕'), m(2, 'me', '반가워')];
  mockFocused = true;
  mockSend.mockReset();
  mockLoadOlder.mockReset();
  mockReload.mockReset();
  mockOlderError = false;
  mockHasMore = false;
  mockFetchRoom.mockReset().mockImplementation(okRoom);
  mockMarkRead.mockReset().mockResolvedValue(undefined);
  mockRouter.push.mockReset();
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
