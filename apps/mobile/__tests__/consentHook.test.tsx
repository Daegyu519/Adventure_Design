import AsyncStorage from '@react-native-async-storage/async-storage';
import { act } from 'react';
import { createRoot } from 'test-renderer';

import { useConsented } from '../lib/consent';

// useConsented의 메모리 상태는 모듈에 하나라서, 이 파일은 테스트 하나만 둔다(상태가 다음 테스트로 새지 않게).
test('useConsented: 읽는 동안 null, 저장소에 동의가 있으면 그 값(true)으로 바뀐다', async () => {
  await AsyncStorage.setItem('consent', '1');
  let seen: boolean | null | undefined;
  const Probe = () => {
    seen = useConsented();
    return null;
  };
  const root = createRoot();
  // render 직후(저장소 읽기 전)에는 null. act 없이 한 틱만 그린다.
  act(() => {
    root.render(<Probe />);
  });
  expect(seen).toBeNull();
  await act(async () => {});
  expect(seen).toBe(true);
});
