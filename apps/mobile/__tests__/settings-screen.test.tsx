import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
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

const mockEnable = jest.fn();
const mockDisable = jest.fn();
let mockPushOn = false;
let mockDenied = false;
let mockEnabledRead: Promise<boolean> | null = null;
jest.mock('../lib/push', () => ({
  enablePush: (id: string) => mockEnable(id),
  disablePush: (id: string) => mockDisable(id),
  pushEnabled: () => mockEnabledRead ?? Promise.resolve(mockPushOn),
  pushDenied: async () => mockDenied,
}));
let mockIos = 'not-ios';
jest.mock('../lib/iosWeb', () => ({ currentIosWebState: () => mockIos }));

const NOTE = '힌트를 끄면 보내기를 눌러도 문장을 AI에 보내지 않아요.';

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
  const pushSwitch = () => find((p) => p.accessibilityLabel === '새 메시지 알림' && p.accessibilityRole === 'switch')[0];
  const flipPush = (to: boolean) => act(async () => (pushSwitch().props.onChange as (e: unknown) => void)({ nativeEvent: { value: to }, target: { value: to } }));
  const chip = (label: string) => find((p) => p.accessibilityRole === 'radio' && p.accessibilityLabel === label)[0];
  return { root, find, texts, hintSwitch, flip, press, chip, pushSwitch, flipPush };
}

beforeEach(async () => {
  mockProfile = { id: 'u1', name: '지은', tone_hint_on: true };
  mockSupabase = { from: (t: string) => ({ update: (row: unknown) => (t === 'profiles' ? mockUpdate(row) : null) }), auth: { signOut: mockSignOut } };
  mockUpdate.mockClear();
  mockEq.mockReset().mockResolvedValue({ error: null });
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockSignOut.mockReset().mockResolvedValue({ error: null });
  await AsyncStorage.clear();
  mockPushOn = false;
  mockDenied = false;
  mockEnabledRead = null;
  mockIos = 'not-ios';
  mockEnable.mockReset().mockResolvedValue('enabled');
  mockDisable.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test('settings: the three sections are headed 힌트 · 화면 · 계정', async () => {
  const { find } = await setup();
  const headers = find((p) => p.accessibilityRole === 'header').map((n) => JSON.stringify(n.children));
  for (const h of ['힌트', '알림', '화면', '계정']) expect(headers.some((j) => j.includes(h))).toBe(true);
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

test('settings a11y: 실패 문구는 alert 역할, 저장 중에도 스위치는 disabled가 아니다(포커스 유지)', async () => {
  let release!: (v: unknown) => void;
  mockEq.mockReturnValue(new Promise((r) => (release = r)));
  const { flip, hintSwitch, find } = await setup();
  await flip(false);
  expect(hintSwitch().props.disabled).toBeFalsy();
  mockEq.mockResolvedValue({ error: { message: 'rls' } });
  await act(async () => release({ error: { message: 'rls' } }));
  expect(find((p) => p.accessibilityRole === 'alert').length).toBeGreaterThan(0);
});

test('settings a11y: 화면 제목은 aria-level 1, 구역 제목은 2', async () => {
  const { find } = await setup();
  const levels = find((p) => p.accessibilityRole === 'header').map((n) => n.props['aria-level']);
  expect(levels).toContain(1);
  expect(levels.filter((l) => l === 2).length).toBe(4);
});

describe('settings push', () => {
  // Android 스위치는 value/disabled 대신 on/enabled를 쓴다
  const isOn = (n: { props: Record<string, unknown> }) => Boolean(n.props.value ?? n.props.on);
  const isDisabled = (n: { props: Record<string, unknown> }) => Boolean(n.props.disabled) || n.props.enabled === false;
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'android'));
  beforeEach(() => (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear?.()); // 이전 시험의 호출 기록이 남지 않게
  test('nothing is requested on screen open; the switch starts off', async () => {
    const { pushSwitch } = await setup();
    expect(mockEnable).not.toHaveBeenCalled();
    expect(isOn(pushSwitch())).toBe(false);
  });

  test('switch reflects an already-registered device', async () => {
    mockPushOn = true;
    const { pushSwitch } = await setup();
    expect(isOn(pushSwitch())).toBe(true);
  });

  test('turning on registers for my user, turns on and announces once', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios'); // iOS는 announceForAccessibility로만 읽힌다(스위치는 비활성이라 핸들러만 직접 부른다)
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const { flipPush, pushSwitch } = await setup();
    await flipPush(true);
    expect(mockEnable).toHaveBeenCalledWith('u1');
    expect(isOn(pushSwitch())).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('알림을 켰어요');
  });

  test.each([
    ['denied', '알림을 허용'],
    ['unsupported', '이 기기에서는 알림을 받지 못할 수도 있어요'],
    ['needs-install', '홈 화면에 추가'],
    ['error', '알림을 켜지 못했어요'],
  ])('%s → stays off, shows a hedged alert line (announced once on iOS)', async (result, text) => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    mockEnable.mockResolvedValue(result);
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const { flipPush, pushSwitch, texts, find } = await setup();
    await flipPush(true);
    expect(isOn(pushSwitch())).toBe(false);
    expect(texts()).toContain(text);
    expect(find((p) => p.accessibilityRole === 'alert').length).toBeGreaterThan(0);
    expect(say).toHaveBeenCalledTimes(1);
  });

  test('turning off releases this device and announces', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    mockPushOn = true;
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const { flipPush, pushSwitch } = await setup();
    await flipPush(false);
    expect(mockDisable).toHaveBeenCalledWith('u1');
    expect(isOn(pushSwitch())).toBe(false);
    expect(say).toHaveBeenCalledWith('알림을 껐어요');
  });

  test('a failed release keeps the switch on and says so', async () => {
    mockPushOn = true;
    mockDisable.mockRejectedValue(new Error('net'));
    const { flipPush, pushSwitch, texts } = await setup();
    await flipPush(false);
    expect(isOn(pushSwitch())).toBe(true);
    expect(texts()).toContain('알림을 끄지 못했어요');
  });

  test('iPhone Safari not installed → hedged home-screen hint, no delivery promise', async () => {
    mockIos = 'needs-install';
    const { texts } = await setup();
    expect(texts()).toContain('홈 화면에 추가');
    expect(texts()).toContain('않을 수도');
  });

  test('no iOS hint elsewhere; no supabase → switch disabled', async () => {
    const a = await setup();
    expect(a.texts()).not.toContain('홈 화면에 추가');
    mockSupabase = null;
    const b = await setup();
    expect(isDisabled(b.pushSwitch())).toBe(true);
  });

  const IDS = (n: Record<string, unknown>) => String(n['aria-describedby'] ?? '').split(/\s+/).filter(Boolean);

  test('disconnected: the reason sits under the push row and the switch points at it', async () => {
    mockSupabase = null;
    const { pushSwitch, find } = await setup();
    expect(isDisabled(pushSwitch())).toBe(true);
    const ids = IDS(pushSwitch().props);
    expect(ids.length).toBeGreaterThan(0);
    const reason = find((p) => ids.includes(String(p.nativeID)) && JSON.stringify(p.children ?? '').includes('서버에 연결되어 있지 않아'));
    expect(reason.length).toBeGreaterThan(0);
  });

  test('a short explanation sits under the switch and is its description', async () => {
    const { pushSwitch, find, texts } = await setup();
    expect(texts()).toContain('브라우저가 허용 여부를 물어볼 수 있어요');
    expect(find((p) => IDS(pushSwitch().props).includes(String(p.nativeID))).length).toBeGreaterThan(0);
  });

  test('already denied on web: after a reload the how-to shows without pressing, as plain text', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    mockDenied = true;
    const { texts, find } = await setup();
    expect(texts()).toContain('주소창 왼쪽 사이트 설정');
    expect(find((p) => p.accessibilityRole === 'alert' && JSON.stringify(p.children ?? '').includes('사이트 설정')).length).toBe(0);
  });

  test('already denied on Android: points at the system app settings', async () => {
    mockDenied = true;
    const { texts } = await setup();
    expect(texts()).toContain('설정 → 앱 → tone-chat → 알림');
  });

  test('pending: visible 켜는 중…, aria-busy on the switch, not disabled, a second tap is ignored', async () => {
    let finish!: (r: string) => void;
    mockEnable.mockReturnValue(new Promise((r) => (finish = r)));
    const { flipPush, pushSwitch, texts } = await setup();
    await flipPush(true);
    expect(texts()).toContain('켜는 중…');
    expect(pushSwitch().props['aria-busy']).toBe(true);
    expect(isDisabled(pushSwitch())).toBe(false);
    await flipPush(true);
    expect(mockEnable).toHaveBeenCalledTimes(1);
    await act(async () => finish('enabled'));
    expect(texts()).not.toContain('켜는 중…');
    expect(pushSwitch().props['aria-busy']).toBeFalsy();
  });

  test('switch stays disabled until the stored state has been read', async () => {
    mockEnabledRead = new Promise(() => {});
    const { pushSwitch } = await setup();
    expect(isDisabled(pushSwitch())).toBe(true);
  });

  test('one tab stop per row: both label rows are hidden from the tab order and the a11y tree', async () => {
    const { find } = await setup();
    const labels = find((p) => p.accessible === false && typeof p.onClick === 'function');
    expect(labels.length).toBe(2);
    for (const l of labels) {
      expect(l.props.tabIndex).toBe(-1);
      expect(l.props['aria-hidden']).toBe(true);
    }
  });

  test('iPhone not-installed hint is the switch description too', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    mockIos = 'needs-install';
    const { pushSwitch, find } = await setup();
    expect(find((p) => IDS(pushSwitch().props).includes(String(p.nativeID)) && JSON.stringify(p.children ?? '').includes('홈 화면에 추가')).length).toBeGreaterThan(0);
  });

  test('native iOS: the switch is disabled with the reason (iPhone uses the web app)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const { pushSwitch, texts } = await setup();
    expect(isDisabled(pushSwitch())).toBe(true);
    expect(texts()).toContain('웹');
  });
});
