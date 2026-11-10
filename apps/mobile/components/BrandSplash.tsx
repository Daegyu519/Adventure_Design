import { useEffect, useState } from 'react';
import { Animated, Image, View } from 'react-native';

import { useReducedMotion } from '../lib/motion';

import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

// OOPS 시작 화면(글꼴·세션을 읽는 동안). 워드마크가 밝은 색이라 어두운 바탕에서만 보인다: 라이트에서도 어두운 면(primary)을 쓴다.
export function BrandSplash() {
  const { colors, scheme } = useTheme();
  const reduced = useReducedMotion();
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return a.setValue(1);
    Animated.timing(a, { toValue: 1, duration: 1200, useNativeDriver: true }).start(); // 시안: 아래에서 10px 떠오르며 나타남
  }, [reduced, a]);
  return (
    <View accessibilityLabel="OOPS! 불러오는 중" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: scheme === 'dark' ? colors.background : colors.primary }}>
      <Animated.View style={{ alignItems: 'center', gap: 22, opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
        <Image source={require('../assets/images/oops-wordmark.png')} alt="OOPS!" style={{ width: 300, height: 168 }} resizeMode="contain" />
        <AppText style={{ color: colors.accent, letterSpacing: 0.5 }}>보내기 전에, 한 번 더.</AppText>
      </Animated.View>
    </View>
  );
}
