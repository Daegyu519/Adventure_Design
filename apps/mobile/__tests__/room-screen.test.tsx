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
jest.mock('../lib/rooms', () => ({
  ...jest.requireActual('../lib/rooms'),
  fetchRoom: () =>
    Promise.resolve({
      room: { id: 'r1', kind: 'group', title: '팀플', relation: '팀원', created_at: '', created_by: null },
      members: [
        { user_id: 'me', name: '나', last_read_at: null, muted: false },
        { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
      ],
    }),
  markRead: (...a: unknown[]) => mockMarkRead(...a),
}));

let mockMessages: Msg[] = [];
const mockSend = jest.fn();
jest.mock('../lib/useRoomMessages', () => ({ useRoomMessages: () => ({ messages: mockMessages, hasMore: false, error: false, loadOlder: jest.fn(), send: (...a: unknown[]) => mockSend(...a) }) }));

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
