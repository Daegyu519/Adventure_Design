import { act } from 'react';
import { AccessibilityInfo, Platform, Share } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import RoomInfo from '../app/room/[id]/info';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
let mockFocused = true;
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ id: 'r1' }), useIsFocused: () => mockFocused }));
const mockFocus = jest.fn();
jest.mock('../lib/focus', () => ({ focusNode: (...a: unknown[]) => mockFocus(...a) }));
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
  mockFocused = true;
  mockFocus.mockReset();
  Platform.OS = 'web'; // 안내 영역은 웹·안드로이드 방식. iOS는 아래 한 테스트에서만
  mockRouter.push.mockReset();
  mockRpc.mockReset();
  mockUpdate.mockReset().mockImplementation(() => eqChain({ error: null }));
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});
afterEach(() => {
  Platform.OS = 'ios';
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
  Platform.OS = 'ios'; // 네이티브 공유 창
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
  const { press, texts } = await setup();
  await press('초대 코드 만들기');
  expect(mockRpc).toHaveBeenCalledWith('create_invite', { room: 'r1', relation: '팀원' });
  expect(texts()).toContain('AB3X9K7Q');
  await press('초대 코드 보내기');
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

const live = (find: (p: (n: TestInstance) => boolean) => TestInstance[]) => find((n) => n.props['aria-live'] === 'polite' && n.props.style?.position === 'absolute')[0];

test('멤버는 list/listitem, 이름이 비면 "이름 없음"', async () => {
  mockFetchRoom.mockImplementation(() => room('group').then((r) => ({ ...r, members: [...r.members, { user_id: 'u3', name: '', last_read_at: null, muted: false }] })));
  const root = createRoot();
  await act(async () => root.render(<RoomInfo />));
  const q = (role: string) => root.container.queryAll((n) => n.props.role === role);
  expect(q('list')).toHaveLength(1);
  expect(q('listitem')).toHaveLength(3);
  expect(textOf(root.container as unknown as TestNode)).toContain('이름 없음');
});

test('인원 수에 읽히는 이름이 있다', async () => {
  const { find } = await setup();
  expect(find((n) => n.props.accessibilityLabel === '멤버 2명, 최대 8명').length).toBeGreaterThan(0);
});

test('알림 행: 44pt 높이이고 글자를 눌러도 켜진다', async () => {
  const { find, sw } = await setup();
  const row = find((n) => n.props.testID === 'mute-row')[0];
  expect(row.props.style.minHeight).toBeGreaterThanOrEqual(44);
  const label = find((n) => n.props.testID === 'mute-label')[0];
  await act(async () => label.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(mockUpdate).toHaveBeenCalledWith('room_members');
  expect(sw()).toBeTruthy();
});

test('안내는 처음부터 있는 polite 영역에 나온다(알림 켬, 초대)', async () => {
  const { find, press, sw, root } = await setup();
  expect(live(find)).toBeTruthy();
  await act(async () => (sw().props.onChange as (e: unknown) => void)({ nativeEvent: { value: true }, target: { value: true } }));
  expect(textOf(live(find) as unknown as TestNode)).toContain('이 방 알림을 껐어요');
  mockRpc.mockResolvedValue({ data: 'AB3X9K7Q', error: null, status: 200 });
  await press('초대 코드 만들기');
  expect(textOf(live(find) as unknown as TestNode)).toContain('초대 코드를 만들었어요');
  void root;
});

test('불러오는 동안 "불러오는 중"을 알린다', async () => {
  mockFetchRoom.mockImplementation(() => new Promise(() => {}));
  const root = createRoot();
  await act(async () => root.render(<RoomInfo />));
  const l = root.container.queryAll((n) => n.props['aria-live'] === 'polite')[0];
  expect(textOf(l as unknown as TestNode)).toContain('불러오는 중');
});

test('초대 코드를 만들면 코드 그룹으로 포커스', async () => {
  mockRpc.mockResolvedValue({ data: 'AB3X9K7Q', error: null, status: 200 });
  const { press, find } = await setup();
  mockFocus.mockReset();
  await press('초대 코드 만들기');
  expect(mockFocus).toHaveBeenCalled();
  expect(find((n) => String(n.props.accessibilityLabel).startsWith('초대 코드 A B 3') && String(n.props.accessibilityLabel).includes('72시간 안에 쓸 수 있어요')).length).toBeGreaterThan(0);
});

test('들어오면 제목으로 포커스, 검색에서 돌아오면 "대화 검색" 버튼으로', async () => {
  const { root } = await setup();
  expect(mockFocus).toHaveBeenCalledTimes(1);
  mockFocused = false;
  await act(async () => root.render(<RoomInfo />));
  mockFocused = true;
  mockFocus.mockReset();
  await act(async () => root.render(<RoomInfo />));
  expect(mockFocus).toHaveBeenCalledTimes(1);
});

test('iOS: 알림을 끄면 announceForAccessibility로 알린다', async () => {
  Platform.OS = 'ios';
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  spy.mockClear();
  const { sw } = await setup();
  spy.mockClear(); // "불러오는 중"은 제외
  await act(async () => (sw().props.onChange as (e: unknown) => void)({ nativeEvent: { value: true }, target: { value: true } }));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('이 방 알림을 껐어요');
});

test('알림 글자는 탭 순서와 접근성 트리에서 뺀다(스위치만 남는다)', async () => {
  const { find } = await setup();
  const p = find((n) => n.props.testID === 'mute-label')[0].props;
  expect(p.tabIndex).toBe(-1);
  expect(p['aria-hidden']).toBe(true);
  expect(p.accessibilityElementsHidden).toBe(true);
  expect(p.importantForAccessibility).toBe('no-hide-descendants');
});
