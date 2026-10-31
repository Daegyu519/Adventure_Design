import { act } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import RoomSearch from '../app/room/[id]/search';
import { fakeStack } from '../test-utils/router';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
// 대화방 → 방 정보 → 검색까지 쌓인 스택(실제 StackRouter처럼 움직이는 가짜).
const start = () => fakeStack([{ name: '/(tabs)', params: {} }, { name: '/room/[id]', params: { id: 'r1' } }, { name: '/room/[id]/info', params: { id: 'r1' } }, { name: '/room/[id]/search', params: { id: 'r1' } }]);
let mockRouter = start();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ id: 'r1' }) }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));
const mockFrom = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => mockFrom(...a) } }));
jest.mock('../lib/rooms', () => ({
  ...jest.requireActual('../lib/rooms'),
  fetchRoom: () => Promise.resolve({ room: { id: 'r1', kind: 'group', title: '팀플', relation: '팀원' }, members: [{ user_id: 'me', name: '나나', last_read_at: null, muted: false }, { user_id: 'u2', name: '민수', last_read_at: null, muted: false }] }),
}));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const calls: Record<string, unknown[]> = {};
function fakeQuery(rows: unknown[]) {
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const k of ['select', 'eq', 'ilike', 'order']) q[k] = (...a) => ((calls[k] = a), q);
  q.limit = (...a) => ((calls.limit = a), Promise.resolve({ data: rows, error: null }));
  return q;
}
const row = (id: number, sender: string, text: string) => ({ id, room_id: 'r1', sender_id: sender, text, image_path: null, created_at: '2026-10-27 01:32:17.123456+00' });

async function setup(rows: unknown[]) {
  mockFrom.mockImplementation(() => fakeQuery(rows));
  const root = createRoot();
  await act(async () => root.render(<RoomSearch />));
  const find = (p: (n: TestInstance) => boolean) => root.container.queryAll(p);
  const search = async (q: string) => {
    await act(async () => find((n) => n.props.accessibilityLabel === '대화 검색어' && typeof n.props.onChangeText === 'function')[0].props.onChangeText(q));
    await act(async () => find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '검색')[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  };
  return { root, find, search, texts: () => textOf(root.container as unknown as TestNode) };
}

beforeEach(() => {
  Platform.OS = 'web';
  Object.keys(calls).forEach((k) => delete calls[k]);
  mockRouter = start();
  mockFrom.mockReset();
});

test('쿼리: 방 · 이스케이프된 ilike · 최신순 · 50개', async () => {
  const { search } = await setup([]);
  await search('50%');
  expect(calls.eq).toEqual(['room_id', 'r1']);
  expect(calls.ilike).toEqual(['text', '%50\\%%']);
  expect(calls.order).toEqual(['id', { ascending: false }]);
  expect(calls.limit).toEqual([50]);
});

test('결과: 보낸 사람 · 개수 안내(polite)', async () => {
  const { search, texts } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  await search('50%');
  expect(texts()).toContain('민수');
  expect(texts()).toContain('1개 찾았어요');
});

test('없으면 "찾는 말이 없어요"', async () => {
  const { search, texts } = await setup([]);
  await search('zzz');
  expect(texts()).toContain('찾는 말이 없어요');
});

test('와일드카드 *로 걸린 가짜 결과는 거른다', async () => {
  const { search, texts } = await setup([row(1, 'u2', 'axb'), row(2, 'u2', 'a*b')]);
  await search('a*b');
  expect(texts()).toContain('1개 찾았어요');
});

test('결과를 누르면 아래에 있던 그 대화방으로 돌아가 그 메시지로(?at=): 방이 두 번 쌓이지 않고, 뒤로 가면 검색이 아니라 대화 목록', async () => {
  const { search, find } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  await search('50%');
  await act(async () => find((n) => n.props.accessibilityRole === 'button' && String(n.props.accessibilityLabel).startsWith('민수'))[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(mockRouter.dismissTo).toHaveBeenCalledWith({ pathname: '/room/[id]', params: { id: 'r1', at: '5', k: expect.any(String) } });
  expect(mockRouter.stack.map((r) => r.name)).toEqual(['/(tabs)', '/room/[id]']);
  expect(mockRouter.stack[1].params).toMatchObject({ id: 'r1', at: '5' });
});

test('빈 검색어는 요청하지 않는다', async () => {
  const { search } = await setup([]);
  await search('  ');
  expect(mockFrom).not.toHaveBeenCalled();
});

const liveText = (find: (p: (n: TestInstance) => boolean) => TestInstance[]) => find((n) => n.props['aria-live'] === 'polite').map((n) => textOf(n as unknown as TestNode)).join('|');

test('개수 안내 영역은 처음부터 있고, 같은 검색을 또 해도 문구가 바뀐다', async () => {
  const { search, find } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  expect(find((n) => n.props['aria-live'] === 'polite').length).toBeGreaterThan(0);
  await search('50%');
  const a = liveText(find);
  expect(a).toContain('1개 찾았어요');
  await search('50%');
  const b = liveText(find);
  expect(b).toContain('1개 찾았어요');
  expect(b).not.toBe(a);
});

test('결과는 list/listitem, 전체는 search 영역', async () => {
  const { search, find } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  await search('50%');
  expect(find((n) => n.props.role === 'list')).toHaveLength(1);
  expect(find((n) => n.props.role === 'listitem')).toHaveLength(1);
  expect(find((n) => n.props.role === 'search').length).toBeGreaterThan(0);
});

test('50개가 차면 "최근 50개만 보여요"', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, 'u2', `50% ${i}`));
  const { search, texts } = await setup(rows);
  await search('50%');
  expect(texts()).toContain('최근 50개만 보여요');
});

test('오류가 나면 이전 결과를 지운다', async () => {
  const { search, texts, find } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  await search('50%');
  mockFrom.mockImplementation(() => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'ilike', 'order']) q[k] = () => q;
    q.limit = () => Promise.resolve({ data: null, error: { message: 'x' } });
    return q;
  });
  await search('50%');
  expect(texts()).not.toContain('오늘 50% 할인');
  expect(find((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
});

test('검색 중을 알리고 입력창이 자동 포커스', async () => {
  const { find } = await setup([]);
  expect(find((n) => n.props.accessibilityLabel === '대화 검색어' && n.props.autoFocus === true && n.props.blurOnSubmit === false).length).toBeGreaterThan(0); // 제출해도 포커스가 body로 떨어지지 않는다
});

afterEach(() => {
  Platform.OS = 'ios';
});

test('iOS: 결과 개수를 announceForAccessibility로 알린다', async () => {
  Platform.OS = 'ios';
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  spy.mockClear();
  const { search } = await setup([row(5, 'u2', '오늘 50% 할인')]);
  await search('50%');
  expect(spy).toHaveBeenCalledWith('검색 중');
  expect(spy).toHaveBeenCalledWith('1개 찾았어요');
});
