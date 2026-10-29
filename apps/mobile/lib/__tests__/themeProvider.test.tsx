import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { useColorScheme } from 'react-native';
import { createRoot } from 'test-renderer';

import { ThemeProvider, useTheme, useThemePref } from '../theme';
import tokens from '../tokens.json';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn(() => 'light') }));
const mockSystem = (s: 'light' | 'dark' | null) => (useColorScheme as jest.Mock).mockReturnValue(s);

async function mount() {
  let seen!: { theme: ReturnType<typeof useTheme>; pref: ReturnType<typeof useThemePref> };
  const Probe = () => {
    seen = { theme: useTheme(), pref: useThemePref() };
    return null;
  };
  const root = createRoot();
  await act(async () => root.render(<ThemeProvider><Probe /></ThemeProvider>));
  return { get: () => seen };
}

beforeEach(async () => {
  mockSystem('light');
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

test('before anything is saved the pref is system and colors follow the OS', async () => {
  mockSystem('dark');
  const { get } = await mount();
  expect(get().pref.pref).toBe('system');
  expect(get().theme.colors).toEqual(tokens.dark);
  expect(get().theme.scheme).toBe('dark');
});

test('setPref switches useTheme at once (even against the OS) and saves it under theme.v1', async () => {
  const { get } = await mount();
  await act(async () => get().pref.setPref('dark'));
  expect(get().theme.colors).toEqual(tokens.dark);
  expect(await AsyncStorage.getItem('theme.v1')).toBe('dark');
  await act(async () => get().pref.setPref('light'));
  expect(get().theme.colors).toEqual(tokens.light);
});

test('a saved pref is loaded on mount', async () => {
  await AsyncStorage.setItem('theme.v1', 'dark');
  const { get } = await mount();
  expect(get().pref.pref).toBe('dark');
  expect(get().theme.scheme).toBe('dark');
});

test('a garbage saved value is ignored (stays system)', async () => {
  await AsyncStorage.setItem('theme.v1', 'purple');
  const { get } = await mount();
  expect(get().pref.pref).toBe('system');
});

test('storage that throws never breaks the app: read falls back to system, write still switches the theme', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('blocked'));
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('blocked'));
  const { get } = await mount();
  expect(get().pref.pref).toBe('system');
  await act(async () => get().pref.setPref('dark'));
  expect(get().theme.scheme).toBe('dark');
});

test('a late read result does not overwrite a choice made while it was pending', async () => {
  let finishRead: (v: string | null) => void = () => {};
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => new Promise((r) => (finishRead = r)));
  const { get } = await mount();
  await act(async () => get().pref.setPref('light'));
  await act(async () => finishRead('dark'));
  expect(get().pref.pref).toBe('light');
});

test('useTheme still works without a provider (existing screens/tests): follows the OS', async () => {
  mockSystem('dark');
  let seen!: ReturnType<typeof useTheme>;
  const Probe = () => {
    seen = useTheme();
    return null;
  };
  await act(async () => createRoot().render(<Probe />));
  expect(seen.colors).toEqual(tokens.dark);
});

test('native keeps the bare Pretendard name (the family registered with expo-font)', async () => {
  const { get } = await mount();
  expect(get().theme.font.family).toBe('Pretendard');
});
