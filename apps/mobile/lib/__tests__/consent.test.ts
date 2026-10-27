import AsyncStorage from '@react-native-async-storage/async-storage';

import { CONSENT_VERSION, loadConsent, saveConsent } from '../consent';

beforeEach(() => AsyncStorage.clear());

test('consent: nothing stored → false', async () => expect(await loadConsent()).toBe(false));

test('consent: saveConsent → loadConsent true, stored as the version string', async () => {
  await saveConsent();
  expect(await AsyncStorage.getItem('consent')).toBe(String(CONSENT_VERSION));
  expect(await loadConsent()).toBe(true);
});

test('consent: an older version is not consent (bumping CONSENT_VERSION asks again)', async () => {
  await AsyncStorage.setItem('consent', String(CONSENT_VERSION - 1));
  expect(await loadConsent()).toBe(false);
});

test('consent: unreadable storage → false (show the consent screen, never crash)', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('blocked'));
  expect(await loadConsent()).toBe(false);
});

test('consent: a failed write does not trap the user on the consent screen', async () => {
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('blocked'));
  await expect(saveConsent()).resolves.toBeUndefined();
});
