import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import Settings from '../app/(tabs)/settings';
import { ThemeProvider } from '../lib/theme';

// lucide는 ESM(.mjs)이라 jest가 못 읽는다. 아이콘 모양은 이 테스트와 관계없다.
jest.mock('lucide-react-native/icons/check', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockEq = jest.fn();
const mockUpdate = jest.fn((_row: unknown) => ({ eq: mockEq }));
const mockSignOut = jest.fn();
let mockSupabase: unknown = null;
jest.mock('../lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const mockRefresh = jest.fn();
let mockProfile: { id: string; name: string; tone_hint_on: boolean } | null = null;
jest.mock('../lib/session', () => ({
  useSession: () => ({ userId: 'u1', email: 'jieun@cnu.ac.kr', profile: mockProfile, refreshProfile: mockRefresh }),
}));

const NOTE = '힌트를 끄면 입력 중인 문장을 AI에 보내지 않아요.';

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
  });
  const find = (pred: (p: Record<string, unknown>) => boolean) => root.container.queryAll((n) => pred(n.props));
  const texts = () => JSON.stringify(root.container.toJSON());
  const hintSwitch = () => find((p) => p.accessibilityLabel === '보내기 전 말투 힌트' && p.accessibilityRole === 'switch')[0];
  const flip = (to: boolean) => act(async () => (hintSwitch().props.onChange as (e: unknown) => void)({ nativeEvent: { value: to }, target: { value: to } }));
  const press = (role: string, label: string) =>
    act(async () =>
      find((p) => p.accessibilityRole === role && p.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }),
    );
  const chip = (label: string) => find((p) => p.accessibilityRole === 'radio' && p.accessibilityLabel === label)[0];
  return { root, find, texts, hintSwitch, flip, press, chip };
}

beforeEach(async () => {
  mockProfile = { id: 'u1', name: '지은', tone_hint_on: true };
  mockSupabase = { from: (t: string) => ({ update: (row: unknown) => (t === 'profiles' ? mockUpdate(row) : null) }), auth: { signOut: mockSignOut } };
  mockUpdate.mockClear();
  mockEq.mockReset().mockResolvedValue({ error: null });
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  await AsyncStorage.clear();
});

test('settings: the three sections are headed 힌트 · 화면 · 계정', async () => {
  const { find } = await setup();
  const headers = find((p) => p.accessibilityRole === 'header').map((n) => JSON.stringify(n.children));
  for (const h of ['힌트', '화면', '계정']) expect(headers.some((j) => j.includes(h))).toBe(true);
});

test('settings hint: the switch shows profile.tone_hint_on; on → no explanation line', async () => {
  const { hintSwitch, texts } = await setup();
  expect(hintSwitch().props.value).toBe(true);
  expect(texts()).not.toContain(NOTE);
});

test('settings hint: turning it off updates my own profile row and re-reads the profile', async () => {
  const { flip } = await setup();
  await flip(false);
  expect(mockUpdate).toHaveBeenCalledWith({ tone_hint_on: false });
  expect(mockEq).toHaveBeenCalledWith('id', 'u1');
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test('settings hint: once the profile says off, the switch is off and the one-line note shows', async () => {
  mockProfile = { id: 'u1', name: '지은', tone_hint_on: false };
  const { hintSwitch, texts } = await setup();
  expect(hintSwitch().props.value).toBe(false);
  expect(texts()).toContain(NOTE);
});

test('settings hint: while saving the switch shows the new value and ignores a second tap', async () => {
  let finish: (v: { error: null }) => void = () => {};
  mockEq.mockReturnValue(new Promise((r) => (finish = r)));
  const { flip, hintSwitch, texts } = await setup();
  await flip(false);
  expect(hintSwitch().props.value).toBe(false);
  expect(texts()).toContain(NOTE);
  await flip(true); // 저장 중 두 번째 탭
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ error: null }));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test('settings hint: tapping the label toggles it too (bigger touch area)', async () => {
  const { find } = await setup();
  await act(async () => find((p) => p.accessible === false && typeof p.onClick === 'function')[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(mockUpdate).toHaveBeenCalledWith({ tone_hint_on: false });
});

test('settings hint: a failed save puts the switch back with a hedged message and no raw server text', async () => {
  mockEq.mockResolvedValue({ error: { message: 'rls' } });
  const { flip, hintSwitch, texts } = await setup();
  await flip(false);
  expect(hintSwitch().props.value).toBe(true); // 저장이 안 됐으니 원래 값
  expect(mockRefresh).not.toHaveBeenCalled();
  expect(texts()).toContain('바꾸지 못했어요');
  expect(texts()).not.toContain('rls');
});

test('settings hint: a thrown request is handled the same way (no crash)', async () => {
  mockEq.mockRejectedValue(new Error('offline'));
  const { flip, texts } = await setup();
  await flip(false);
  expect(texts()).toContain('바꾸지 못했어요');
});

test('settings hint: no supabase client → the switch is disabled and says why', async () => {
  mockSupabase = null;
  mockProfile = null;
  const { hintSwitch, texts } = await setup();
  expect(hintSwitch().props.disabled).toBe(true);
  expect(texts()).toContain('지금은 바꿀 수 없어요');
});

test('settings theme: three radio chips 시스템 · 밝게 · 어둡게; 시스템 is checked at first', async () => {
  const { chip } = await setup();
  expect(chip('시스템').props.accessibilityState).toMatchObject({ checked: true });
  expect(chip('밝게').props.accessibilityState).toMatchObject({ checked: false });
  expect(chip('어둡게').props.accessibilityState).toMatchObject({ checked: false });
});

test('settings theme: choosing 어둡게 checks it and saves it under theme.v1', async () => {
  const { press, chip } = await setup();
  await press('radio', '어둡게');
  expect(chip('어둡게').props.accessibilityState).toMatchObject({ checked: true });
  expect(chip('시스템').props.accessibilityState).toMatchObject({ checked: false });
  expect(await AsyncStorage.getItem('theme.v1')).toBe('dark');
});

test('settings account: shows email and name, and 로그아웃 signs out of this device', async () => {
  const { press, texts } = await setup();
  expect(texts()).toContain('jieun@cnu.ac.kr');
  expect(texts()).toContain('지은');
  await press('button', '로그아웃');
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
});

test('settings account: logout clears per-user keys but keeps consent and theme', async () => {
  await AsyncStorage.multiSet([
    ['consent', '1'],
    ['theme.v1', 'dark'],
    ['draft:room-1', '보내지 않은 문장'],
  ]);
  const { press } = await setup();
  await press('button', '로그아웃');
  expect((await AsyncStorage.getAllKeys()).slice().sort()).toEqual(['consent', 'theme.v1']);
});

test('settings account: a failed logout keeps the data and tells the user, hedged', async () => {
  mockSignOut.mockResolvedValue({ error: new Error('network') });
  await AsyncStorage.setItem('draft:room-1', '보내지 않은 문장');
  const { press, texts } = await setup();
  await press('button', '로그아웃');
  expect(texts()).toContain('로그아웃하지 못했어요');
  expect(await AsyncStorage.getItem('draft:room-1')).not.toBeNull();
});
