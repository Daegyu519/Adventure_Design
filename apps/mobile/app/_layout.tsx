import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';

import { useConsented } from '../lib/consent';
import { gate } from '../lib/gate';
import { usePushTaps } from '../lib/push';
import { SessionProvider, useSession } from '../lib/session';
import { supabase } from '../lib/supabase';
import { ThemeProvider, useTheme } from '../lib/theme';
import tokens from '../lib/tokens.json';

// 글꼴이 준비될 때까지 스플래시를 붙잡아 둔다(모듈 최상단에서 한 번).
SplashScreen.preventAutoHideAsync();

// OFL 라이선스: assets/fonts/OFL.txt
const fonts = [
  {
    fontFamily: tokens.font.family,
    fontDefinitions: [
      { path: require('../assets/fonts/Pretendard-Regular.otf'), weight: 400 },
      { path: require('../assets/fonts/Pretendard-Medium.otf'), weight: 500 },
      { path: require('../assets/fonts/Pretendard-SemiBold.otf'), weight: 600 },
      { path: require('../assets/fonts/Pretendard-Bold.otf'), weight: 700 },
    ],
  },
];

export default function RootLayout() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <Gated />
      </SessionProvider>
    </ThemeProvider>
  );
}

// 알림을 누르면 그 대화방으로. 앱 화면(Stack 안 보호 구간)이 열린 뒤에만 듣는다.
function PushTaps() {
  usePushTaps();
  return null;
}

function Gated() {
  const { colors, scheme } = useTheme();
  const [loaded, error] = useFonts(fonts);
  const { status, profileStatus } = useSession();
  const g = gate({ consented: useConsented(), backend: supabase !== null, session: status, profile: profileStatus });
  // 글꼴이 실패해도 시스템 글꼴로 계속 가고, 동의·세션·프로필을 읽기 전(g === 'loading')에는 스플래시를 붙잡는다.
  const ready = (loaded || error !== null) && g !== 'loading';

  useEffect(() => {
    if (__DEV__ && error) console.warn('[fonts] Pretendard 로드 실패, 시스템 글꼴로 계속합니다.', error);
  }, [error]);

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  // 읽는 동안에는 바탕색만 칠한 빈 화면을 둔다. 스플래시가 걷힌 뒤(로그인 직후 프로필을 읽는 동안)에 흰 프레임이 번쩍이지 않게.
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {g === 'app' && <PushTaps />}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={g === 'consent'}>
          <Stack.Screen name="consent" />
        </Stack.Protected>
        <Stack.Protected guard={g === 'login'}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={g === 'profile'}>
          <Stack.Screen name="profile" />
        </Stack.Protected>
        <Stack.Protected guard={g === 'app'}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="room/[id]/index" />
          <Stack.Screen name="room/[id]/info" />
          <Stack.Screen name="room/[id]/search" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
