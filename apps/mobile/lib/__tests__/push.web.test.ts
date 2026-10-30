import AsyncStorage from '@react-native-async-storage/async-storage';

import { disablePush, enablePush, pushEnabled } from '../push.web';

let mockSupabase: unknown = null;
jest.mock('../supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));
let mockIos = 'not-ios';
jest.mock('../iosWeb', () => ({ currentIosWebState: () => mockIos }));

const upsert = jest.fn();
const delEq2 = jest.fn();
const del = jest.fn(() => ({ eq: () => ({ eq: delEq2 }) }));

const unsubscribe = jest.fn();
const sub = { endpoint: 'https://fcm.googleapis.com/x', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }), unsubscribe };
const subscribe = jest.fn();
const getSubscription = jest.fn();
const register = jest.fn();
let perm = 'default';
const requestPermission = jest.fn();

function setBrowser(on: boolean) {
  const g = globalThis as Record<string, unknown>;
  if (!on) {
    delete g.navigator;
    delete g.PushManager;
    g.navigator = {};
    return;
  }
  g.navigator = { serviceWorker: { register, ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) } };
  g.PushManager = class {};
  g.Notification = { get permission() { return perm; }, requestPermission };
}

const KEY = 'AQID';
beforeEach(async () => {
  process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY = KEY;
  mockIos = 'not-ios';
  perm = 'default';
  upsert.mockReset().mockResolvedValue({ error: null });
  delEq2.mockReset().mockResolvedValue({ error: null });
  unsubscribe.mockReset().mockResolvedValue(true);
  subscribe.mockReset().mockResolvedValue(sub);
  getSubscription.mockReset().mockResolvedValue(null);
  register.mockReset().mockResolvedValue({});
  requestPermission.mockReset().mockImplementation(async () => (perm = 'granted'));
  mockSupabase = { from: (t: string) => (t === 'push_tokens' ? { upsert, delete: del } : null) };
  setBrowser(true);
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('registers sw, subscribes with the VAPID key and upserts the web row', async () => {
  await expect(enablePush('u1')).resolves.toBe('enabled');
  expect(register).toHaveBeenCalledWith('/sw.js');
  expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
  const row = upsert.mock.calls[0][0];
  expect(row).toMatchObject({ user_id: 'u1', platform: 'web' });
  expect(JSON.parse(row.token).endpoint).toBe('https://fcm.googleapis.com/x');
  expect(upsert.mock.calls[0][1]).toEqual({ onConflict: 'user_id,token' });
  await expect(pushEnabled()).resolves.toBe(true);
});

test('reuses an existing subscription', async () => {
  getSubscription.mockResolvedValue(sub);
  await enablePush('u1');
  expect(subscribe).not.toHaveBeenCalled();
});

test('no VAPID key → unsupported, never asks permission', async () => {
  process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY = '';
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  expect(requestPermission).not.toHaveBeenCalled();
});

test('no Push API → unsupported; on uninstalled iOS Safari → needs-install', async () => {
  setBrowser(false);
  await expect(enablePush('u1')).resolves.toBe('unsupported');
  mockIos = 'needs-install';
  await expect(enablePush('u1')).resolves.toBe('needs-install');
});

test('permission not granted → denied (no subscription)', async () => {
  requestPermission.mockImplementation(async () => (perm = 'denied'));
  await expect(enablePush('u1')).resolves.toBe('denied');
  expect(subscribe).not.toHaveBeenCalled();
});

test('subscribe/upsert failures → error, nothing remembered', async () => {
  upsert.mockResolvedValue({ error: { message: 'x' } });
  await expect(enablePush('u1')).resolves.toBe('error');
  subscribe.mockRejectedValue(new Error('push service'));
  await expect(enablePush('u1')).resolves.toBe('error');
  expect(await AsyncStorage.getItem('push.token.v1')).toBeNull();
});

test('disablePush deletes the row, unsubscribes and forgets', async () => {
  getSubscription.mockResolvedValue(sub);
  await enablePush('u1');
  await disablePush('u1');
  expect(delEq2).toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalled();
  expect(await AsyncStorage.getItem('push.token.v1')).toBeNull();
});

test('disablePush still unsubscribes when the row delete fails (then throws)', async () => {
  getSubscription.mockResolvedValue(sub);
  await enablePush('u1');
  delEq2.mockResolvedValue({ error: { message: 'net' } });
  await expect(disablePush('u1')).rejects.toBeDefined();
  expect(unsubscribe).toHaveBeenCalled();
});
