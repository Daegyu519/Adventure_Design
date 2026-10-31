import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SplashScreen from 'expo-splash-screen';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import RootLayout from '../app/_layout';
import tokens from '../lib/tokens.json';

// 글꼴·스플래시·라우터는 가짜로 바꾼다. 가짜 Stack.Protected는 진짜처럼 guard가 거짓이면 화면을 아예 그리지 않는다.
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(), hide: jest.fn() }));
const mockStatusBar = jest.fn((_p: { style?: string }) => null);
jest.mock('expo-status-bar', () => ({ StatusBar: (p: { style?: string }) => mockStatusBar(p) }));
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  const Stack = ({ children }: { children: unknown }) => <View>{children}</View>;
  Stack.Protected = ({ guard, children }: { guard: boolean; children: unknown }) => (guard ? children : null);
  Stack.Screen = ({ name, dangerouslySingular }: { name: string; dangerouslySingular?: unknown }) => <View testID={`screen:${name}`} singular={dangerouslySingular} />;
  return { Stack };
});

const mockPushTaps = jest.fn();
jest.mock('../lib/push', () => ({ usePushTaps: () => mockPushTaps() }));

let mockConsented: boolean | null = null;
jest.mock('../lib/consent', () => ({ useConsented: () => mockConsented }));

let mockSupabase: unknown = null;
jest.mock('../lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

type Sess = { user: { id: string; email?: string } } | null;
const SESSION: Sess = { user: { id: 'u1', email: 'a@b.co' } };
const ROW = { id: 'u1', name: '지은', created_at: '2026-10-27T00:00:00Z', tone_hint_on: true };

// 세션·프로필 읽기를 우리가 풀어 줄 때까지 멈춰 둘 수 있는 가짜 supabase
function fakeSupabase() {
  let finishSession: (s: Sess) => void = () => {};
  let finishProfile: (row: typeof ROW | null) => void = () => {};
  mockSupabase = {
    auth: {
      getSession: () => new Promise((r) => (finishSession = (s) => r({ data: { session: s }, error: null }))),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => new Promise((r) => (finishProfile = (row) => r({ data: row, error: null }))) }) }),
    }),
  };
  return { session: (s: Sess) => act(async () => finishSession(s)), profile: (row: typeof ROW | null) => act(async () => finishProfile(row)) };
}

async function mount() {
  const root = createRoot();
  await act(async () => {
    root.render(<RootLayout />);
  });
  const screens = () =>
    root.container
      .queryAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('screen:'))
      .map((n) => String(n.props.testID).slice('screen:'.length));
  // 읽는 동안에는 화면 대신 바탕색만 칠한 빈 화면을 그린다(스플래시가 걷힌 뒤 흰 프레임이 번쩍이지 않게).
  const blank = () => root.container.queryAll((n) => n.props.style?.flex === 1 && n.props.style?.backgroundColor === tokens.light.background);
  return { root, screens, blank };
}

beforeEach(async () => {
  mockConsented = null;
  mockSupabase = null;
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

test('layout: consent not read yet → only the background-colored blank view, and the splash stays', async () => {
  const { screens, blank } = await mount();
  expect(blank()).toHaveLength(1);
  expect(screens()).toEqual([]);
  expect(SplashScreen.hide).not.toHaveBeenCalled();
});

test('layout: not consented → only the consent screen, even with keys', async () => {
  mockConsented = false;
  fakeSupabase();
  const { screens } = await mount();
  expect(screens()).toEqual(['consent']);
  expect(SplashScreen.hide).toHaveBeenCalled();
});

test('layout: no supabase keys → straight to the tabs, no login', async () => {
  mockConsented = true;
  const { screens } = await mount();
  expect(screens()).toEqual(['(tabs)', 'room/[id]/index', 'room/[id]/info', 'room/[id]/search']);
});

test('layout: keys + session still loading → blank (no login flash), then login once known to be signed out', async () => {
  mockConsented = true;
  const fake = fakeSupabase();
  const { screens, blank } = await mount();
  expect(blank()).toHaveLength(1);
  expect(screens()).toEqual([]);
  expect(SplashScreen.hide).not.toHaveBeenCalled();
  await fake.session(null);
  expect(blank()).toHaveLength(0);
  expect(screens()).toEqual(['login']);
  expect(SplashScreen.hide).toHaveBeenCalled();
});

test('layout: signed in → blank while the profile loads, then profile screen', async () => {
  mockConsented = true;
  const fake = fakeSupabase();
  const { screens, blank } = await mount();
  await fake.session(SESSION);
  expect(blank()).toHaveLength(1); // 로그인 화면도, 아무것도 없는 흰 프레임도 아니다
  expect(screens()).toEqual([]);
  await fake.profile(null);
  expect(screens()).toEqual(['profile']);
});

test('layout: signed in with a profile → tabs', async () => {
  mockConsented = true;
  const fake = fakeSupabase();
  const { screens } = await mount();
  await fake.session(SESSION);
  await fake.profile(ROW);
  expect(screens()).toEqual(['(tabs)', 'room/[id]/index', 'room/[id]/info', 'room/[id]/search']);
});

// 상태 표시줄 글자색은 시스템이 아니라 고른 테마를 따라야 한다(밝은 바탕에 흰 시계가 나오면 안 보인다).
const lastBarStyle = () => mockStatusBar.mock.calls.at(-1)?.[0].style;

test('layout: saved theme dark → light status bar content; saved light → dark content', async () => {
  mockConsented = false;
  await AsyncStorage.setItem('theme.v1', 'dark');
  await mount();
  expect(lastBarStyle()).toBe('light');
  jest.clearAllMocks();
  await AsyncStorage.setItem('theme.v1', 'light');
  await mount();
  expect(lastBarStyle()).toBe('dark');
});

test('layout: the blank loading view and the stack take the chosen theme background', async () => {
  mockConsented = null;
  await AsyncStorage.setItem('theme.v1', 'dark');
  const { root } = await mount();
  const dark = root.container.queryAll((n) => n.props.style?.flex === 1 && n.props.style?.backgroundColor === tokens.dark.background);
  expect(dark).toHaveLength(1);
});

test('layout: notification taps are not listened to before sign-in', async () => {
  mockConsented = true;
  const fake = fakeSupabase();
  await mount();
  await fake.session(null);
  expect(mockPushTaps).not.toHaveBeenCalled();
});

test('layout: notification taps are listened to once in the app', async () => {
  mockConsented = true;
  const fake = fakeSupabase();
  await mount();
  await fake.session(SESSION);
  await fake.profile(ROW);
  expect(mockPushTaps).toHaveBeenCalled();
});

// 같은 방 화면이 두 번 쌓이면 Realtime 채널을 나눠 써서 한쪽이 던지거나 조용히 멈춘다(AC-1). 방 화면은 id마다 하나.
test('layout: the room route is singular per room id (search params at/k do not make a second one)', async () => {
  mockConsented = true;
  const { root } = await mount();
  const singular = root.container.queryAll((n) => n.props.testID === 'screen:room/[id]/index')[0].props.singular as (name: string, p: Record<string, string>) => string;
  expect(typeof singular).toBe('function');
  expect(singular('room/[id]/index', { id: 'r1', at: '5', k: '9' })).toBe(singular('room/[id]/index', { id: 'r1' }));
  expect(singular('room/[id]/index', { id: 'r1' })).not.toBe(singular('room/[id]/index', { id: 'r2' }));
});
