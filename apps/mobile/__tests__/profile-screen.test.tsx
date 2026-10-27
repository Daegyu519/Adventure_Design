import { act } from 'react';
import { createRoot } from 'test-renderer';

import Profile from '../app/profile';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockInsert = jest.fn();
const mockRefresh = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { from: (t: string) => ({ insert: (row: unknown) => mockInsert(t, row) }) } }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'u1', refreshProfile: mockRefresh }) }));

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Profile />);
  });
  const field = () => root.container.queryAll((n) => n.props.accessibilityLabel === '이름' && typeof n.props.onChangeText === 'function')[0];
  const type = (text: string) => act(async () => field().props.onChangeText(text));
  const save = () =>
    act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button')[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  const texts = () => JSON.stringify(root.container.toJSON());
  return { type, save, texts };
}

beforeEach(() => {
  mockInsert.mockReset().mockResolvedValue({ error: null });
  mockRefresh.mockReset().mockResolvedValue(undefined);
});

test('profile: 빈 이름은 저장하지 않고 안내한다', async () => {
  const { type, save, texts } = await setup();
  await type('  ');
  await save();
  expect(mockInsert).not.toHaveBeenCalled();
  expect(texts()).toContain('이름을 적어 주세요');
});

test('profile: 21자는 저장하지 않는다', async () => {
  const { type, save, texts } = await setup();
  await type('가'.repeat(21));
  await save();
  expect(mockInsert).not.toHaveBeenCalled();
  expect(texts()).toContain('20자까지 쓸 수 있어요');
});

test('profile: 다듬은 이름으로 profiles에 내 id 한 행을 넣고 프로필을 다시 읽는다', async () => {
  const { type, save } = await setup();
  await type('  지은 ');
  await save();
  expect(mockInsert).toHaveBeenCalledWith('profiles', { id: 'u1', name: '지은' });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test('profile: 저장이 실패하면 안내하고 다시 읽지 않는다', async () => {
  mockInsert.mockResolvedValue({ error: { code: '42501', message: 'rls' } });
  const { type, save, texts } = await setup();
  await type('지은');
  await save();
  expect(texts()).toContain('저장하지 못했어요');
  expect(texts()).not.toContain('rls');
  expect(mockRefresh).not.toHaveBeenCalled();
});

test('profile: 이미 행이 있으면(기본 키 충돌 23505) 오류 대신 다시 읽어 앱으로 넘긴다', async () => {
  mockInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
  const { type, save, texts } = await setup();
  await type('지은');
  await save();
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(texts()).not.toContain('저장하지 못했어요');
});

test('profile: 이름을 로그에 남기지 않는다', async () => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  mockInsert.mockResolvedValue({ error: { code: '42501', message: 'x' } });
  const { type, save } = await setup();
  await type('비밀이름');
  await save();
  expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain('비밀이름');
  jest.restoreAllMocks();
});
