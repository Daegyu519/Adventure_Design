import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from './supabase';

// 이 기기의 토큰(네이티브는 Expo 토큰, 웹은 구독 JSON). 로그아웃 때 그 행만 지우려고 기억한다. 토큰은 로그에 남기지 않는다.
export const TOKEN_KEY = 'push.token.v1';
export type PushResult = 'enabled' | 'denied' | 'unsupported' | 'needs-install' | 'error';

export const storedToken = () => AsyncStorage.getItem(TOKEN_KEY);
export const forgetToken = () => AsyncStorage.removeItem(TOKEN_KEY);

async function dropRow(userId: string, token: string): Promise<void> {
  if (!supabase) throw new Error('no supabase');
  const { error } = await supabase.from('push_tokens').delete().eq('user_id', userId).eq('token', token);
  if (error) throw new Error('push_tokens delete failed');
}

// 서버 RPC가 같은 토큰을 가진 다른 사용자의 행을 정리하고 내 행을 만든다(공유 기기에서 이전 사용자의 알림이 새지 않게).
// 토큰이 바뀐 경우(로테이션) 이전에 기억한 토큰의 내 행은 새 토큰을 등록한 뒤에 지운다(실패해도 계속):
// 등록이 실패하면 이전 행이 남아 알림이 끊기지 않는다. 성공했을 때만 기억한다.
export async function saveToken(userId: string, token: string, platform: 'android' | 'web'): Promise<void> {
  if (!supabase) throw new Error('no supabase');
  const prev = await storedToken();
  const { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: platform });
  if (error) throw new Error('register_push_token failed');
  if (prev && prev !== token) await dropRow(userId, prev).catch(() => {});
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

// 이 기기 행 삭제(RLS 때문에 로그인 상태에서 불러야 한다). 지우지 못하면 던지고 토큰을 남겨 다시 시도할 수 있게 한다.
export async function releaseToken(userId: string): Promise<void> {
  const token = await storedToken();
  if (!token) return;
  await dropRow(userId, token);
  await forgetToken();
}
