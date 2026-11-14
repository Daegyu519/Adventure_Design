import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadCasual, saveCasual } from '../casual';

beforeEach(() => AsyncStorage.clear());

test('방마다 따로 저장하고, 끄면 지운다', async () => {
  expect(await loadCasual('r1')).toBe(false);
  await saveCasual('r1', true);
  expect(await loadCasual('r1')).toBe(true);
  expect(await loadCasual('r2')).toBe(false);
  await saveCasual('r1', false);
  expect(await loadCasual('r1')).toBe(false);
  expect(await AsyncStorage.getItem('casual:r1')).toBeNull();
});

test('저장소가 막혀도 던지지 않고 표시하지 않은 것으로 본다', async () => {
  const get = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('blocked'));
  const set = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('blocked'));
  expect(await loadCasual('r1')).toBe(false);
  await expect(saveCasual('r1', true)).resolves.toBeUndefined();
  get.mockRestore();
  set.mockRestore();
});
