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
  return { byRole, press };
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
  await press('button');
  expect(await AsyncStorage.getItem('consent')).toBe('1');
});

test('consent screen: 체크를 다시 누르면 시작하기가 도로 꺼진다', async () => {
  const { byRole, press } = await setup();
  await press('checkbox');
  await press('checkbox');
  expect(byRole('button').props.accessibilityState.disabled).toBe(true);
});
