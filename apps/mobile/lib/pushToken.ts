import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from './supabase';

// 이 기기의 토큰(네이티브는 Expo 토큰, 웹은 구독 JSON). 로그아웃 때 그 행만 지우려고 기억한다. 토큰은 로그에 남기지 않는다.
export const TOKEN_KEY = 'push.token.v1';
export type PushResult = 'enabled' | 'denied' | 'unsupported' | 'needs-install' | 'error';

export const storedToken = () => AsyncStorage.getItem(TOKEN_KEY);
export const forgetToken = () => AsyncStorage.removeItem(TOKEN_KEY);

// 행을 먼저 올리고 성공했을 때만 기억한다. 실패하면 던진다(호출한 쪽이 'error'로 바꾼다).
export async function saveToken(userId: string, token: string, platform: 'android' | 'web'): Promise<void> {
  if (!supabase) throw new Error('no supabase');
  const { error } = await supabase
    .from('push_tokens')
    .upsert({ user_id: userId, token, platform, updated_at: new Date().toISOString() }, { onConflict: 'user_id,token' });
  if (error) throw new Error('push_tokens upsert failed');
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

// 이 기기 행 삭제(RLS 때문에 로그인 상태에서 불러야 한다). 지우지 못하면 던지고 토큰을 남겨 다시 시도할 수 있게 한다.
export async function releaseToken(userId: string): Promise<void> {
  const token = await storedToken();
  if (!token) return;
  if (!supabase) throw new Error('no supabase');
  const { error } = await supabase.from('push_tokens').delete().eq('user_id', userId).eq('token', token);
  if (error) throw new Error('push_tokens delete failed');
  await forgetToken();
}
