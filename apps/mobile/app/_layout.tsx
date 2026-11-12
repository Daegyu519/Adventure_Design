import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { BrandSplash } from '../components/BrandSplash';
import { UpdateBanner } from '../components/UpdateBanner';
import { useConsented } from '../lib/consent';
import { gate } from '../lib/gate';
import { SPLASH_MIN_MS } from '../lib/splash';
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
  const fontsReady = loaded || error !== null;
  // 시작 화면은 최소 SPLASH_MIN_MS는 보여 준다(0이면 바로 통과: 테스트)
  const [minDone, setMinDone] = useState(SPLASH_MIN_MS <= 0);
  useEffect(() => {
    if (minDone) return;
    const id = setTimeout(() => setMinDone(true), SPLASH_MIN_MS);
    return () => clearTimeout(id);
  }, [minDone]);
  const ready = fontsReady && g !== 'loading' && minDone;

  useEffect(() => {
    if (__DEV__ && error) console.warn('[fonts] Pretendard 로드 실패, 시스템 글꼴로 계속합니다.', error);
  }, [error]);

  // 네이티브 스플래시는 글꼴·동의·세션을 다 읽으면 걷는다(예전과 같다). 최소 시간이 남았으면 같은 모양의 BrandSplash가 이어받는다
  const loadedAll = fontsReady && g !== 'loading';
  useEffect(() => {
    if (loadedAll) SplashScreen.hide();
  }, [loadedAll]);

  // 읽는 동안에는 OOPS 시작 화면을 둔다. 스플래시가 걷힌 뒤(로그인 직후 프로필을 읽는 동안)에 흰 프레임이 번쩍이지 않게.
  if (!ready) return <BrandSplash />;
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {g === 'app' && <PushTaps />}
      <UpdateBanner />
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
          {/* 방 화면은 id마다 하나(at·k가 달라도). 둘이 쌓이면 같은 이름의 Realtime 채널을 나눠 써서 한쪽이 던지거나 조용히 멈춘다(알림 탭·두 번 누름). */}
          <Stack.Screen name="room/[id]/index" dangerouslySingular={(_, p) => String(p.id)} />
          <Stack.Screen name="room/[id]/info" />
          <Stack.Screen name="room/[id]/search" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
