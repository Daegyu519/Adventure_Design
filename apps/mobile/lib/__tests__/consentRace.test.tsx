import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import { saveConsent, useConsented } from '../consent';

// useConsented의 메모리 상태는 모듈에 하나라서, 이 파일은 테스트 하나만 둔다(상태가 다음 테스트로 새지 않게).
test('늦게 도착한 읽기(false)가 그 사이 saveConsent(true)를 덮어쓰지 않는다', async () => {
  // 읽기는 우리가 풀어 줄 때까지 멈춰 있다
  let finishRead: (v: string | null) => void = () => {};
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => new Promise((r) => (finishRead = r)));

  let seen: boolean | null | undefined;
  const Probe = () => {
    seen = useConsented();
    return null;
  };
  const root = createRoot();
  await act(async () => {
    root.render(<Probe />);
  });
  expect(seen).toBeNull(); // 아직 읽는 중

  await act(async () => {
    await saveConsent(); // 읽기보다 먼저 끝난다
  });
  expect(seen).toBe(true);

  await act(async () => {
    finishRead(null); // 늦게 도착한 "저장된 것 없음"
  });
  expect(seen).toBe(true); // 도로 false로 돌아가지 않는다
});
