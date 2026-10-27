import { act } from 'react';
import { createRoot } from 'test-renderer';

import Profile from '../app/profile';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockInsert = jest.fn();
const mockRefresh = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { from: (t: string) => ({ insert: (row: unknown) => mockInsert(t, row) }) } }));

// 진짜 SessionProvider처럼 값이 바뀌면 화면이 다시 그려지도록 구독 가능한 가짜 저장소로 만든다.
const mockSession = { failed: false, listeners: new Set<() => void>() };
const setProfileFailed = (v: boolean) => {
  mockSession.failed = v;
  mockSession.listeners.forEach((l) => l());
};
jest.mock('../lib/session', () => {
  const { useSyncExternalStore } = jest.requireActual('react');
  const subscribe = (l: () => void) => (mockSession.listeners.add(l), () => void mockSession.listeners.delete(l));
  return { useSession: () => ({ userId: 'u1', refreshProfile: mockRefresh, profileFailed: useSyncExternalStore(subscribe, () => mockSession.failed) }) };
});

const LOAD_FAILED = '프로필을 불러오지 못했어요';

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Profile />);
  });
  const field = () => root.container.queryAll((n) => n.props.accessibilityLabel === '이름' && typeof n.props.onChangeText === 'function')[0];
  const type = (text: string) => act(async () => field().props.onChangeText(text));
  const press = (label: string) =>
    act(async () =>
      root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }),
    );
  const save = () => press('시작하기');
  const texts = () => JSON.stringify(root.container.toJSON());
  return { field, type, save, press, texts };
}

beforeEach(() => {
  mockInsert.mockReset().mockResolvedValue({ error: null });
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockSession.failed = false;
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

test('profile: 저장하는 중에 다시 제출(Enter)해도 한 번만 넣는다', async () => {
  mockInsert.mockReturnValue(new Promise(() => {}));
  const { type, save, field } = await setup();
  await type('지은');
  await save();
  await act(async () => field().props.onSubmitEditing());
  expect(mockInsert).toHaveBeenCalledTimes(1);
});

test('profile: 프로필을 못 불러왔으면 이름 입력 대신 안내와 다시 불러오기를 보여 준다', async () => {
  mockSession.failed = true;
  const { field, press, texts } = await setup();
  expect(texts()).toContain(LOAD_FAILED);
  expect(field()).toBeUndefined(); // 이미 이름이 있는 사람이 새 이름을 정하게 하지 않는다
  await press('다시 불러오기');
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(mockInsert).not.toHaveBeenCalled();
});

test('profile: 저장한 뒤 다시 읽기가 실패하면 같은 안내가 뜬다(말없이 멈추지 않는다)', async () => {
  mockRefresh.mockImplementation(async () => setProfileFailed(true)); // 세션이 profileFailed를 켠다
  const { type, save, texts } = await setup();
  await type('지은');
  await save();
  expect(texts()).toContain(LOAD_FAILED);
});

test('profile: 다시 불러오는 중에 한 번 더 눌러도 한 번만 읽는다', async () => {
  mockSession.failed = true;
  mockRefresh.mockReturnValue(new Promise(() => {}));
  const { press } = await setup();
  await press('다시 불러오기');
  await press('다시 불러오기');
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});
