import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearSignedUrls } from './images';
import { disablePush } from './push';
import { supabase } from './supabase';

// 로그아웃해도 남기는 저장소 키. 나머지는 모두 "그 사람 것"으로 보고 지운다(같은 폰에서 다른 계정이 들어와도 새어 나가지 않게).
// 동의는 이 기기에서 한 것이고, 테마는 기기 취향이다. 새 키를 만드는 작업은 기본이 "지워짐"이라 여기를 건드릴 일이 없다.
const KEEP = ['consent', 'theme.v1'];

// 이 기기에서만 로그아웃하고(다른 기기 세션은 두고), 성공하면 사용자별 로컬 데이터를 지운다. 성공했을 때만 true.
// 로그아웃이 실패하면 아무것도 지우지 않는다(아직 로그인 상태이므로). 화면 전환은 세션 구독(게이트)이 한다.
export async function signOutAndClear(): Promise<boolean> {
  if (!supabase) return false;
  // 푸시 토큰 행은 로그인 상태(RLS)에서만 지울 수 있어 세션이 사라지기 전에 푸시를 해제한다. 실패하거나 3초를 넘기면 그냥 간다.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const id = (await supabase.auth.getSession()).data.session?.user.id;
    if (id) await Promise.race([disablePush(id), new Promise<void>((r) => (timer = setTimeout(r, 3000)))]);
  } catch {
    // 해제 못 해도 로그아웃은 막지 않는다(웹은 구독이 끊기고, 죽은 토큰은 엔진이 지운다).
  }
  clearTimeout(timer);
  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) return false;
  } catch {
    return false;
  }
  clearSignedUrls();
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((k) => !KEEP.includes(k)));
  } catch {
    // 지우지 못해도 로그아웃은 끝났다. 다음 로그인에서 덮어써진다.
  }
  return true;
}
