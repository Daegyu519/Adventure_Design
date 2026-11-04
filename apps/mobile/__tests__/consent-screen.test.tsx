import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import Consent from '../app/consent';

// lucide는 ESM(.mjs)이라 jest가 못 읽는다. 아이콘 모양은 이 테스트와 관계없다.
jest.mock('lucide-react-native/icons/check', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

beforeEach(() => AsyncStorage.clear());

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Consent />);
  });
  const byRole = (role: string) => root.container.queryAll((n) => n.props.accessibilityRole === role)[0];
  const press = (role: string) => act(async () => byRole(role).props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { root, byRole, press };
}

test('consent screen: 체크 전 시작하기는 비활성이고 눌러도 저장되지 않는다', async () => {
  const { byRole, press } = await setup();
  expect(byRole('checkbox').props.accessibilityState.checked).toBe(false);
  expect(byRole('button').props.accessibilityState.disabled).toBe(true);
  await press('button');
  expect(await AsyncStorage.getItem('consent')).toBeNull();
});

test('consent screen: 체크하면 시작하기가 켜지고, 누르면 동의가 저장된다', async () => {
  const { byRole, press } = await setup();
  await press('checkbox');
  expect(byRole('checkbox').props.accessibilityState.checked).toBe(true);
  expect(byRole('button').props.accessibilityState.disabled).toBe(false);
  expect(byRole('button').props.accessibilityState.busy).toBe(false);
  await press('button');
  expect(await AsyncStorage.getItem('consent')).toBe('2');
  expect(byRole('button').props.accessibilityState.busy).toBe(true); // 저장하는 동안. 웹의 aria-busy는 브라우저에서 확인
});

test('consent screen: 체크를 다시 누르면 시작하기가 도로 꺼진다', async () => {
  const { byRole, press } = await setup();
  await press('checkbox');
  await press('checkbox');
  expect(byRole('button').props.accessibilityState.disabled).toBe(true);
});

test('consent screen: 체크 상자는 Space 키로도 토글된다(웹 키보드)', async () => {
  const { byRole } = await setup();
  await act(async () => byRole('checkbox').props.onKeyDown({ nativeEvent: { key: ' ' }, preventDefault() {} }));
  expect(byRole('checkbox').props.accessibilityState.checked).toBe(true);
  await act(async () => byRole('checkbox').props.onKeyDown({ nativeEvent: { key: 'a' }, preventDefault() {} }));
  expect(byRole('checkbox').props.accessibilityState.checked).toBe(true);
});

test('consent screen: Space를 누르고 있어도(repeat) 한 번만 토글되고 페이지는 스크롤되지 않는다', async () => {
  const { byRole } = await setup();
  let prevented = 0;
  const key = (repeat: boolean) =>
    act(async () => byRole('checkbox').props.onKeyDown({ nativeEvent: { key: ' ', repeat }, preventDefault: () => prevented++ }));
  await key(false); // 처음 누름 -> 체크
  await key(true); // 누르고 있는 동안 반복 -> 무시(반복도 토글하면 다시 꺼진다)
  expect(byRole('checkbox').props.accessibilityState.checked).toBe(true);
  expect(prevented).toBe(2);
});

test('consent screen: 제목은 h1(aria-level 1), 절 제목은 h2', async () => {
  const { root } = await setup();
  const levels = root.container.queryAll((n) => n.props.accessibilityRole === 'header').map((n) => n.props['aria-level']);
  expect(levels).toEqual([1, 2, 2]);
});
