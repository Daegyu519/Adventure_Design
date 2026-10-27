import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import type { Database } from './types/db';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// ponytail: 키 없이 화면 작업용, T-07에서 필수로 바꿈
export const supabase: SupabaseClient<Database> | null =
  url && anonKey
    ? createClient<Database>(url, anonKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          // 웹은 supabase-js 기본값(localStorage, 주소의 세션 감지)을 쓴다. 네이티브만 AsyncStorage에 세션을 저장한다.
          ...(Platform.OS === 'web' ? {} : { storage: AsyncStorage, detectSessionInUrl: false }),
        },
      })
    : null;

// Expo는 apps/mobile/.env 만 읽는다(루트 .env 아님). 값이 비어 있으면 개발 중에 눈에 보이게 알린다.
if (__DEV__ && !supabase) {
  console.warn('[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY 가 없어 supabase 클라이언트가 null 입니다. apps/mobile/.env 를 확인하세요(.env.example 참고).');
}

// 네이티브: 앱이 앞에 있을 때만 토큰 갱신을 돌린다.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
