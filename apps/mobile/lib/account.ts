import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from './supabase';

// 로그아웃해도 남기는 저장소 키. 나머지는 모두 "그 사람 것"으로 보고 지운다(같은 폰에서 다른 계정이 들어와도 새어 나가지 않게).
// 동의는 이 기기에서 한 것이고, 테마는 기기 취향이다. 새 키를 만드는 작업은 기본이 "지워짐"이라 여기를 건드릴 일이 없다.
const KEEP = ['consent', 'theme.v1'];

// 이 기기에서만 로그아웃하고(다른 기기 세션은 두고), 성공하면 사용자별 로컬 데이터를 지운다. 성공했을 때만 true.
// 로그아웃이 실패하면 아무것도 지우지 않는다(아직 로그인 상태이므로). 화면 전환은 세션 구독(게이트)이 한다.
export async function signOutAndClear(): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) return false;
  } catch {
    return false;
  }
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((k) => !KEEP.includes(k)));
  } catch {
    // 지우지 못해도 로그아웃은 끝났다. 다음 로그인에서 덮어써진다.
  }
  return true;
}
