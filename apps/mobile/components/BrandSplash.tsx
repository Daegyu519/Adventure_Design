import { Image, View } from 'react-native';

import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

// OOPS 시작 화면(글꼴·세션을 읽는 동안). 워드마크가 밝은 색이라 어두운 바탕에서만 보인다: 라이트에서도 어두운 면(primary)을 쓴다.
export function BrandSplash() {
  const { colors, scheme } = useTheme();
  return (
    <View accessibilityLabel="OOPS! 불러오는 중" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, backgroundColor: scheme === 'dark' ? colors.background : colors.primary }}>
      <Image source={require('../assets/images/oops-wordmark.png')} alt="OOPS!" style={{ width: 300, height: 168 }} resizeMode="contain" />
      <AppText style={{ color: colors.accent, letterSpacing: 0.5 }}>보내기 전에, 한 번 더.</AppText>
    </View>
  );
}
