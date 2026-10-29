import { act } from 'react';
import { createRoot, type TestNode } from 'test-renderer';

import Chats from '../app/(tabs)/index';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

let mockSupabase: unknown = {};
jest.mock('../lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

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
  mockSupabase = {};
  mockRouter.push.mockReset();
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
