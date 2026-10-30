import { act } from 'react';
import { AccessibilityInfo, Share } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import RoomInfo from '../app/room/[id]/info';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ id: 'r1' }) }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));
const mockRpc = jest.fn();
const mockUpdate = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => mockRpc(...a), from: (...a: unknown[]) => mockUpdate(...a) } }));
const mockFetchRoom = jest.fn();
jest.mock('../lib/rooms', () => ({ ...jest.requireActual('../lib/rooms'), fetchRoom: (...a: unknown[]) => mockFetchRoom(...a) }));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const room = (kind: 'group' | 'direct') =>
  Promise.resolve({
    room: { id: 'r1', kind, title: kind === 'group' ? '팀플' : null, relation: '팀원', created_at: '', created_by: null },
    members: [
      { user_id: 'me', name: '나나', last_read_at: null, muted: false },
      { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
    ],
  });
const eqChain = (result: unknown) => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }) });

async function setup(kind: 'group' | 'direct' = 'group') {
  mockFetchRoom.mockImplementation(() => room(kind));
  const root = createRoot();
  await act(async () => root.render(<RoomInfo />));
  const find = (p: (n: TestInstance) => boolean) => root.container.queryAll(p);
  const press = (label: string) => act(async () => find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  const sw = () => find((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === '이 방 알림 끄기')[0];
  return { root, find, press, sw, texts: () => textOf(root.container as unknown as TestNode) };
}

beforeEach(() => {
  mockRouter.push.mockReset();
  mockRpc.mockReset();
  mockUpdate.mockReset().mockImplementation(() => eqChain({ error: null }));
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

test('그룹: 이름 · 관계 · n/8명 · 멤버(나 표시)', async () => {
  const { texts } = await setup();
  const t = texts();
  expect(t).toContain('팀플');
  expect(t).toContain('팀원');
  expect(t).toContain('2/8명');
  expect(t).toContain('나나 (나)');
  expect(t).toContain('민수');
});

test('1:1은 초대 코드 만들기와 인원 수가 없다', async () => {
  const { texts, find } = await setup('direct');
  expect(texts()).not.toContain('/8명');
  expect(find((n) => n.props.accessibilityLabel === '초대 코드 만들기')).toHaveLength(0);
});

test('알림 끄기: room_members.update({muted}) 후 켜짐 상태', async () => {
  const { sw } = await setup();
  await act(async () => (sw().props.onChange as (e: unknown) => void)({ nativeEvent: { value: true }, target: { value: true } }));
  expect(mockUpdate).toHaveBeenCalledWith('room_members');
  expect(sw().props['aria-checked'] ?? sw().props.value ?? sw().props.checked).toBeTruthy();
});

test('알림 끄기 실패하면 되돌리고 알린다', async () => {
  mockUpdate.mockImplementation(() => eqChain({ error: { message: 'x' } }));
  const { sw, find } = await setup();
  await act(async () => (sw().props.onChange as (e: unknown) => void)({ nativeEvent: { value: true }, target: { value: true } }));
  expect(sw().props.value).toBe(false);
  expect(find((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
});

test('그룹 초대 코드: rpc(create_invite, {room, relation}) → 코드와 보내기', async () => {
  mockRpc.mockResolvedValue({ data: 'AB3X9K7Q', error: null, status: 200 });
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
  const { press, texts } = await setup();
  await press('초대 코드 만들기');
  expect(mockRpc).toHaveBeenCalledWith('create_invite', { room: 'r1', relation: '팀원' });
  expect(texts()).toContain('AB3X9K7Q');
  await press('보내기');
  expect(Share.share).toHaveBeenCalled();
});

test('초대 코드 실패는 고정 문구(room_full)', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'room_full' }, status: 400 });
  const { press, texts } = await setup();
  await press('초대 코드 만들기');
  expect(texts()).toContain('방이 가득 찼어요');
});

test('대화 검색 → /room/r1/search', async () => {
  const { press } = await setup();
  await press('대화 검색');
  expect(mockRouter.push).toHaveBeenCalledWith('/room/r1/search');
});
