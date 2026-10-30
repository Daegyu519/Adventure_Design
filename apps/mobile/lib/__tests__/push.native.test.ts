import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { disablePush, enablePush, pushEnabled, tapUrl } from '../push';

let mockSupabase: unknown = null;
jest.mock('../supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  useLastNotificationResponse: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}));
let mockIsDevice = true;
jest.mock('expo-device', () => ({ __esModule: true, get isDevice() { return mockIsDevice; } }));
const mockNotifications = jest.requireMock('expo-notifications');
let mockProjectId: string | undefined = 'proj-1';
jest.mock('expo-constants', () => ({ __esModule: true, default: { get expoConfig() { return { extra: { eas: { projectId: mockProjectId } } }; } } }));

const upsert = jest.fn();
const delEq2 = jest.fn();
const del = jest.fn(() => ({ eq: () => ({ eq: delEq2 }) }));
beforeEach(async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  mockIsDevice = true;
  mockProjectId = 'proj-1';
  upsert.mockReset().mockResolvedValue({ error: null });
  del.mockClear();
  delEq2.mockReset().mockResolvedValue({ error: null });
  mockSupabase = { from: (t: string) => (t === 'push_tokens' ? { upsert, delete: del } : null) };
  mockNotifications.getPermissionsAsync.mockReset().mockResolvedValue({ status: 'undetermined' });
  mockNotifications.requestPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  mockNotifications.getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: 'ExponentPushToken[abc]' });
  mockNotifications.setNotificationChannelAsync.mockClear();
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('android: asks permission, registers the Expo token and stores it for logout', async () => {
  await expect(enablePush('u1')).resolves.toBe('enabled');
  expect(mockNotifications.setNotificationChannelAsync).toHaveBeenCalledWith('messages', expect.objectContaining({ importance: 4 }));
  expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({ user_id: 'u1', token: 'ExponentPushToken[abc]', platform: 'android' }),
    { onConflict: 'user_id,token' },
  );
  expect(await AsyncStorage.getItem('push.token.v1')).toBe('ExponentPushToken[abc]');
  await expect(pushEnabled()).resolves.toBe(true);
});

test('permission denied → denied, nothing stored', async () => {
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
  await expect(enablePush('u1')).resolves.toBe('denied');
  expect(upsert).not.toHaveBeenCalled();
});

test('no EAS projectId → unsupported without prompting', async () => {
  mockProjectId = undefined;
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalled();
});

test('missing FCM config (token fetch throws) → unsupported, no crash', async () => {
  mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('FCM not configured'));
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  expect(upsert).not.toHaveBeenCalled();
});

test('simulator / iOS native → unsupported (iPhone uses web push)', async () => {
  mockIsDevice = false;
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  mockIsDevice = true;
  jest.replaceProperty(Platform, 'OS', 'ios');
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('upsert failure → error and nothing remembered', async () => {
  upsert.mockResolvedValue({ error: { message: 'rls' } });
  await expect(enablePush('u1')).resolves.toBe('error');
  expect(await AsyncStorage.getItem('push.token.v1')).toBeNull();
});

test('disablePush deletes this device row and forgets the token', async () => {
  await enablePush('u1');
  await disablePush('u1');
  expect(del).toHaveBeenCalled();
  expect(await AsyncStorage.getItem('push.token.v1')).toBeNull();
});

test('disablePush with a failed delete throws and keeps the token so it can be retried', async () => {
  await enablePush('u1');
  delEq2.mockResolvedValue({ error: { message: 'net' } });
  await expect(disablePush('u1')).rejects.toBeDefined();
  expect(await AsyncStorage.getItem('push.token.v1')).toBe('ExponentPushToken[abc]');
});

test('disablePush with nothing stored does nothing', async () => {
  await disablePush('u1');
  expect(del).not.toHaveBeenCalled();
});

test('tapUrl only accepts in-app room paths', () => {
  expect(tapUrl({ url: '/room/abc-1' })).toBe('/room/abc-1');
  for (const bad of ['https://evil.example', '//evil.example', '/room/../x', '/settings', 5, undefined]) expect(tapUrl({ url: bad })).toBeNull();
  expect(tapUrl(null)).toBeNull();
});
