import AsyncStorage from '@react-native-async-storage/async-storage';

import { signOutAndClear } from '../account';

let mockSupabase: unknown = null;
jest.mock('../supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const mockDisablePush = jest.fn();
jest.mock('../push', () => ({ disablePush: (id: string) => mockDisablePush(id) }));

const signOut = jest.fn();
const getSession = jest.fn();
beforeEach(async () => {
  signOut.mockReset().mockResolvedValue({ error: null });
  mockDisablePush.mockReset().mockResolvedValue(undefined);
  getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
  mockSupabase = { auth: { signOut, getSession } };
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['consent', '1'],
    ['theme.v1', 'dark'],
    ['draft:room-1', '나중에 보낼 문장'],
    ['sb-abc-auth-token', '{}'],
  ]);
});
afterEach(() => jest.restoreAllMocks());

test('signs out of this device only, then clears per-user keys but keeps consent and the theme', async () => {
  await expect(signOutAndClear()).resolves.toBe(true);
  expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  expect((await AsyncStorage.getAllKeys()).slice().sort()).toEqual(['consent', 'theme.v1']);
});

test('if sign-out fails nothing is cleared (the user is still signed in) and it reports false', async () => {
  signOut.mockResolvedValue({ error: new Error('network') });
  await expect(signOutAndClear()).resolves.toBe(false);
  expect(await AsyncStorage.getAllKeys()).toHaveLength(4);
});

test('a throwing sign-out also reports false', async () => {
  signOut.mockRejectedValue(new Error('boom'));
  await expect(signOutAndClear()).resolves.toBe(false);
  expect(await AsyncStorage.getAllKeys()).toHaveLength(4);
});

test('a storage failure while clearing does not turn a successful sign-out into a failure', async () => {
  jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('blocked'));
  await expect(signOutAndClear()).resolves.toBe(true);
});

test('no supabase client (no keys) → false, nothing touched', async () => {
  mockSupabase = null;
  await expect(signOutAndClear()).resolves.toBe(false);
  expect(await AsyncStorage.getAllKeys()).toHaveLength(4);
});

test('sign-out clears cached signed photo URLs', async () => {
  const images = require('../images');
  const spy = jest.spyOn(images, 'clearSignedUrls');
  await signOutAndClear();
  expect(spy).toHaveBeenCalled();
});

test('releases this device push token BEFORE the session is gone', async () => {
  const order: string[] = [];
  mockDisablePush.mockImplementation(async () => void order.push('release'));
  signOut.mockImplementation(async () => (order.push('signOut'), { error: null }));
  await signOutAndClear();
  expect(mockDisablePush).toHaveBeenCalledWith('u1');
  expect(order).toEqual(['release', 'signOut']);
});

test('a failing push release does not block sign-out', async () => {
  mockDisablePush.mockRejectedValue(new Error('net'));
  await expect(signOutAndClear()).resolves.toBe(true);
});

test('a hanging push release is abandoned after a few seconds', async () => {
  jest.useFakeTimers();
  mockDisablePush.mockReturnValue(new Promise(() => {}));
  const p = signOutAndClear();
  await jest.advanceTimersByTimeAsync(5000);
  await expect(p).resolves.toBe(true);
  jest.useRealTimers();
});
