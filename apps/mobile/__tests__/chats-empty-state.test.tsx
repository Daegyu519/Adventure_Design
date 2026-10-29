import { act } from 'react';
import { createRoot, type TestNode } from 'test-renderer';

import Chats from '../app/(tabs)/index';
import type { RoomListItem } from '../lib/rooms';

jest.mock('lucide-react-native/icons/bell-off', () => () => null);
jest.mock('lucide-react-native/icons/plus', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return { useRouter: () => mockRouter, useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]) };
});
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));

let mockRooms: RoomListItem[] = [];
let mockReject = false;
jest.mock('../lib/rooms', () => ({ fetchRoomList: () => (mockReject ? Promise.reject(new Error('x')) : Promise.resolve(mockRooms)) }));

let mockSupabase: unknown = {};
const removeChannel = jest.fn();
let onInsert: (() => void) | null = null;
const channel = { on: (_t: string, _f: unknown, cb: () => void) => ((onInsert = cb), channel), subscribe: () => channel };
jest.mock('../lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const room = (o: Partial<RoomListItem>): RoomListItem => ({ id: 'r1', kind: 'direct', title: '민수', relation: '친구', muted: false, unread: 0, last: null, created_at: '2026-10-01T00:00:00+00:00', ...o });

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Chats />);
  });
  const texts = () => textOf(root.container as unknown as TestNode);
  const press = (label: string) =>
    act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { root, texts, press };
}

beforeEach(() => {
  mockSupabase = { channel: () => channel, removeChannel };
  mockRooms = [];
  mockReject = false;
  mockRouter.push.mockReset();
  removeChannel.mockReset();
});

test('대화 탭 빈 상태: 제목과 안내', async () => {
  const { texts, root } = await setup();
  expect(texts()).toContain('아직 대화가 없어요');
  expect(root.container.queryAll((n) => n.props.accessibilityRole === 'header').length).toBeGreaterThan(0);
  expect(texts()).not.toContain('Supabase 키가 없어요');
});

test('대화 탭 빈 상태: 초대 코드 만들기 / 코드 입력은 각 탭으로 연다', async () => {
  const { press } = await setup();
  await press('초대 코드 만들기');
  expect(mockRouter.push).toHaveBeenLastCalledWith('/rooms/new?tab=direct');
  await press('코드 입력');
  expect(mockRouter.push).toHaveBeenLastCalledWith('/rooms/new?tab=join');
});

test('대화 탭 빈 상태: 키가 없으면 한 줄 안내가 더 붙는다', async () => {
  mockSupabase = null;
  const { texts } = await setup();
  expect(texts()).toContain('Supabase 키가 없어요. `.env`를 채우면 대화가 보여요');
});

test('목록: 제목 · 미리보기 · 안 읽은 수 배지, 누르면 방으로', async () => {
  mockRooms = [room({ unread: 3, last: { text: '안녕', isImage: false, created_at: '2026-10-20T00:00:00+00:00' } }), room({ id: 'r2', title: '팀플', muted: true, last: { text: '', isImage: true, created_at: '2026-10-19T00:00:00+00:00' } })];
  const { texts, root, press } = await setup();
  expect(texts()).toContain('민수');
  expect(texts()).toContain('안녕');
  expect(texts()).toContain('사진');
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === '안 읽은 메시지 3개').length).toBeGreaterThan(0);
  expect(root.container.queryAll((n) => String(n.props.accessibilityLabel).includes('알림 꺼짐')).length).toBeGreaterThan(0);
  expect(texts()).not.toContain('아직 대화가 없어요');
  await press('민수, 안 읽은 메시지 3개, 안녕');
  expect(mockRouter.push).toHaveBeenLastCalledWith('/room/r1');
  await press('새 대화');
  expect(mockRouter.push).toHaveBeenLastCalledWith('/rooms/new');
});

test('목록: 새 메시지가 오면 다시 불러오고, 화면을 떠나면 채널을 끊는다', async () => {
  const { texts, root } = await setup();
  expect(texts()).toContain('아직 대화가 없어요');
  mockRooms = [room({ unread: 1 })];
  await act(async () => onInsert!());
  expect(texts()).toContain('민수');
  await act(async () => root.unmount());
  expect(removeChannel).toHaveBeenCalled();
});

test('목록: 불러오기 실패는 alert로 알리고 다시 불러오기를 준다', async () => {
  mockReject = true;
  const { root, texts, press } = await setup();
  expect(root.container.queryAll((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
  expect(texts()).not.toContain('아직 대화가 없어요');
  mockReject = false;
  mockRooms = [room({})];
  await press('다시 불러오기');
  expect(texts()).toContain('민수');
});
