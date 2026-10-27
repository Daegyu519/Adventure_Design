import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { useTheme } from '../lib/theme';
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
  const { colors } = useTheme();
  const [loaded, error] = useFonts(fonts);
  const ready = loaded || error !== null; // 글꼴 실패해도 시스템 글꼴로 계속 간다

  useEffect(() => {
    if (__DEV__ && error) console.warn('[fonts] Pretendard 로드 실패, 시스템 글꼴로 계속합니다.', error);
  }, [error]);

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  if (!ready) return null;
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </>
  );
}
