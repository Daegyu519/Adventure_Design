import * as SplashScreen from 'expo-splash-screen';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import RootLayout from '../app/_layout';
import tokens from '../lib/tokens.json';

// 글꼴·스플래시·라우터는 가짜로 바꾼다. 가짜 Stack.Protected는 진짜처럼 guard가 거짓이면 화면을 아예 그리지 않는다.
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(), hide: jest.fn() }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  const Stack = ({ children }: { children: unknown }) => <View>{children}</View>;
  Stack.Protected = ({ guard, children }: { guard: boolean; children: unknown }) => (guard ? children : null);
  Stack.Screen = ({ name }: { name: string }) => <View testID={`screen:${name}`} />;
  return { Stack };
});

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

beforeEach(() => {
  mockConsented = null;
  mockSupabase = null;
  jest.clearAllMocks();
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
  expect(screens()).toEqual(['(tabs)']);
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

test('layout: signed in → blank while the profile loads (after the splash is gone too), then profile screen', async () => {
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
  expect(screens()).toEqual(['(tabs)']);
});
