import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// ponytail: 키 없이 화면 작업용, T-07에서 필수로 바꿈
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          // 웹은 supabase-js 기본값(localStorage, 주소의 세션 감지)을 쓴다. 네이티브만 AsyncStorage에 세션을 저장한다.
          ...(Platform.OS === 'web' ? {} : { storage: AsyncStorage, detectSessionInUrl: false }),
        },
      })
    : null;

// 네이티브: 앱이 앞에 있을 때만 토큰 갱신을 돌린다.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
